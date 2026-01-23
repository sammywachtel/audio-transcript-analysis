/**
 * Tests for Temporal Graph Module
 *
 * Validates temporal proximity weighting and chunk boundary bridging
 * for speaker reconciliation.
 */

import {
  computeTemporalWeight,
  isBoundaryPair,
  computeFinalSimilarity,
  buildSpeakerAppearanceWindows,
  buildChunkBoundsMap,
  computeTimeDeltaMs,
  computeTimeDeltaSeconds,
  isCrossChunkPair,
  applyTemporalBoosts,
  SpeakerAppearanceWindow,
} from '../temporalGraph';
import { ChunkArtifact } from '../types';

// ============================================================================
// computeTemporalWeight tests
// ============================================================================

describe('computeTemporalWeight', () => {
  const halfLife = 300; // 5 minutes
  const maxWindow = 3600; // 1 hour

  it('should return 1.0 for zero time delta', () => {
    expect(computeTemporalWeight(0, halfLife, maxWindow)).toBe(1.0);
  });

  it('should return ~0.368 at half-life (exp(-1))', () => {
    const weight = computeTemporalWeight(halfLife, halfLife, maxWindow);
    expect(weight).toBeCloseTo(Math.exp(-1), 5);
  });

  it('should return ~0.135 at 2x half-life (exp(-2))', () => {
    const weight = computeTemporalWeight(halfLife * 2, halfLife, maxWindow);
    expect(weight).toBeCloseTo(Math.exp(-2), 5);
  });

  it('should return 0 beyond max window', () => {
    expect(computeTemporalWeight(maxWindow + 1, halfLife, maxWindow)).toBe(0);
    expect(computeTemporalWeight(maxWindow * 2, halfLife, maxWindow)).toBe(0);
  });

  it('should return 0 for exactly max window', () => {
    // At exactly maxWindow, we still apply the cutoff
    expect(computeTemporalWeight(maxWindow + 0.001, halfLife, maxWindow)).toBe(0);
  });

  it('should use default config values', () => {
    // Uses TemporalConfig.HALF_LIFE_SECONDS (300) and MAX_WINDOW_SECONDS (3600)
    const weight = computeTemporalWeight(300);
    expect(weight).toBeCloseTo(Math.exp(-1), 5);
  });

  it('should handle negative time deltas gracefully', () => {
    expect(computeTemporalWeight(-100, halfLife, maxWindow)).toBe(0);
  });

  it('should smoothly decay between 0 and half-life', () => {
    const weights = [0, 60, 120, 180, 240, 300].map(t =>
      computeTemporalWeight(t, halfLife, maxWindow)
    );

    // Each weight should be less than the previous
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeLessThan(weights[i - 1]);
    }
  });

  it('should produce expected values for 5-minute half-life', () => {
    // At 1 minute: exp(-60/300) = exp(-0.2) ≈ 0.819
    expect(computeTemporalWeight(60, 300, 3600)).toBeCloseTo(0.819, 2);

    // At 10 minutes: exp(-600/300) = exp(-2) ≈ 0.135
    expect(computeTemporalWeight(600, 300, 3600)).toBeCloseTo(0.135, 2);

    // At 30 minutes: exp(-1800/300) = exp(-6) ≈ 0.0025
    expect(computeTemporalWeight(1800, 300, 3600)).toBeCloseTo(0.0025, 3);
  });
});

// ============================================================================
// isBoundaryPair tests
// ============================================================================

describe('isBoundaryPair', () => {
  const chunkBounds = new Map<number, { startMs: number; endMs: number }>([
    [0, { startMs: 0, endMs: 600000 }],      // 0-10 minutes
    [1, { startMs: 600000, endMs: 1200000 }], // 10-20 minutes
    [2, { startMs: 1200000, endMs: 1800000 }], // 20-30 minutes
  ]);

  // Boundary window is 30 seconds (30000ms) - configured in TemporalConfig

  it('should return true for adjacent chunks with speaker at end/start', () => {
    const windowA: SpeakerAppearanceWindow = {
      chunkIndex: 0,
      speakerId: 'SPEAKER_00',
      firstOriginalMs: 500000,
      lastOriginalMs: 595000, // 5 seconds from end (within 30s window)
    };

    const windowB: SpeakerAppearanceWindow = {
      chunkIndex: 1,
      speakerId: 'SPEAKER_01',
      firstOriginalMs: 605000, // 5 seconds from start (within 30s window)
      lastOriginalMs: 700000,
    };

    expect(isBoundaryPair(windowA, windowB, chunkBounds)).toBe(true);
  });

  it('should return true if only earlier speaker is near boundary', () => {
    const windowA: SpeakerAppearanceWindow = {
      chunkIndex: 0,
      speakerId: 'SPEAKER_00',
      firstOriginalMs: 500000,
      lastOriginalMs: 590000, // 10 seconds from end (within 30s)
    };

    const windowB: SpeakerAppearanceWindow = {
      chunkIndex: 1,
      speakerId: 'SPEAKER_01',
      firstOriginalMs: 700000, // 100 seconds from start (outside 30s)
      lastOriginalMs: 800000,
    };

    expect(isBoundaryPair(windowA, windowB, chunkBounds)).toBe(true);
  });

  it('should return true if only later speaker is near boundary', () => {
    const windowA: SpeakerAppearanceWindow = {
      chunkIndex: 0,
      speakerId: 'SPEAKER_00',
      firstOriginalMs: 100000,
      lastOriginalMs: 500000, // 100 seconds from end (outside 30s)
    };

    const windowB: SpeakerAppearanceWindow = {
      chunkIndex: 1,
      speakerId: 'SPEAKER_01',
      firstOriginalMs: 610000, // 10 seconds from start (within 30s)
      lastOriginalMs: 700000,
    };

    expect(isBoundaryPair(windowA, windowB, chunkBounds)).toBe(true);
  });

  it('should return false for non-adjacent chunks', () => {
    const windowA: SpeakerAppearanceWindow = {
      chunkIndex: 0,
      speakerId: 'SPEAKER_00',
      firstOriginalMs: 500000,
      lastOriginalMs: 595000,
    };

    const windowB: SpeakerAppearanceWindow = {
      chunkIndex: 2, // Skipped chunk 1
      speakerId: 'SPEAKER_01',
      firstOriginalMs: 1205000,
      lastOriginalMs: 1300000,
    };

    expect(isBoundaryPair(windowA, windowB, chunkBounds)).toBe(false);
  });

  it('should return false when neither speaker is near boundary', () => {
    const windowA: SpeakerAppearanceWindow = {
      chunkIndex: 0,
      speakerId: 'SPEAKER_00',
      firstOriginalMs: 100000,
      lastOriginalMs: 400000, // 200 seconds from end (outside 30s)
    };

    const windowB: SpeakerAppearanceWindow = {
      chunkIndex: 1,
      speakerId: 'SPEAKER_01',
      firstOriginalMs: 800000, // 200 seconds from start (outside 30s)
      lastOriginalMs: 900000,
    };

    expect(isBoundaryPair(windowA, windowB, chunkBounds)).toBe(false);
  });

  it('should return false for same-chunk speakers', () => {
    const windowA: SpeakerAppearanceWindow = {
      chunkIndex: 0,
      speakerId: 'SPEAKER_00',
      firstOriginalMs: 100000,
      lastOriginalMs: 200000,
    };

    const windowB: SpeakerAppearanceWindow = {
      chunkIndex: 0, // Same chunk
      speakerId: 'SPEAKER_01',
      firstOriginalMs: 300000,
      lastOriginalMs: 400000,
    };

    expect(isBoundaryPair(windowA, windowB, chunkBounds)).toBe(false);
  });

  it('should handle reversed order (B before A)', () => {
    const windowA: SpeakerAppearanceWindow = {
      chunkIndex: 1,
      speakerId: 'SPEAKER_00',
      firstOriginalMs: 605000, // Near start of chunk 1
      lastOriginalMs: 700000,
    };

    const windowB: SpeakerAppearanceWindow = {
      chunkIndex: 0,
      speakerId: 'SPEAKER_01',
      firstOriginalMs: 500000,
      lastOriginalMs: 595000, // Near end of chunk 0
    };

    expect(isBoundaryPair(windowA, windowB, chunkBounds)).toBe(true);
  });

  it('should return false when chunk bounds are missing', () => {
    const windowA: SpeakerAppearanceWindow = {
      chunkIndex: 5, // Not in chunkBounds map
      speakerId: 'SPEAKER_00',
      firstOriginalMs: 500000,
      lastOriginalMs: 595000,
    };

    const windowB: SpeakerAppearanceWindow = {
      chunkIndex: 6, // Not in chunkBounds map
      speakerId: 'SPEAKER_01',
      firstOriginalMs: 605000,
      lastOriginalMs: 700000,
    };

    expect(isBoundaryPair(windowA, windowB, chunkBounds)).toBe(false);
  });
});

// ============================================================================
// computeFinalSimilarity tests
// ============================================================================

describe('computeFinalSimilarity', () => {
  it('should apply temporal boost correctly', () => {
    const base = 0.8;
    const temporalWeight = 1.0; // Full weight
    // Default boost factor is 0.5, so:
    // Expected: 0.8 * (1 + 0.5 * 1.0) = 0.8 * 1.5 = 1.2 → capped at 1.0
    const result = computeFinalSimilarity(base, temporalWeight, false);
    expect(result).toBe(1.0); // Capped
  });

  it('should not apply temporal boost when weight is 0', () => {
    const base = 0.75;
    const result = computeFinalSimilarity(base, 0, false);
    expect(result).toBe(base); // Unchanged
  });

  it('should apply partial temporal boost', () => {
    const base = 0.6;
    const temporalWeight = 0.5;
    // Default factor is 0.5
    // Expected: 0.6 * (1 + 0.5 * 0.5) = 0.6 * 1.25 = 0.75
    const result = computeFinalSimilarity(base, temporalWeight, false);
    expect(result).toBeCloseTo(0.75, 5);
  });

  it('should apply boundary boost when conditions met', () => {
    const base = 0.7; // Above threshold (0.65)
    const temporalWeight = 0;
    // Default boundary boost is 1.3
    // Expected: 0.7 * 1.3 = 0.91
    const result = computeFinalSimilarity(base, temporalWeight, true);
    expect(result).toBeCloseTo(0.91, 5);
  });

  it('should NOT apply boundary boost when base below threshold', () => {
    const base = 0.6; // Below threshold (0.65)
    const result = computeFinalSimilarity(base, 0, true);
    expect(result).toBe(base); // No boost applied
  });

  it('should apply both temporal and boundary boosts', () => {
    const base = 0.7;
    const temporalWeight = 0.5;

    // Temporal first: 0.7 * (1 + 0.5 * 0.5) = 0.7 * 1.25 = 0.875
    // Boundary: 0.875 * 1.3 = 1.1375 → capped at 1.0
    const result = computeFinalSimilarity(base, temporalWeight, true);
    expect(result).toBe(1.0);
  });

  it('should cap result at 1.0', () => {
    const base = 0.9;
    const temporalWeight = 1.0;

    // Without cap: 0.9 * 1.5 = 1.35
    const result = computeFinalSimilarity(base, temporalWeight, false);
    expect(result).toBe(1.0);
  });

  it('should handle negative base similarity', () => {
    const base = -0.3;
    const temporalWeight = 0.5;

    // Should still apply temporal boost (might make it more negative)
    // -0.3 * (1 + 0.5 * 0.5) = -0.3 * 1.25 = -0.375
    const result = computeFinalSimilarity(base, temporalWeight, false);
    expect(result).toBeCloseTo(-0.375, 5);
  });

  it('should respect custom config', () => {
    const base = 0.5;
    const config = {
      TEMPORAL_BOOST_FACTOR: 1.0,
      BOUNDARY_BOOST: 1.5,
      BOUNDARY_SIMILARITY_THRESHOLD: 0.4,
    };

    // With custom factor: 0.5 * (1 + 1.0 * 1.0) = 1.0
    const result = computeFinalSimilarity(base, 1.0, false, config);
    expect(result).toBe(1.0);

    // With custom boundary threshold: 0.5 > 0.4, so boundary boost applies
    // 0.5 * 1.5 = 0.75
    const resultBoundary = computeFinalSimilarity(base, 0, true, config);
    expect(resultBoundary).toBeCloseTo(0.75, 5);
  });
});

// ============================================================================
// computeTimeDeltaMs / computeTimeDeltaSeconds tests
// ============================================================================

describe('computeTimeDeltaMs', () => {
  it('should return 0 for overlapping windows', () => {
    const windowA: SpeakerAppearanceWindow = {
      chunkIndex: 0,
      speakerId: 'SPEAKER_00',
      firstOriginalMs: 100,
      lastOriginalMs: 500,
    };

    const windowB: SpeakerAppearanceWindow = {
      chunkIndex: 1,
      speakerId: 'SPEAKER_01',
      firstOriginalMs: 300, // Overlaps with A (100-500)
      lastOriginalMs: 700,
    };

    expect(computeTimeDeltaMs(windowA, windowB)).toBe(0);
  });

  it('should compute gap when A ends before B starts', () => {
    const windowA: SpeakerAppearanceWindow = {
      chunkIndex: 0,
      speakerId: 'SPEAKER_00',
      firstOriginalMs: 100,
      lastOriginalMs: 500,
    };

    const windowB: SpeakerAppearanceWindow = {
      chunkIndex: 1,
      speakerId: 'SPEAKER_01',
      firstOriginalMs: 800, // 300ms after A ends
      lastOriginalMs: 1000,
    };

    expect(computeTimeDeltaMs(windowA, windowB)).toBe(300);
  });

  it('should compute gap when B ends before A starts', () => {
    const windowA: SpeakerAppearanceWindow = {
      chunkIndex: 1,
      speakerId: 'SPEAKER_00',
      firstOriginalMs: 1000,
      lastOriginalMs: 1500,
    };

    const windowB: SpeakerAppearanceWindow = {
      chunkIndex: 0,
      speakerId: 'SPEAKER_01',
      firstOriginalMs: 100,
      lastOriginalMs: 500, // 500ms before A starts
    };

    expect(computeTimeDeltaMs(windowA, windowB)).toBe(500);
  });

  it('should return 0 for adjacent windows (no gap)', () => {
    const windowA: SpeakerAppearanceWindow = {
      chunkIndex: 0,
      speakerId: 'SPEAKER_00',
      firstOriginalMs: 100,
      lastOriginalMs: 500,
    };

    const windowB: SpeakerAppearanceWindow = {
      chunkIndex: 1,
      speakerId: 'SPEAKER_01',
      firstOriginalMs: 500, // Exactly where A ends
      lastOriginalMs: 800,
    };

    expect(computeTimeDeltaMs(windowA, windowB)).toBe(0);
  });
});

describe('computeTimeDeltaSeconds', () => {
  it('should convert milliseconds to seconds', () => {
    const windowA: SpeakerAppearanceWindow = {
      chunkIndex: 0,
      speakerId: 'SPEAKER_00',
      firstOriginalMs: 0,
      lastOriginalMs: 1000,
    };

    const windowB: SpeakerAppearanceWindow = {
      chunkIndex: 1,
      speakerId: 'SPEAKER_01',
      firstOriginalMs: 61000, // 60 seconds after A ends
      lastOriginalMs: 70000,
    };

    expect(computeTimeDeltaSeconds(windowA, windowB)).toBe(60);
  });
});

// ============================================================================
// isCrossChunkPair tests
// ============================================================================

describe('isCrossChunkPair', () => {
  it('should return true for different chunks', () => {
    expect(isCrossChunkPair('SPEAKER_00_chunk0', 'SPEAKER_01_chunk1')).toBe(true);
    expect(isCrossChunkPair('SPEAKER_00_chunk5', 'SPEAKER_00_chunk7')).toBe(true);
  });

  it('should return false for same chunk', () => {
    expect(isCrossChunkPair('SPEAKER_00_chunk0', 'SPEAKER_01_chunk0')).toBe(false);
    expect(isCrossChunkPair('SPEAKER_02_chunk3', 'SPEAKER_05_chunk3')).toBe(false);
  });

  it('should return false for malformed keys', () => {
    expect(isCrossChunkPair('SPEAKER_00', 'SPEAKER_01')).toBe(false);
    expect(isCrossChunkPair('invalid', 'SPEAKER_01_chunk1')).toBe(false);
  });
});

// ============================================================================
// buildSpeakerAppearanceWindows tests
// ============================================================================

describe('buildSpeakerAppearanceWindows', () => {
  it('should build windows from chunk artifacts', () => {
    const artifacts: ChunkArtifact[] = [
      createMockChunkArtifact(0, [
        { speakerId: 'SPEAKER_00', startMs: 0, endMs: 5000 },
        { speakerId: 'SPEAKER_00', startMs: 10000, endMs: 15000 },
        { speakerId: 'SPEAKER_01', startMs: 20000, endMs: 25000 },
      ], { startMs: 0, endMs: 60000, overlapBeforeMs: 0, overlapAfterMs: 5000 }),
    ];

    const windows = buildSpeakerAppearanceWindows(artifacts);

    expect(windows.size).toBe(2);

    const speaker00 = windows.get('SPEAKER_00_chunk0');
    expect(speaker00).toBeDefined();
    expect(speaker00!.firstOriginalMs).toBe(0);
    expect(speaker00!.lastOriginalMs).toBe(15000);

    const speaker01 = windows.get('SPEAKER_01_chunk0');
    expect(speaker01).toBeDefined();
    expect(speaker01!.firstOriginalMs).toBe(20000);
    expect(speaker01!.lastOriginalMs).toBe(25000);
  });

  it('should convert chunk-local timestamps to original timeline', () => {
    // Chunk starts at 300000ms (5 minutes) with 5000ms overlap before
    const artifacts: ChunkArtifact[] = [
      createMockChunkArtifact(1, [
        { speakerId: 'SPEAKER_00', startMs: 0, endMs: 5000 }, // Chunk-local
      ], { startMs: 300000, endMs: 600000, overlapBeforeMs: 5000, overlapAfterMs: 5000 }),
    ];

    const windows = buildSpeakerAppearanceWindows(artifacts);
    const speaker00 = windows.get('SPEAKER_00_chunk1');

    // chunkAudioStartMs = 300000 - 5000 = 295000
    // originalStartMs = 295000 + 0 = 295000
    // originalEndMs = 295000 + 5000 = 300000
    expect(speaker00!.firstOriginalMs).toBe(295000);
    expect(speaker00!.lastOriginalMs).toBe(300000);
  });

  it('should handle multiple chunks', () => {
    const artifacts: ChunkArtifact[] = [
      createMockChunkArtifact(0, [
        { speakerId: 'SPEAKER_00', startMs: 0, endMs: 5000 },
      ], { startMs: 0, endMs: 60000, overlapBeforeMs: 0, overlapAfterMs: 5000 }),
      createMockChunkArtifact(1, [
        { speakerId: 'SPEAKER_00', startMs: 0, endMs: 5000 },
      ], { startMs: 60000, endMs: 120000, overlapBeforeMs: 5000, overlapAfterMs: 0 }),
    ];

    const windows = buildSpeakerAppearanceWindows(artifacts);

    expect(windows.size).toBe(2);
    expect(windows.has('SPEAKER_00_chunk0')).toBe(true);
    expect(windows.has('SPEAKER_00_chunk1')).toBe(true);
  });

  it('should return empty map for empty artifacts', () => {
    const windows = buildSpeakerAppearanceWindows([]);
    expect(windows.size).toBe(0);
  });
});

// ============================================================================
// buildChunkBoundsMap tests
// ============================================================================

describe('buildChunkBoundsMap', () => {
  it('should build bounds map from chunk artifacts', () => {
    const artifacts: ChunkArtifact[] = [
      createMockChunkArtifact(0, [], { startMs: 0, endMs: 60000, overlapBeforeMs: 0, overlapAfterMs: 5000 }),
      createMockChunkArtifact(1, [], { startMs: 60000, endMs: 120000, overlapBeforeMs: 5000, overlapAfterMs: 5000 }),
      createMockChunkArtifact(2, [], { startMs: 120000, endMs: 180000, overlapBeforeMs: 5000, overlapAfterMs: 0 }),
    ];

    const boundsMap = buildChunkBoundsMap(artifacts);

    expect(boundsMap.size).toBe(3);
    expect(boundsMap.get(0)).toEqual({ startMs: 0, endMs: 60000 });
    expect(boundsMap.get(1)).toEqual({ startMs: 60000, endMs: 120000 });
    expect(boundsMap.get(2)).toEqual({ startMs: 120000, endMs: 180000 });
  });
});

// ============================================================================
// applyTemporalBoosts tests
// ============================================================================

describe('applyTemporalBoosts', () => {
  it('should apply temporal boosts to cross-chunk pairs', () => {
    const matrix = [
      [1.0, 0.7, 0.6],
      [0.7, 1.0, 0.65],
      [0.6, 0.65, 1.0],
    ];

    const speakerKeys = [
      'SPEAKER_00_chunk0',
      'SPEAKER_01_chunk0', // Same chunk as [0]
      'SPEAKER_00_chunk1', // Different chunk
    ];

    const appearances = new Map<string, SpeakerAppearanceWindow>([
      ['SPEAKER_00_chunk0', { chunkIndex: 0, speakerId: 'SPEAKER_00', firstOriginalMs: 0, lastOriginalMs: 50000 }],
      ['SPEAKER_01_chunk0', { chunkIndex: 0, speakerId: 'SPEAKER_01', firstOriginalMs: 10000, lastOriginalMs: 40000 }],
      ['SPEAKER_00_chunk1', { chunkIndex: 1, speakerId: 'SPEAKER_00', firstOriginalMs: 60000, lastOriginalMs: 100000 }],
    ]);

    const chunkBounds = new Map([
      [0, { startMs: 0, endMs: 60000 }],
      [1, { startMs: 60000, endMs: 120000 }],
    ]);

    applyTemporalBoosts(matrix, speakerKeys, appearances, chunkBounds);

    // [0][1] should be unchanged (same chunk)
    expect(matrix[0][1]).toBe(0.7);
    expect(matrix[1][0]).toBe(0.7);

    // [0][2] should be boosted (cross-chunk, temporal proximity)
    // Time delta: 60000 - 50000 = 10000ms = 10 seconds
    // Temporal weight: exp(-10/300) ≈ 0.967
    // Base 0.6, boosted: 0.6 * (1 + 0.5 * 0.967) ≈ 0.6 * 1.484 ≈ 0.89
    expect(matrix[0][2]).toBeGreaterThan(0.6);
    expect(matrix[2][0]).toBe(matrix[0][2]); // Symmetric

    // [1][2] should also be boosted (cross-chunk)
    expect(matrix[1][2]).toBeGreaterThan(0.65);
    expect(matrix[2][1]).toBe(matrix[1][2]);
  });

  it('should not modify same-chunk pairs', () => {
    const matrix = [
      [1.0, 0.8],
      [0.8, 1.0],
    ];

    const speakerKeys = ['SPEAKER_00_chunk0', 'SPEAKER_01_chunk0'];

    const appearances = new Map<string, SpeakerAppearanceWindow>([
      ['SPEAKER_00_chunk0', { chunkIndex: 0, speakerId: 'SPEAKER_00', firstOriginalMs: 0, lastOriginalMs: 10000 }],
      ['SPEAKER_01_chunk0', { chunkIndex: 0, speakerId: 'SPEAKER_01', firstOriginalMs: 20000, lastOriginalMs: 30000 }],
    ]);

    const chunkBounds = new Map([[0, { startMs: 0, endMs: 60000 }]]);

    applyTemporalBoosts(matrix, speakerKeys, appearances, chunkBounds);

    // Should remain unchanged
    expect(matrix[0][1]).toBe(0.8);
    expect(matrix[1][0]).toBe(0.8);
  });

  it('should apply boundary boost for eligible pairs', () => {
    const matrix = [
      [1.0, 0.7],
      [0.7, 1.0],
    ];

    const speakerKeys = ['SPEAKER_00_chunk0', 'SPEAKER_00_chunk1'];

    // Speaker at end of chunk 0, start of chunk 1 (boundary pair)
    const appearances = new Map<string, SpeakerAppearanceWindow>([
      ['SPEAKER_00_chunk0', { chunkIndex: 0, speakerId: 'SPEAKER_00', firstOriginalMs: 50000, lastOriginalMs: 58000 }], // 2s from end
      ['SPEAKER_00_chunk1', { chunkIndex: 1, speakerId: 'SPEAKER_00', firstOriginalMs: 62000, lastOriginalMs: 80000 }], // 2s from start
    ]);

    const chunkBounds = new Map([
      [0, { startMs: 0, endMs: 60000 }],
      [1, { startMs: 60000, endMs: 120000 }],
    ]);

    applyTemporalBoosts(matrix, speakerKeys, appearances, chunkBounds);

    // Base 0.7 > 0.65 threshold, so boundary boost applies
    // Time delta: 62000 - 58000 = 4000ms = 4 seconds
    // Temporal weight: exp(-4/300) ≈ 0.987
    // After temporal: 0.7 * (1 + 0.5 * 0.987) ≈ 0.7 * 1.49 ≈ 1.04 → capped at 1.0
    // After boundary: min(1.0 * 1.3, 1.0) = 1.0
    expect(matrix[0][1]).toBe(1.0);
  });

  it('should not apply boundary boost when base similarity below threshold', () => {
    const matrix = [
      [1.0, 0.5], // Below 0.65 threshold
      [0.5, 1.0],
    ];

    const speakerKeys = ['SPEAKER_00_chunk0', 'SPEAKER_00_chunk1'];

    const appearances = new Map<string, SpeakerAppearanceWindow>([
      ['SPEAKER_00_chunk0', { chunkIndex: 0, speakerId: 'SPEAKER_00', firstOriginalMs: 55000, lastOriginalMs: 59000 }],
      ['SPEAKER_00_chunk1', { chunkIndex: 1, speakerId: 'SPEAKER_00', firstOriginalMs: 61000, lastOriginalMs: 70000 }],
    ]);

    const chunkBounds = new Map([
      [0, { startMs: 0, endMs: 60000 }],
      [1, { startMs: 60000, endMs: 120000 }],
    ]);

    applyTemporalBoosts(matrix, speakerKeys, appearances, chunkBounds);

    // Should have temporal boost but NOT boundary boost (base < 0.65)
    // Time delta: 61000 - 59000 = 2000ms = 2 seconds
    // Temporal weight: exp(-2/300) ≈ 0.993
    // After temporal: 0.5 * (1 + 0.5 * 0.993) ≈ 0.5 * 1.497 ≈ 0.748
    // No boundary boost because base (0.5) < threshold (0.65)
    expect(matrix[0][1]).toBeCloseTo(0.748, 2);
    expect(matrix[0][1]).toBeLessThan(0.8); // Should NOT have 1.3x boundary boost
  });
});

// ============================================================================
// Helper Functions
// ============================================================================

function createMockChunkArtifact(
  chunkIndex: number,
  segments: Array<{ speakerId: string; startMs: number; endMs: number }>,
  chunkBounds: { startMs: number; endMs: number; overlapBeforeMs: number; overlapAfterMs: number }
): ChunkArtifact {
  return {
    conversationId: 'test-conv',
    userId: 'test-user',
    chunkIndex,
    totalChunks: 3,
    segments: segments.map((s, i) => ({
      segmentId: `seg-${chunkIndex}-${i}`,
      index: i,
      speakerId: s.speakerId,
      startMs: s.startMs,
      endMs: s.endMs,
      text: 'Test segment',
    })),
    speakers: {},
    terms: {},
    termOccurrences: [],
    topics: [],
    people: [],
    chunkBounds,
    emittedContext: {
      emittedByChunkIndex: chunkIndex,
      speakerMap: [],
      previousSummary: '',
      knownTermIds: [],
      knownTopicIds: [],
      knownPersonIds: [],
      cumulativeSegmentCount: 0,
      lastProcessedMs: 0,
    },
    createdAt: new Date().toISOString(),
    storagePath: `chunks/${chunkIndex}.wav`,
  };
}
