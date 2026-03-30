# Pipeline Flow Reference

Canonical reference for the transcription pipeline — from audio upload to completed transcript.

## Pipeline Architecture

The pipeline has two layers: a thin **dispatcher** (Cloud Function) and a heavy **orchestrator** (Cloud Run).

```
┌─────────────────────────────────────────────────────────────────────────┐
│ CLIENT (React App)                                                      │
│  Upload audio file → Firebase Storage                                   │
└─────────┬───────────────────────────────────────────────────────────────┘
          │
          │ onObjectFinalized
          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ transcribeAudio — DISPATCHER (Cloud Function)                           │
│ Memory: 256MiB | Timeout: 60s | File: functions/src/transcribe.ts       │
│                                                                         │
│  1. Validate upload path: audio/{userId}/{conversationId}.{ext}         │
│  2. Firestore transaction: dedup (Cloud Storage fires 3+ triggers)      │
│  3. Write initial state: status='processing', queuedAt, etc.           │
│  4. Production: dispatch IAM-auth HTTP POST to orchestrator             │
│     Emulator:   run processWithNewPipeline() inline                     │
│  5. Return (dispatcher is done — orchestrator owns the rest)            │
└─────────┬───────────────────────────────────────────────────────────────┘
          │
          │ IAM-authenticated HTTP POST /transcribe
          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ transcription-orchestrator — PIPELINE (Cloud Run)                       │
│ CPU: 2 | Memory: 2Gi | Timeout: 900s                                   │
│ File: cloud-run-orchestrator/src/server.ts → pipeline.ts                │
│                                                                         │
│  1. Validate request fields                                             │
│  2. Firestore transaction: orchestratorClaimed dedup guard              │
│  3. Return 202 Accepted (fire-and-forget for dispatcher)                │
│  4. Run pipeline asynchronously:                                        │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ Step 1: Gemini 3 Flash (WAV) — single-pass analysis              │  │
│  │ ├── Full-audio diarization (speakers by name)                    │  │
│  │ ├── Transcription with speaker attribution                       │  │
│  │ └── Content analysis (terms, topics, persons)                    │  │
│  │                                                                   │  │
│  │ Step 2: Download MP3 + detect audio duration                     │  │
│  │                                                                   │  │
│  │ Step 3: Per-chunk HARDY alignment                                │  │
│  │ ├── Split into 10-min chunks if needed                           │  │
│  │ ├── Scale Gemini timestamps to chunk-local time                  │  │
│  │ ├── Call Cloud Run GPU WhisperX (IAM-auth HTTP)                  │  │
│  │ ├── HARDY anchor + region alignment                              │  │
│  │ └── Offset aligned timestamps back to global time                │  │
│  │                                                                   │  │
│  │ Step 4: Quality gates                                            │  │
│  │ ├── Segment coverage ≥ 50% of Gemini segments                   │  │
│  │ └── Low-confidence chunk tracking for needs_review               │  │
│  │                                                                   │  │
│  │ Step 5: assembleFirestoreData() + persist to Firestore           │  │
│  │ ├── processingPipeline: 'gemini_hybrid'                          │  │
│  │ ├── pipelineVersion: 'gemini_hybrid'                             │  │
│  │ └── status: 'complete' (or 'needs_review')                       │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  5. Clear orchestratorClaimed flag on completion/failure                 │
└─────────────────────────────────────────────────────────────────────────┘
```

## Idempotency: `orchestratorClaimed`

Cloud Storage fires `onObjectFinalized` at least once — in practice, 3 triggers per upload is routine. Each trigger dispatches to the orchestrator, and Cloud Run may spin up separate container instances for each request. A simple in-memory Set would not work because the requests hit different instances.

The solution is a **Firestore transaction guard** using the `orchestratorClaimed` field:

```typescript
const claimed = await db.runTransaction(async (txn) => {
  const doc = await txn.get(conversationRef);
  if (doc.data()?.orchestratorClaimed) return false; // already claimed
  txn.update(conversationRef, { orchestratorClaimed: true });
  return true;
});
```

Only the first instance to win the transaction runs the pipeline. Others return 409 Conflict and exit. The flag is cleared after the pipeline completes (success or failure) so retries work correctly.

**Note**: `orchestratorClaimed` is an implementation detail of the orchestrator's deduplication logic. It is not part of the operator-facing Firestore schema and should not be referenced by frontend code or analytics queries.

## Progress Contract

The pipeline reports progress through `ProgressManager`, writing to the conversation document's `processingProgress` field. The frontend's real-time listener picks up these updates instantly.

| Step | Enum Value           | Percentage | Description                     |
| ---- | -------------------- | ---------- | ------------------------------- |
| 1    | `GEMINI_ANALYSIS`    | 20%        | Running Gemini 3 Flash analysis |
| 2    | `WHISPERX_ALIGNMENT` | 60%        | Per-chunk HARDY alignment       |
| 3    | `ASSEMBLY`           | 85%        | Building Firestore payload      |
| 4    | `SAVING`             | 95%        | Writing to Firestore            |
| 5    | `COMPLETE`           | 100%       | Done                            |

**Status sequence**: `queued` → `processing` (set by dispatcher) → progress steps above → `complete`

## Dispatcher Deduplication

The dispatcher (`transcribeAudio`) has its own deduplication layer using a Firestore transaction that checks `queuedAt`. This prevents all 3 Cloud Storage triggers from even reaching the orchestrator. The orchestrator's `orchestratorClaimed` guard is a defense-in-depth measure for the (rare) case where two dispatchers both win the race.

## Alignment Fallback

If HARDY alignment fails for a chunk, the pipeline degrades gracefully to scaled Gemini timestamps rather than failing the entire run. When this happens:

- The chunk's segments use linearly scaled Gemini timestamps
- `alignmentStatus` is set to `'fallback'` on the conversation document
- The UI shows a "Fallback Sync" indicator

Partial alignment beats missing segments — a transcript with some imprecise timestamps is better than no transcript.

## Error Handling

Both the dispatcher and orchestrator write structured errors to Firestore so the frontend can display actionable messages:

```typescript
interface StructuredError {
  code: string; // Machine-readable error code
  stage: string; // Pipeline stage where failure occurred
  message: string; // Human-readable description
  retryable: boolean; // Whether the user should try again
}
```

Error codes include `GEMINI_PARSE_FAILED`, `WHISPERX_UNAVAILABLE`, `QUALITY_GATE_FAILED`, `STORAGE_ERROR`, `ABORTED`, and `GEMINI_TIMEOUT`.

## Deployment

The orchestrator deploys via GitHub Actions (`deploy-orchestrator.yml`). On push to `main` when orchestrator or shared function sources change, the workflow:

1. Builds a Docker image via Cloud Build (repo-root context — the Dockerfile copies `functions/src/` at build time)
2. Deploys to Cloud Run as `transcription-orchestrator`
3. Updates the `ORCHESTRATOR_URL` secret in Secret Manager
4. Runs a health check against `/health`

Manual fallback: `gcloud run deploy transcription-orchestrator ...` (see deploy docs for full flags).

## Cloud Run Service Configuration

| Setting       | Value    | Rationale                                                                 |
| ------------- | -------- | ------------------------------------------------------------------------- |
| CPU           | 2        | Pipeline is network-bound (Gemini, WhisperX) but needs headroom for HARDY |
| Memory        | 2Gi      | Audio file download + ffmpeg chunk splitting                              |
| Timeout       | 900s     | 15-minute pipeline ceiling with cleanup headroom                          |
| Concurrency   | 1        | One pipeline per instance (no shared state)                               |
| Min instances | 0        | Scale to zero when idle                                                   |
| Max instances | 3        | Cost safeguard — caps parallel pipelines                                  |
| Auth          | IAM only | `--no-allow-unauthenticated` — dispatcher must present OIDC token         |

## Related Documentation

- [Architecture](architecture.md) — System architecture overview
- [HARDY Alignment](alignment-architecture.md) — Detailed alignment algorithm reference
- [Data Model](data-model.md) — Firestore schema for pipeline output fields
- [Deployment](../how-to/deploy.md) — How to deploy the orchestrator
