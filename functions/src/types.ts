/**
 * Shared types for Cloud Functions
 *
 * These types mirror the frontend types.ts to avoid cross-directory
 * TypeScript compilation issues. Keep in sync with root types.ts.
 */

/**
 * Processing mode for chunked audio uploads.
 * - 'parallel': Chunks process independently (fast, speaker reconciliation at merge)
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
  // Speaker reconciliation metadata (parallel mode only)
  reconciliationConfidence?: number;
  reconciliationDetails?: ReconciliationDetails;
  // Extended reconciliation observability (parallel mode)
  reconciliationMetadata?: ReconciliationMetadata;
  // Fallback metadata (when parallel → sequential fallback occurred)
  fallbackMetadata?: FallbackMetadata;
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
  /** Speaker signatures for parallel mode reconciliation (keyed by speakerId) */
  chunkSpeakerSignatures?: SpeakerSignature[];
}

/**
 * Speaker signature for parallel mode reconciliation.
 * Captures fingerprint data for each speaker so downstream merge
 * can correlate speakers across independently-processed chunks.
 */
export interface SpeakerSignature {
  /** Speaker ID within this chunk (e.g., "SPEAKER_00") */
  speakerId: string;
  /** Chunk index where this speaker appeared */
  chunkIndex: number;
  /** Inferred display name (if speaker introduced themselves) */
  inferredName?: string;
  /** Topic IDs where this speaker spoke (subset for fingerprinting) */
  topicSignatures: string[];
  /** Term keys this speaker used (subset for fingerprinting) */
  termSignatures: string[];
  /** Number of segments this speaker contributed */
  segmentCount: number;
  /** Sample quote from this speaker (first ~100 chars) */
  sampleQuote: string;
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

  /**
   * Speaker signatures for parallel mode reconciliation.
   * Present when processingMode is 'parallel'; used by merge to correlate speakers.
   */
  chunkSpeakerSignatures?: SpeakerSignature[];

  /**
   * Voice embeddings for embedding-based speaker reconciliation.
   * 256-dimensional vectors from pyannote/embedding model.
   * Present when WhisperX fork with embedding extraction is used.
   * Format: { "SPEAKER_00": [0.123, -0.456, ...], "SPEAKER_01": [...] }
   */
  speakerEmbeddings?: {
    [speakerId: string]: number[];
  };

  // Metadata
  /** When this chunk artifact was created */
  createdAt: string;
  /** Storage path to chunk audio file */
  storagePath: string;
}

// =============================================================================
// Speaker Reconciliation Types (Parallel Mode)
// =============================================================================

/**
 * Overall confidence score and per-cluster breakdown for speaker reconciliation.
 * Used to assess the quality of speaker matching across chunks.
 */
export interface ReconciliationConfidence {
  /** Overall confidence (0-1, minimum of cluster confidences) */
  overall: number;
  /** Per-cluster confidence scores */
  clusters: Array<{
    canonicalId: string;
    confidence: number;
  }>;
}

/**
 * Detailed match evidence for speaker reconciliation.
 * Provides transparency into how speakers were matched.
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
