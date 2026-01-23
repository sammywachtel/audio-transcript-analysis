/**
 * Temporal Graph Module for Speaker Reconciliation
 *
 * Provides temporal proximity weighting and chunk boundary bridging
 * to improve embedding-based speaker matching across chunks.
 *
 * Key concepts:
 * - Temporal weight: exponential decay based on time since last appearance
 * - Boundary bridging: boost for speakers at chunk boundaries (where splits are artificial)
 * - Final similarity: combines base cosine similarity with temporal and boundary boosts
 */

import { ChunkArtifact, Segment } from './types';

// ============================================================================
// Configuration
// ============================================================================

export const TemporalConfig = {
  /** Half-life for temporal decay in seconds (5 minutes) */
  HALF_LIFE_SECONDS: 300,

  /** Maximum temporal window in seconds (1 hour) - no boost beyond this */
  MAX_WINDOW_SECONDS: 3600,

  /** Temporal boost factor: final = base * (1 + factor * weight) */
  TEMPORAL_BOOST_FACTOR: 0.5,

  /** Window from chunk boundary to consider "boundary adjacent" (seconds) */
  BOUNDARY_WINDOW_SECONDS: 30,

  /** Boundary bridge boost multiplier (30% boost) */
  BOUNDARY_BOOST: 1.3,

  /** Minimum base similarity required for boundary boost */
  BOUNDARY_SIMILARITY_THRESHOLD: 0.65,
};

// ============================================================================
// Types
// ============================================================================

/**
 * Appearance window for a speaker in a chunk.
 * Timestamps are in original audio timeline (milliseconds).
 */
export interface SpeakerAppearanceWindow {
  /** Chunk index where this speaker appeared */
  chunkIndex: number;
  /** Speaker ID within the chunk (e.g., "SPEAKER_00") */
  speakerId: string;
  /** First appearance in original timeline (ms) */
  firstOriginalMs: number;
  /** Last appearance in original timeline (ms) */
  lastOriginalMs: number;
}

/**
 * Key for identifying a unique (chunk, speaker) pair.
 * Format: "SPEAKER_00_chunk0"
 */
export type SpeakerChunkKey = string;

// ============================================================================
// Core Temporal Functions
// ============================================================================

/**
 * Compute temporal weight based on time delta using exponential decay.
 *
 * Formula: weight = exp(-timeDelta / halfLife)
 *
 * Returns 0 if timeDelta exceeds maxWindow (temporal boost disabled).
 *
 * @param timeDeltaSeconds - Absolute time difference between speaker appearances (seconds)
 * @param halfLifeSeconds - Half-life for decay (default 300s = 5 minutes)
 * @param maxWindowSeconds - Maximum window for temporal boost (default 3600s = 1 hour)
 * @returns Temporal weight in [0, 1]
 */
export function computeTemporalWeight(
  timeDeltaSeconds: number,
  halfLifeSeconds: number = TemporalConfig.HALF_LIFE_SECONDS,
  maxWindowSeconds: number = TemporalConfig.MAX_WINDOW_SECONDS
): number {
  // No temporal boost for very distant appearances
  if (timeDeltaSeconds > maxWindowSeconds) {
    return 0;
  }

  // Negative time deltas shouldn't happen, but handle gracefully
  if (timeDeltaSeconds < 0) {
    return 0;
  }

  // Same-time appearances get full weight
  if (timeDeltaSeconds === 0) {
    return 1;
  }

  // Exponential decay: weight = exp(-t / τ)
  // At t = halfLife, weight = exp(-1) ≈ 0.368
  return Math.exp(-timeDeltaSeconds / halfLifeSeconds);
}

/**
 * Check if two speakers form a "boundary pair" eligible for boundary bridging.
 *
 * Conditions:
 * 1. They are in adjacent chunks (|chunkA - chunkB| === 1)
 * 2. At least one speaker is within BOUNDARY_WINDOW_SECONDS of the chunk boundary
 *
 * @param windowA - Speaker appearance window in chunk A
 * @param windowB - Speaker appearance window in chunk B
 * @param chunkBounds - Chunk boundary info for both chunks (keyed by chunkIndex)
 * @returns True if this is a valid boundary pair
 */
export function isBoundaryPair(
  windowA: SpeakerAppearanceWindow,
  windowB: SpeakerAppearanceWindow,
  chunkBounds: Map<number, { startMs: number; endMs: number }>
): boolean {
  // Must be adjacent chunks
  const chunkDiff = Math.abs(windowA.chunkIndex - windowB.chunkIndex);
  if (chunkDiff !== 1) {
    return false;
  }

  // Determine which is the earlier chunk
  const [earlier, later] = windowA.chunkIndex < windowB.chunkIndex
    ? [windowA, windowB]
    : [windowB, windowA];

  const earlierBounds = chunkBounds.get(earlier.chunkIndex);
  const laterBounds = chunkBounds.get(later.chunkIndex);

  if (!earlierBounds || !laterBounds) {
    return false;
  }

  const boundaryWindowMs = TemporalConfig.BOUNDARY_WINDOW_SECONDS * 1000;

  // Earlier speaker should be near the END of their chunk
  const earlierDistanceFromEnd = earlierBounds.endMs - earlier.lastOriginalMs;
  const earlierNearBoundary = earlierDistanceFromEnd <= boundaryWindowMs;

  // Later speaker should be near the START of their chunk
  const laterDistanceFromStart = later.firstOriginalMs - laterBounds.startMs;
  const laterNearBoundary = laterDistanceFromStart <= boundaryWindowMs;

  // At least one must be near the boundary
  return earlierNearBoundary || laterNearBoundary;
}

/**
 * Compute final similarity with temporal and boundary boosts.
 *
 * Combines:
 * 1. Base similarity (quality-weighted cosine)
 * 2. Temporal proximity boost (if within temporal window)
 * 3. Boundary bridge boost (if adjacent chunks + near boundary + high similarity)
 *
 * @param baseSimilarity - Quality-weighted cosine similarity (may be negative)
 * @param temporalWeight - Temporal weight from computeTemporalWeight [0,1]
 * @param isBoundary - Whether this is a boundary pair
 * @param config - Optional config override
 * @returns Final boosted similarity, capped at 1.0
 */
export function computeFinalSimilarity(
  baseSimilarity: number,
  temporalWeight: number,
  isBoundary: boolean,
  config: Partial<typeof TemporalConfig> = {}
): number {
  const boostFactor = config.TEMPORAL_BOOST_FACTOR ?? TemporalConfig.TEMPORAL_BOOST_FACTOR;
  const boundaryBoost = config.BOUNDARY_BOOST ?? TemporalConfig.BOUNDARY_BOOST;
  const boundaryThreshold = config.BOUNDARY_SIMILARITY_THRESHOLD ?? TemporalConfig.BOUNDARY_SIMILARITY_THRESHOLD;

  let finalSimilarity = baseSimilarity;

  // Apply temporal boost: final = base * (1 + factor * weight)
  // Only applies if there's actual temporal proximity (weight > 0)
  if (temporalWeight > 0) {
    finalSimilarity = baseSimilarity * (1 + boostFactor * temporalWeight);
  }

  // Apply boundary boost if eligible
  // Must be a boundary pair AND base similarity must be above threshold
  if (isBoundary && baseSimilarity > boundaryThreshold) {
    finalSimilarity = finalSimilarity * boundaryBoost;
  }

  // Cap at 1.0 to maintain similarity semantics
  return Math.min(1.0, finalSimilarity);
}

// ============================================================================
// Speaker Appearance Window Building
// ============================================================================

/**
 * Build speaker appearance windows from chunk artifacts.
 *
 * For each (chunk, speaker) pair, computes the first and last appearance
 * times in the original audio timeline.
 *
 * @param chunkArtifacts - Array of chunk artifacts with segments
 * @returns Map from SpeakerChunkKey to SpeakerAppearanceWindow
 */
export function buildSpeakerAppearanceWindows(
  chunkArtifacts: ChunkArtifact[]
): Map<SpeakerChunkKey, SpeakerAppearanceWindow> {
  const windows = new Map<SpeakerChunkKey, SpeakerAppearanceWindow>();

  for (const artifact of chunkArtifacts) {
    const { chunkIndex, segments, chunkBounds } = artifact;

    // Group segments by speaker
    const speakerSegments = new Map<string, Segment[]>();
    for (const segment of segments) {
      const existing = speakerSegments.get(segment.speakerId) ?? [];
      existing.push(segment);
      speakerSegments.set(segment.speakerId, existing);
    }

    // Build window for each speaker
    for (const [speakerId, segs] of speakerSegments) {
      if (segs.length === 0) continue;

      // Segments already have timestamps in original timeline (converted during artifact creation)
      // But we need to verify - if they're chunk-local, we'd need to convert
      // Per codebase: chunkMerge.ts converts to original timeline, but artifacts store chunk-local
      // Let's use chunkBounds to convert if needed

      // Actually, examining types.ts: ChunkArtifact.segments have "chunk-local timestamps initially"
      // We need to convert using chunkBounds
      const chunkAudioStartMs = chunkBounds.startMs - chunkBounds.overlapBeforeMs;

      let firstMs = Infinity;
      let lastMs = -Infinity;

      for (const seg of segs) {
        // Convert chunk-local to original timeline
        const originalStartMs = chunkAudioStartMs + seg.startMs;
        const originalEndMs = chunkAudioStartMs + seg.endMs;

        if (originalStartMs < firstMs) firstMs = originalStartMs;
        if (originalEndMs > lastMs) lastMs = originalEndMs;
      }

      if (firstMs !== Infinity && lastMs !== -Infinity) {
        const key = `${speakerId}_chunk${chunkIndex}`;
        windows.set(key, {
          chunkIndex,
          speakerId,
          firstOriginalMs: firstMs,
          lastOriginalMs: lastMs,
        });
      }
    }
  }

  return windows;
}

/**
 * Build chunk bounds map from chunk artifacts.
 *
 * @param chunkArtifacts - Array of chunk artifacts
 * @returns Map from chunkIndex to {startMs, endMs}
 */
export function buildChunkBoundsMap(
  chunkArtifacts: ChunkArtifact[]
): Map<number, { startMs: number; endMs: number }> {
  const boundsMap = new Map<number, { startMs: number; endMs: number }>();

  for (const artifact of chunkArtifacts) {
    boundsMap.set(artifact.chunkIndex, {
      startMs: artifact.chunkBounds.startMs,
      endMs: artifact.chunkBounds.endMs,
    });
  }

  return boundsMap;
}

// ============================================================================
// Time Delta Computation
// ============================================================================

/**
 * Compute the time delta between two speaker appearances.
 *
 * Uses the closest edges of their appearance windows:
 * - If A ends before B starts: delta = B.first - A.last
 * - If B ends before A starts: delta = A.first - B.last
 * - If they overlap: delta = 0
 *
 * @param windowA - First speaker's appearance window
 * @param windowB - Second speaker's appearance window
 * @returns Time delta in milliseconds (always >= 0)
 */
export function computeTimeDeltaMs(
  windowA: SpeakerAppearanceWindow,
  windowB: SpeakerAppearanceWindow
): number {
  // Check for overlap
  if (windowA.lastOriginalMs >= windowB.firstOriginalMs &&
      windowB.lastOriginalMs >= windowA.firstOriginalMs) {
    // Overlapping windows - no temporal gap
    return 0;
  }

  // Non-overlapping - compute gap
  if (windowA.lastOriginalMs < windowB.firstOriginalMs) {
    // A ends before B starts
    return windowB.firstOriginalMs - windowA.lastOriginalMs;
  } else {
    // B ends before A starts
    return windowA.firstOriginalMs - windowB.lastOriginalMs;
  }
}

/**
 * Compute time delta in seconds.
 * Convenience wrapper around computeTimeDeltaMs.
 */
export function computeTimeDeltaSeconds(
  windowA: SpeakerAppearanceWindow,
  windowB: SpeakerAppearanceWindow
): number {
  return computeTimeDeltaMs(windowA, windowB) / 1000;
}

// ============================================================================
// Integration Helpers
// ============================================================================

/**
 * Determine if a pair is cross-chunk (eligible for temporal boost).
 *
 * Intra-chunk pairs (same chunk) don't get temporal boost because
 * they're already being compared within the same context.
 *
 * @param keyA - Speaker chunk key A (e.g., "SPEAKER_00_chunk0")
 * @param keyB - Speaker chunk key B (e.g., "SPEAKER_01_chunk1")
 * @returns True if the speakers are from different chunks
 */
export function isCrossChunkPair(keyA: SpeakerChunkKey, keyB: SpeakerChunkKey): boolean {
  const matchA = keyA.match(/_chunk(\d+)$/);
  const matchB = keyB.match(/_chunk(\d+)$/);

  if (!matchA || !matchB) {
    // Can't determine chunk - treat as same chunk (no boost)
    return false;
  }

  return matchA[1] !== matchB[1];
}

/**
 * Apply temporal and boundary boosts to a similarity matrix.
 *
 * This is the main integration point for speaker reconciliation.
 * Call this after computing the quality-weighted cosine similarity matrix.
 *
 * @param matrix - NxN similarity matrix (will be modified in place)
 * @param speakerKeys - Array of speaker keys corresponding to matrix indices
 * @param appearances - Speaker appearance windows
 * @param chunkBounds - Chunk boundary info
 */
export function applyTemporalBoosts(
  matrix: number[][],
  speakerKeys: string[],
  appearances: Map<SpeakerChunkKey, SpeakerAppearanceWindow>,
  chunkBounds: Map<number, { startMs: number; endMs: number }>
): void {
  const n = matrix.length;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const keyA = speakerKeys[i];
      const keyB = speakerKeys[j];

      // Only apply boosts to cross-chunk pairs
      if (!isCrossChunkPair(keyA, keyB)) {
        continue;
      }

      const windowA = appearances.get(keyA);
      const windowB = appearances.get(keyB);

      if (!windowA || !windowB) {
        // No appearance data - can't compute temporal boost
        continue;
      }

      // Compute temporal weight
      const timeDeltaSeconds = computeTimeDeltaSeconds(windowA, windowB);
      const temporalWeight = computeTemporalWeight(timeDeltaSeconds);

      // Check if boundary pair
      const boundary = isBoundaryPair(windowA, windowB, chunkBounds);

      // Apply boosts
      const baseSimilarity = matrix[i][j];
      const boostedSimilarity = computeFinalSimilarity(
        baseSimilarity,
        temporalWeight,
        boundary
      );

      // Update matrix (symmetric)
      matrix[i][j] = boostedSimilarity;
      matrix[j][i] = boostedSimilarity;
    }
  }
}
