# Data Model Reference

Firestore schema and TypeScript type definitions.

## Firestore Collections

### conversations

Primary collection storing conversation data.

**Path**: `conversations/{conversationId}`

```typescript
interface ConversationDoc {
  // Identity
  conversationId: string;
  userId: string;           // Firebase Auth UID
  title: string;

  // Timestamps
  createdAt: Timestamp;
  updatedAt: Timestamp;

  // Audio
  durationMs: number;
  audioStoragePath: string; // Firebase Storage path

  // Processing Status (Queue-Driven Architecture)
  status: 'queued' | 'processing' | 'merging' | 'reprocessing' | 'complete' | 'failed' | 'aborted';
  processingError?: string;

  // Processing Timestamps (Queue-Driven Architecture)
  queuedAt?: Timestamp;           // When Cloud Task was enqueued
  processingStartedAt?: Timestamp; // When processTranscription began

  // Alignment Status
  alignmentStatus?: 'pending' | 'aligned' | 'fallback';
  alignmentError?: string;      // Reason for fallback if applicable

  // Processing Mode (Chunked Uploads)
  processingMode?: 'parallel' | 'sequential';  // Controls chunk execution strategy

  // Speaker Reconciliation (Parallel Mode Only)
  reconciliationConfidence?: number;           // Overall confidence (0-1) of speaker matching
  reconciliationDetails?: ReconciliationDetails; // Detailed match evidence per cluster
  reconciliationMetadata?: ReconciliationMetadata; // Extended observability (signals, durations)

  // Fallback Metadata (Parallel → Sequential Fallback)
  fallbackMetadata?: FallbackMetadata;         // Present if fallback was triggered

  // Abort Control
  abortRequested?: boolean;     // User requested processing stop

  // Analysis Results
  speakers: Record<string, Speaker>;
  segments: Segment[];
  terms: Record<string, Term>;
  termOccurrences: TermOccurrence[];
  topics: Topic[];
  people: Person[];
}
```

**Processing Status Flow:**
1. `queued` - Audio uploaded, Cloud Task enqueued (set by `transcribeAudio`)
2. `processing` - Heavy processing started (set by `processTranscription`)
3. `merging` - Chunk processing complete, merge in progress (large files only)
4. `reprocessing` - Parallel fallback triggered, sequential reprocessing in progress
5. `complete` - Processing succeeded
6. `failed` - Processing failed (may retry via Cloud Tasks)
7. `aborted` - User cancelled processing

**New Timestamps:**
- `queuedAt` - Set when `transcribeAudio` enqueues the Cloud Task
- `processingStartedAt` - Set when `processTranscription` begins actual processing

#### conversations/{conversationId}/chatHistory (subcollection)

Chat message history for conversation chat feature. Provides persistent, synchronized chat across devices.

**Path**: `conversations/{conversationId}/chatHistory/{messageId}`

```typescript
interface ChatHistoryDoc {
  role: 'user' | 'assistant';
  content: string;
  sources?: Array<{              // Timestamp citations (assistant messages only)
    segmentId: string;
    startMs: number;
    endMs: number;
    speaker: string;
    text: string;
  }>;
  costUsd?: number;              // AI processing cost (assistant messages only)
  isUnanswerable?: boolean;      // True if LLM couldn't answer (assistant messages only)
  createdAt: Timestamp;          // Server timestamp
}
```

**Features**:
- Real-time synchronization across devices
- Pagination support (load older messages in batches of 10)
- 50 message limit per conversation (enforced client-side)
- Immutable messages (no updates after creation)
- Export to JSON for data portability
- Deleted when parent conversation is deleted

**Security**: Users can only access chat history for conversations they own. Messages are immutable (no updates allowed).

#### conversations/{conversationId}/speakerCorrections (subcollection)

Manual speaker merge operations. Users can merge incorrectly diarized speakers from the UI (e.g., "Speaker 2" is actually "Tom"). Corrections are applied at read time - original data remains immutable.

**Path**: `conversations/{conversationId}/speakerCorrections/{correctionId}`

```typescript
interface SpeakerCorrectionDoc {
  type: 'merge';                 // Correction type (future: 'split', 'rename', etc.)
  sourceSpeakerId: string;       // Speaker being merged away (removed from speaker list)
  targetSpeakerId: string;       // Speaker to merge into (all source segments reassigned)
  userId: string;                // User who created the correction
  createdAt: Timestamp;          // Server timestamp
}
```

**Apply-on-Read Pattern**:
- Corrections are NOT applied to the stored conversation data
- Client applies corrections in order when loading conversation:
  1. Load original speakers and segments from conversation document
  2. Load corrections from subcollection (ordered by createdAt)
  3. For each merge correction:
     - Remove sourceSpeakerId from speaker list
     - Remap all segments from sourceSpeakerId to targetSpeakerId
  4. Display corrected data to user

**Undo Support**:
- Delete the most recent correction document to undo
- Client re-applies remaining corrections on next read
- Full correction history is preserved (cannot undo individual merges from middle of sequence)

**Features**:
- Real-time synchronization (Firestore listener)
- Persists across reloads and devices
- 3-click workflow: Click merge button → Select target speaker → Confirm
- Non-destructive (original data unchanged)
- Audit trail for debugging diarization issues

**Security**:
- Users can only read/delete corrections for conversations they own
- Corrections are created via Cloud Function (not directly by client)
- Immutable once created (no updates allowed)

### users

User profile, preferences, and admin status.

**Path**: `users/{userId}`

```typescript
interface UserDoc {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  createdAt: Timestamp;
  isAdmin?: boolean;      // Grants access to admin dashboard
  preferences?: {
    theme?: 'light' | 'dark';
  };
}
```

**Note**: The `isAdmin` field must be manually set in Firestore to grant admin access. There is no self-service admin enrollment.

### _metrics

Processing metrics for observability (admin read-only). Tracks detailed processing statistics, LLM usage, and estimated costs. Supports both transcription jobs and chat queries (discriminated by `type` field).

**Path**: `_metrics/{docId}`

**Transcription Metrics**:
```typescript
interface TranscriptionMetricsDoc {
  type?: 'transcription';  // Optional for backward compatibility (absence implies transcription)
  conversationId: string;
  userId: string;
  status: 'success' | 'failed';
  errorMessage?: string;
  alignmentStatus?: 'aligned' | 'fallback';

  // Stage timings (milliseconds)
  timingMs: {
    download: number;      // Audio download from Storage
    whisperx: number;      // WhisperX transcription + diarization
    buildSegments: number; // Segment construction
    gemini: number;        // Gemini analysis (topics, terms, etc.)
    speakerCorrection: number; // Gemini speaker reassignment
    transform: number;     // Data transformation
    firestore: number;     // Firestore write
    total: number;         // Total processing time
  };

  // Result counts
  segmentCount: number;
  speakerCount: number;
  termCount: number;
  topicCount: number;
  personCount: number;
  speakerCorrectionsApplied: number;

  // Audio metadata
  audioSizeMB: number;
  durationMs: number;

  // LLM Usage (added in observability system)
  // Audio/text token separation added in v2.2.0 for accurate cost calculation
  llmUsage?: {
    geminiAnalysis: {
      inputTokens: number;           // Total input tokens (backward compat)
      audioInputTokens?: number;     // Tokens from audio input (pre-analysis)
      textInputTokens?: number;      // Tokens from text input (transcript analysis)
      outputTokens: number;
      model: string;
    };
    geminiSpeakerCorrection: {
      inputTokens: number;           // Total input tokens (backward compat)
      audioInputTokens?: number;     // Tokens from audio input (always 0 for corrections)
      textInputTokens?: number;      // Tokens from text input
      outputTokens: number;
      model: string;
    };
    whisperx: {
      predictionId?: string;  // Replicate prediction ID for cost traceability
      computeTimeSeconds: number;  // Actual GPU compute time from Replicate metrics.predict_time (not wall-clock)
      model: string;  // 'whisperx-diarization' - includes speaker diarization
    };
    // Note: diarization field removed in v2.2.0 - now bundled with whisperx
  };

  // Gemini billing labels for cost attribution (added with Vertex AI migration)
  // Array of label objects from each Gemini API call (pre-analysis, analysis, speaker ID, speaker correction)
  // Maps to BigQuery billing exports for automatic cost reconciliation
  geminiLabels?: Array<{
    conversation_id: string;
    user_id: string;
    call_type: 'pre_analysis' | 'fallback_transcription' | 'analysis' | 'speaker_identification' | 'speaker_correction';
    environment: string;  // 'production' | 'development'
  }>;

  // Estimated costs (calculated from _pricing collection)
  // Schema updated in v2.2.0: removed diarizationUsd (bundled with whisperx), added audio/text breakdown
  estimatedCost?: {
    geminiUsd: number;              // Combined Gemini costs (backward compat)
    geminiAudioInputUsd?: number;   // Gemini audio input cost ($1/1M tokens)
    geminiTextInputUsd?: number;    // Gemini text input cost ($0.30/1M tokens)
    geminiOutputUsd?: number;       // Gemini output cost
    whisperxUsd: number;            // WhisperX compute cost (includes diarization)
    totalUsd: number;
  };

  // Actual cost from BigQuery billing exports (added in v2.2.0)
  // Populated by billingSync Cloud Function running daily at 4 AM UTC
  actualCost?: {
    geminiUsd: number;          // Actual Gemini/Vertex AI cost from BigQuery
    fetchedAt: Timestamp;       // When this data was fetched
    source: 'bigquery_billing_export';
  };

  // Pricing snapshot for billing reconciliation (added for cost visibility)
  // Captures the exact rates used so costs can be audited even after price changes
  // Schema updated in v2.2.0: removed diarization fields, added audio/text rates
  pricingSnapshot?: {
    capturedAt: Timestamp;            // When the pricing was looked up
    geminiPricingId: string | null;   // _pricing doc ID used, or null if not configured
    whisperxPricingId: string | null;
    rates: {
      geminiInputPerMillion: number;       // Backward compat (text input rate)
      geminiAudioInputPerMillion?: number; // Audio input rate ($1/1M)
      geminiTextInputPerMillion?: number;  // Text input rate ($0.30/1M)
      geminiOutputPerMillion: number;      // USD per 1M output tokens
      whisperxPerSecond: number;           // USD per compute second (includes diarization)
    };
  };

  // Timestamp
  timestamp: Timestamp;
}
```

**Chat Metrics**:
```typescript
interface ChatMetricsDoc {
  type: 'chat';  // Required discriminator
  conversationId: string;
  userId: string;
  queryType: 'question' | 'follow_up';  // Heuristic-based classification

  // Token usage
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    model: string;  // e.g., 'gemini-2.5-flash'
  };

  // Cost and performance
  costUsd: number;              // Estimated cost for this query
  responseTimeMs: number;       // Total request processing time

  // Response quality
  sourcesCount: number;         // Number of validated timestamp sources
  isUnanswerable: boolean;      // Whether LLM indicated question was unanswerable

  // Gemini billing labels for cost attribution (added with Vertex AI migration)
  // Single label object for this chat query
  // Maps to BigQuery billing exports for automatic cost reconciliation
  geminiLabels?: {
    conversation_id: string;
    user_id: string;
    call_type: 'chat';
    environment: string;  // 'production' | 'development'
  };

  // Pricing info for billing reconciliation (added for cost visibility)
  pricingId?: string | null;    // _pricing doc ID used, or null if default
  pricingSnapshot?: {
    capturedAt: Timestamp;
    inputPricePerMillion: number;
    outputPricePerMillion: number;
  };

  // Timestamp
  timestamp: Timestamp;
}
```

**Security**: Only Cloud Functions can write to `_metrics`. Only admin users can read.

### _user_events

User activity events for audit trail and analytics.

**Path**: `_user_events/{eventId}`

```typescript
interface UserEventDoc {
  eventType: 'conversation_created' | 'conversation_deleted' | 'processing_completed' | 'processing_failed';
  userId: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;  // e.g., { durationMs, estimatedCostUsd }
  timestamp: Timestamp;
}
```

**Security**: Only Cloud Functions can write. Only admin users can read.

### _user_stats

Pre-computed user aggregates with lifetime totals and rolling windows.

**Path**: `_user_stats/{userId}`

```typescript
interface UserStatsDoc {
  userId: string;

  lifetime: {
    conversationsCreated: number;
    conversationsDeleted: number;
    conversationsExisting: number;  // created - deleted
    jobsSucceeded: number;
    jobsFailed: number;
    audioHoursProcessed: number;
    estimatedCostUsd: number;
    totalAudioFiles: number;
  };

  last7Days: {
    conversationsCreated: number;
    conversationsDeleted: number;
    jobsSucceeded: number;
    jobsFailed: number;
    audioHoursProcessed: number;
    estimatedCostUsd: number;
  };

  last30Days: {
    conversationsCreated: number;
    conversationsDeleted: number;
    jobsSucceeded: number;
    jobsFailed: number;
    audioHoursProcessed: number;
    estimatedCostUsd: number;
  };

  firstActivityAt: Timestamp;
  lastActivityAt: Timestamp;
  updatedAt: Timestamp;
}
```

**Security**: Users can read their own stats. Admin users can read all. Only Cloud Functions can write.

### _global_stats

System-wide aggregates for admin dashboard.

**Path**: `_global_stats/current`

```typescript
interface GlobalStatsDoc {
  users: {
    totalUsers: number;
    activeUsersLast7Days: number;
    activeUsersLast30Days: number;
  };

  processing: {
    totalJobsAllTime: number;
    successRate: number;  // 0-100
    avgProcessingTimeMs: number;
    totalAudioHoursProcessed: number;
  };

  llmUsage: {
    totalGeminiInputTokens: number;
    totalGeminiOutputTokens: number;
    totalWhisperXComputeSeconds: number;
    estimatedTotalCostUsd: number;
  };

  conversations: {
    totalConversationsCreated: number;
    totalConversationsDeleted: number;
    totalConversationsExisting: number;
  };

  lastUpdatedAt: Timestamp;
  computedAt: string;  // ISO timestamp
}
```

**Security**: Only admin users can read. Only Cloud Functions can write.

### _daily_stats

Time-series data for admin charts.

**Path**: `_daily_stats/{YYYY-MM-DD}`

```typescript
interface DailyStatsDoc {
  date: string;  // YYYY-MM-DD
  activeUsers: number;
  newUsers: number;
  conversationsCreated: number;
  conversationsDeleted: number;
  jobsSucceeded: number;
  jobsFailed: number;
  audioHoursProcessed: number;
  geminiTokensUsed: number;
  whisperXComputeSeconds: number;
  estimatedCostUsd: number;
  avgProcessingTimeMs: number;
  createdAt: Timestamp;
}
```

**Security**: Only admin users can read. Only Cloud Functions can write.

### _pricing

LLM pricing configuration for cost estimation.

**Path**: `_pricing/{pricingId}`

**IMPORTANT (v2.2.0+)**: Pricing configuration is **required**. If pricing records are missing, costs will calculate as $0 with warnings logged. There are no longer default fallback values.

**Required pricing records**:
- `gemini-2.5-flash` - Audio input pricing (inputPricePerMillion for audio, outputPricePerMillion)
- `gemini-2.5-flash-text` - Text input pricing (inputPricePerMillion for text)
- `whisperx` - Compute time pricing (pricePerSecond) - includes diarization

```typescript
interface PricingDoc {
  model: string;  // 'gemini-2.5-flash', 'gemini-2.5-flash-text', 'whisperx'
  service: 'gemini' | 'replicate';

  // Token-based pricing (for Gemini)
  inputPricePerMillion?: number;   // USD per 1M input tokens
  outputPricePerMillion?: number;  // USD per 1M output tokens

  // Time-based pricing (for Replicate/WhisperX)
  pricePerSecond?: number;         // USD per compute second

  // Validity period
  effectiveFrom: Timestamp;        // Start date (inclusive)
  effectiveUntil?: Timestamp;      // End date (exclusive), null = current

  // Metadata
  notes?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

**Example pricing documents**:
```json
// gemini-2.5-flash (audio input)
{
  "model": "gemini-2.5-flash",
  "service": "gemini",
  "inputPricePerMillion": 1.00,     // $1/1M for audio tokens
  "outputPricePerMillion": 2.50,    // $2.50/1M for output tokens
  "effectiveFrom": "2026-01-01T00:00:00Z"
}

// gemini-2.5-flash-text (text input)
{
  "model": "gemini-2.5-flash-text",
  "service": "gemini",
  "inputPricePerMillion": 0.30,     // $0.30/1M for text tokens
  "effectiveFrom": "2026-01-01T00:00:00Z"
}

// whisperx (includes diarization)
{
  "model": "whisperx",
  "service": "replicate",
  "pricePerSecond": 0.0023,         // ~$0.14/min
  "effectiveFrom": "2026-01-01T00:00:00Z"
}
```

**Security**: All authenticated users can read (for cost display). Only admin users can write.

### _chat_rate_limits

Rate limiting storage for chat queries to prevent abuse.

**Path**: `_chat_rate_limits/{conversationId}_{userId}_{YYYY-MM-DD}`

```typescript
interface ChatRateLimitDoc {
  conversationId: string;
  userId: string;
  dateBucket: string;              // YYYY-MM-DD in UTC
  queryCount: number;              // Number of queries made today
  firstQueryAt: Timestamp;         // First query of the day
  lastQueryAt: Timestamp;          // Most recent query
}
```

**Design**: Uses composite document ID to avoid Firestore hot spots. Each user/conversation/day combination gets its own document, allowing distributed writes. Rate limit resets daily at midnight UTC.

**Limit**: 20 queries per conversation per day per user.

**Security**: Only Cloud Functions can read/write (implicit - no client access needed).

## TypeScript Types

### Conversation

```typescript
interface Conversation {
  conversationId: string;
  userId: string;
  title: string;
  createdAt: string;          // ISO timestamp
  updatedAt: string;          // ISO timestamp
  durationMs: number;
  audioUrl?: string;          // Temporary signed URL
  status: 'queued' | 'processing' | 'complete' | 'failed' | 'aborted';
  alignmentStatus?: 'pending' | 'aligned' | 'fallback';
  alignmentError?: string;    // Reason for fallback
  processingMode?: 'parallel' | 'sequential';  // Chunk execution strategy
  reconciliationConfidence?: number;  // Speaker matching confidence (parallel mode)
  reconciliationDetails?: ReconciliationDetails;  // Match evidence (parallel mode)
  queuedAt?: string;          // ISO timestamp when Cloud Task enqueued
  processingStartedAt?: string; // ISO timestamp when processing began
  speakers: Record<string, Speaker>;
  segments: Segment[];
  terms: Record<string, Term>;
  termOccurrences: TermOccurrence[];
  topics: Topic[];
  people: Person[];
}
```

**Processing Mode Values:**
- `'parallel'` (default): Chunks process independently and concurrently. Faster for long files, but requires speaker reconciliation at merge time. Best for most use cases.
- `'sequential'`: Chunks wait for predecessor to complete before starting. Slower but maintains consistent speaker IDs across chunks without reconciliation.

**Speaker Reconciliation Metadata (parallel mode only):**
- `reconciliationConfidence`: Overall confidence score (0-1) for speaker matching. Minimum of all cluster confidences.
- `reconciliationDetails`: Detailed evidence for how speakers were matched (see `ReconciliationDetails` below).

### Speaker

```typescript
interface Speaker {
  speakerId: string;
  displayName: string;        // User-editable name
  colorIndex: number;         // Index into color palette
}
```

### Segment

```typescript
interface Segment {
  segmentId: string;
  index: number;              // Order in transcript
  speakerId: string;
  startMs: number;            // Start time in milliseconds
  endMs: number;              // End time in milliseconds
  text: string;
}
```

### Term

```typescript
interface Term {
  termId: string;
  key: string;                // Normalized term (lowercase)
  display: string;            // Display form
  definition: string;         // AI-generated explanation
  aliases: string[];          // Alternative forms
}
```

### TermOccurrence

```typescript
interface TermOccurrence {
  termId: string;
  segmentId: string;
  startChar: number;          // Character offset in segment
  endChar: number;
}
```

### Topic

```typescript
interface Topic {
  topicId: string;
  label: string;              // Topic title
  startsAfterSegmentIndex: number;
  isTangent: boolean;         // Whether this is a digression
}
```

### Person

```typescript
interface Person {
  personId: string;
  name: string;               // Person's name
  affiliation?: string;       // Company, role, etc.
  userNotes?: string;         // User-added notes
}
```

### PersonOccurrence

Computed at runtime (not stored):

```typescript
interface PersonOccurrence {
  personId: string;
  segmentId: string;
  startChar: number;
  endChar: number;
}
```

### ProcessingStep

Enum representing granular processing stages:

```typescript
enum ProcessingStep {
  PENDING = 'pending',         // Waiting to start
  UPLOADING = 'uploading',     // Audio uploading to Storage
  TRANSCRIBING = 'transcribing', // WhisperX transcription
  ANALYZING = 'analyzing',     // Gemini analysis (terms, topics, people)
  ALIGNING = 'aligning',       // WhisperX timestamp alignment
  FINALIZING = 'finalizing',   // Writing results to Firestore
  COMPLETE = 'complete',       // Processing finished successfully
  FAILED = 'failed'            // Processing failed with error
}
```

### StepMeta

Metadata for enhanced UI display of processing steps:

```typescript
interface StepMeta {
  label: string;              // Human-readable step name (e.g., "Transcribing Audio")
  description?: string;       // Optional detailed description of current activity
  category: 'pending' | 'active' | 'success' | 'error';  // Visual state category
}
```

**Category Values:**
- `'pending'` - Step not yet started (gray/muted styling)
- `'active'` - Step currently in progress (blue/animated styling)
- `'success'` - Step completed successfully (green/check styling)
- `'error'` - Step failed with error (red/warning styling)

### ProcessingProgress

Real-time processing status for user feedback:

```typescript
interface ProcessingProgress {
  currentStep: ProcessingStep;       // Current processing stage
  percentComplete: number;           // 0-100 progress percentage
  stepStartedAt?: string;            // ISO timestamp when current step began
  estimatedRemainingMs?: number;     // Estimated time to completion
  errorMessage?: string;             // Error details if failed
  stepMeta?: StepMeta;               // Optional metadata for enhanced UI feedback
}
```

**Backward Compatibility Note:** The `stepMeta` field is optional to maintain compatibility with existing conversations created before this feature was added. Legacy data will have `stepMeta: undefined`, and UI components should gracefully handle this case by falling back to default display behavior based on `currentStep`.

**Example JSON:**
```json
{
  "currentStep": "analyzing",
  "percentComplete": 65,
  "stepStartedAt": "2025-01-15T14:30:00.000Z",
  "estimatedRemainingMs": 45000,
  "stepMeta": {
    "label": "Analyzing Content",
    "description": "Extracting topics, terms, and identifying speakers...",
    "category": "active"
  }
}
```

### ProcessingTimeline

Timeline tracking for performance analysis and debugging:

```typescript
interface ProcessingTimeline {
  stepName: ProcessingStep;   // Which step this entry represents
  startedAt: string;          // ISO timestamp when step started
  completedAt?: string;       // ISO timestamp when step completed (absent if in-progress)
  durationMs?: number;        // Duration in milliseconds (computed when completedAt is set)
}
```

### ReconciliationDetails

Speaker reconciliation metadata for parallel chunk processing:

```typescript
interface ReconciliationDetails {
  clusterCount: number;        // Number of canonical speakers created
  originalSpeakerCount: number; // Total speakers across all chunks
  clusters: Array<{
    canonicalId: string;       // Canonical speaker ID (e.g., "speaker_canonical_0")
    originalIds: string[];     // Original speaker IDs merged into this cluster
    confidence: number;        // Cluster confidence (0-1)
    displayName: string;       // Best display name from cluster
    matchEvidence: {
      nameMatches: number;     // Number of name-based matches
      topicOverlap: number;    // Average topic overlap score
      termOverlap: number;     // Average term overlap score
    };
  }>;
}
```

**Purpose**: Provides transparency into how speakers were matched across chunks in parallel mode. Includes confidence scores and match evidence for debugging and quality assessment.

**When present**: Only for conversations processed in parallel mode with multiple chunks. Sequential mode doesn't need reconciliation since speaker IDs are consistent across chunks.

### ReconciliationMetadata

Extended observability data for speaker reconciliation:

```typescript
interface ReconciliationMetadata {
  signalsUsed: string[];           // Matching signals used: ['name', 'topic', 'term'] or ['embeddings']
  fallbackTriggered: boolean;      // True if fallback to sequential occurred
  speakerMatchConfidences: Array<{
    canonicalId: string;
    confidence: number;            // Per-speaker confidence (0-1)
  }>;
  reconciliationDurationMs?: number; // Processing time for reconciliation phase

  // Singleton detection and adaptive relaxation (embedding reconciliation only)
  singletonRatio?: number;         // Singleton clusters / total clusters (0-1)
  singletonCount?: number;         // Number of singleton clusters
  estimatedUniqueSpeakers?: number; // Heuristic estimate of unique speakers
  relaxationTriggered?: boolean;   // Whether adaptive threshold relaxation was triggered
  finalEdgeThreshold?: number;     // Final edge threshold after relaxation
  relaxationIterations?: number;   // Number of relaxation iterations performed
}
```

**Purpose**: Provides performance and signal data for reconciliation monitoring. Helps identify slow reconciliations and track which signals contributed to matches.

**Singleton Detection** (embedding reconciliation only):
- **singletonRatio**: Percentage of clusters with only 1 member (indicates over-fragmentation if >40%)
- **singletonCount**: Absolute count of singleton clusters
- **estimatedUniqueSpeakers**: Conservative heuristic (max unique speakers in any chunk)

**Adaptive Relaxation** (embedding reconciliation only):
When singleton ratio >40%, the system automatically relaxes clustering thresholds to reduce over-fragmentation:
- **relaxationTriggered**: Whether relaxation was needed
- **finalEdgeThreshold**: Edge threshold after relaxation (starts at base, relaxes by 0.05 steps, floor: 0.45)
- **relaxationIterations**: Number of relaxation loops (max: 3)

These metrics enable operators to monitor clustering quality and identify conversations with potential speaker fragmentation issues.

### FallbackMetadata

Metadata stored when parallel processing falls back to sequential:

```typescript
type FallbackReason = 'low_speaker_confidence' | 'reconciliation_error';

interface FallbackMetadata {
  triggeredAt: string;             // ISO timestamp when fallback was triggered
  parallelConfidence: number;      // Confidence score that triggered fallback
  archiveId: string;               // Path to archived parallel chunks
  reason: FallbackReason;          // Why fallback occurred
  parallelDurationMs?: number;     // How long the parallel attempt took
  sequentialDurationMs?: number;   // Populated after sequential completes
  configuredThreshold: number;     // CONFIDENCE_THRESHOLD at time of trigger
}
```

**Purpose**: Provides audit trail for fallback events. Enables:
- Debugging why fallback occurred (confidence vs threshold)
- Accessing archived parallel chunks for post-mortem analysis
- Measuring processing time difference between parallel and sequential
- Tracking threshold configuration at time of trigger

**When present**: Only on conversations where fallback to sequential was triggered. Can query `fallbackMetadata.triggeredAt IS NOT NULL` to find all fallback occurrences.

## Firebase Storage Structure

```
audio/
└── {userId}/
    └── {conversationId}.{ext}
```

**Example**: `audio/abc123/conv-456.mp3`

### Storage Rules

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /audio/{userId}/{fileName} {
      allow read, write: if request.auth != null
        && request.auth.uid == userId;

      // Max file size: 100MB
      allow write: if request.resource.size < 100 * 1024 * 1024;

      // Only audio/video files
      allow write: if request.resource.contentType.matches('audio/.*')
        || request.resource.contentType.matches('video/.*');
    }
  }
}
```

## Firestore Security Rules

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Helper: Check if user is admin
    function isAdmin() {
      return request.auth != null &&
        exists(/databases/$(database)/documents/users/$(request.auth.uid)) &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.isAdmin == true;
    }

    match /users/{userId} {
      allow read, write: if request.auth != null
        && request.auth.uid == userId;
    }

    match /conversations/{conversationId} {
      // Read: must be owner
      allow read: if request.auth != null
        && resource.data.userId == request.auth.uid;

      // Create: must set userId to own uid
      allow create: if request.auth != null
        && request.resource.data.userId == request.auth.uid;

      // Update: must be owner
      allow update: if request.auth != null
        && resource.data.userId == request.auth.uid;

      // Delete: must be owner
      allow delete: if request.auth != null
        && resource.data.userId == request.auth.uid;

      // Chat history subcollection
      match /chatHistory/{messageId} {
        // Read: must own parent conversation
        allow read: if request.auth != null
          && get(/databases/$(database)/documents/conversations/$(conversationId)).data.userId == request.auth.uid;

        // Create: must own parent conversation
        allow create: if request.auth != null
          && get(/databases/$(database)/documents/conversations/$(conversationId)).data.userId == request.auth.uid;

        // Delete: must own parent conversation (for clear history)
        allow delete: if request.auth != null
          && get(/databases/$(database)/documents/conversations/$(conversationId)).data.userId == request.auth.uid;
      }
    }

    // Metrics collection - admin read only, Cloud Functions write only
    match /_metrics/{doc} {
      allow read: if isAdmin();
      allow write: if false;  // Only Cloud Functions can write
    }

    // User events - admin read only, Cloud Functions write
    match /_user_events/{eventId} {
      allow read: if isAdmin();
      allow write: if false;
    }

    // User stats - owner or admin can read, Cloud Functions write
    match /_user_stats/{userId} {
      allow read: if request.auth.uid == userId || isAdmin();
      allow write: if false;
    }

    // Global stats - admin read only, Cloud Functions write
    match /_global_stats/{docId} {
      allow read: if isAdmin();
      allow write: if false;
    }

    // Daily stats - admin read only, Cloud Functions write
    match /_daily_stats/{dateId} {
      allow read: if isAdmin();
      allow write: if false;
    }

    // Pricing - anyone can read, admin can write
    match /_pricing/{pricingId} {
      allow read: if request.auth != null;
      allow write: if isAdmin();
    }
  }
}
```

## Firestore Indexes

```json
{
  "indexes": [
    {
      "collectionGroup": "conversations",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "userId", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    }
  ]
}
```

**Search Functionality Note**: The full-text search feature (added in search_discovery_scope_02) runs entirely client-side and does **not** require additional Firestore indexes. Search operates on conversations already loaded into the client from the existing `userId` + `createdAt` index. All matching, ranking, and snippet extraction happens in the browser using `services/searchService.ts`.

## Service API

### FirestoreService

```typescript
interface FirestoreService {
  // Subscribe to user's conversations (real-time)
  subscribeToUserConversations(
    userId: string,
    callback: (conversations: Conversation[]) => void
  ): () => void;  // Returns unsubscribe function

  // Save conversation
  save(conversation: Conversation): Promise<void>;

  // Update conversation
  update(conversation: Partial<Conversation>): Promise<void>;

  // Delete conversation
  delete(conversationId: string): Promise<void>;

  // Get single conversation
  getById(conversationId: string): Promise<Conversation | null>;
}
```

### StorageService

```typescript
interface StorageService {
  // Upload audio file
  uploadAudio(
    userId: string,
    conversationId: string,
    file: File
  ): Promise<string>;  // Returns storage path

  // Get signed download URL
  getAudioUrl(storagePath: string): Promise<string>;

  // Delete audio file
  deleteAudio(storagePath: string): Promise<void>;
}
```

## Cloud Function Schemas

### transcribeAudio (Storage Trigger)

**Trigger**: `onObjectFinalized` on `audio/{userId}/{fileName}`

**Process**:
1. Download audio from Storage
2. Call Gemini API with audio
3. Parse structured response
4. Update Firestore document

**Gemini Response Schema**:

```typescript
interface GeminiResponse {
  title: string;
  speakers: Array<{
    id: string;
    name: string;
  }>;
  segments: Array<{
    speakerId: string;
    startMs: number;
    endMs: number;
    text: string;
  }>;
  terms: Array<{
    key: string;
    display: string;
    definition: string;
    aliases: string[];
  }>;
  topics: Array<{
    label: string;
    startsAfterSegmentIndex: number;
    isTangent: boolean;
  }>;
  people: Array<{
    name: string;
    affiliation?: string;
  }>;
}
```

### chatWithConversation (HTTPS Callable)

**Request**:
```typescript
{
  conversationId: string;
  message: string;  // Max 1000 characters
}
```

**Response**:
```typescript
{
  answer: string;                    // LLM-generated answer
  sources: Array<{                   // Validated timestamp sources
    segmentId: string;
    startMs: number;
    endMs: number;
    text: string;
    confidence: 'high' | 'medium' | 'low';
  }>;
  isUnanswerable: boolean;           // True if question not answerable from transcript
  tokenUsage: {                      // LLM usage for this query
    inputTokens: number;
    outputTokens: number;
    model: string;
  };
  costUsd: number;                   // Estimated cost for this query
  responseTimeMs: number;            // Processing time
  rateLimitRemaining: number;        // Queries remaining today
}
```

**Rate Limiting**: 20 queries per conversation per day per user. Resets at midnight UTC.

**Errors**:
- `unauthenticated`: User not signed in
- `invalid-argument`: Missing/invalid conversationId or message
- `not-found`: Conversation doesn't exist
- `permission-denied`: User doesn't own the conversation
- `failed-precondition`: Conversation not ready (status != 'complete')
- `resource-exhausted`: Rate limit exceeded

## Related Documentation

- [Architecture](architecture.md) - System design
- [Firebase Setup](../how-to/firebase-setup.md) - Configuration
