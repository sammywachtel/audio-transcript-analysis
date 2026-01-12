/**
 * Reconciliation Configuration
 *
 * Threshold configuration for speaker reconciliation during parallel chunk merging.
 * Uses a progressive enhancement pattern: constant → env var → Firestore (future).
 *
 * Current implementation: Phase 1-2 (constant with env var override)
 * Phase 3 (Firestore-based dynamic config) deferred until A/B testing needed.
 */

/**
 * Reconciliation configuration constants and helpers.
 *
 * CONFIDENCE_THRESHOLD determines when speaker reconciliation is considered
 * too uncertain to proceed. Below this threshold, the merge process will
 * trigger a fallback to sequential reprocessing.
 */
export const ReconciliationConfig = {
  /**
   * Minimum acceptable confidence for speaker reconciliation.
   * When reconcileSpeakers() returns a confidence below this threshold,
   * chunkMerge.ts throws ReconciliationLowConfidenceError, which is caught
   * to initiate fallback to sequential reprocessing.
   *
   * Default: 0.75 (conservative - prefer fallback over mislabeled transcripts)
   * Override via RECONCILIATION_CONFIDENCE_THRESHOLD env var for testing/tuning.
   */
  CONFIDENCE_THRESHOLD: (() => {
    const envValue = process.env.RECONCILIATION_CONFIDENCE_THRESHOLD;
    if (envValue) {
      const parsed = parseFloat(envValue);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
        console.log(`[ReconciliationConfig] Using env threshold: ${parsed}`);
        return parsed;
      }
      console.warn(`[ReconciliationConfig] Invalid env threshold "${envValue}", using default 0.75`);
    }
    return 0.75;
  })(),

  /**
   * High-confidence match threshold for greedy clustering.
   * Speaker pairs above this score are merged into the same cluster.
   *
   * Note: This is internal to the clustering algorithm and not exposed as config.
   * Changing this requires careful testing as it affects cluster formation.
   */
  HIGH_CONFIDENCE_MATCH: 0.7,

  /**
   * Future: Load threshold dynamically from Firestore.
   * Phase 3 implementation for A/B testing or per-user thresholds.
   *
   * @param _userId - Optional user ID for per-user thresholds (not yet implemented)
   * @returns The configured confidence threshold
   */
  async getDynamicThreshold(_userId?: string): Promise<number> {
    // Phase 3: Will query Firestore for dynamic/per-user thresholds
    // For now, return the static threshold
    return this.CONFIDENCE_THRESHOLD;
  }
};

/**
 * Maximum retry attempts for sequential reprocessing after fallback.
 * Prevents infinite loops if sequential also fails.
 */
export const MAX_FALLBACK_RETRIES = 1;

/**
 * Status values for reprocessing state machine.
 */
export type ReprocessingStatus = 'reprocessing' | 'complete' | 'failed';
