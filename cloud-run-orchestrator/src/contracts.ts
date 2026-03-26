/**
 * Dispatcher ↔ Orchestrator Contract Types
 *
 * Canonical type definitions for the Cloud Function dispatcher and
 * Cloud Run orchestrator boundary. The Cloud Function imports these
 * types via a mirrored copy in functions/src/types.ts — keep them
 * in sync or face the wrath of a 3 AM pager.
 *
 * Changes here MUST be reflected in functions/src/types.ts.
 */

// =============================================================================
// Error Codes & Stages
// =============================================================================

/**
 * Machine-readable failure codes. Each maps to a specific failure mode
 * the orchestrator can encounter, so the dispatcher (and eventually the
 * frontend) can decide whether retry is sane.
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

/**
 * Pipeline stage where the failure occurred. Useful for dashboards
 * and for humans trying to figure out which service to kick.
 */
export type PipelineStage =
  | 'download'
  | 'gemini_analysis'
  | 'whisperx_timestamps'
  | 'hardy_alignment'
  | 'quality_gates'
  | 'firestore_write';

/**
 * Structured error payload — replaces the old freeform processingError strings.
 * Both the orchestrator response body and Firestore processingError field use this shape.
 */
export interface StructuredError {
  /** Machine-readable error code */
  code: OrchestratorErrorCode;
  /** Pipeline stage where failure occurred */
  stage: PipelineStage;
  /** Human-readable error message (for logs, not for users) */
  message: string;
  /** Whether a retry has a reasonable chance of succeeding */
  retryable: boolean;
}

// =============================================================================
// Request / Response
// =============================================================================

/** POST /transcribe request body — everything the orchestrator needs to start. */
export interface TranscribeRequest {
  conversationId: string;
  audioStoragePath: string;
  userId: string;
}

/**
 * Immediate acknowledgement from POST /transcribe — returned before the
 * pipeline starts. The dispatcher reads this to confirm the request was
 * accepted, then returns. Pipeline results go straight to Firestore.
 */
export interface TranscribeAccepted {
  status: 'accepted';
  conversationId: string;
}

/**
 * POST /transcribe final outcome — logged by the orchestrator after the
 * pipeline completes. NOT returned to the dispatcher (it already left).
 * Useful for monitoring, integration tests, and structured log queries.
 */
export interface TranscribeResponse {
  status: 'accepted' | 'complete' | 'failed';
  conversationId?: string;
  segments?: number;
  speakers?: number;
  durationMs?: number;
  error?: StructuredError;
}

/** GET /health response body — includes version for deploy verification. */
export interface HealthResponse {
  status: 'ok';
  version: string;
  uptime: number;
}
