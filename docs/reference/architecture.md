# Architecture Reference

Technical architecture of the Audio Transcript Analysis App.

## System Overview

```
┌───────────────────────────────────────────────────────────────────┐
│                          User Browser                             │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │                     React Application                        │ │
│  │  ┌───────────┐  ┌───────────────────┐  ┌───────────────────┐ │ │
│  │  │   Auth    │  │   Conversation    │  │      Pages        │ │ │
│  │  │  Context  │  │     Context       │  │ Library/Viewer/   │ │ │
│  │  │           │  │                   │  │ Search            │ │ │
│  │  └─────┬─────┘  └─────────┬─────────┘  └─────────┬─────────┘ │ │
│  │        │                  │                      │           │ │
│  │        └──────────────────┼──────────────────────┘           │ │
│  │                           │                                  │ │
│  │  ┌────────────────────────┴────────────────────────────────┐ │ │
│  │  │                    Firebase SDK                         │ │ │
│  │  │  Auth │ Firestore (real-time) │ Storage │ Functions     │ │ │
│  │  └─────────────────────────────────────────────────────────┘ │ │
│  └──────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
                               │
                               │ HTTPS
                               ▼
┌───────────────────────────────────────────────────────────────────┐
│                          Firebase                                 │
│                                                                   │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────┐   │
│  │  Firebase      │  │  Firestore     │  │  Firebase Storage  │   │
│  │  Auth          │  │  Database      │  │  (Audio Blobs)     │   │
│  └────────────────┘  └────────────────┘  └─────────┬──────────┘   │
│                                                    │              │
│                                                    │ onFinalized  │
│                                                    ▼              │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │                Cloud Functions (18 total)                    │ │
│  │                                                              │ │
│  │  ┌──────────────────────┐  ┌──────────────────────────────┐  │ │
│  │  │  transcribeAudio     │  │  Callables (HTTPS)           │  │ │
│  │  │  (Storage trigger)   │  │  ┌────────────────────────┐  │  │ │
│  │  │  - validates file    │  │  │ chatWithConversation   │  │  │ │
│  │  │  - enqueues task     │  │  │ retryTranscription     │  │  │ │
│  │  │  - 540s timeout      │  │  │ mergeSpeakers          │  │  │ │
│  │  └──────────┬───────────┘  │  │ reassignSegments       │  │  │ │
│  │             │              │  │ renameSpeaker          │  │  │ │
│  │             ▼              │  │ undoCorrection         │  │  │ │
│  │  ┌──────────────────────┐  │  └────────────────────────┘  │  │ │
│  │  │  Cloud Tasks Queue   │  └──────────────────────────────┘  │ │
│  │  │  transcription-queue │                                    │ │
│  │  └──────────┬───────────┘  ┌──────────────────────────────┐  │ │
│  │             │              │  Background                  │  │ │
│  │             ▼              │  ┌────────────────────────┐  │  │ │
│  │  ┌────────────────────┐    │  │ onConversation*        │  │  │ │
│  │  │  processTranscr.   │    │  │ computeDailyStats      │  │  │ │
│  │  │  (private, 60 min) │    │  │ syncBillingCosts       │  │  │ │
│  │  └──────────┬─────────┘    │  │ handleReconAlert       │  │  │ │
│  │             │              │  └────────────────────────┘  │  │ │
│  │             ▼              └──────────────────────────────┘  │ │
│  │  ┌────────────────────┐                                      │ │
│  │  │  processMerge      │  See cloud-functions-flow.md         │ │
│  │  │  (private, 10 min) │  for detailed flow diagrams.        │ │
│  │  └────────────────────┘                                      │ │
│  │                                                              │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
                                 │
                         ┌───────┴───────┐
                         ▼               ▼
                  ┌────────────────┐  ┌────────────────┐
                  │  Vertex AI     │  │  Replicate     │
                  │  (Gemini)      │  │  (WhisperX)    │
                  └────────────────┘  └────────────────┘
```

## Component Architecture

### Frontend Layers

```
Pages (Library, Viewer, Search)
        │
        ├── use contexts ────┐
        │                    │
        ▼                    ▼
    Hooks              Contexts
    ├── useAudioPlayer      ├── AuthContext
    ├── useChat             └── ConversationContext
    ├── usePersonMentions
    ├── useTranscriptSelection
    ├── useSearch           (search orchestration)
    ├── useSearchFilters    (filter state + URL sync)
    └── useDebounce         (input debouncing)
        │
        └── use services ────┐
                             │
                             ▼
                        Services
                        ├── chatService     (Firebase callable wrapper)
                        ├── firestoreService
                        ├── storageService
                        └── searchService   (search + filter logic)
                             │
                             ▼
                      Firebase SDK
```

### Directory Structure

```
audio-transcript-analysis-app/
├── components/              # React components
│   ├── auth/               # Authentication components
│   │   ├── SignInButton.tsx
│   │   ├── UserMenu.tsx
│   │   ├── ProtectedRoute.tsx
│   │   └── AdminRoute.tsx  # Admin-only content gating
│   ├── search/             # Search result and filter components
│   │   ├── SearchResults.tsx        # Results container + pagination
│   │   ├── ConversationResultCard.tsx # Grouped results per conversation
│   │   ├── SegmentResult.tsx        # Individual segment match
│   │   ├── ZeroResultsState.tsx     # Empty state with suggestions
│   │   ├── FilterSidebar.tsx        # Desktop 300px filter sidebar
│   │   ├── FilterBottomSheet.tsx    # Mobile bottom sheet with drag-to-dismiss
│   │   ├── DateRangeFilter.tsx      # Date range preset/custom selector
│   │   ├── SpeakerFilter.tsx        # Speaker checkbox filter with counts
│   │   └── TopicFilter.tsx          # Topic checkbox filter with counts
│   ├── shared/             # Shared components
│   │   └── CostIndicator.tsx        # Per-message cost display
│   └── viewer/             # Transcript viewer components
│       ├── AudioPlayer.tsx
│       ├── ChatInput.tsx            # Chat message input
│       ├── ChatMessage.tsx          # User/assistant message display
│       ├── ChatSidebar.tsx          # Chat panel with messages
│       ├── Sidebar.tsx              # Three-tab sidebar (Context/People/Chat)
│       ├── TranscriptSegment.tsx
│       ├── TranscriptView.tsx
│       ├── TopicMarker.tsx
│       └── ViewerHeader.tsx
├── contexts/               # React contexts
│   ├── AuthContext.tsx     # Authentication state + isAdmin role
│   └── ConversationContext.tsx
├── hooks/                  # Custom React hooks
│   ├── useAudioPlayer.ts
│   ├── useAutoScroll.ts
│   ├── useChat.ts          # Chat message state management
│   ├── useDebounce.ts      # Generic debounce for inputs
│   ├── useMetrics.ts       # Observability data hooks
│   ├── usePersonMentions.ts
│   ├── useSearch.ts        # Search state + pagination + filter integration
│   ├── useSearchFilters.ts # Filter state with URL/sessionStorage sync
│   └── useTranscriptSelection.ts
├── pages/                  # Page components
│   ├── Library.tsx         # Conversation list + upload
│   ├── Search.tsx          # Full-text search across transcripts
│   ├── Viewer.tsx          # Transcript viewer
│   ├── AdminDashboard.tsx  # Admin dashboard with metrics, users, pricing
│   └── UserStats.tsx       # Personal usage statistics
├── services/               # Firebase + app services
│   ├── chatService.ts      # Chat Firebase callable wrapper
│   ├── firestoreService.ts
│   ├── storageService.ts
│   ├── metricsService.ts   # Observability queries
│   └── searchService.ts    # Client-side search logic
├── utils/                  # Utility functions
│   └── textHighlight.ts    # Snippet extraction + highlighting
├── components/
│   ├── admin/              # Admin dashboard components
│   │   └── PricingManager.tsx  # LLM pricing configuration
│   └── metrics/            # Metrics visualization
│       ├── StatCard.tsx
│       ├── TimeSeriesChart.tsx
│       ├── LLMUsageBreakdown.tsx
│       └── MetricsTable.tsx
├── functions/              # Cloud Functions (Node.js) — 18 functions, 8 modules
│   └── src/
│       ├── index.ts                    # Function exports + Firebase Admin init
│       ├── transcribe.ts               # transcribeAudio (Storage trigger) + Gemini pipeline
│       ├── processTranscription.ts     # processTranscription (Cloud Tasks)
│       ├── chunkMerge.ts               # processMerge + processReprocessing (Cloud Tasks)
│       ├── chat.ts                     # chatWithConversation (HTTPS callable)
│       ├── retry.ts                    # retryTranscription (HTTPS callable)
│       ├── speakerCorrections.ts       # merge/reassign/rename/undo (HTTPS callables)
│       ├── statsTriggers.ts            # onConversation* (Firestore triggers)
│       ├── statsAggregator.ts          # computeDailyStats + triggerStatsComputation
│       ├── billingSync.ts              # syncBillingCosts + triggerBillingSync + diagnose
│       ├── handleReconciliationAlert.ts # Pub/Sub circuit breaker
│       ├── alignment.ts                # WhisperX integration via Replicate
│       ├── chunking.ts                 # Audio splitting + silence detection
│       ├── metrics.ts                  # Processing metrics recording
│       ├── userEvents.ts               # User activity event tracking
│       ├── pricing.ts                  # Pricing lookup and cost calculation
│       └── logger.ts                   # Structured logging utility
├── types.ts                # TypeScript types
├── utils.ts                # Helper functions
└── firebase-config.ts      # Firebase initialization
```

## Data Flow

### Upload Flow (Queue-Driven Architecture with Chunking)

```
1. User selects audio file
        ↓
2. Frontend uploads to Firebase Storage
   storageService.uploadAudio(file)
        ↓
3. Frontend creates Firestore doc (status: 'processing', alignmentStatus: 'pending')
   firestoreService.save(conversation)
        ↓
4. Storage trigger fires transcribeAudio
   onObjectFinalized → transcribeAudio()
        ↓
5. transcribeAudio downloads audio for duration check
   ├── Updates Firestore: status='queued'
   └── Downloads to /tmp for analysis
        ↓
6. Chunking decision based on duration
   ├── Short file (≤30 min) → Single Cloud Task (step 7a)
   └── Long file (>30 min) → Chunking workflow (step 7b)

7a. Short file: Enqueue single task
    └── Creates task in 'transcription-queue'
         ↓
7b. Long file: Chunk and enqueue multiple tasks
    ├── Detect silence gaps via ffmpeg
    ├── Split at natural break points (10-15 min chunks)
    ├── Add 5-10s overlap between chunks
    ├── Upload chunks to Storage (chunks/{conversationId}/)
    ├── Save chunk metadata to Firestore
    └── Enqueue one Cloud Task per chunk
         ↓
8. Cloud Tasks invokes processTranscription (HTTP function, 30-min timeout per chunk)
   ├── Updates Firestore: status='processing'
   └── Downloads audio (chunk or full file) from Storage
        ↓
9. processTranscription calls Gemini API for pre-analysis and content extraction
        ↓
10. processTranscription calls WhisperX for transcription + alignment
    ├── Success → alignmentStatus: 'aligned'
    └── Failure → alignmentStatus: 'fallback' (uses Gemini transcription)
        ↓
11. processTranscription writes results to Firestore (status: 'complete')
    ├── Success → Returns 200 (no Cloud Tasks retry)
    └── Failure → Returns 500 (Cloud Tasks retries with backoff)
        ↓
12. Real-time listener updates UI
    onSnapshot → setConversations()
```

**Why Two-Stage Architecture?**

- Storage triggers have a hard 540s (9-minute) timeout limit
- Large audio files (46MB+) need 10-15+ minutes for Gemini + WhisperX processing
- HTTP functions can have up to 3600s (60-minute) timeout
- Cloud Tasks handles retries automatically with exponential backoff

### Job Control (Cancel & Retry)

The system provides full job control capabilities allowing users to cancel active jobs and retry failed ones.

**Cancel/Abort Flow:**

```
1. User clicks "Cancel" on processing job in Library
        ↓
2. Frontend calls firestoreService.abortProcessing(conversationId)
   ├── Validates status is abortable: processing, chunking, merging, or reprocessing
   └── Sets abortRequested: true flag in Firestore
        ↓
3. Backend functions check abort flag at strategic checkpoints:
   ├── transcribeAudio: Before enqueueing chunk tasks
   ├── chunkMerge: After loading artifacts, after reconciliation, before final write
   └── processTranscription: At processing boundaries (existing)
        ↓
4. When abort detected, function throws AbortRequestedError
   ├── Updates status to 'aborted'
   ├── Sets processingError: 'Cancelled by user'
   └── Returns 200 (success) to prevent Cloud Tasks retry
        ↓
5. Real-time listener updates UI to show "Cancelled" status
```

**Retry Flow:**

```
1. User clicks "Retry" on failed/aborted job in Library
        ↓
2. Frontend calls retryTranscription callable function
   ├── Validates user owns conversation
   ├── Validates status is 'failed' or 'aborted'
   ├── Validates retryCount < 3 (max retry limit)
   └── Validates audio file still exists in storage
        ↓
3. Retry strategy determination:
   ├── Non-chunked job → Full restart
   │   ├── Clears error state and processing metadata
   │   ├── Sets status: 'processing', retryCount++
   │   └── Enqueues new processTranscription task
   │
   └── Chunked job with partial progress → Resume incomplete chunks
       ├── Identifies chunks with status ≠ 'complete'
       ├── Resets incomplete chunk statuses to 'pending'
       ├── Sets status: 'chunking', retryCount++
       └── Enqueues tasks only for incomplete chunks
        ↓
4. Processing resumes with updated retry metadata:
   ├── retryCount: incremented (enforces max 3 limit)
   ├── lastFailedAt: timestamp of previous failure
   └── lastRetryAt: timestamp of retry initiation
        ↓
5. Real-time listener updates UI to show new processing status
```

**Abortable Statuses:**
- `processing` - Single file or initial processing
- `chunking` - Chunked file with tasks being enqueued
- `merging` - Chunks being merged together
- `reprocessing` - Sequential reprocessing after parallel fallback

**Retry Metadata Fields:**
- `retryCount` (number): Number of retry attempts (max 3)
- `lastFailedAt` (ISO timestamp): When the job last failed
- `lastRetryAt` (ISO timestamp): When retry was last initiated
- `taskGeneration` (number): Counter incremented on each retry to invalidate stale Cloud Tasks

**Stale Task Detection:**

When a job fails and is retried, orphaned Cloud Tasks from the previous attempt may still be in-flight. Without mitigation, these stale tasks can corrupt the retry by updating progress or status with outdated values.

The `taskGeneration` field solves this:
1. Each new job starts with `taskGeneration: 1`
2. Cloud Task payloads include the current `taskGeneration`
3. On retry, `taskGeneration` is incremented in Firestore
4. When a task runs, it compares `payload.taskGeneration` vs Firestore's `taskGeneration`
5. If payload's generation is lower, the task is stale and returns 200 (complete, no-op)
6. Default: missing `taskGeneration` in payload defaults to 0, so pre-feature tasks are always stale after any retry

**Implementation Files:**
- `src/services/firestoreService.ts` - `abortProcessing()` client-side abort request
- `functions/src/retry.ts` - `retryTranscription` callable function
- `functions/src/transcribe.ts` - `checkAbort()` function and abort checkpoints
- `functions/src/chunkMerge.ts` - Abort checkpoints in merge flow
- `src/pages/Library.tsx` - Cancel and Retry UI controls

### Audio Chunking Module

For audio files longer than 30 minutes, the system splits the file into smaller chunks to stay within Cloud Function timeout limits. Each chunk is processed independently, then merged downstream.

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Audio Chunking Pipeline                            │
│                                                                       │
│  ┌─────────────────┐                                                  │
│  │  Original Audio │                                                  │
│  │  (>30 minutes)  │                                                  │
│  └────────┬────────┘                                                  │
│           │                                                           │
│           ▼                                                           │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  Silence Detection (ffmpeg -af silencedetect=n=-30dB:d=0.5)     │ │
│  │  ├── Scans for pauses in speech                                 │ │
│  │  └── Returns list of silence gaps (start, end, duration)        │ │
│  └────────┬────────────────────────────────────────────────────────┘ │
│           │                                                           │
│           ▼                                                           │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  Chunk Boundary Calculation                                      │ │
│  │  ├── Target: 10-15 minute chunks                                 │ │
│  │  ├── Minimum: 2 minutes (prevents tiny chunks)                   │ │
│  │  └── Snaps to silence gaps for clean cuts                        │ │
│  └────────┬────────────────────────────────────────────────────────┘ │
│           │                                                           │
│           ▼                                                           │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  Chunk Extraction with Overlap                                   │ │
│  │  ├── Extract each chunk via ffmpeg (-ss/-to/-c copy)            │ │
│  │  ├── 5-10s overlap at boundaries                                 │ │
│  │  └── Overlap ensures no words truncated                          │ │
│  └────────┬────────────────────────────────────────────────────────┘ │
│           │                                                           │
│           ▼                                                           │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  Chunk Upload & Task Creation                                    │ │
│  │  ├── Upload to Storage: chunks/{conversationId}/chunk-NNN.ext   │ │
│  │  ├── Save metadata to Firestore (chunkMetadata field)           │ │
│  │  └── Create Cloud Task per chunk (staggered scheduling)         │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

**Chunk Metadata Structure:**

Each chunk stores metadata for downstream deduplication and merging:

```typescript
interface ChunkMetadata {
  chunkIndex: number; // Zero-indexed chunk number
  totalChunks: number; // Total chunks for this file
  startMs: number; // Start time in original audio
  endMs: number; // End time in original audio
  overlapBeforeMs: number; // Overlap with previous chunk (0 for first)
  overlapAfterMs: number; // Overlap with next chunk (0 for last)
  chunkStoragePath: string; // Storage path: chunks/{id}/chunk-NNN.ext
  originalStoragePath: string; // Original file path
  durationMs: number; // Chunk duration (including overlaps)
}
```

**Key Files:**

- `functions/src/chunking.ts` - Silence detection, chunk boundary calculation, extraction
- `functions/src/chunkBounds.ts` - Validation helpers, overlap region utilities
- `@ffmpeg-installer/ffmpeg` - Provides ffmpeg binary for Cloud Functions

**Configuration (CHUNK_CONFIG):**

- `TARGET_DURATION_SECONDS`: 600 (10 min target)
- `MAX_DURATION_SECONDS`: 900 (15 min max)
- `MIN_DURATION_SECONDS`: 120 (2 min floor)
- `OVERLAP_SECONDS`: 7 (5-10s overlap window)
- `CHUNKING_THRESHOLD_SECONDS`: 1800 (30 min threshold)
- `SILENCE_THRESHOLD_DB`: -30dB
- `SILENCE_MIN_DURATION`: 0.5s

**Benefits:**

- Files of any length can be processed (no timeout issues)
- Each chunk fits comfortably in 30-minute Cloud Task timeout
- Silence-based splits prevent mid-word truncation
- Overlap ensures transcript continuity at boundaries
- Parallel processing possible with staggered task scheduling

### Chunk Context and Resumable Execution

For long audio files processed in chunks, the system maintains context between chunks to ensure:

1. **Speaker continuity** - The same person keeps the same speaker ID across all chunks
2. **Metadata deduplication** - Terms, topics, and people aren't duplicated across chunks
3. **Resumable execution** - Failed chunks can be retried without reprocessing successful ones

```
┌──────────────────────────────────────────────────────────────────────────┐
│                   Chunk Context State Machine                             │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  transcribeAudio (Storage Trigger)                                   │ │
│  │  ├── Initializes chunkStatuses: all 'pending'                       │ │
│  │  ├── Creates empty chunkContexts array                              │ │
│  │  └── Enqueues Cloud Task per chunk (staggered)                      │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                              │                                            │
│                              ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  processTranscription (Cloud Task Handler)                          │ │
│  │                                                                      │ │
│  │  For each chunk:                                                     │ │
│  │  1. Load ChunkContext from previous chunk (or initial for chunk 0)  │ │
│  │  2. Mark chunk status → 'processing'                                │ │
│  │  3. Execute transcription pipeline with context                      │ │
│  │  4. Build nextContext with speaker mappings, metadata IDs            │ │
│  │  5. Mark chunk status → 'complete', save nextContext                 │ │
│  │     (or → 'failed' with error on failure)                           │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                              │                                            │
│                              ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  Resume Logic (chunkContext.ts)                                      │ │
│  │  ├── getResumableChunks() → finds pending/failed chunks             │ │
│  │  ├── Each chunk loads context from last 'complete' predecessor       │ │
│  │  └── Failed chunks retry with backoff via Cloud Tasks               │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

**Firestore Schema - `chunkingMetadata` Field:**

```typescript
// Stored in conversations/{conversationId}.chunkingMetadata
interface ChunkingMetadata {
  chunkingEnabled: boolean; // true if file was chunked
  totalChunks: number; // Total number of chunks
  completedChunks: number; // Count of 'complete' chunks
  chunkStatuses: ChunkStatus[]; // Per-chunk status tracking
  chunkContexts: ChunkContext[]; // Per-chunk emitted contexts
  chunkedAt: string; // ISO timestamp
  originalDurationMs: number; // Original audio duration
  originalStoragePath: string; // Path to original file
}

interface ChunkStatus {
  chunkIndex: number;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  startedAt?: string; // When processing started
  completedAt?: string; // When processing finished
  error?: string; // Error message if failed
  retryCount?: number; // Number of retry attempts
}

interface ChunkContext {
  emittedByChunkIndex: number; // Which chunk created this context
  speakerMap: SpeakerMapping[]; // Canonical speaker ID mappings
  previousSummary: string; // Truncated summary (max 512 chars)
  knownTermIds: string[]; // Term IDs for deduplication
  knownTopicIds: string[]; // Topic IDs for deduplication
  knownPersonIds: string[]; // Person IDs for deduplication
  cumulativeSegmentCount: number; // Total segments so far
  lastProcessedMs: number; // Last timestamp processed
}

interface SpeakerMapping {
  originalId: string; // e.g., "SPEAKER_00"
  canonicalId: string; // Consistent ID across chunks
  displayName?: string; // Inferred name if known
}
```

**Key Files:**

- `functions/src/chunkContext.ts` - Context loading, status updates, resume helpers
- `functions/src/processTranscription.ts` - Chunk-aware task handler
- `functions/src/transcribe.ts` - Initializes chunk statuses on upload
- `functions/src/types.ts` - ChunkContext, ChunkStatus, ChunkingMetadata types

**Status Transitions:**

```
pending ──┬──▶ processing ──┬──▶ complete
          │                 │
          │                 └──▶ failed ──▶ (retry) ──▶ processing
          │
          └──▶ (blocked by predecessor) ──▶ pending (wait)
```

**Transaction Safety:**

All status and context updates use Firestore transactions to prevent race conditions:

- Multiple chunk tasks may run concurrently
- `markChunkComplete()` atomically updates status AND increments `completedChunks`
- `loadChunkContext()` validates predecessor chunk is complete before returning

**Resume Behavior:**

When a chunk fails and Cloud Tasks retries:

1. `loadChunkContext()` checks if previous chunk is complete
2. If previous chunk is still `processing` or `pending`, returns error (triggers retry)
3. If previous chunk is `complete`, loads its emitted context
4. If previous chunk is `failed`, returns error (dependent failure)

This ensures chunks are processed in dependency order even with concurrent execution.

### Processing Modes (Parallel vs Sequential)

The system supports two processing modes for chunked uploads, controlled by the `processingMode` field:

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    Processing Mode Comparison                            │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  PARALLEL MODE (Default)                 SEQUENTIAL MODE (Legacy)        │
│  ════════════════════════                ═══════════════════════         │
│                                                                          │
│  Chunk 0  ──▶ Process ──▶ Complete      Chunk 0 ──▶ Process ──▶ Complete │
│  Chunk 1  ──▶ Process ──▶ Complete             │                        │
│  Chunk 2  ──▶ Process ──▶ Complete             ▼                        │
│  (All run simultaneously)               Chunk 1 ◀─ Load context          │
│         │                                      │                        │
│         ▼                                      ▼                        │
│  ┌─────────────────────┐                      Process ──▶ Complete       │
│  │ Speaker Reconcile   │                             │                   │
│  │ (merge-time)        │                             ▼                   │
│  └─────────────────────┘                Chunk 2 ◀─ Load context          │
│         │                                      │                        │
│         ▼                                      ▼                        │
│      MERGE                                   Process ──▶ Complete        │
│                                                    │                    │
│                                                    ▼                    │
│                                                 MERGE                    │
│                                                                          │
│  ✓ Faster (all chunks process at once)    ✓ Consistent speaker IDs       │
│  ✓ Best for long files (1hr+ audio)       ✓ No post-hoc reconciliation   │
│  ⚡ ~60% faster for 6-chunk files          ⏱ ~60% slower (sequential wait) │
│                                                                          │
│  Speaker reconciliation at merge uses:    Context propagation ensures:   │
│  - Inferred names from introductions      - Speaker IDs inherited        │
│  - Topic/term signatures                  - No ID conflicts at merge     │
│  - Segment counts per speaker             - Cumulative metadata           │
│  - Sample quotes for fingerprinting       - Resume-safe state            │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

**Parallel Mode** (default for new uploads):
- All chunks start processing immediately after upload
- Each chunk uses a fresh initial context (no waiting)
- Speaker IDs may differ across chunks (SPEAKER_00 in chunk 0 ≠ SPEAKER_00 in chunk 3)
- `SpeakerSignature` fingerprints stored with each chunk artifact
- Merge function reconciles speakers using signatures (future scope)

**Sequential Mode** (legacy behavior):
- Chunks wait for predecessor to complete before starting
- Each chunk loads context from previous chunk
- Speaker IDs remain consistent across all chunks
- No reconciliation needed at merge time
- Slower but deterministic speaker tracking

**UI Selection:**

Users choose the processing mode in the upload modal:
- "Fast" button → `processingMode: 'parallel'`
- "Legacy" button → `processingMode: 'sequential'`

**Data Flow:**

```
Upload Modal → createMockConversation(file, { processingMode })
           → storageService.uploadAudio(..., { processingMode })
                   ↓ (customMetadata)
           → transcribeAudio (reads from Storage metadata)
                   ↓ (Firestore + Cloud Task payload)
           → processTranscription (branches on mode)
                   ↓
           → parallel: createInitialChunkContext()
           → sequential: loadChunkContext(conversationId, chunkIndex)
```

**Key Files:**

- `src/pages/Library.tsx` - Upload modal with mode toggle
- `src/utils/index.ts` - `createMockConversation` with options
- `src/services/storageService.ts` - Passes mode via customMetadata
- `functions/src/transcribe.ts` - Reads mode, propagates to Firestore/tasks
- `functions/src/processTranscription.ts` - Branches on mode
- `functions/src/chunkContext.ts` - `createInitialChunkContext()` for parallel

**Speaker Signature (Parallel Mode):**

When `processingMode === 'parallel'`, each chunk stores speaker signatures for merge-time reconciliation:

```typescript
interface SpeakerSignature {
  speakerId: string;       // "SPEAKER_00" (local to this chunk)
  chunkIndex: number;      // Which chunk this signature belongs to
  inferredName?: string;   // Name if speaker introduced themselves
  topicSignatures: string[]; // Topic IDs where speaker spoke
  termSignatures: string[];  // Term keys used by this speaker
  segmentCount: number;    // Segments contributed by speaker
  sampleQuote: string;     // First ~100 chars for fingerprinting
}
```

Signatures are stored in `conversations/{id}/chunks/{chunkIndex}.chunkSpeakerSignatures`.

### Alignment Module (HARDY Algorithm)

The Cloud Function includes an integrated alignment module that provides precise timestamps using WhisperX via Replicate:

```
Cloud Function (transcribeAudio)
        │
        │ 1. Gemini API (transcription + speaker diarization)
        ▼
┌──────────────────────────────┐
│  Segments with approximate   │
│  timestamps from Gemini      │
└──────────────┬───────────────┘
               │
               │ 2. alignment.ts (HARDY algorithm)
               ▼
┌──────────────────────────────┐
│  Replicate WhisperX API      │
│  (word-level timestamps)     │
└──────────────┬───────────────┘
               │
               │ 3. Fuzzy matching + anchor-based alignment
               ▼
┌──────────────────────────────┐
│  HARDY 4-Level Alignment     │
│  ├─ Level 1: Anchor Points   │
│  ├─ Level 2: Region Segment  │
│  ├─ Level 3: Regional Align  │
│  └─ Level 4: Validation      │
└──────────────┬───────────────┘
               │
       ┌───────┴───────┐
       │               │
       ▼               ▼
  Success           Failure
  alignmentStatus:  alignmentStatus:
  'aligned'         'fallback'
  (~50ms accuracy)  (uses Gemini
                    timestamps)
```

**Key Components:**

- `functions/src/alignment.ts` - HARDY algorithm implementation
- Uses `fuzzball` for fuzzy string matching
- Uses `replicate` SDK for WhisperX API calls
- `REPLICATE_API_TOKEN` stored as Firebase secret

**Fallback Behavior:**

- If WhisperX times out or fails, the Cloud Function uses Gemini's original timestamps
- The `alignmentError` field stores the reason for fallback
- Client displays "Fallback Sync" badge with tooltip explaining the issue
- Timestamps are still usable but may be ~5-10 seconds off

### Playback Flow

```
1. User clicks conversation in Library
        ↓
2. ConversationContext sets activeConversationId
        ↓
3. Viewer mounts, gets activeConversation from context
        ↓
4. useAudioPlayer initializes Audio element
        ↓
5. Audio loads, metadata event fires
        ↓
6. User clicks segment → seek to timestamp
        ↓
7. Audio plays, timeupdate events fire
        ↓
8. activeSegmentIndex updates, UI highlights
```

### Search Flow

```
1. User navigates to /search or clicks Search button
        ↓
2. URL query params parsed (?q=term&dateRange=7d&speakers=A,B&topics=X)
        ↓
3. Search.tsx mounts, initializes from URL or sessionStorage
        ↓
4. useSearch + useSearchFilters hooks orchestrate:
   ├── useDebounce (300ms) prevents search on every keystroke
   ├── useSearchFilters manages filter state + URL/session sync
   └── searchService.searchConversations() runs after debounce
        ↓
5. searchService (client-side) processes:
   ├── Tokenizes query
   ├── Searches all conversation segments (already in memory)
   ├── Applies filters (date range, speakers, topics)
   ├── Ranks matches by relevance
   └── Extracts snippets with ~50-char context windows
        ↓
6. Results grouped by conversation, displayed with:
   ├── Match counts per conversation
   ├── Highlighted snippets (textHighlight.ts)
   ├── Live speaker/topic counts from filtered results
   └── "Load more" pagination (20 results per page)
        ↓
7. "Open in Viewer" → navigate to Viewer with targetSegmentId
        ↓
8. Viewer.tsx scrolls to segment + applies temporary highlight
```

**Filter UI (responsive):**

- **Desktop**: 300px sticky sidebar with collapsible sections
- **Mobile**: Bottom sheet triggered by "Filters (N)" button
  - Drag-to-dismiss gesture (swipe down >80px to close)
  - Backdrop click or Apply button also dismiss

**Key Points:**

- Search runs entirely client-side (no additional Firestore queries)
- Uses conversations already loaded via ConversationContext
- URL syncs with query AND filters for shareable search links
- Browser back/forward restores full filter state
- SessionStorage persists filters when navigating away and returning

### Chat Flow (Backend)

```
1. User asks question about transcript
        ↓
2. chatWithConversation Cloud Function invoked
        ↓
3. Rate limit check (20 queries/day per conversation)
        ↓
4. Fetch conversation from Firestore + verify ownership
        ↓
5. buildChatPrompt constructs context:
   ├── Full transcript with speaker attribution
   ├── Topics, terms, people metadata
   └── System instructions requiring timestamp citations
        ↓
6. Call Gemini API (gemini-2.0-flash-exp)
        ↓
7. Extract segment indices from LLM response
        ↓
8. validateTimestampSources verifies citations:
   ├── Match segment indices to actual segments
   ├── Assign confidence levels (high/medium/low)
   └── Filter out invalid sources
        ↓
9. Calculate cost and record metrics to _metrics collection
        ↓
10. Return structured response with:
    ├── Answer text
    ├── Validated timestamp sources
    ├── Token usage and cost
    ├── Rate limit remaining
    └── isUnanswerable flag
```

**Key Components:**

- `functions/src/chat.ts` - Main Cloud Function
- `functions/src/utils/promptBuilder.ts` - Context-rich prompt construction
- `functions/src/utils/timestampValidation.ts` - Source validation and confidence scoring
- `functions/src/utils/rateLimit.ts` - Firestore-backed rate limiting
- `functions/src/utils/chatMetrics.ts` - Chat-specific metrics recording

**Rate Limiting:**

- 20 queries per conversation per day per user
- Stored in `_chat_rate_limits/{conversationId}_{userId}_{YYYY-MM-DD}`
- Resets daily at midnight UTC
- Uses Firestore transactions for atomic increment

**Unanswerable Questions:**

- LLM instructed to explicitly state when information not in transcript
- `isUnanswerable` flag set based on response patterns
- Empty or low-confidence sources returned for unanswerable questions

### Chat UI Flow (Frontend)

The chat interface is integrated into the Viewer sidebar as a third tab alongside Context and People.

```
┌─────────────────────────────────────────────────────────────┐
│                    Viewer Page                              │
│                                                             │
│  ┌───────────────────┐              ┌──────────────────┐   │
│  │  Transcript       │              │  Sidebar         │   │
│  │  View             │              │                  │   │
│  │                   │              │  [Context|People │   │
│  │  Audio Player     │              │   |Chat ③]       │   │
│  │  (synchronized)   │              │                  │   │
│  └───────────────────┘              │  ┌────────────┐  │   │
│                                     │  │ Chat Panel │  │   │
│                                     │  └────────────┘  │   │
│                                     └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**Component Hierarchy:**

```
Viewer.tsx
├── useChat({ conversationId })
│   ├── messages: ChatMessage[]
│   ├── draftInput: string
│   ├── sendMessage(msg: string)
│   └── isLoading, error states
│
├── Sidebar.tsx
│   ├── activeTab: 'context' | 'people' | 'chat'
│   ├── chatMessageCount badge on tab
│   │
│   └── ChatSidebar.tsx (when activeTab === 'chat')
│       ├── Header: title + duration
│       ├── Empty state with example questions
│       ├── Message list (scrollable)
│       │   └── ChatMessage.tsx × N
│       │       ├── User/Assistant avatar
│       │       ├── Message content
│       │       ├── CostIndicator (assistant only)
│       │       └── Timestamp sources (clickable links)
│       │
│       └── ChatInput.tsx (fixed at bottom)
│           ├── Auto-resizing textarea
│           ├── Enter to submit, Shift+Enter for newline
│           └── Send button
```

**State Management:**

1. **useChatHistory Hook** (`hooks/useChatHistory.ts`):
   - Real-time Firestore listener for message synchronization
   - Loads most recent 10 messages initially
   - Provides `loadOlder()` for pagination (batches of 10)
   - Tracks message count for 50 message limit enforcement
   - Automatic cleanup on conversation change/unmount
   - Works across devices (messages sync in real-time)

2. **useChat Hook** (`hooks/useChat.ts`):
   - Manages draft input (persists across tab switches)
   - Handles message sending and persistence
   - Checks message count limit (50 messages per conversation)
   - Calls chatHistoryService to persist both user and assistant messages
   - Error handling and loading states

3. **Chat History Service** (`services/chatHistoryService.ts`):
   - Firestore CRUD for `conversations/{id}/chatHistory` subcollection
   - Real-time subscriptions with pagination support
   - Batch deletion for clear history
   - Export to JSON with clean formatting
   - Message count tracking for limit enforcement

4. **Chat Service** (`services/chatService.ts`):
   - Wrapper around Firebase callable: `httpsCallable(functions, 'chatWithConversation')`
   - Client-side validation (message length, empty check)
   - Error transformation from Firebase error codes

**User Flow:**

```
1. User clicks Chat tab in Sidebar
        ↓
2. useChatHistory subscribes to Firestore chatHistory subcollection
        ↓
3. Most recent 10 messages loaded from Firestore
        ↓
4. If no messages, empty state shows example questions
        ↓
5. User types question in ChatInput
        ↓
6. Press Enter → sendMessage() called
        ↓
7. User message persisted to Firestore via chatHistoryService
        ↓
8. Real-time listener adds user message to UI instantly
        ↓
9. Loading spinner appears
        ↓
10. Backend processes request (see Chat Flow above)
        ↓
11. Assistant response persisted to Firestore via chatHistoryService
        ↓
12. Real-time listener adds assistant response to UI
        ↓
13. Timestamp sources rendered as clickable links
        ↓
14. Click timestamp → scroll to segment + seek audio
        ↓
15. If user has older messages, "Load older" button appears
        ↓
16. Click "Load older" → previous 10 messages loaded
```

**Timestamp Citations:**

- Format: `[▶ 12:34 - Speaker Name]`
- Clicking navigates to segment and seeks audio
- Uses existing `handleNavigateToSegment()` + `seek()` from Viewer
- Blue pill styling matching design system

**Empty State:**

- Shows when `messages.length === 0`
- Provides 4 example questions:
  - "What are the main topics discussed?"
  - "Who are the key people mentioned?"
  - "What decisions were made?"
  - "Can you summarize the conversation?"

**Error Handling:**

- Rate limit exceeded → dismissible error banner
- Network errors → dismissible error banner
- Failed messages do not persist to Firestore

**Chat History Persistence:**

- Messages stored in Firestore `conversations/{id}/chatHistory` subcollection
- Real-time synchronization across tabs and devices
- Survives page reloads and browser restarts
- Automatically cleaned up when parent conversation is deleted
- Draft input persists when switching tabs (in-memory only)

**Message Limits:**

- 50 message limit per conversation (user + assistant combined)
- Warning indicator at 45 messages (yellow badge)
- Blocking indicator at 50 messages (red badge + disabled input)
- Clear history resets count to 0

**Chat History Controls:**

- **Export**: Downloads all messages as JSON with metadata
- **Clear**: Batch deletes all messages (with confirmation modal)
- **Load Older**: Pagination for loading previous messages (10 at a time)
- Message count display: `X/50` with color-coded warnings

### Two-Way Selection Sync

```
Transcript → Sidebar:
  Click term in segment → onTermClick(termId)
  → useTranscriptSelection.handleTermClickInTranscript()
  → setSelectedTermId → scroll sidebar card into view

Sidebar → Transcript:
  Click term card → onTermSelect(termId)
  → useTranscriptSelection.handleTermClickInSidebar()
  → setSelectedTermId → scroll segment into view
```

## Security Model

### Authentication

- **Firebase Auth**: Google OAuth 2.0
- **Token Management**: Automatic refresh by Firebase SDK
- **Session Persistence**: `LOCAL` (survives browser restart)

### Data Isolation

All Firestore queries include `userId` filter:

```typescript
query(collection(db, 'conversations'), where('userId', '==', user.uid));
```

### Security Rules

```javascript
// Firestore
match /conversations/{conversationId} {
  allow read, write: if request.auth != null
    && resource.data.userId == request.auth.uid;
}

// Admin-only metrics collection
match /_metrics/{doc} {
  allow read: if isAdmin();
  allow write: if false;  // Only Cloud Functions can write
}

// Storage
match /audio/{userId}/{fileName} {
  allow read, write: if request.auth != null
    && request.auth.uid == userId;
}
```

### Admin Role

Admin users have access to the observability dashboard. Admin status is determined by the `isAdmin` field in the user's Firestore document:

```
users/{userId}
├── isAdmin: boolean    // Grants access to admin dashboard
├── email: string
└── ...
```

The `AuthContext` fetches this field on login and exposes `isAdmin` to the app. The `AdminRoute` component gates admin-only content.

## Observability System

The observability system provides comprehensive metrics, cost tracking, and usage analytics for both admins and regular users.

### Data Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                    Cloud Functions                                │
│                                                                  │
│  ┌───────────────┐    ┌──────────────┐    ┌─────────────────┐   │
│  │ transcribe.ts │───▶│  metrics.ts  │───▶│ _metrics/{id}   │   │
│  │               │    │  (LLM usage, │    └─────────────────┘   │
│  │ Gemini +      │    │   costs)     │                          │
│  │ WhisperX      │    └──────────────┘                          │
│  └───────────────┘                                              │
│                                                                  │
│  ┌───────────────────┐    ┌──────────────────────────────────┐  │
│  │ statsTriggers.ts  │───▶│ _user_events, _user_stats        │  │
│  │ (onCreate/Delete) │    │ (per-user aggregates)            │  │
│  └───────────────────┘    └──────────────────────────────────┘  │
│                                                                  │
│  ┌───────────────────┐    ┌──────────────────────────────────┐  │
│  │ statsAggregator   │───▶│ _global_stats, _daily_stats      │  │
│  │ (scheduled 2AM)   │    │ (system-wide aggregates)         │  │
│  └───────────────────┘    └──────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                       Frontend                                   │
│                                                                  │
│  ┌────────────────┐    ┌───────────────────┐                    │
│  │ metricsService │───▶│ hooks/useMetrics  │                    │
│  │ (Firestore     │    │ (React state)     │                    │
│  │  queries)      │    └─────────┬─────────┘                    │
│  └────────────────┘              │                              │
│                                  ▼                              │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                   UI Components                          │    │
│  │  ┌──────────────┐  ┌─────────────┐  ┌────────────────┐  │    │
│  │  │ AdminDash    │  │ UserStats   │  │ PricingManager │  │    │
│  │  │ (admin)      │  │ (all users) │  │ (admin)        │  │    │
│  │  └──────────────┘  └─────────────┘  └────────────────┘  │    │
│  └─────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

### Firestore Collections

| Collection      | Purpose                                | Writers         | Readers           |
| --------------- | -------------------------------------- | --------------- | ----------------- |
| `_metrics`      | Per-job processing details + LLM usage | Cloud Functions | Admin             |
| `_user_events`  | Activity audit trail                   | Cloud Functions | Admin             |
| `_user_stats`   | Pre-computed user aggregates           | Cloud Functions | Owner, Admin      |
| `_global_stats` | System-wide aggregates                 | Cloud Functions | Admin             |
| `_daily_stats`  | Time-series for charts                 | Cloud Functions | Admin             |
| `_pricing`      | LLM pricing configuration              | Admin           | All authenticated |

See [Data Model](data-model.md) for detailed schemas.

### LLM Usage Tracking

Each processing job captures LLM usage from both Gemini and Replicate:

```typescript
llmUsage: {
  geminiAnalysis: {
    inputTokens: number;           // Total input tokens (backward compat)
    audioInputTokens?: number;     // Tokens from audio input (pre-analysis)
    textInputTokens?: number;      // Tokens from text input (transcript analysis)
    outputTokens: number;
    model: string;  // e.g., 'gemini-2.5-flash'
  };
  geminiSpeakerCorrection: {
    inputTokens: number;           // Total input tokens (backward compat)
    audioInputTokens?: number;     // Always 0 for corrections (text-only)
    textInputTokens?: number;      // Tokens from text input
    outputTokens: number;
    model: string;
  };
  whisperx: {
    predictionId?: string;  // Replicate prediction ID for billing traceability
    computeTimeSeconds: number;  // Includes speaker diarization (bundled model)
    model: string;  // 'whisperx-diarization'
  };
  // Note: diarization field removed in v2.2.0 - now bundled with whisperx
}
```

### Billing Reconciliation

The cost tracking system supports billing reconciliation through several mechanisms:

**BigQuery Billing Sync (v2.2.0+)**: Actual Gemini costs are synced from BigQuery billing exports:

- `syncBillingCosts` Cloud Function runs daily at 4 AM UTC
- Queries BigQuery billing exports using `conversation_id` labels
- Updates `_metrics` documents with `actualCost` field for comparison
- Enables true estimated vs. actual cost reconciliation
- Admin dashboard shows variance between estimated and actual costs

**Pricing Snapshots**: Each `_metrics` document includes a `pricingSnapshot` capturing:

- The exact rates used for cost calculation
- The `_pricing` document IDs (or null if not configured)
- Audio vs. text input rate breakdown (v2.2.0+)
- The timestamp when pricing was looked up

This enables historical cost recalculation even after prices change.

**Important (v2.2.0+)**: Pricing configuration is now **required**. The `_pricing` collection must have records for `gemini-2.5-flash`, `gemini-2.5-flash-text`, and `whisperx`. Missing pricing results in $0 costs with warnings.

**Replicate Prediction IDs**: WhisperX metrics include the actual `predictionId` from Replicate, enabling:

- Direct correlation with Replicate billing data
- Verification of compute time estimates
- Traceability for cost audits

**Vertex AI Request Labels**: All Gemini API calls include billing attribution labels (`functions/src/utils/llmMetadata.ts`):

- `conversation_id`: Correlates costs with specific conversations
- `user_id`: Enables per-user cost tracking
- `call_type`: Distinguishes between different Gemini operations (pre_analysis, analysis, chat, etc.)
- `environment`: Separates production vs. emulator costs

These labels appear in BigQuery billing exports for automatic cost attribution and reconciliation with usage metrics.

### Cost Calculation

Costs are calculated using database-driven pricing configuration:

```typescript
// Gemini (token-based, with audio/text separation as of v2.2.0)
// Audio tokens (pre-analysis): $1/1M, Text tokens (transcript analysis): $0.30/1M
geminiCost =
  (audioInputTokens * audioInputPricePerMillion) / 1_000_000 +
  (textInputTokens * textInputPricePerMillion) / 1_000_000 +
  (outputTokens * outputPricePerMillion) / 1_000_000;

// Replicate (time-based, includes diarization)
whisperxCost = computeTimeSeconds * pricePerSecond;
```

Pricing is looked up by model and timestamp, supporting historical accuracy as prices change. As of v2.2.0, audio and text input tokens are tracked separately for more accurate cost calculation.

**Important**: For Replicate services (WhisperX), we use **actual GPU compute time** from `metrics.predict_time` in the prediction response, not wall-clock duration. Wall-clock time includes queue time (1-2s) and network latency (~10-15s overhead), which would inflate cost estimates by ~3-4x. The actual compute time accurately reflects what Replicate bills for.

### User Activity Tracking

Firestore triggers capture user activity:

```typescript
// On conversation create
onConversationCreated → recordUserEvent('conversation_created') → updateUserStats

// On conversation delete
onConversationDeleted → recordUserEvent('conversation_deleted') → updateUserStats

// On processing complete (in transcribe.ts)
recordUserEvent('processing_completed', { durationMs, estimatedCostUsd })
```

### Rolling Window Stats

User stats maintain three time windows:

- **Lifetime**: All-time totals
- **Last 7 Days**: Rolling week
- **Last 30 Days**: Rolling month

Rolling windows are recalculated during the scheduled aggregation job.

### Admin Dashboard

Five-tab interface for administrators:

1. **Overview**: Global stats cards, time-series charts (jobs, costs, usage)
2. **Users**: User list with drill-down to individual user metrics
3. **Jobs**: Processing history table with expandable details and drill-down to job detail view
4. **Chat**: Chat activity aggregated by conversation with pricing migration warnings
5. **Pricing**: View/add LLM pricing configurations

### Job Detail View

Accessed via `/admin/jobs/:metricId` when clicking a job row in the Jobs tab. Shows comprehensive job-level observability:

**Timing Breakdown:**

- Visual progress bars showing relative time spent in each phase
- Detailed millisecond-level timing for: download, WhisperX, segment building, Gemini analysis, speaker correction, transform, and Firestore write operations

**LLM Usage:**

- Per-call token counts for Gemini Analysis and Speaker Correction
- WhisperX compute time with direct links to Replicate predictions for billing verification
- Diarization compute time (if applicable)

**Pricing Snapshot:**

- Captured rates used at job execution time
- Enables historical cost verification even after pricing changes

**Cost Verification:**

- "Estimated vs Current" comparison using `CostVerificationBadge`
- Visual indicators: ✓ (green) for variance <1%, ⚠️ (yellow) for 1-5%, ❌ (red) for >5%
- Hover tooltip shows detailed variance breakdown

### Chat Metrics Tab

Aggregates chat queries by conversation, showing:

- Query count per conversation
- Total tokens (input/output breakdown)
- Average response time
- Total cost per conversation
- Last query timestamp

**Pricing Migration Warning:**

- Displayed when any chat metrics lack `pricingSnapshot` field
- Indicates billing reconciliation is not yet available for those queries
- Helps track rollout of pricing snapshot feature

### Cost Reconciliation Report

Accessible at `/admin/reports/cost-reconciliation`. Provides billing verification workflow:

**Period Summaries:**

- Weekly or monthly aggregation toggle
- Per-service breakdown (Gemini, WhisperX, Chat)
- Estimated vs recalculated cost comparison
- Variance highlighting (rows >5% variance shown in red)
- Status badges: ✓ Match, ⚠️ Minor, ❌ Significant

**Pricing Change Log:**

- All pricing configuration changes within the date range
- Effective dates and rate details
- Notes field for tracking why pricing changed

**CSV Export:**

- Finance-friendly export format
- Columns: Period, Service, Jobs, Estimated Cost, Recalculated Cost, Variance, Variance %
- Filename includes export date for tracking

**Variance Thresholds:**

- Match: <1% variance
- Minor: 1-5% variance (yellow)
- Significant: >5% variance (red)

### Cost Verification Badge

Reusable component that appears in:

- MetricsTable expanded rows
- Job Detail page cost comparison section

**Functionality:**

- Calls `recalculateCostWithCurrentPricing()` to compare stored cost against current pricing
- Memoized to avoid redundant computation
- Hover tooltip shows detailed breakdown: original cost, recalculated cost, variance amount and percentage
- Falls back gracefully when pricing snapshot is missing (older docs)

**Variance Calculation:**
For processing metrics:

```typescript
// Recalculate using current pricing
geminiCost = lookup(model).inputPrice * tokens...
whisperxCost = lookup(model).pricePerSecond * seconds...
variance = recalculatedCost - originalCost
variancePercent = (variance / originalCost) * 100
```

For chat metrics:

```typescript
chatCost =
  lookup(model).inputPrice * inputTokens +
  lookup(model).outputPrice * outputTokens;
variance = recalculatedCost - originalCost;
```

### User Stats Page

Personal usage statistics for all users:

- Lifetime totals (conversations, audio hours, estimated cost)
- 7-day and 30-day rolling windows
- Recent processing jobs table

**Pricing Accuracy Indicator:**

- Shows comparison of stored pricing snapshot vs current pricing configuration
- Visual badge: ✓ Match (<1%), ⚠️ Minor (1-5%), ❌ Significant (>5%)
- Displays timestamp when rates were captured
- Includes disclaimer about configured vs actual billing rates
- Admin users see link to detailed cost breakdown in admin dashboard

**Cost Display Centralization:**

- Inline cost indicators removed from upload/delete/abort modals
- Cost details consolidated in My Stats page for accuracy
- Prevents displaying ad-hoc cost guesses during active processing

Access: All authenticated users can view their own stats via "My Stats" in Library header.

### Scheduled Aggregation

The `computeGlobalStats` Cloud Function runs daily at 2 AM UTC:

1. Queries all `_user_stats` documents
2. Computes global totals and rolling windows
3. Recalculates user rolling windows from `_user_events`
4. Writes to `_global_stats/current` and `_daily_stats/{date}`

### Security Model

```javascript
// Admin-only collections
match /_metrics/{doc} { allow read: if isAdmin(); allow write: if false; }
match /_user_events/{doc} { allow read: if isAdmin(); allow write: if false; }
match /_global_stats/{doc} { allow read: if isAdmin(); allow write: if false; }
match /_daily_stats/{doc} { allow read: if isAdmin(); allow write: if false; }

// User stats - owner or admin
match /_user_stats/{userId} {
  allow read: if request.auth.uid == userId || isAdmin();
  allow write: if false;
}

// Pricing - anyone can read (for cost display), admin can write
match /_pricing/{pricingId} {
  allow read: if request.auth != null;
  allow write: if isAdmin();
}
```

## Offline Support

Firebase provides automatic offline persistence:

```typescript
const db = initializeFirestore(app, {
  cacheSizeBytes: 100 * 1024 * 1024, // 100MB
});
```

Behavior:

- Reads from cache first (instant)
- Writes queue locally, sync when online
- Real-time listeners work offline with cached data

## Performance Considerations

### Optimizations

1. **Real-time Listeners**: Firestore `onSnapshot` instead of polling
2. **Audio Streaming**: Signed URLs for direct streaming from Storage
3. **Lazy Loading**: Conversation content loaded on demand
4. **Drift Correction**: Timestamps scaled once on first load

### Bundle Size

| Module           | Size (gzipped) |
| ---------------- | -------------- |
| React + ReactDOM | ~45KB          |
| Firebase SDK     | ~35KB          |
| Application Code | ~25KB          |
| Tailwind CSS     | ~10KB          |

## Deployment Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   GitHub        │────▶│  GitHub Actions │
│   Repository    │     │  (CI/CD)        │
└─────────────────┘     └────────┬────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
                    ▼                         ▼
           ┌──────────────┐          ┌──────────────┐
           │  Cloud Run   │          │   Firebase   │
           │  (Frontend)  │          │  Functions   │
           │              │          │  + Rules     │
           └──────────────┘          └──────────────┘
                                            │
                                     ┌──────┴──────┐
                                     ▼             ▼
                              ┌──────────┐  ┌──────────┐
                              │ Gemini   │  │Replicate │
                              │ API      │  │WhisperX  │
                              └──────────┘  └──────────┘
```

**Parallel Deployment:** Frontend and Firebase Functions deploy simultaneously on merge to main.

## Google Cloud Infrastructure

### Vertex AI SDK Integration

The application uses the `@google-cloud/vertexai` SDK for Gemini API calls (migrated from `@google/generative-ai` to enable billing labels). Cloud Functions authenticate automatically using the default service account.

**Environment Variables:**

- `GCLOUD_PROJECT` or `GCP_PROJECT`: Auto-detected by Cloud Functions
- `VERTEX_AI_LOCATION`: Defaults to `us-central1` if not set

**Required IAM Permission:**

- The Cloud Functions service account (`PROJECT@appspot.gserviceaccount.com`) requires `roles/aiplatform.endpoints.predict` to call Vertex AI models.

**WhisperX Prediction Tracking:**

- `transcribeWithWhisperX()` and `transcribeWithWhisperXRobust()` both return `predictionId` from Replicate's predictions API
- Stored in `_metrics` documents for correlation with Replicate billing data
- Enables traceability and cost audit for WhisperX transcription jobs

### Required APIs

The application requires the following Google Cloud APIs:

| API                                 | Service             | Purpose                                                             |
| ----------------------------------- | ------------------- | ------------------------------------------------------------------- |
| `aiplatform.googleapis.com`         | Vertex AI           | Gemini API calls with billing labels                                |
| `cloudfunctions.googleapis.com`     | Cloud Functions     | Serverless function execution                                       |
| `cloudscheduler.googleapis.com`     | Cloud Scheduler     | Scheduled functions (daily stats aggregation)                       |
| `cloudbuild.googleapis.com`         | Cloud Build         | Build container images for functions                                |
| `artifactregistry.googleapis.com`   | Artifact Registry   | Store container images                                              |
| `run.googleapis.com`                | Cloud Run           | Functions v2 runtime (functions run as containers)                  |
| `eventarc.googleapis.com`           | Eventarc            | Route Storage events to Cloud Functions                             |
| `pubsub.googleapis.com`             | Pub/Sub             | Event message delivery (used by Eventarc)                           |
| `secretmanager.googleapis.com`      | Secret Manager      | Secure storage for REPLICATE_API_TOKEN and HUGGINGFACE_ACCESS_TOKEN |
| `firestore.googleapis.com`          | Firestore           | NoSQL database                                                      |
| `storage.googleapis.com`            | Cloud Storage       | Audio file storage                                                  |
| `iamcredentials.googleapis.com`     | IAM Credentials     | Workload Identity for CI/CD                                         |
| `cloudbilling.googleapis.com`       | Cloud Billing       | Project billing verification                                        |
| `firebaseextensions.googleapis.com` | Firebase Extensions | Firebase deployment features                                        |

### Cloud Functions v2 Event Pipeline

When an audio file is uploaded to Storage, this event pipeline triggers transcription:

```
┌──────────────────┐
│  Firebase        │
│  Storage         │
│  (audio upload)  │
└────────┬─────────┘
         │ onObjectFinalized event
         ▼
┌──────────────────┐     ┌──────────────────┐
│  Cloud Storage   │────▶│  Pub/Sub         │
│  Service Agent   │     │  (event message) │
│  @gs-project-    │     └────────┬─────────┘
│  accounts.iam    │              │
└──────────────────┘              ▼
                        ┌──────────────────┐
                        │  Eventarc        │
                        │  Service Agent   │
                        │  @gcp-sa-        │
                        │  eventarc.iam    │
                        └────────┬─────────┘
                                 │ routes to
                                 ▼
                        ┌──────────────────┐
                        │  Cloud Run       │
                        │  (Functions v2)  │
                        │                  │
                        │  transcribeAudio │
                        └────────┬─────────┘
                                 │ calls
                                 ▼
                        ┌──────────────────┐
                        │  Secret Manager  │
                        │  REPLICATE_TOKEN │
                        │  HUGGINGFACE_    │
                        │  ACCESS_TOKEN    │
                        └────────┬─────────┘
                                 │
                        ┌────────┴────────┐
                        ▼                 ▼
                ┌──────────────┐  ┌──────────────┐
                │  Vertex AI   │  │  Replicate   │
                │  (Gemini)    │  │  (WhisperX)  │
                └──────┬───────┘  └──────┬───────┘
                       │                 │
                       └────────┬────────┘
                                │
                                ▼
                        ┌──────────────────┐
                        │  alignment.ts    │
                        │  (HARDY match)   │
                        └────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │  Firestore       │
                        │  (save results)  │
                        └──────────────────┘
```

### Service Accounts

#### User-Managed Service Accounts

| Service Account                                       | Purpose                 | Key Roles                                                                          |
| ----------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `firebase-adminsdk-*@PROJECT.iam.gserviceaccount.com` | CI/CD deployment        | Cloud Functions Admin, Cloud Scheduler Admin, Secret Manager Admin, Firebase Admin |
| `PROJECT@appspot.gserviceaccount.com`                 | Cloud Functions runtime | Secret Manager Secret Accessor (auto-granted)                                      |

#### Google-Managed Service Agents

These are automatically created and managed by Google Cloud:

| Service Agent | Format                                                            | Purpose                               | Required Role                                       |
| ------------- | ----------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------- |
| Storage       | `service-PROJECT_NUM@gs-project-accounts.iam.gserviceaccount.com` | Publish storage events                | `roles/pubsub.publisher`                            |
| Pub/Sub       | `service-PROJECT_NUM@gcp-sa-pubsub.iam.gserviceaccount.com`       | Create auth tokens for event delivery | `roles/iam.serviceAccountTokenCreator`              |
| Eventarc      | `service-PROJECT_NUM@gcp-sa-eventarc.iam.gserviceaccount.com`     | Read storage bucket metadata          | `objectViewer` on bucket                            |
| Compute       | `PROJECT_NUM-compute@developer.gserviceaccount.com`               | Invoke Cloud Run, receive events      | `roles/run.invoker`, `roles/eventarc.eventReceiver` |

### IAM Role Dependencies

```
                    ┌─────────────────────────────────┐
                    │         GitHub Actions          │
                    │    (FIREBASE_SERVICE_ACCOUNT)   │
                    └───────────────┬─────────────────┘
                                    │ authenticates as
                                    ▼
┌───────────────────────────────────────────────────────────────────┐
│                    firebase-adminsdk-* SA                         │
├───────────────────────────────────────────────────────────────────┤
│  roles/cloudfunctions.admin    → deploy functions                 │
│  roles/cloudscheduler.admin    → manage scheduled functions       │
│  roles/firebaserules.admin     → deploy security rules            │
│  roles/firebase.admin          → Firebase Extensions API          │
│  roles/storage.admin           → manage Storage                   │
│  roles/datastore.user          → read/write Firestore             │
│  roles/iam.serviceAccountUser  → act as runtime SA                │
│  roles/secretmanager.admin     → manage secrets, grant access     │
└───────────────────────────────────────────────────────────────────┘
                                    │
                                    │ grants access to
                                    ▼
┌───────────────────────────────────────────────────────────────────┐
│                    PROJECT@appspot.gserviceaccount.com            │
│                         (Runtime SA)                              │
├───────────────────────────────────────────────────────────────────┤
│  roles/secretmanager.secretAccessor → read GEMINI_API_KEY,        │
│                                         REPLICATE_API_TOKEN       │
│  (auto-granted by Firebase during deployment)                     │
└───────────────────────────────────────────────────────────────────┘
```

### CI/CD Pipeline Flow

```
┌──────────────┐    ┌──────────────┐
│   GitHub     │    │   GitHub     │
│   Push/PR    │───▶│   Actions    │
└──────────────┘    └──────┬───────┘
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
┌─────────────────────────┐  ┌─────────────────────────┐
│   deploy-frontend       │  │ deploy-firebase-        │
│                         │  │ functions               │
│  Cloud Build → GCR      │  │                         │
│  → Cloud Run deploy     │  │  npm ci → npm build     │
│  → Health check         │  │  → firebase deploy      │
│                         │  │    --only functions     │
└─────────────────────────┘  └─────────────────────────┘
        │                            │
        ▼                            ▼
┌─────────────────────────┐  ┌─────────────────────────┐
│  Cloud Run (Frontend)   │  │  Firebase Functions     │
│  - React SPA            │  │  - transcribeAudio      │
│  - Static assets        │  │  - processTranscription │
└─────────────────────────┘  │  - alignment.ts (HARDY) │
                             └─────────────────────────┘
```

**Parallel Execution:** Both jobs run simultaneously (~3-4 min total).

## Related Documentation

- [Data Model](data-model.md) - Firestore schema and types
- [Design Decisions](../explanation/design-decisions.md) - Why we built it this way
- [Firebase Setup](../how-to/firebase-setup.md) - Configuration guide
