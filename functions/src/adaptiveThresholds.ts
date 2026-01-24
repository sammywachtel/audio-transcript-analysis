/**
 * Adaptive Thresholds for Speaker Reconciliation
 *
 * Pure functions for computing adaptive edge thresholds and quality-adjusted
 * cohesion thresholds. Reduces over-fragmentation without manual tuning.
 *
 * Core ideas:
 * - Edge threshold adapts based on cluster count (more clusters → relax, fewer → tighten)
 * - Cohesion threshold adapts based on cluster quality (higher quality → stricter)
 * - Iterative refinement converges within max 3 iterations
 */

// ============================================================================
// Configuration
// ============================================================================

export interface AdaptiveThresholdConfig {
  /** Base edge threshold for cluster formation (default 0.68) */
  baseEdgeThreshold: number;
  /** Step size for edge threshold adjustment (default 0.05) */
  edgeAdjustStep: number;
  /** Cluster count above which we relax threshold (default 14) */
  maxClusters: number;
  /** Cluster count below which we tighten threshold (default 10) */
  minClusters: number;
  /** Minimum allowed threshold (default 0.55) */
  thresholdMin: number;
  /** Maximum allowed threshold (default 0.80) */
  thresholdMax: number;
  /** Maximum refinement iterations (default 3) */
  maxIterations: number;

  // Quality-based cohesion thresholds
  /** Quality above this uses stricter cohesion (default 0.75) */
  highQualityThreshold: number;
  /** Quality below this uses looser cohesion (default 0.50) */
  lowQualityThreshold: number;
  /** Cohesion for high-quality clusters (default 0.55) */
  highQualityCohesion: number;
  /** Cohesion for medium-quality clusters (default 0.60) */
  mediumQualityCohesion: number;
  /** Cohesion for low-quality clusters (default 0.70) */
  lowQualityCohesion: number;
}

export const DEFAULT_CONFIG: AdaptiveThresholdConfig = {
  baseEdgeThreshold: 0.68,
  edgeAdjustStep: 0.05,
  maxClusters: 14,
  minClusters: 10,
  thresholdMin: 0.55,
  thresholdMax: 0.80,
  maxIterations: 3,

  highQualityThreshold: 0.75,
  lowQualityThreshold: 0.50,
  highQualityCohesion: 0.55,
  mediumQualityCohesion: 0.60,
  lowQualityCohesion: 0.70
};

// ============================================================================
// Threshold Computation
// ============================================================================

/**
 * Clamp a threshold value to valid range.
 */
export function clampThreshold(
  value: number,
  config: AdaptiveThresholdConfig = DEFAULT_CONFIG
): number {
  return Math.max(config.thresholdMin, Math.min(config.thresholdMax, value));
}

/**
 * Compute adaptive edge threshold based on current cluster count.
 *
 * Strategy:
 * - Too many clusters (>14): Relax threshold to encourage merging
 * - Too few clusters (<10): Tighten threshold to prevent over-merging
 * - Goldilocks zone (10-14): Use base threshold
 *
 * @param clusterCount - Current number of clusters
 * @param config - Configuration parameters
 * @returns Adjusted edge threshold, clamped to [0.55, 0.80]
 */
export function computeAdaptiveEdgeThreshold(
  clusterCount: number,
  config: AdaptiveThresholdConfig = DEFAULT_CONFIG
): number {
  let threshold = config.baseEdgeThreshold;

  if (clusterCount > config.maxClusters) {
    // Too many clusters - relax threshold to encourage merging
    threshold -= config.edgeAdjustStep;
  } else if (clusterCount < config.minClusters) {
    // Too few clusters - tighten threshold to prevent over-merging
    threshold += config.edgeAdjustStep;
  }
  // Else: in the sweet spot, use base threshold

  return clampThreshold(threshold, config);
}

/**
 * Compute average quality score for a cluster.
 *
 * @param members - Cluster members with optional quality scores
 * @param defaultQuality - Quality to use when missing (default 1.0)
 * @returns Mean quality score
 */
export function computeClusterAverageQuality(
  members: { quality?: number }[],
  defaultQuality: number = 1.0
): number {
  if (members.length === 0) return defaultQuality;

  let totalQuality = 0;
  for (const member of members) {
    totalQuality += member.quality ?? defaultQuality;
  }

  return totalQuality / members.length;
}

/**
 * Compute quality-adjusted cohesion threshold for a cluster.
 *
 * Strategy:
 * - High quality (>0.75): Stricter cohesion (0.55) - we can afford to be picky
 * - Medium quality (0.50-0.75): Standard cohesion (0.60)
 * - Low quality (<0.50): Looser cohesion (0.70) - be permissive to avoid over-fragmentation
 *
 * Note: When merging two clusters, use the stricter (higher) of the two thresholds
 * to ensure both clusters maintain their quality standards.
 *
 * @param avgClusterQuality - Mean quality score for the cluster
 * @param config - Configuration parameters
 * @returns Cohesion threshold, clamped to [0.55, 0.80]
 */
export function computeClusterCohesionThreshold(
  avgClusterQuality: number,
  config: AdaptiveThresholdConfig = DEFAULT_CONFIG
): number {
  let cohesion: number;

  if (avgClusterQuality > config.highQualityThreshold) {
    // High quality - use strict cohesion
    cohesion = config.highQualityCohesion;
  } else if (avgClusterQuality >= config.lowQualityThreshold) {
    // Medium quality - use standard cohesion
    cohesion = config.mediumQualityCohesion;
  } else {
    // Low quality - use loose cohesion to avoid over-fragmentation
    cohesion = config.lowQualityCohesion;
  }

  return clampThreshold(cohesion, config);
}
