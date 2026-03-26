/**
 * Shared types for Cloud Functions
 *
 * These types mirror the frontend types.ts to avoid cross-directory
 * TypeScript compilation issues. Keep in sync with root types.ts.
 */

/**
 * Processing mode for chunked audio uploads.
 * - 'parallel': Chunks process independently (fast)
 * - 'sequential': Chunks wait for predecessor context (legacy, consistent speaker IDs)
 */
export type ProcessingMode = 'parallel' | 'sequential';

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
  startIndex: number;
  endIndex: number;
  type: 'main' | 'tangent';
  parentTopicId?: string;
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

export interface Conversation {
  conversationId: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  audioUrl?: string;
  // Legacy statuses 'chunking' | 'merging' | 'reprocessing' are no longer set by the
  // current Gemini hybrid pipeline, but may exist on historical Firestore documents.
  // Do NOT remove them — frontend status guards and Firestore reads depend on the union.
  status: 'processing' | 'chunking' | 'merging' | 'reprocessing' | 'needs_review' | 'complete' | 'failed' | 'aborted';
  abortRequested?: boolean;
  speakers: Record<string, Speaker>;
  segments: Segment[];
  terms: Record<string, Term>;
  termOccurrences: TermOccurrence[];
  topics: Topic[];
  people: Person[];
  alignmentStatus?: 'pending' | 'aligned' | 'fallback';
  alignmentError?: string;
  processingProgress?: ProcessingProgress;
  processingTimeline?: ProcessingTimeline[];
  syncStatus?: 'local_only' | 'synced' | 'pending_upload' | 'conflict';
  lastSyncedAt?: string;
  // Processing mode for chunked uploads (defaults to 'parallel' for new uploads)
  processingMode?: ProcessingMode;
  // Quality warnings (non-blocking issues surfaced to user)
  warnings?: TranscriptWarning[];
  // Error details — string for legacy, StructuredError for orchestrator-managed failures
  processingError?: string | StructuredError;
  // Pipeline provenance — which pipeline produced this data
  processingPipeline?: 'legacy' | 'gemini_hybrid';
  pipelineVersion?: string;

  // Retry tracking metadata
  retryCount?: number;
  lastFailedAt?: string;
  lastRetryAt?: string;
  // Task generation - incremented on retry to invalidate stale Cloud Tasks
  taskGeneration?: number;
}

export enum ProcessingStep {
  PENDING = 'pending',
  UPLOADING = 'uploading',
  PRE_ANALYZING = 'pre_analyzing',
  TRANSCRIBING = 'transcribing',
  ANALYZING = 'analyzing',
  REASSIGNING = 'reassigning',
  ALIGNING = 'aligning',
  FINALIZING = 'finalizing',
  COMPLETE = 'complete',
  FAILED = 'failed'
}

export interface StepMeta {
  label: string;
  description?: string;
  category: 'pending' | 'active' | 'success' | 'error';
}

export interface ProcessingProgress {
  currentStep: ProcessingStep;
  percentComplete: number;
  stepStartedAt?: string;
  estimatedRemainingMs?: number;
  errorMessage?: string;
  stepMeta?: StepMeta;
}

export interface ProcessingTimeline {
  stepName: ProcessingStep;
  startedAt: string;
  completedAt?: string;
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
 * Speaker identity hints extracted from the leader chunk (chunk 0).
 * Passed to follower chunks so they can skip Gemini pre-analysis
 * and start with known speaker names/counts.
 */
export interface SpeakerHints {
  /** Number of speakers detected in the leader chunk */
  numSpeakers: number;
  /** Speaker names inferred from the leader chunk (e.g., ["Alice", "Bob"]) */
  speakerNames: string[];
  /** Per-speaker notes from the leader's pipeline (roles, context clues) */
  speakerNotes?: Array<{
    speakerId: string;
    inferredName?: string;
    role?: string;
  }>;
}

/**
 * Serialized follower chunk descriptor, persisted in Firestore
 * while waiting for the leader chunk to finish.
 * Basically everything we need to re-create the Cloud Task later.
 */
export interface PendingFollowerChunk {
  chunkIndex: number;
  totalChunks: number;
  chunkStoragePath: string;
  startMs: number;
  endMs: number;
  overlapBeforeMs: number;
  overlapAfterMs: number;
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
  /** Guard flag to prevent duplicate merge task enqueueing */
  mergeTaskEnqueued?: boolean;
  /** When merge task was enqueued (ISO timestamp) */
  mergeEnqueuedAt?: string;
  /** When merge started (ISO timestamp) */
  mergeStartedAt?: string;
  /** When merge completed (ISO timestamp) */
  mergedAt?: string;
  /** Speaker hints extracted from leader chunk (chunk 0) after it completes */
  leaderSpeakerHints?: SpeakerHints;
  /** Follower chunks waiting for leader to finish before dispatch */
  pendingFollowerChunks?: PendingFollowerChunk[];
  /** Whether follower tasks have been dispatched (guard against duplicate dispatch) */
  followersDispatched?: boolean;
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

/**
 * Chunk artifact stored in conversations/{id}/chunks/{chunkIndex}.
 * Contains the full pipeline results for one chunk, to be merged later.
 */
export interface ChunkArtifact {
  /** Conversation ID this chunk belongs to */
  conversationId: string;
  /** User ID (for security) */
  userId: string;
  /** Zero-indexed chunk number */
  chunkIndex: number;
  /** Total number of chunks in this conversation */
  totalChunks: number;

  // Pipeline results for this chunk
  /** Transcript segments (with chunk-local timestamps initially) */
  segments: Segment[];
  /** Speakers discovered in this chunk */
  speakers: Record<string, Speaker>;
  /** Terms extracted in this chunk */
  terms: Record<string, Term>;
  /** Term occurrences in this chunk */
  termOccurrences: TermOccurrence[];
  /** Topics identified in this chunk */
  topics: Topic[];
  /** People mentioned in this chunk */
  people: Person[];

  // Timing info for merge deduplication
  chunkBounds: {
    /** Start time in original audio (ms) */
    startMs: number;
    /** End time in original audio (ms) */
    endMs: number;
    /** Overlap with previous chunk (ms) */
    overlapBeforeMs: number;
    /** Overlap with next chunk (ms) */
    overlapAfterMs: number;
  };

  /** Context emitted for the next chunk */
  emittedContext: ChunkContext;

  // Metadata
  /** When this chunk artifact was created */
  createdAt: string;
  /** Storage path to chunk audio file */
  storagePath: string;
}

// =============================================================================
// Cloud Run Orchestrator Contract Types
// =============================================================================
// Mirrored from cloud-run-orchestrator/src/contracts.ts — keep in sync.

/**
 * Machine-readable failure codes for the orchestrator pipeline.
 * Used in both the HTTP response and Firestore processingError field.
 */
export type OrchestratorErrorCode =
  | 'GEMINI_TIMEOUT'
  | 'GEMINI_PARSE_FAILED'
  | 'WHISPERX_UNAVAILABLE'
  | 'WHISPERX_TIMEOUT'
  | 'ALIGNMENT_FAILED'
  | 'QUALITY_GATE_FAILED'
  | 'STORAGE_ERROR'
  | 'ABORTED'
  | 'UNKNOWN';

/** Pipeline stage where a failure occurred. */
export type PipelineStage =
  | 'download'
  | 'gemini_analysis'
  | 'whisperx_timestamps'
  | 'hardy_alignment'
  | 'quality_gates'
  | 'firestore_write';

/** Structured error payload — replaces freeform processingError strings. */
export interface StructuredError {
  code: OrchestratorErrorCode;
  stage: PipelineStage;
  message: string;
  retryable: boolean;
}

/** POST /transcribe request body sent by the dispatcher. */
export interface TranscribeRequest {
  conversationId: string;
  audioStoragePath: string;
  userId: string;
}

/** Immediate 202 acknowledgement from POST /transcribe. */
export interface TranscribeAccepted {
  status: 'accepted';
  conversationId: string;
}

/** POST /transcribe outcome (logged by orchestrator, not returned to dispatcher). */
export interface TranscribeResponse {
  status: 'accepted' | 'complete' | 'failed';
  conversationId?: string;
  segments?: number;
  speakers?: number;
  durationMs?: number;
  error?: StructuredError;
}

/** GET /health response from the orchestrator. */
export interface HealthResponse {
  status: 'ok';
  version: string;
  uptime: number;
}
