# Cloud Functions Flow Reference

Comprehensive flow diagram showing all Google Cloud Functions, their triggers, interactions, and data flow.

## Overview

The application uses **18 Cloud Functions** across 8 source modules to handle audio processing, chat, speaker corrections, analytics, billing, and alerting:

### Transcription Pipeline

| Function | File | Trigger | Memory | Timeout | Purpose |
|----------|------|---------|--------|---------|---------|
| `transcribeAudio` | `transcribe.ts` | Storage `onObjectFinalized` | 2GiB | 9 min | Entry point for uploads, chunks large files |
| `processTranscription` | `processTranscription.ts` | Cloud Tasks HTTP | 2GiB | 60 min | Process each chunk via Gemini + WhisperX |
| `processMerge` | `chunkMerge.ts` | Cloud Tasks HTTP | 1GiB | 10 min | Stitch chunks, reconcile speakers |
| `processReprocessing` | `chunkMerge.ts` | Cloud Tasks HTTP | 512MiB | 10 min | Fallback: re-chunk in sequential mode |

### User-Facing Callables

| Function | File | Trigger | Memory | Timeout | Purpose |
|----------|------|---------|--------|---------|---------|
| `chatWithConversation` | `chat.ts` | HTTPS Callable | 512MiB | 5 min | LLM chat with timestamp citations |
| `retryTranscription` | `retry.ts` | HTTPS Callable | 512MiB | 60 sec | Resume or restart failed jobs |
| `mergeSpeakers` | `speakerCorrections.ts` | HTTPS Callable | 256MiB | 30 sec | Merge two speakers into one |
| `reassignSegments` | `speakerCorrections.ts` | HTTPS Callable | 256MiB | 30 sec | Move segments to a different speaker |
| `renameSpeaker` | `speakerCorrections.ts` | HTTPS Callable | 256MiB | 30 sec | Change a speaker's display name |
| `undoCorrection` | `speakerCorrections.ts` | HTTPS Callable | 256MiB | 30 sec | Undo a previous correction |

### Stats & Analytics

| Function | File | Trigger | Memory | Timeout | Purpose |
|----------|------|---------|--------|---------|---------|
| `onConversationCreated` | `statsTriggers.ts` | Firestore `onDocumentCreated` | default | default | Record creation event |
| `onConversationDeleted` | `statsTriggers.ts` | Firestore `onDocumentDeleted` | default | default | Record deletion event |
| `computeDailyStats` | `statsAggregator.ts` | Scheduler (2 AM UTC) | 512MiB | 5 min | Aggregate usage statistics |
| `triggerStatsComputation` | `statsAggregator.ts` | HTTPS Callable | 512MiB | 5 min | Manual stats trigger (admin) |

### Billing & Alerting

| Function | File | Trigger | Memory | Timeout | Purpose |
|----------|------|---------|--------|---------|---------|
| `syncBillingCosts` | `billingSync.ts` | Scheduler (4 AM UTC) | 512MiB | 9 min | Sync actual costs from BigQuery |
| `triggerBillingSync` | `billingSync.ts` | HTTPS Callable | 512MiB | 9 min | Manual billing sync trigger (admin) |
| `diagnoseBillingLabels` | `billingSync.ts` | HTTPS Callable | 512MiB | 60 sec | Diagnostic for billing label issues |
| `handleReconciliationAlert` | `handleReconciliationAlert.ts` | Pub/Sub `reconciliation-alerts` | 256MB | 60 sec | Auto-disable reconciliation on errors |

## Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    AUDIO TRANSCRIPT ANALYSIS - CLOUD FUNCTIONS                  │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│ CLIENT (React App)                                                              │
│                                                                                 │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐  ┌───────────────┐ │
│  │ Upload         │  │ chatWith       │  │ Speaker        │  │ retry         │ │
│  │ Audio File     │  │ Conversation   │  │ Corrections    │  │ Transcription │ │
│  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘  └───────┬───────┘ │
│          │                   │                   │                   │         │
└──────────┼───────────────────┼───────────────────┼───────────────────┼─────────┘
           │                   │                   │                   │
           ▼                   ▼                   ▼                   ▼
┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
│ Firebase Storage   │ │ Gemini API         │ │ Firestore          │ │ Cloud Tasks        │
│ (audio/{userId})   │ │ + Firestore        │ │ (corrections sub)  │ │ Queue              │
└─────────┬──────────┘ └────────────────────┘ └────────────────────┘ └─────────┬──────────┘
          │                                                                    │
          │ onObjectFinalized                                                  │
          ▼                                                                    │
┌───────────────────────────────────────────────────────────────────────────┐  │
│ transcribeAudio (Storage Trigger)                                         │  │
│ Memory: 2GiB | Timeout: 9 min                                             │  │
│ ┌───────────────────────────────────────────────────────────────────────┐ │  │
│ │ 1. Detect audio duration                                              │ │  │
│ │ 2. If >30 min → Chunk audio into overlapping segments                 │ │  │
│ │ 3. Upload chunks to Storage                                           │ │  │
│ │ 4. Create Cloud Tasks for each chunk                                  │ │  │
│ │ 5. If <30 min → Process directly via executeTranscriptionPipeline     │ │  │
│ └───────────────────────────────────────────────────────────────────────┘ │  │
└─────────┬─────────────────────────────────────┬───────────────────────────┘  │
          │                                     │                              │
          │ Small file (<30 min)                │ Large file (>30 min)         │
          ▼                                     ▼                              │
┌───────────────────────┐             ┌───────────────────────┐                │
│ Direct Processing     │             │ Cloud Tasks Queue     │◄───────────────┘
│ (same function)       │             │ (N chunk tasks)       │  retryTranscription
│                       │             │                       │  enqueues here
│ → Gemini API          │             │ mode: parallel or     │
│ → WhisperX align      │             │       sequential      │
│ → Firestore update    │             │                       │
│ → status: complete    │             └───────────┬───────────┘
└───────────────────────┘                         │
                                                  │ For each chunk
                                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ processTranscription (Cloud Tasks HTTP)                                     │
│ Memory: 2GiB | Timeout: 60 min                                              │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ PARALLEL MODE:                      SEQUENTIAL MODE:                    │ │
│ │ ┌──────────────────────┐            ┌──────────────────────┐            │ │
│ │ │ Fresh context        │            │ Load predecessor     │            │ │
│ │ │ (no dependencies)    │            │ context (speaker     │            │ │
│ │ │                      │            │ IDs, signatures)     │            │ │
│ │ └──────────┬───────────┘            └──────────┬───────────┘            │ │
│ │            │                                   │                        │ │
│ │            └─────────────┬─────────────────────┘                        │ │
│ │                          ▼                                              │ │
│ │                ┌───────────────────────┐                                │ │
│ │                │ executeTranscription  │                                │ │
│ │                │ Pipeline:             │                                │ │
│ │                │ • Gemini API call     │                                │ │
│ │                │ • WhisperX alignment  │                                │ │
│ │                │ • Store chunk result  │                                │ │
│ │                └──────────┬────────────┘                                │ │
│ │                           │                                             │ │
│ │                           ▼                                             │ │
│ │                ┌───────────────────────┐                                │ │
│ │                │ Mark chunk complete   │                                │ │
│ │                │ Emit next context     │                                │ │
│ │                │ Store speaker sigs    │                                │ │
│ │                └──────────┬────────────┘                                │ │
│ └───────────────────────────┼─────────────────────────────────────────────┘ │
└─────────────────────────────┼───────────────────────────────────────────────┘
                              │
                              ▼
                    ┌───────────────────────┐
                    │ All chunks complete?  │
                    └───────────┬───────────┘
                                │
              ┌─────────────────┴─────────────────┐
              │ No                                │ Yes
              ▼                                   ▼
     ┌─────────────────┐                ┌───────────────────────┐
     │ Wait for other  │                │ Enqueue merge task    │
     │ chunks          │                │ status: 'merging'     │
     └─────────────────┘                └───────────┬───────────┘
                                                    │
                                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ processMerge (Cloud Tasks HTTP)                                             │
│ Memory: 1GiB | Timeout: 10 min                                               │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ 1. Load all chunk artifacts from subcollection                          │ │
│ │ 2. Deduplicate segments in overlap regions                              │ │
│ │ 3. Reconcile speaker IDs across chunks:                                 │ │
│ │    ┌─────────────────────┐      ┌─────────────────────┐                 │ │
│ │    │ PARALLEL MODE       │      │ SEQUENTIAL MODE     │                 │ │
│ │    │ • Embedding-based   │      │ • Direct mapping    │                 │ │
│ │    │ • Heuristics        │      │ • IDs already       │                 │ │
│ │    │ • Confidence score  │      │   consistent        │                 │ │
│ │    └──────────┬──────────┘      └──────────┬──────────┘                 │ │
│ │               │                            │                            │ │
│ │               └─────────────┬──────────────┘                            │ │
│ │                             ▼                                           │ │
│ │                 ┌───────────────────────┐                               │ │
│ │                 │ Merge terms, topics,  │                               │ │
│ │                 │ persons with          │                               │ │
│ │                 │ deterministic IDs     │                               │ │
│ │                 └──────────┬────────────┘                               │ │
│ │                            │                                            │ │
│ │                            ▼                                            │ │
│ │                 ┌───────────────────────┐                               │ │
│ │                 │ Confidence check      │                               │ │
│ │                 └──────────┬────────────┘                               │ │
│ └────────────────────────────┼────────────────────────────────────────────┘ │
└──────────────────────────────┼──────────────────────────────────────────────┘
                               │
             ┌─────────────────┴─────────────────┐
             │ High confidence                   │ Low confidence
             ▼                                   ▼
┌───────────────────────────┐       ┌─────────────────────────────────────────┐
│ SUCCESS                   │       │ processReprocessing (Cloud Tasks HTTP)  │
│ • Write final document    │       │ Memory: 512MiB | Timeout: 10 min        │
│ • status: 'complete'      │       │ ┌─────────────────────────────────────┐ │
│ • Ready for chat/view     │       │ │ 1. Download original audio          │ │
└───────────────────────────┘       │ │ 2. Re-chunk with sequential mode    │ │
                                    │ │ 3. Archive old parallel chunks      │ │
                                    │ │ 4. Enqueue new chunk tasks          │ │
                                    │ │    (mode: sequential)               │ │
                                    │ └──────────────────┬──────────────────┘ │
                                    └────────────────────┼────────────────────┘
                                                         │
                                                         │ Restart pipeline
                                                         ▼
                                              ┌────────────────────────┐
                                              │ processTranscription   │
                                              │ (sequential mode)      │
                                              │ → processMerge         │
                                              │ → status: 'complete'   │
                                              └────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│ SPEAKER CORRECTIONS (speakerCorrections.ts)                                     │
│ All: HTTPS Callable | 256MiB | 30 sec | Apply-on-read pattern                  │
│                                                                                 │
│  Client (Viewer page)                                                           │
│          │                                                                      │
│          ├─► mergeSpeakers ──────► speakerCorrections/{id} (type: merge)        │
│          │   Merge speaker A into B                                             │
│          │                                                                      │
│          ├─► reassignSegments ──► speakerCorrections/{id} (type: reassign)      │
│          │   Move segments to a different speaker                               │
│          │                                                                      │
│          ├─► renameSpeaker ─────► speakerCorrections/{id} (type: rename)        │
│          │   Change display name (validated: non-empty, <50 chars)              │
│          │                                                                      │
│          └─► undoCorrection ────► Sets undoneAt timestamp (preserves audit)     │
│                                                                                 │
│  Client applies corrections at read time — no reprocessing needed.              │
│  Server replays active corrections to validate new operations.                  │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│ STATS & ANALYTICS                                                               │
│                                                                                 │
│ ┌─────────────────────────┐ ┌─────────────────────────┐ ┌─────────────────────┐ │
│ │ onConversationCreated   │ │ onConversationDeleted   │ │ computeDailyStats   │ │
│ │ statsTriggers.ts        │ │ statsTriggers.ts        │ │ statsAggregator.ts  │ │
│ │ (Firestore trigger)     │ │ (Firestore trigger)     │ │ (Scheduler: 2AM)    │ │
│ │                         │ │                         │ │                     │ │
│ │ Records user event      │ │ Records user event      │ │ Aggregates global & │ │
│ │ for analytics           │ │ for analytics           │ │ daily stats         │ │
│ └─────────────────────────┘ └─────────────────────────┘ └─────────────────────┘ │
│                                                                                 │
│ ┌─────────────────────────────────────────────────────────────────────────────┐ │
│ │ triggerStatsComputation (HTTPS Callable) - Admin manual trigger for stats   │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│ RECONCILIATION ALERTING (handleReconciliationAlert.ts)                           │
│ Pub/Sub: reconciliation-alerts | 256MB | 60 sec                                 │
│                                                                                 │
│  Cloud Monitoring                                                               │
│  (log-based metric: reconciliation errors > 5% in 5 min)                        │
│          │                                                                      │
│          ▼                                                                      │
│  Alert policy fires ──► Pub/Sub topic: reconciliation-alerts                    │
│                                    │                                            │
│                                    ▼                                            │
│                         handleReconciliationAlert                               │
│                                    │                                            │
│                                    ▼                                            │
│                         Disables context-aware reconciliation                   │
│                         (feature flag in Firestore)                             │
│                                                                                 │
│  On OPEN incident: auto-disables to prevent cascading failures.                 │
│  Manual re-enable required after investigation.                                 │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│ RETRY FLOW (retryTranscription → Cloud Tasks)                                   │
│ retry.ts | HTTPS Callable | 512MiB | 60 sec                                    │
│                                                                                 │
│  Failed/Aborted Job                                                             │
│          │                                                                      │
│          ▼                                                                      │
│  ┌───────────────────────┐                                                      │
│  │ Check chunking        │                                                      │
│  │ metadata              │                                                      │
│  └───────────┬───────────┘                                                      │
│              │                                                                  │
│     ┌────────┴────────┐                                                         │
│     ▼                 ▼                                                         │
│ ┌───────────────┐ ┌───────────────────────┐                                     │
│ │ Chunked +     │ │ Non-chunked OR        │                                     │
│ │ partial       │ │ no progress           │                                     │
│ │ progress      │ │                       │                                     │
│ └───────┬───────┘ └───────────┬───────────┘                                     │
│         │                     │                                                 │
│         ▼                     ▼                                                 │
│ ┌───────────────┐ ┌───────────────────────┐                                     │
│ │ Resume only   │ │ Full restart          │                                     │
│ │ incomplete    │ │ (increment task       │                                     │
│ │ chunks        │ │  generation)          │                                     │
│ └───────────────┘ └───────────────────────┘                                     │
│                                                                                 │
│ Max retries: 3 | taskGeneration invalidates stale Cloud Tasks                   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Function Details

### 1. transcribeAudio (Storage Trigger)

**File:** `functions/src/transcribe.ts`

Entry point for all audio uploads. Triggered when a file is uploaded to Firebase Storage.

**Responsibilities:**
- Detect audio duration using ffprobe
- For files >30 min: split into overlapping chunks, upload chunks, create Cloud Tasks
- For files ≤30 min: process directly via `executeTranscriptionPipeline`
- Update Firestore with processing status

**Key Decisions:**
- 9-minute timeout is a hard limit for Storage triggers
- Chunking threshold of 30 minutes ensures processing completes within Cloud Tasks timeout
- Overlapping chunks (5-10s) prevent word truncation at boundaries

### 2. processTranscription (Cloud Tasks HTTP)

**File:** `functions/src/processTranscription.ts`

Handles the actual transcription work for each chunk or whole file.

**Processing Pipeline:**
1. Download audio from Storage
2. Call Gemini API for transcription + speaker diarization
3. Call WhisperX (via Replicate) for word-level timestamp alignment
4. Store results in Firestore (chunk subcollection or main document)

**Two Processing Modes:**
- **Parallel**: All chunks process independently, speaker reconciliation at merge
- **Sequential**: Each chunk waits for predecessor, consistent speaker IDs throughout

### 3. processMerge (Cloud Tasks HTTP)

**File:** `functions/src/chunkMerge.ts` (lines 846-937)

Stitches chunk results into a single coherent transcript.

**Merge Operations:**
1. Load all chunk artifacts from `conversations/{id}/chunks/` subcollection
2. Deduplicate segments in overlap regions (fuzzy matching)
3. Reconcile speaker IDs across chunks
4. Merge terms, topics, persons with deterministic IDs
5. Compute confidence score for speaker reconciliation

**Fallback Logic:**
If parallel mode speaker reconciliation confidence is too low, triggers `processReprocessing` to re-run in sequential mode.

### 4. processReprocessing (Cloud Tasks HTTP)

**File:** `functions/src/chunkMerge.ts` (lines 968-1223)

Fallback handler when parallel processing produces low-confidence speaker reconciliation.

**Actions:**
1. Download original audio file
2. Re-chunk with sequential processing mode
3. Archive old parallel chunks
4. Enqueue new chunk tasks (sequential mode)

### 5. chatWithConversation (HTTPS Callable)

**File:** `functions/src/chat.ts`

Enables natural language Q&A about transcripts with timestamp citations.

**Features:**
- Rate limited (20 queries/day per conversation per user)
- Returns markdown-formatted answers with inline `{{SOURCE_n}}` placeholders
- Validates citations against actual segments
- Calculates and records cost metrics

**Inline Source Placeholder Contract:**

The LLM is instructed to emit `{{SOURCE_n}}` placeholders in its response, where `n` is a 0-indexed position corresponding to the order of segment citations. This enables the frontend to render interactive timestamp buttons inline with the supporting text.

```
Example LLM response:
"The speaker mentioned Q4 revenue {{SOURCE_0}}. They also discussed next quarter {{SOURCE_1}}."
```

**Source Ordering Requirements:**
- `extractSegmentIndices()` returns segment indices in order of first appearance
- `validateTimestampSources()` preserves this order (no sorting)
- The returned `sources` array matches placeholder indices: `sources[0]` → `{{SOURCE_0}}`
- Frontend handles out-of-range indices gracefully with `[Source unavailable]`

**Files involved:**
- `functions/src/utils/promptBuilder.ts` - LLM prompt instructions for `{{SOURCE_n}}` format
- `functions/src/utils/timestampValidation.ts` - Source extraction and validation
- `src/components/viewer/MarkdownWithSources.tsx` - Frontend markdown + source rendering

### 6. retryTranscription (HTTPS Callable)

**File:** `functions/src/retry.ts`

Allows users to retry failed or aborted jobs.

**Retry Strategy:**
- **Chunked with partial progress**: Resume only incomplete chunks
- **Non-chunked or no progress**: Full restart
- Max 3 retries enforced
- Increments `taskGeneration` to invalidate stale Cloud Tasks

### 7. Speaker Correction Functions

**File:** `functions/src/speakerCorrections.ts`

Four lightweight callables that let users fix diarization errors from the Viewer UI. All use the **apply-on-read pattern**: corrections are written to a `speakerCorrections` subcollection and the client applies them at read time (no reprocessing required). The server replays active corrections before each write to validate operations against the effective speaker state.

- **`mergeSpeakers`**: Merge speaker A into speaker B (all A's segments become B's)
- **`reassignSegments`**: Move specific segments to a different speaker
- **`renameSpeaker`**: Change a speaker's display name (validated: non-empty, <50 chars)
- **`undoCorrection`**: Mark a correction as undone (sets `undoneAt` timestamp, preserves audit trail)

**Shared Characteristics:**
- Auth required, ownership verified
- 256MiB memory, 30 sec timeout
- Returns `correctionId` for undo tracking (except `undoCorrection`)

### 8. Stats Functions

**Files:** `functions/src/statsTriggers.ts`, `functions/src/statsAggregator.ts`

- `onConversationCreated`: Firestore trigger — records user event on conversation creation
- `onConversationDeleted`: Firestore trigger — records user event on conversation deletion
- `computeDailyStats`: Scheduled (2 AM UTC) — aggregates rolling windows (7-day, 30-day active users), processing stats, LLM usage
- `triggerStatsComputation`: HTTPS Callable — admin manual trigger, same logic as scheduled version

### 9. handleReconciliationAlert (Pub/Sub)

**File:** `functions/src/handleReconciliationAlert.ts`

Circuit breaker that auto-disables context-aware speaker reconciliation when Cloud Monitoring detects elevated error rates.

**Alert Pipeline:**
1. Log-based metric counts `reconciliation_error` events
2. Alert policy fires when error rate exceeds 5% in a 5-minute window
3. Alert publishes to `reconciliation-alerts` Pub/Sub topic
4. This function receives the alert and disables the feature flag in Firestore

**Behavior:**
- On `OPEN` incident: disables context-aware reconciliation to prevent cascading failures
- On `CLOSED` incident: logs only (manual re-enable required after investigation)

**Setup:** Requires manual creation of Pub/Sub topic, log-based metrics, and alert policy (documented in rollout runbook).

## Billing Sync Functions (v2.2.0+)

**Files:** `functions/src/billingSync.ts`

These functions sync actual Gemini costs from BigQuery billing exports to enable cost reconciliation:

- `syncBillingCosts`: Scheduled (4 AM UTC) to fetch actual costs from BigQuery and update `_metrics` documents with `actualCost` field
- `triggerBillingSync`: Admin-only manual trigger for on-demand billing sync
- `diagnoseBillingLabels`: Admin-only diagnostic function to debug billing label propagation

**Data Flow:**
```
Vertex AI API Calls → Billing Labels (conversation_id, user_id, call_type)
        │
        ▼
BigQuery Billing Export (24-48 hour delay)
        │
        ▼ (4 AM UTC daily)
syncBillingCosts queries BigQuery
        │
        ▼
_metrics documents updated with actualCost
        │
        ▼
Admin dashboard shows estimated vs actual costs
```

**Prerequisites:**
- BigQuery billing export enabled in `wachtel-ops` project
- Service account has `roles/bigquery.dataViewer` on billing dataset
- `_pricing` collection configured (no fallback defaults as of v2.2.0)

**Note:** Billing data has a 24-48 hour delay. The sync queries a 7-day window to catch late-arriving data.

## Key Architectural Decisions

### Why Cloud Tasks over Direct Calls?

Storage triggers have a **9-minute hard timeout limit**. Large audio files can take 15-60+ minutes to process. Cloud Tasks enables:
- 60-minute timeouts per task
- Automatic retry with exponential backoff
- Dead letter queue for failed tasks
- Distributed processing of chunks

### Why Two Processing Modes?

**Parallel Mode** (default):
- Faster: all chunks process simultaneously
- ~60% faster for 6-chunk files
- Speaker IDs may differ across chunks
- Requires speaker reconciliation at merge

**Sequential Mode** (fallback):
- Slower: each chunk waits for predecessor
- Consistent speaker IDs throughout
- No reconciliation needed
- Used when parallel confidence is too low

### Task Generation Counter

When retrying a job, the system increments `taskGeneration`. Cloud Tasks handlers check this value and reject stale tasks (from previous attempts) without expensive cancellation logic.

## Related Documentation

- [Architecture](architecture.md) - Full system architecture
- [Data Model](data-model.md) - Firestore schema for chunk metadata
- [Chunk Merge Explanation](../explanation/chunk-merge.md) - Deep dive on merging logic
