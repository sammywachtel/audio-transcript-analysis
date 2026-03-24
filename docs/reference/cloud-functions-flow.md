# Cloud Functions Flow Reference

Comprehensive flow diagram showing all Google Cloud Functions, their triggers, interactions, and data flow.

## Overview

The application uses Cloud Functions across several source modules to handle audio processing, chat, speaker corrections, analytics, and billing:

### Transcription Pipeline

| Function | File | Trigger | Memory | Timeout | Purpose |
|----------|------|---------|--------|---------|---------|
| `transcribeAudio` | `transcribe.ts` | Storage `onObjectFinalized` | 2GiB | 9 min | Entry point for uploads, runs hybrid pipeline |
| `processWithNewPipeline` | `newPipeline.ts` | Called from `transcribeAudio` | — | — | Gemini 3 Flash + WhisperX hybrid orchestration |

### User-Facing Callables

| Function | File | Trigger | Memory | Timeout | Purpose |
|----------|------|---------|--------|---------|---------|
| `chatWithConversation` | `chat.ts` | HTTPS Callable | 512MiB | 5 min | LLM chat with timestamp citations |
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

### Billing

| Function | File | Trigger | Memory | Timeout | Purpose |
|----------|------|---------|--------|---------|---------|
| `syncBillingCosts` | `billingSync.ts` | Scheduler (4 AM UTC) | 512MiB | 9 min | Sync actual costs from BigQuery |
| `triggerBillingSync` | `billingSync.ts` | HTTPS Callable | 512MiB | 9 min | Manual billing sync trigger (admin) |
| `diagnoseBillingLabels` | `billingSync.ts` | HTTPS Callable | 512MiB | 60 sec | Diagnostic for billing label issues |

## Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    AUDIO TRANSCRIPT ANALYSIS - CLOUD FUNCTIONS                  │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│ CLIENT (React App)                                                              │
│                                                                                 │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐                    │
│  │ Upload         │  │ chatWith       │  │ Speaker        │                    │
│  │ Audio File     │  │ Conversation   │  │ Corrections    │                    │
│  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘                    │
│          │                   │                   │                              │
└──────────┼───────────────────┼───────────────────┼──────────────────────────────┘
           │                   │                   │
           ▼                   ▼                   ▼
┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
│ Firebase Storage   │ │ Gemini API         │ │ Firestore          │
│ (audio/{userId})   │ │ + Firestore        │ │ (corrections sub)  │
└─────────┬──────────┘ └────────────────────┘ └────────────────────┘
          │
          │ onObjectFinalized
          ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ transcribeAudio (Storage Trigger)                                         │
│ Memory: 2GiB | Timeout: 9 min                                             │
│ ┌───────────────────────────────────────────────────────────────────────┐ │
│ │ 1. Detect audio duration via ffprobe                                  │ │
│ │ 2. Set status: 'processing'                                           │ │
│ │ 3. Route to processWithNewPipeline()                                  │ │
│ └───────────────────────────────────────────────────────────────────────┘ │
└─────────┬───────────────────────────────────────────────────────────────┘
          │
          ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ processWithNewPipeline (newPipeline.ts)                                    │
│ Gemini 3 Flash + WhisperX Hybrid Pipeline                                 │
│ ┌───────────────────────────────────────────────────────────────────────┐ │
│ │ Step 1: Gemini 3 Flash (WAV)                                          │ │
│ │ ├── Full-audio diarization (speakers by name)                         │ │
│ │ ├── Transcription with speaker attribution                            │ │
│ │ └── Content analysis (terms, topics, persons)                         │ │
│ │                                                                       │ │
│ │ Step 2: Download MP3 + split into 10-min chunks                       │ │
│ │                                                                       │ │
│ │ Step 3: Per-chunk HARDY alignment                                     │ │
│ │ ├── Scale Gemini timestamps to chunk-local time                       │ │
│ │ ├── Call Cloud Run GPU WhisperX (IAM-auth HTTP)                       │ │
│ │ ├── HARDY anchor + region alignment                                   │ │
│ │ └── Offset aligned timestamps back to global time                     │ │
│ │                                                                       │ │
│ │ Step 4: Quality gates + assembleFirestoreData()                       │ │
│ │                                                                       │ │
│ │ Step 5: Write to Firestore → status: 'complete'                       │ │
│ └───────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘

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
```

## Function Details

### 1. transcribeAudio (Storage Trigger)

**File:** `functions/src/transcribe.ts`

Entry point for all audio uploads. Triggered when a file is uploaded to Firebase Storage.

**Responsibilities:**
- Detect audio duration using ffprobe
- Set Firestore status to `processing`
- Route all uploads to `processWithNewPipeline()` from `newPipeline.ts`
- Handle errors and set `failed` status

**Key Decisions:**
- 9-minute timeout is a hard limit for Storage triggers
- The hybrid pipeline processes most audio within this window (Gemini is fast, WhisperX processes in parallel chunks)

### 2. Hybrid Pipeline (processWithNewPipeline)

**File:** `functions/src/newPipeline.ts`

Orchestrates the Gemini 3 Flash + WhisperX hybrid pipeline end-to-end.

**Pipeline Sequence:**
1. **Gemini 3 Flash** (WAV) — full-audio diarization + content analysis via `processWithGemini3Flash()`
2. **Download MP3** — separate download for WhisperX (Gemini cleans up its own copy)
3. **Split into 10-min chunks** — for WhisperX alignment (single chunk if <10 min, skips ffmpeg)
4. **Per-chunk HARDY alignment** — scale Gemini timestamps to chunk-local time, `alignTimestamps()`, offset back to global
5. **Assembly** — `assembleFirestoreData()` converts Gemini + aligned segments to Firestore schema
6. **Persist** — writes complete conversation payload with `status: 'complete'`

**Progress Contract:**

The hybrid pipeline reports progress through `ProgressManager` with these steps (in order):

| Step | Enum Value | Percentage | Description |
|------|-----------|------------|-------------|
| 1 | `GEMINI_ANALYSIS` | 20% | Running Gemini 3 Flash analysis |
| 2 | `WHISPERX_ALIGNMENT` | 60% | Per-chunk HARDY alignment |
| 3 | `ASSEMBLY` | 85% | Building Firestore payload |
| 4 | `SAVING` | 95% | Writing to Firestore |
| 5 | `COMPLETE` | 100% | Done |

**Status Sequence:** `queued` → `processing` (set by `transcribeAudio`) → progress steps above → `complete`

The pipeline writes `pipelineVersion: 'gemini_hybrid'` to the conversation document so downstream consumers (frontend, analytics) can identify which pipeline produced the data.

**Alignment Fallback:** If HARDY alignment fails for a chunk, the pipeline degrades gracefully to scaled Gemini timestamps rather than failing the entire run. Partial alignment beats missing segments.

**Known Limitations:**
- Runs within the 9-minute Storage trigger timeout. Very long audio (>45 min) may approach this limit.
- No retry/recovery logic. Failures leave the conversation in `failed` status.

### 3. chatWithConversation (HTTPS Callable)

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

### 4. Speaker Correction Functions

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

### 5. Stats Functions

**Files:** `functions/src/statsTriggers.ts`, `functions/src/statsAggregator.ts`

- `onConversationCreated`: Firestore trigger — records user event on conversation creation
- `onConversationDeleted`: Firestore trigger — records user event on conversation deletion
- `computeDailyStats`: Scheduled (2 AM UTC) — aggregates rolling windows (7-day, 30-day active users), processing stats, LLM usage
- `triggerStatsComputation`: HTTPS Callable — admin manual trigger, same logic as scheduled version

## Billing Sync Functions (v2.2.0+)

**Files:** `functions/src/billingSync.ts`

These functions sync actual Gemini costs from BigQuery billing exports for cost comparison:

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

### Why Single-Pass Gemini + Chunked WhisperX?

The previous architecture used a multi-step pipeline: per-chunk Gemini analysis, per-chunk WhisperX with diarization, cross-chunk speaker matching, and a complex merge step. This produced inconsistent speaker labeling (15 speakers instead of 6 for a 6-speaker conversation) and required 392 manual corrections.

The current architecture eliminates all of that:
- **Gemini 3 Flash** processes the full audio in a single API call, producing consistent speaker identities across the entire conversation
- **WhisperX** provides only word-level timestamps (no diarization needed)
- **HARDY alignment** bridges Gemini's content with WhisperX's timing
- Audio is split into 10-minute chunks only for WhisperX request sizing — Gemini sees the whole file

This means no cross-chunk speaker matching, no merge step, no quality scoring, and dramatically fewer manual corrections needed.

### Why the 9-Minute Timeout Works

Storage triggers have a hard 9-minute timeout. The hybrid pipeline typically completes well within this:
- Gemini 3 Flash: 15-100s (scales with audio length, but handles full files)
- WhisperX chunks: process sequentially, ~30-60s each
- HARDY alignment: negligible (<1s per chunk)
- Firestore write: <5s

For a 45-minute audio file, total processing is typically 3-5 minutes. Very long files (>60 min) may approach the timeout and would need Cloud Tasks routing in a future scope.

## Related Documentation

- [Architecture](architecture.md) - Full system architecture
- [Data Model](data-model.md) - Firestore schema
- [Alignment Architecture](alignment-architecture.md) - HARDY algorithm details
- [Gemini 3 Migration](../explanation/gemini3-migration.md) - Why the pipeline was redesigned
