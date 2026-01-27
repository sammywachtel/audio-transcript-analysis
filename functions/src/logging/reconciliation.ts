/**
 * Structured Logging for Speaker Reconciliation
 *
 * Provides consistent, parseable log output for reconciliation events.
 * Designed for Cloud Logging queries and alerting via log-based metrics.
 *
 * Log events:
 * - RECONCILIATION_STARTED: Merge begins reconciliation
 * - RECONCILIATION_COMPLETED: Reconciliation succeeded
 * - RECONCILIATION_FALLBACK_TRIGGERED: Low confidence → fallback initiated
 * - RECONCILIATION_FAILED: Reconciliation error (not low confidence)
 */

/**
 * Reconciliation event types for structured logging.
 */
export type ReconciliationEvent =
  | 'started'
  | 'completed'
  | 'fallback_triggered'
  | 'failed';

/**
 * Data payload for reconciliation log entries.
 * All fields optional - include what's relevant for each event type.
 */
export interface ReconciliationLogData {
  /** Conversation ID being processed */
  conversationId: string;
  /** Processing mode (parallel/sequential) */
  mode: 'parallel' | 'sequential';
  /** Overall reconciliation confidence (0-1) */
  confidence?: number;
  /** Number of chunks being merged */
  chunkCount?: number;
  /** Number of speakers after reconciliation */
  speakerCount?: number;
  /** Signals used for matching (e.g., ['name', 'topic', 'term']) */
  signalsUsed?: string[];
  /** Processing duration in milliseconds */
  durationMs?: number;
  /** Error message if failed */
  error?: string;
  /** Whether fallback was triggered */
  fallbackTriggered?: boolean;
  /** Archive ID for fallback chunks */
  archiveId?: string;
  /** Configured confidence threshold */
  threshold?: number;
}

/**
 * Structured log entry format for Cloud Logging parsing.
 */
interface StructuredLogEntry {
  timestamp: string;
  event: string;
  service: string;
  version: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
  conversationId: string;
  mode: 'parallel' | 'sequential';
  confidence?: number;
  chunkCount?: number;
  speakerCount?: number;
  signalsUsed?: string[];
  durationMs?: number;
  error?: string;
  fallbackTriggered?: boolean;
  archiveId?: string;
  threshold?: number;
}

/**
 * Log a reconciliation event with structured JSON output.
 *
 * Output is JSON for Cloud Logging parsing. Example:
 * ```json
 * {
 *   "timestamp": "2026-01-10T12:00:00.000Z",
 *   "event": "RECONCILIATION_COMPLETED",
 *   "service": "speaker-reconciliation",
 *   "version": "1.0.0",
 *   "severity": "INFO",
 *   "conversationId": "abc123",
 *   "mode": "parallel",
 *   "confidence": 0.85,
 *   "chunkCount": 3,
 *   "durationMs": 1234
 * }
 * ```
 *
 * @param event - Event type (started, completed, fallback_triggered, failed)
 * @param data - Event-specific data payload
 */
export function logReconciliation(
  event: ReconciliationEvent,
  data: ReconciliationLogData
): void {
  const severity = getSeverity(event);
  const eventName = `RECONCILIATION_${event.toUpperCase()}`;

  const logEntry: StructuredLogEntry = {
    timestamp: new Date().toISOString(),
    event: eventName,
    service: 'speaker-reconciliation',
    version: '1.0.0',
    severity,
    conversationId: data.conversationId,
    mode: data.mode,
    ...(data.confidence !== undefined && { confidence: data.confidence }),
    ...(data.chunkCount !== undefined && { chunkCount: data.chunkCount }),
    ...(data.speakerCount !== undefined && { speakerCount: data.speakerCount }),
    ...(data.signalsUsed && { signalsUsed: data.signalsUsed }),
    ...(data.durationMs !== undefined && { durationMs: data.durationMs }),
    ...(data.error && { error: data.error }),
    ...(data.fallbackTriggered !== undefined && { fallbackTriggered: data.fallbackTriggered }),
    ...(data.archiveId && { archiveId: data.archiveId }),
    ...(data.threshold !== undefined && { threshold: data.threshold })
  };

  // Output as JSON for Cloud Logging structured parsing
  console.log(JSON.stringify(logEntry));
}

/**
 * Get log severity based on event type.
 */
function getSeverity(event: ReconciliationEvent): 'INFO' | 'WARNING' | 'ERROR' {
  switch (event) {
    case 'started':
    case 'completed':
      return 'INFO';
    case 'fallback_triggered':
      return 'WARNING';
    case 'failed':
      return 'ERROR';
  }
}

/**
 * Helper to log reconciliation start.
 *
 * @param conversationId - Conversation being processed
 * @param chunkCount - Number of chunks to merge
 * @param mode - Processing mode
 */
export function logReconciliationStarted(
  conversationId: string,
  chunkCount: number,
  mode: 'parallel' | 'sequential'
): void {
  logReconciliation('started', {
    conversationId,
    mode,
    chunkCount
  });
}

/**
 * Helper to log reconciliation completion.
 *
 * @param conversationId - Conversation being processed
 * @param confidence - Final confidence score
 * @param speakerCount - Number of canonical speakers
 * @param signalsUsed - Matching signals used
 * @param durationMs - Processing time
 * @param mode - Processing mode
 */
export function logReconciliationCompleted(
  conversationId: string,
  confidence: number,
  speakerCount: number,
  signalsUsed: string[],
  durationMs: number,
  mode: 'parallel' | 'sequential'
): void {
  logReconciliation('completed', {
    conversationId,
    mode,
    confidence,
    speakerCount,
    signalsUsed,
    durationMs
  });
}

/**
 * Helper to log fallback trigger.
 *
 * @param conversationId - Conversation being processed
 * @param confidence - Confidence that triggered fallback
 * @param threshold - Configured threshold
 * @param archiveId - Archive ID for parallel chunks
 * @param mode - Processing mode (should be 'parallel')
 * @param durationMs - Reconciliation duration in milliseconds
 */
export function logFallbackTriggered(
  conversationId: string,
  confidence: number,
  threshold: number,
  archiveId: string,
  mode: 'parallel' | 'sequential',
  durationMs?: number
): void {
  logReconciliation('fallback_triggered', {
    conversationId,
    mode,
    confidence,
    threshold,
    archiveId,
    fallbackTriggered: true,
    durationMs
  });
}

/**
 * Helper to log reconciliation failure.
 *
 * @param conversationId - Conversation being processed
 * @param error - Error message
 * @param mode - Processing mode
 */
export function logReconciliationFailed(
  conversationId: string,
  error: string,
  mode: 'parallel' | 'sequential'
): void {
  logReconciliation('failed', {
    conversationId,
    mode,
    error
  });
}

// ============================================================================
// Structured Monitoring Logs
// ============================================================================
// These logs use eventType fields for Cloud Monitoring log-based metrics.
// Filter examples:
//   jsonPayload.eventType="reconciliation_completed"
//   jsonPayload.eventType="reconciliation_error"

/**
 * Reconciliation metrics for monitoring and admin dashboard.
 */
export interface ReconciliationMetrics {
  conversationId: string;
  strategy: 'context-aware' | 'embedding-only';
  clusterCount: number;
  confidence: number;
  latencyMs: number;
  edgeThreshold?: number;
  cohesionThreshold?: number;
  qualityExclusions?: number;
  avgClusterQuality?: number;
  temporalBoosts?: number;
  boundaryBridges?: number;
  hasWarning: boolean;
  rolloutPercentage: number;
  flagEnabled: boolean;
  // Singleton detection and adaptive relaxation metrics
  singletonRatio?: number;
  singletonCount?: number;
  estimatedUniqueSpeakers?: number;
  relaxationTriggered?: boolean;
  finalEdgeThreshold?: number;
  relaxationIterations?: number;
}

/**
 * Error types for reconciliation failures.
 */
export type ReconciliationErrorType =
  | 'exception'
  | 'low_confidence'
  | 'timeout'
  | 'missing_data';

/**
 * Log reconciliation error for Cloud Monitoring metrics.
 *
 * Use this for critical errors that should count toward the 5% auto-disable threshold.
 *
 * Filter: jsonPayload.eventType="reconciliation_error"
 */
export function logReconciliationError(
  conversationId: string,
  errorType: ReconciliationErrorType,
  strategy: 'context-aware' | 'embedding-only',
  details: Record<string, unknown> = {}
): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    eventType: 'reconciliation_error',  // Key for log-based metric
    service: 'speaker-reconciliation',
    severity: 'critical',
    conversationId,
    strategy,
    errorType,
    ...details
  };

  // Use console.error for ERROR severity in Cloud Logging
  console.error(JSON.stringify(logEntry));
}

/**
 * Log successful reconciliation for Cloud Monitoring metrics.
 *
 * Filter: jsonPayload.eventType="reconciliation_completed"
 */
export function logReconciliationSuccess(
  metrics: ReconciliationMetrics
): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    eventType: 'reconciliation_completed',  // Key for log-based metric
    service: 'speaker-reconciliation',
    severity: 'info',
    success: true,
    warning: metrics.hasWarning,
    ...metrics
  };

  console.log(JSON.stringify(logEntry));
}

/**
 * Log strategy selection for observability.
 *
 * Filter: jsonPayload.eventType="reconciliation_strategy_selected"
 */
export function logStrategySelection(
  conversationId: string,
  strategy: 'context-aware' | 'embedding-only',
  reason: string,
  rolloutPercentage: number,
  flagEnabled: boolean,
  isOverridden: boolean
): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    eventType: 'reconciliation_strategy_selected',
    service: 'speaker-reconciliation',
    severity: 'info',
    conversationId,
    strategy,
    reason,
    rolloutPercentage,
    flagEnabled,
    isOverridden
  };

  console.log(JSON.stringify(logEntry));
}
