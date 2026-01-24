/**
 * Unit tests for adaptive thresholds module.
 *
 * Covers:
 * - Edge threshold adaptation based on cluster count
 * - Threshold clamping to [0.55, 0.80]
 * - Quality-adjusted cohesion thresholds
 * - Cluster average quality calculation
 * - Stricter cohesion selection
 */

import {
  computeAdaptiveEdgeThreshold,
  computeClusterCohesionThreshold,
  computeClusterAverageQuality,
  clampThreshold,
  DEFAULT_CONFIG
} from '../adaptiveThresholds';

describe('adaptiveThresholds', () => {
  describe('clampThreshold', () => {
    it('should clamp values below minimum', () => {
      expect(clampThreshold(0.3)).toBe(0.55);
    });

    it('should clamp values above maximum', () => {
      expect(clampThreshold(0.9)).toBe(0.80);
    });

    it('should not clamp values within range', () => {
      expect(clampThreshold(0.65)).toBe(0.65);
    });
  });

  describe('computeAdaptiveEdgeThreshold', () => {
    it('should use base threshold for cluster count in sweet spot', () => {
      // 10-14 clusters: use base threshold (0.68)
      expect(computeAdaptiveEdgeThreshold(10)).toBe(0.68);
      expect(computeAdaptiveEdgeThreshold(12)).toBe(0.68);
      expect(computeAdaptiveEdgeThreshold(14)).toBe(0.68);
    });

    it('should relax threshold for too many clusters', () => {
      // >14 clusters: relax by 0.05 → 0.63
      expect(computeAdaptiveEdgeThreshold(15)).toBe(0.63);
      expect(computeAdaptiveEdgeThreshold(20)).toBe(0.63);
    });

    it('should tighten threshold for too few clusters', () => {
      // <10 clusters: tighten by 0.05 → 0.73
      expect(computeAdaptiveEdgeThreshold(9)).toBeCloseTo(0.73, 2);
      expect(computeAdaptiveEdgeThreshold(5)).toBeCloseTo(0.73, 2);
    });

    it('should clamp adjusted threshold to minimum', () => {
      // Very high cluster count should clamp to 0.55
      const config = { ...DEFAULT_CONFIG, baseEdgeThreshold: 0.56, edgeAdjustStep: 0.05 };
      expect(computeAdaptiveEdgeThreshold(20, config)).toBe(0.55); // 0.56 - 0.05 = 0.51 → clamped to 0.55
    });

    it('should clamp adjusted threshold to maximum', () => {
      // Very low cluster count should clamp to 0.80
      const config = { ...DEFAULT_CONFIG, baseEdgeThreshold: 0.76, edgeAdjustStep: 0.05 };
      expect(computeAdaptiveEdgeThreshold(5, config)).toBe(0.80); // 0.76 + 0.05 = 0.81 → clamped to 0.80
    });
  });

  describe('computeClusterAverageQuality', () => {
    it('should compute mean quality when all members have quality', () => {
      const members = [
        { quality: 0.8 },
        { quality: 0.6 },
        { quality: 0.9 }
      ];
      expect(computeClusterAverageQuality(members)).toBeCloseTo(0.767, 2);
    });

    it('should use default quality (1.0) when quality is missing', () => {
      const members = [
        { quality: 0.8 },
        {},  // Missing quality
        { quality: 0.6 }
      ];
      // (0.8 + 1.0 + 0.6) / 3 = 0.8
      expect(computeClusterAverageQuality(members)).toBeCloseTo(0.8, 2);
    });

    it('should return default quality for empty cluster', () => {
      expect(computeClusterAverageQuality([])).toBe(1.0);
    });

    it('should support custom default quality', () => {
      const members = [{}];
      expect(computeClusterAverageQuality(members, 0.5)).toBe(0.5);
    });
  });

  describe('computeClusterCohesionThreshold', () => {
    it('should use strict cohesion for high quality (>0.75)', () => {
      expect(computeClusterCohesionThreshold(0.8)).toBe(0.55);
      expect(computeClusterCohesionThreshold(0.9)).toBe(0.55);
    });

    it('should use standard cohesion for medium quality (0.50-0.75)', () => {
      // Quality exactly at 0.75 uses medium-quality cohesion (0.60) since threshold is >0.75
      expect(computeClusterCohesionThreshold(0.75)).toBe(0.60);
      // Just above 0.75 triggers high-quality cohesion (0.55)
      expect(computeClusterCohesionThreshold(0.751)).toBe(0.55);
      expect(computeClusterCohesionThreshold(0.65)).toBe(0.60);
      expect(computeClusterCohesionThreshold(0.50)).toBe(0.60);
    });

    it('should use loose cohesion for low quality (<0.50)', () => {
      expect(computeClusterCohesionThreshold(0.49)).toBe(0.70);
      expect(computeClusterCohesionThreshold(0.30)).toBe(0.70);
      expect(computeClusterCohesionThreshold(0.10)).toBe(0.70);
    });

    it('should clamp cohesion to valid range', () => {
      // Test with custom config that would exceed bounds
      const config = {
        ...DEFAULT_CONFIG,
        highQualityCohesion: 0.50,  // Would be valid
        lowQualityCohesion: 0.85    // Would exceed max (0.80)
      };
      expect(computeClusterCohesionThreshold(0.30, config)).toBe(0.80); // Clamped
    });
  });

  describe('stricter cohesion selection', () => {
    it('should document that caller uses Math.max for stricter threshold', () => {
      // When merging two clusters, use the stricter (higher) of the two thresholds
      const quality1 = 0.8;  // High quality → cohesion 0.55
      const quality2 = 0.4;  // Low quality → cohesion 0.70

      const cohesion1 = computeClusterCohesionThreshold(quality1);
      const cohesion2 = computeClusterCohesionThreshold(quality2);

      expect(cohesion1).toBe(0.55);
      expect(cohesion2).toBe(0.70);

      // Caller should use Math.max to get stricter threshold
      const stricterCohesion = Math.max(cohesion1, cohesion2);
      expect(stricterCohesion).toBe(0.70); // Use the higher (stricter) value
    });
  });

  describe('integration: realistic scenarios', () => {
    it('should adapt threshold down when too many clusters', () => {
      // Start with 20 clusters (too many)
      const threshold1 = computeAdaptiveEdgeThreshold(20);
      expect(threshold1).toBe(0.63); // Relaxed from 0.68

      // After merging to 12 clusters (sweet spot)
      const threshold2 = computeAdaptiveEdgeThreshold(12);
      expect(threshold2).toBe(0.68); // Back to base
    });

    it('should adapt threshold up when too few clusters', () => {
      // Start with 5 clusters (too few)
      const threshold1 = computeAdaptiveEdgeThreshold(5);
      expect(threshold1).toBeCloseTo(0.73, 2); // Tightened from 0.68

      // After splitting to 11 clusters (sweet spot)
      const threshold2 = computeAdaptiveEdgeThreshold(11);
      expect(threshold2).toBe(0.68); // Back to base
    });

    it('should converge within 3 iterations for typical case', () => {
      // Simulate iterative refinement
      let clusterCount = 20; // Start with over-fragmentation
      const iterations: number[] = [];

      for (let i = 0; i < 3; i++) {
        const threshold = computeAdaptiveEdgeThreshold(clusterCount);
        iterations.push(threshold);

        // Simulate clustering result (threshold affects cluster count)
        if (threshold < 0.68) {
          // Relaxed threshold → more merging → fewer clusters
          clusterCount = Math.max(10, Math.floor(clusterCount * 0.7));
        } else if (threshold > 0.68) {
          // Tightened threshold → less merging → more clusters
          clusterCount = Math.min(14, Math.ceil(clusterCount * 1.3));
        } else {
          // At base threshold, assume convergence
          break;
        }
      }

      // Should converge (reach sweet spot or stop changing)
      expect(iterations.length).toBeLessThanOrEqual(3);
      expect(clusterCount).toBeGreaterThanOrEqual(10);
      expect(clusterCount).toBeLessThanOrEqual(14);
    });

    it('should handle quality-adjusted cohesion for mixed-quality clusters', () => {
      // High-quality cluster (strict cohesion)
      const members1 = [
        { quality: 0.85 },
        { quality: 0.90 },
        { quality: 0.88 }
      ];
      const quality1 = computeClusterAverageQuality(members1);
      const cohesion1 = computeClusterCohesionThreshold(quality1);

      expect(quality1).toBeCloseTo(0.877, 2);
      expect(cohesion1).toBe(0.55); // High quality → strict

      // Low-quality cluster (loose cohesion)
      const members2 = [
        { quality: 0.35 },
        { quality: 0.40 },
        { quality: 0.38 }
      ];
      const quality2 = computeClusterAverageQuality(members2);
      const cohesion2 = computeClusterCohesionThreshold(quality2);

      expect(quality2).toBeCloseTo(0.377, 2);
      expect(cohesion2).toBe(0.70); // Low quality → loose

      // When merging, use stricter (higher) threshold
      const effectiveCohesion = Math.max(cohesion1, cohesion2);
      expect(effectiveCohesion).toBe(0.70); // Protect low-quality cluster from over-merging
    });
  });
});
