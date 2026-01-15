# Cloud Functions Flow Reference

Comprehensive flow diagram showing all Google Cloud Functions, their triggers, interactions, and data flow.

## Overview

The application uses **10 Cloud Functions** to handle audio processing, chat, analytics, and billing:

| Function | Trigger | Memory | Timeout | Purpose |
|----------|---------|--------|---------|---------|
| `transcribeAudio` | Storage `onObjectFinalized` | 2GiB | 9 min | Entry point for uploads, chunks large files |
| `processTranscription` | Cloud Tasks HTTP | 2GiB | 60 min | Process each chunk via Gemini + WhisperX |
| `processMerge` | Cloud Tasks HTTP | 512MiB | 10 min | Stitch chunks, reconcile speakers |
| `processReprocessing` | Cloud Tasks HTTP | 512MiB | 10 min | Fallback: re-chunk in sequential mode |
| `chatWithConversation` | HTTPS Callable | 512MiB | 10 min | LLM chat with timestamp citations |
| `retryTranscription` | HTTPS Callable | 512MiB | 60 sec | Resume or restart failed jobs |
| `computeDailyStats` | Scheduler (2 AM) | 256MiB | 9 min | Aggregate usage statistics |
| `syncBillingCosts` | Scheduler (4 AM) | 512MiB | 9 min | Sync actual costs from BigQuery |
| `triggerBillingSync` | HTTPS Callable | 512MiB | 9 min | Manual billing sync trigger (admin) |
| `diagnoseBillingLabels` | HTTPS Callable | 512MiB | 60 sec | Diagnostic for billing label issues |

## Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    AUDIO TRANSCRIPT ANALYSIS - CLOUD FUNCTIONS                  │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│ CLIENT (React App)                                                              │
│                                                                                 │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐  ┌───────────────┐ │
│  │ Upload         │  │ chatWith       │  │ getSignedUrl   │  │ retry         │ │
│  │ Audio File     │  │ Conversation   │  │ (Callable)     │  │ Transcription │ │
│  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘  └───────┬───────┘ │
│          │                   │                   │                   │         │
└──────────┼───────────────────┼───────────────────┼───────────────────┼─────────┘
           │                   │                   │                   │
           ▼                   ▼                   ▼                   ▼
┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
│ Firebase Storage   │ │ Gemini API         │ │ Firebase Storage   │ │ Cloud Tasks        │
│ (audio/{userId})   │ │ + Firestore        │ │ (signed URL)       │ │ Queue              │
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
│ Memory: 512MiB | Timeout: 10 min                                            │
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
│ SUPPORTING FUNCTIONS                                                            │
│                                                                                 │
│ ┌─────────────────────────┐ ┌─────────────────────────┐ ┌─────────────────────┐ │
│ │ onConversationCreated   │ │ onConversationDeleted   │ │ computeDailyStats   │ │
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
│ RETRY FLOW (retryTranscription → Cloud Tasks)                                   │
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

### 7. Stats Functions

**Files:** `functions/src/statsTriggers.ts`, `functions/src/statsAggregator.ts`

- `onConversationCreated`: Records user event on conversation creation
- `onConversationDeleted`: Records user event on conversation deletion
- `computeDailyStats`: Scheduled (2 AM UTC) aggregation of global and daily stats
- `triggerStatsComputation`: Admin manual trigger for stats computation

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
