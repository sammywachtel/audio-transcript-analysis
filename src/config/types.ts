export interface Speaker {
  speakerId: string;
  displayName: string;
  colorIndex: number;
}

export interface Term {
  termId: string;
  key: string;
  display: string;
  definition: string;
  aliases: string[];
}

export interface TermOccurrence {
  occurrenceId: string;
  termId: string;
  segmentId: string;
  startChar: number;
  endChar: number;
}

export interface Topic {
  topicId: string;
  title: string;
  startIndex: number; // Segment index
  endIndex: number; // Segment index
  type: 'main' | 'tangent';
  parentTopicId?: string; // For tangents
}

export interface Person {
  personId: string;
  name: string;
  affiliation?: string;
  userNotes?: string;
}

/**
 * Warning categories for transcript quality issues.
 * Used to surface issues without blocking transcript delivery.
 */
export type WarningCategory =
  | 'speaker_confidence'   // Speaker identification may be unreliable
  | 'audio_quality'        // Audio quality issues detected
  | 'alignment_fallback'   // Using fallback timestamps (may be inaccurate)
  | 'processing_partial';  // Some processing steps were skipped/degraded

/**
 * Warning about transcript quality.
 * Stored on conversation to surface issues to users.
 */
export interface TranscriptWarning {
  /** Unique identifier for this warning */
  warningId: string;
  /** Category of warning (for filtering/display) */
  category: WarningCategory;
  /** User-friendly message explaining the issue */
  message: string;
  /** Technical details for debugging (optional) */
  details?: string;
  /** Severity level affects UI treatment */
  severity: 'info' | 'warning' | 'error';
  /** Optional: segment indices affected (for highlighting) */
  affectedSegments?: number[];
  /** Optional: speaker IDs affected */
  affectedSpeakers?: string[];
  /** When this warning was generated */
  createdAt: string;
}

export interface Segment {
  segmentId: string;
  index: number;
  speakerId: string;
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * Processing mode for chunked audio uploads.
 * - 'parallel': Chunks process independently (fast, speaker reconciliation at merge)
 * - 'sequential': Chunks wait for predecessor context (legacy, consistent speaker IDs)
 */
export type ProcessingMode = 'parallel' | 'sequential';

export interface Conversation {
  conversationId: string;
  userId: string; // Owner's Firebase UID - isolates data per user
  title: string;
  createdAt: string;
  updatedAt: string; // For sync conflict resolution and tracking
  durationMs: number;
  audioUrl?: string; // Ephemeral signed URL for audio playback (not stored in Firestore)
  audioStoragePath?: string; // Firebase Storage path for audio file
  status: 'processing' | 'chunking' | 'merging' | 'reprocessing' | 'needs_review' | 'complete' | 'failed' | 'aborted';
  abortRequested?: boolean;  // Set to true to request abort, Cloud Function checks this
  speakers: Record<string, Speaker>;
  segments: Segment[];
  terms: Record<string, Term>;
  termOccurrences: TermOccurrence[]; // Flat list for easy lookup
  topics: Topic[];
  people: Person[];
  // Server-side alignment status (set by Cloud Function after WhisperX processing)
  // - 'pending': Alignment not yet attempted (processing)
  // - 'aligned': WhisperX alignment succeeded
  // - 'fallback': WhisperX failed, using Gemini timestamps (may be inaccurate)
  alignmentStatus?: 'pending' | 'aligned' | 'fallback';
  alignmentError?: string; // Error message if alignment failed (for fallback status)
  // Processing mode for chunked uploads (defaults to 'parallel' for new uploads)
  processingMode?: ProcessingMode;
  // Speaker reconciliation metadata (parallel mode only)
  reconciliationConfidence?: number;
  reconciliationDetails?: ReconciliationDetails;
  // Extended reconciliation observability (parallel mode)
  reconciliationMetadata?: ReconciliationMetadata;
  // Fallback metadata (when parallel → sequential fallback occurred)
  fallbackMetadata?: FallbackMetadata;

  // Quality warnings (non-blocking issues surfaced to user)
  warnings?: TranscriptWarning[];

  // Retry tracking metadata
  retryCount?: number;
  lastFailedAt?: string;
  lastRetryAt?: string;
  // Task generation - incremented on retry to invalidate stale Cloud Tasks
  taskGeneration?: number;

  // Progressive processing status (all optional for backward compatibility)
  processingProgress?: ProcessingProgress;
  processingTimeline?: ProcessingTimeline[];

  // Sync metadata (future use for Firestore sync)
  syncStatus?: 'local_only' | 'synced' | 'pending_upload' | 'conflict';
  lastSyncedAt?: string;
}

export interface PlaybackState {
  isPlaying: boolean;
  currentTimeMs: number;
  durationMs: number;
  playbackRate: number;
}

// User profile stored in Firestore users/{userId} collection
export interface UserProfile {
  userId: string;
  email: string;
  displayName?: string;
  photoURL?: string;
  isAdmin: boolean; // Admin users can access observability dashboard
  createdAt: string;
  lastLoginAt?: string;
}

// Processing step enum for granular status tracking
export enum ProcessingStep {
  PENDING = 'pending',
  UPLOADING = 'uploading',
  OPTIMIZING = 'optimizing',    // Re-encoding audio for clean playback seeking
  CHUNKING = 'chunking',        // Splitting large audio into chunks
  PRE_ANALYZING = 'pre_analyzing',
  TRANSCRIBING = 'transcribing',
  ANALYZING = 'analyzing',
  REASSIGNING = 'reassigning',
  ALIGNING = 'aligning',
  FINALIZING = 'finalizing',
  COMPLETE = 'complete',
  FAILED = 'failed'
}

// Metadata for each processing step (UI display info)
export interface StepMeta {
  label: string;
  description?: string;
  category: 'pending' | 'active' | 'success' | 'error';
}

// Real-time processing progress for user feedback
export interface ProcessingProgress {
  currentStep: ProcessingStep;
  percentComplete: number; // 0-100
  stepStartedAt?: string; // ISO timestamp
  estimatedRemainingMs?: number;
  errorMessage?: string;
  stepMeta?: StepMeta; // Optional metadata for enhanced UI feedback
}

// Timeline tracking for performance analysis
export interface ProcessingTimeline {
  stepName: ProcessingStep;
  startedAt: string; // ISO timestamp
  completedAt?: string; // ISO timestamp
  durationMs?: number;
}

// =============================================================================
// Chunked Processing Types
// =============================================================================

/**
 * Status of individual chunk processing.
 * Used to track progress and enable resumable execution.
 */
export type ChunkProcessingStatus = 'pending' | 'processing' | 'complete' | 'failed';

/**
 * Status entry for a single chunk in the processing pipeline.
 * Tracks lifecycle timestamps and any errors for resume logic.
 */
export interface ChunkStatus {
  /** Zero-indexed chunk number */
  chunkIndex: number;
  /** Current processing state */
  status: ChunkProcessingStatus;
  /** When processing started (ISO timestamp) */
  startedAt?: string;
  /** When processing completed (ISO timestamp) */
  completedAt?: string;
  /** Error message if status is 'failed' */
  error?: string;
  /** Number of retry attempts for this chunk */
  retryCount?: number;
}

/**
 * Speaker identity mapping preserved across chunk boundaries.
 * Maps pyannote speaker IDs to consistent identities.
 */
export interface SpeakerMapping {
  /** Original speaker ID from current chunk (e.g., "SPEAKER_00") */
  originalId: string;
  /** Canonical speaker ID used across all chunks */
  canonicalId: string;
  /** Inferred display name if known */
  displayName?: string;
  /** Voice signature hint for matching (future use) */
  voiceSignature?: string;
}

/**
 * Context passed between chunk processing tasks.
 * Enables diarization continuity and resumable execution.
 *
 * This is the state machine's "carry forward" data - each chunk
 * reads the previous context and emits a new one for the next chunk.
 */
export interface ChunkContext {
  /** Which chunk this context was emitted by (for validation) */
  emittedByChunkIndex: number;
  /** Speaker mappings discovered so far */
  speakerMap: SpeakerMapping[];
  /** Short summary of content processed so far (max ~512 chars, sanitized) */
  previousSummary: string;
  /** Terms extracted from previous chunks (for deduplication) */
  knownTermIds: string[];
  /** Topic IDs from previous chunks */
  knownTopicIds: string[];
  /** Person IDs from previous chunks */
  knownPersonIds: string[];
  /** Total segments processed so far (for index continuity) */
  cumulativeSegmentCount: number;
  /** Timestamp of last processed audio (ms in original) for continuity */
  lastProcessedMs: number;
}

/**
 * Firestore-stored chunking metadata with status tracking.
 * Extended from the original chunkMetadata to include context propagation.
 */
export interface ChunkingMetadata {
  /** Whether chunking was applied */
  chunkingEnabled: boolean;
  /** Total number of chunks */
  totalChunks: number;
  /** Number of chunks that completed successfully */
  completedChunks: number;
  /** Per-chunk status array */
  chunkStatuses: ChunkStatus[];
  /** Per-chunk context sequence (chunkContexts[i] = context emitted by chunk i) */
  chunkContexts: ChunkContext[];
  /** When chunking was initiated (ISO timestamp) */
  chunkedAt: string;
  /** Original audio duration (ms) */
  originalDurationMs: number;
  /** Original audio storage path */
  originalStoragePath: string;
}

/**
 * Result returned by the transcription pipeline for chunk context propagation.
 * Contains the data needed to build the next chunk's context.
 */
export interface ChunkPipelineResult {
  /** Speaker mappings discovered in this chunk (originalId → canonicalId) */
  speakerMappings: SpeakerMapping[];
  /** Short summary of content processed (will be sanitized/truncated) */
  summary: string;
  /** Term IDs extracted in this chunk */
  termIds: string[];
  /** Topic IDs extracted in this chunk */
  topicIds: string[];
  /** Person IDs extracted in this chunk */
  personIds: string[];
  /** Number of segments processed in this chunk */
  segmentCount: number;
  /** Last timestamp processed in this chunk (ms) */
  lastTimestampMs: number;
}

// =============================================================================
// Speaker Reconciliation Types (Parallel Mode)
// =============================================================================

/**
 * Detailed match evidence for speaker reconciliation.
 * Provides transparency into how speakers were matched across chunks.
 */
export interface ReconciliationDetails {
  /** Number of clusters (canonical speakers) created */
  clusterCount: number;
  /** Total number of original speakers across all chunks */
  originalSpeakerCount: number;
  /** Per-cluster match evidence */
  clusters: Array<{
    canonicalId: string;
    originalIds: string[];
    confidence: number;
    displayName: string;
    matchEvidence: {
      nameMatches: number;
      topicOverlap: number;
      termOverlap: number;
    };
  }>;
}

// =============================================================================
// Fallback & Observability Types
// =============================================================================

/**
 * Reasons why fallback to sequential reprocessing was triggered.
 */
export type FallbackReason = 'low_speaker_confidence' | 'reconciliation_error';

/**
 * Metadata stored when parallel processing falls back to sequential.
 * Provides audit trail and debugging information for operators.
 */
export interface FallbackMetadata {
  /** When fallback was triggered (ISO timestamp) */
  triggeredAt: string;
  /** The confidence score that triggered fallback */
  parallelConfidence: number;
  /** Reference to archived parallel chunks (subcollection path) */
  archiveId: string;
  /** Reason for fallback */
  reason: FallbackReason;
  /** How long the parallel attempt took (ms) */
  parallelDurationMs?: number;
  /** How long the sequential reprocessing took (ms) - populated after completion */
  sequentialDurationMs?: number;
  /** Confidence threshold that was configured at the time */
  configuredThreshold: number;
}

/**
 * Extended reconciliation metadata for observability.
 * Stored on conversation records for post-mortem analysis.
 */
export interface ReconciliationMetadata {
  /** Which matching signals were used (e.g., ['name', 'topic', 'term']) */
  signalsUsed: string[];
  /** Whether fallback to sequential was triggered */
  fallbackTriggered: boolean;
  /** Per-speaker confidence scores for matched clusters */
  speakerMatchConfidences: Array<{
    canonicalId: string;
    confidence: number;
  }>;
  /** Processing duration for reconciliation phase (ms) */
  reconciliationDurationMs?: number;
}

// =============================================================================
// Speaker Correction Types (Manual Merge Feature)
// =============================================================================

/**
 * Type of speaker correction operation.
 * - 'merge': Merge all segments from one speaker into another
 * - 'reassign': Reassign specific segments to a different speaker
 * - 'rename': Rename a speaker's display name
 */
export type SpeakerCorrectionType = 'merge' | 'reassign' | 'rename';

/**
 * User-initiated speaker correction record.
 * Stored in conversations/{id}/speakerCorrections subcollection.
 * Applied at read-time to derive corrected speaker list and segment assignments.
 */
export interface SpeakerCorrection {
  /** Unique ID for this correction */
  correctionId: string;
  /** Type of correction */
  type: SpeakerCorrectionType;

  // Fields for 'merge' corrections
  /** Speaker ID being merged away (will be removed from speaker list) */
  sourceSpeakerId?: string;
  /** Speaker ID to merge into (all source segments reassigned to this) */
  targetSpeakerId?: string;

  // Fields for 'reassign' corrections
  /** Segment IDs to reassign (reassign type only) */
  segmentIds?: string[];
  /** Speaker ID segments are being moved from (reassign type only) */
  fromSpeakerId?: string;
  /** Speaker ID segments are being moved to (reassign type only) */
  toSpeakerId?: string;

  // Fields for 'rename' corrections
  /** Speaker ID being renamed (rename type only) */
  speakerId?: string;
  /** New display name for the speaker (rename type only) */
  newDisplayName?: string;
  /** Previous display name for undo display purposes (rename type only) */
  previousDisplayName?: string;

  /** When this correction was created (ISO timestamp) */
  createdAt: string;
  /** User who created this correction (for verification) */
  userId: string;

  /** If set, this correction has been undone and should be ignored in apply-on-read.
   *  Preserves audit trail - we don't delete corrections on undo. */
  undoneAt?: string;
}
