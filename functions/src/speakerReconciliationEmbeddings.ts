/**
 * Speaker Reconciliation using Voice Embeddings
 *
 * Matches speakers across chunks using 256-dimensional voice embeddings
 * from pyannote/embedding instead of content-based signals (name/topic/term).
 *
 * Algorithm:
 * 1. Collect embeddings from all chunks
 * 2. Compute pairwise cosine similarities
 * 3. Cluster using agglomerative clustering (no assumed speaker count)
 * 4. Map original speaker IDs to canonical cluster IDs
 */

import { ChunkArtifact } from './types';
import { computeWeightedSimilarity } from './speakerQuality';
import {
  buildSpeakerAppearanceWindows,
  buildChunkBoundsMap,
  applyTemporalBoosts,
} from './temporalGraph';
import {
  computeAdaptiveEdgeThreshold,
  computeClusterCohesionThreshold,
  computeClusterAverageQuality,
  DEFAULT_CONFIG as ADAPTIVE_CONFIG
} from './adaptiveThresholds';

// ============================================================================
// Types
// ============================================================================

export interface EmbeddingReconciliationResult {
  /** Map from "SPEAKER_00_chunk0" → "speaker_canonical_0" */
  speakerIdMap: Map<string, string>;
  /** Overall confidence based on cluster cohesion (0-1) */
  overallConfidence: number;
  /** Per-cluster details for debugging */
  clusterDetails: EmbeddingClusterDetails[];
  /** Threshold metadata for monitoring/observability */
  edgeThreshold: number;
  cohesionThreshold: number;
  qualityExclusions: number;
  /** Singleton ratio: singleton clusters / total clusters */
  singletonRatio: number;
  /** Estimated unique speakers from chunk artifacts */
  estimatedUniqueSpeakers: number;
  /** Whether adaptive relaxation was triggered */
  relaxationTriggered: boolean;
  /** Final edge threshold after relaxation (if triggered) */
  finalEdgeThreshold: number;
  /** Number of relaxation iterations performed */
  relaxationIterations: number;
  /** Number of cross-chunk same-name pairs that received a similarity boost */
  nameBoostCount: number;
}

export interface EmbeddingClusterDetails {
  canonicalId: string;
  originalIds: string[];  // e.g., ["SPEAKER_00_chunk0", "SPEAKER_00_chunk3", "SPEAKER_01_chunk7"]
  confidence: number;     // Average pairwise similarity within cluster
  centroid: number[];     // Average embedding (for future speaker identification)
  displayName: string;    // Inferred display name (if any)
  matchEvidence: {        // Compatibility with content-based reconciliation
    nameMatches: number;
    topicOverlap: number;
    termOverlap: number;
  };
}

interface EmbeddingEntry {
  chunkIndex: number;
  speakerId: string;
  originalId: string;     // "SPEAKER_00_chunk0"
  embedding: number[];
  quality: number;        // Composite quality score [0-1]
}

// ============================================================================
// Configuration
// ============================================================================

export const EmbeddingReconciliationConfig = {
  /** Cosine similarity threshold for clustering (0.65-0.75 typical) */
  SIMILARITY_THRESHOLD: 0.70,

  /**
   * Cohesion safeguard threshold: minimum similarity required across all
   * cross-cluster pairs when merging. Lower than SIMILARITY_THRESHOLD to allow
   * transitive merges where some pairs are slightly weaker.
   * 0.7 caused over-fragmentation (24 clusters); 0.6 is more permissive.
   */
  COHESION_THRESHOLD: 0.60,

  /** Minimum embedding dimension (wespeaker uses 256) */
  MIN_EMBEDDING_DIM: 256,

  /** Confidence threshold below which we trigger fallback */
  CONFIDENCE_THRESHOLD: 0.60,

  /**
   * Singleton cluster confidence: "no evidence" means neutral, not bad.
   * A speaker appearing in only one chunk has no cross-chunk comparisons,
   * so we assign 0.75 (neutral-ish) instead of 0.5 which tanks overall confidence.
   */
  SINGLETON_CONFIDENCE: 0.75,

  /**
   * Quality floor: segments below this quality threshold are excluded
   * from reconciliation to prevent low-quality audio from causing false merges.
   */
  QUALITY_FLOOR: 0.3,

  /**
   * @deprecated NAME_BOOST is no longer used for the actual similarity calculation.
   * Kept for backward-compatible reporting/logging. Use NAME_MERGE_FLOOR instead.
   *
   * Old behavior: `Math.min(1.0, before + NAME_BOOST)` — additive, could be gamed
   * by very-low-similarity pairs getting just enough nudge to sneak through.
   */
  NAME_BOOST: 0.15,

  /**
   * Name merge floor: when two speakers share the same normalized display name
   * across chunks, their similarity is lifted to AT LEAST this value.
   *
   * Floor semantics (max) beat additive semantics (add) here: if the embedding
   * similarity is already above 0.75 we don't change it, but if it's 0.50 we
   * raise it to 0.75 — treating a confirmed name match as a reliable identity signal
   * without compounding already-high scores toward 1.0.
   */
  NAME_MERGE_FLOOR: 0.75,
};

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Estimate the number of unique speakers based on chunk artifacts.
 * Conservative heuristic: maximum unique speakers in any single chunk.
 * This assumes chunks are long enough to capture most/all speakers.
 */
function estimateUniqueSpeakers(chunkArtifacts: ChunkArtifact[]): number {
  let maxUniqueSpeakers = 0;

  for (const artifact of chunkArtifacts) {
    const embeddings = artifact.speakerEmbeddings ?? {};
    const uniqueInChunk = Object.keys(embeddings).length;
    if (uniqueInChunk > maxUniqueSpeakers) {
      maxUniqueSpeakers = uniqueInChunk;
    }
  }

  return maxUniqueSpeakers;
}

/**
 * Normalize a speaker display name for same-identity comparison.
 *
 * Strips parenthesized role suffixes (e.g. "Sam (New Team Member)" → "sam"),
 * lowercases, and trims whitespace. Returns null for generic placeholder names
 * like "Speaker 1" or "Unknown" — boosting those would merge every anonymous
 * speaker in a meeting, which is exactly the wrong thing.
 */
function normalizeSpeakerName(displayName: string): string | null {
  if (!displayName) return null;

  // Generic names that tell us nothing about identity — skip them
  if (/^speaker\s*\d*/i.test(displayName.trim()) || /^unknown$/i.test(displayName.trim())) {
    return null;
  }

  // Strip parenthesized role/title suffixes: "Sam (Lead Engineer)" → "Sam"
  const stripped = displayName.replace(/\s*\([^)]*\)\s*/g, '').trim().toLowerCase();

  return stripped.length > 0 ? stripped : null;
}

/**
 * Levenshtein (edit) distance between two strings.
 * Classic DP — O(m·n) time, O(min(m,n)) space.
 * Exported for testing.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Use the shorter string as the "row" dimension for space efficiency
  if (a.length > b.length) { const tmp = a; a = b; b = tmp; }

  let prev = Array.from({ length: a.length + 1 }, (_, i) => i);

  for (let j = 1; j <= b.length; j++) {
    const curr = [j];
    for (let i = 1; i <= a.length; i++) {
      curr[i] = a[i - 1] === b[j - 1]
        ? prev[i - 1]
        : 1 + Math.min(prev[i - 1], prev[i], curr[i - 1]);
    }
    prev = curr;
  }

  return prev[a.length];
}

/**
 * Check if two normalized speaker names are "close enough" to be the same
 * person, accounting for ASR transcription variants (Arya/Araya, Denis/Dennis).
 *
 * Uses Levenshtein distance with length-aware thresholds:
 *  - Names ≤ 3 chars: exact match only (too short for fuzzy — "Jay" ≠ "Ray")
 *  - Names 4+ chars: normalized similarity ≥ 0.80 (~1 typo per 5 chars)
 *
 * Exported for testing.
 */
export function namesAreSimilar(nameA: string, nameB: string): boolean {
  if (nameA === nameB) return true;

  // Short names are too ambiguous for fuzzy matching
  if (nameA.length <= 3 || nameB.length <= 3) return false;

  const dist = levenshteinDistance(nameA, nameB);
  const maxLen = Math.max(nameA.length, nameB.length);
  const similarity = 1 - dist / maxLen;

  return similarity >= 0.80;
}

/**
 * Apply name-based similarity boosts to cross-chunk speaker pairs.
 *
 * When two speakers from different chunks share similar normalized display names
 * (fuzzy match via Levenshtein distance — catches ASR variants like Arya/Araya),
 * we lift their similarity to NAME_MERGE_FLOOR. This helps borderline pairs that
 * voice embeddings alone can't confidently merge — especially when audio quality
 * is uneven across chunks. Won't rescue truly different speakers (the embedding
 * signal is still dominant), but it's a useful tiebreaker.
 *
 * Same-chunk pairs are deliberately excluded — two different people named "Alex"
 * in the same chunk should stay separate, and embedding similarity already handles
 * the cross-chunk case when voices are clearly different.
 *
 * @returns Total number of boosts applied (for observability)
 */
function applyNameBoosts(
  similarityMatrix: number[][],
  entries: EmbeddingEntry[],
  chunkArtifacts: ChunkArtifact[]
): number {
  let boostCount = 0;

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      // Same-chunk pairs are never merged anyway — skip the lookup overhead
      if (entries[i].chunkIndex === entries[j].chunkIndex) continue;

      // Look up display names from the chunk artifacts
      const artifactI = chunkArtifacts.find(a => a.chunkIndex === entries[i].chunkIndex);
      const artifactJ = chunkArtifacts.find(a => a.chunkIndex === entries[j].chunkIndex);

      if (!artifactI || !artifactJ) continue;

      const speakerI = artifactI.speakers[entries[i].speakerId];
      const speakerJ = artifactJ.speakers[entries[j].speakerId];

      if (!speakerI?.displayName || !speakerJ?.displayName) continue;

      const nameI = normalizeSpeakerName(speakerI.displayName);
      const nameJ = normalizeSpeakerName(speakerJ.displayName);

      if (!nameI || !nameJ || !namesAreSimilar(nameI, nameJ)) continue;

      // Same (or fuzzy-matched) name in different chunks — lift to floor if below it.
      // Max semantics: already above 0.75? Leave it alone. Below? Raise to floor.
      // Avoids piling score onto already-high pairs and makes the threshold crisp.
      const before = similarityMatrix[i][j];
      const boosted = Math.max(before, EmbeddingReconciliationConfig.NAME_MERGE_FLOOR);
      similarityMatrix[i][j] = boosted;
      similarityMatrix[j][i] = boosted;

      const fuzzyMatch = nameI !== nameJ;
      console.log('[EmbeddingReconciliation] Name floor applied:', {
        entryI: entries[i].originalId,
        entryJ: entries[j].originalId,
        name: nameI,
        ...(fuzzyMatch ? { fuzzyMatchedWith: nameJ, editDistance: levenshteinDistance(nameI, nameJ) } : {}),
        before: before.toFixed(3),
        floor: EmbeddingReconciliationConfig.NAME_MERGE_FLOOR.toFixed(3),
        after: boosted.toFixed(3),
        lifted: before < EmbeddingReconciliationConfig.NAME_MERGE_FLOOR
      });

      boostCount++;
    }
  }

  return boostCount;
}

/**
 * Reconcile speakers across chunks using voice embeddings.
 *
 * @param chunkArtifacts - Artifacts from all chunks (must include speakerEmbeddings)
 * @returns Reconciliation result with speaker mappings and confidence
 */
export function reconcileSpeakersWithEmbeddings(
  chunkArtifacts: ChunkArtifact[]
): EmbeddingReconciliationResult {
  console.log('[EmbeddingReconciliation] Starting reconciliation:', {
    chunkCount: chunkArtifacts.length
  });

  // Step 1: Collect all embeddings with metadata (tracks quality exclusions)
  const { entries: embeddingEntries, qualityExclusions } = collectEmbeddings(chunkArtifacts);

  if (embeddingEntries.length === 0) {
    console.warn('[EmbeddingReconciliation] No embeddings found, returning empty result');
    return {
      speakerIdMap: new Map(),
      overallConfidence: 0,
      clusterDetails: [],
      edgeThreshold: 0,
      cohesionThreshold: 0,
      qualityExclusions,
      singletonRatio: 0,
      estimatedUniqueSpeakers: 0,
      relaxationTriggered: false,
      finalEdgeThreshold: 0,
      relaxationIterations: 0,
      nameBoostCount: 0
    };
  }

  console.log('[EmbeddingReconciliation] Collected embeddings:', {
    totalSpeakers: embeddingEntries.length,
    embeddingDim: embeddingEntries[0].embedding.length,
    qualityExclusions
  });

  // Step 2: Estimate unique speakers (conservative heuristic: max unique speakers in any chunk)
  const estimatedUniqueSpeakers = estimateUniqueSpeakers(chunkArtifacts);

  console.log('[EmbeddingReconciliation] Estimated unique speakers:', {
    estimatedUniqueSpeakers
  });

  // Step 3: Compute pairwise quality-weighted cosine similarity matrix
  const similarityMatrix = computeCosineSimilarityMatrix(embeddingEntries);

  // Step 3.5: Apply temporal and boundary boosts to cross-chunk pairs
  const speakerKeys = embeddingEntries.map(e => e.originalId);
  const speakerAppearances = buildSpeakerAppearanceWindows(chunkArtifacts);
  const chunkBounds = buildChunkBoundsMap(chunkArtifacts);

  applyTemporalBoosts(similarityMatrix, speakerKeys, speakerAppearances, chunkBounds);

  console.log('[EmbeddingReconciliation] Applied temporal/boundary boosts:', {
    speakerAppearanceCount: speakerAppearances.size,
    chunkBoundsCount: chunkBounds.size
  });

  // Step 3.6: Apply name-based similarity boosts for cross-chunk same-name pairs
  const nameBoostCount = applyNameBoosts(similarityMatrix, embeddingEntries, chunkArtifacts);

  console.log('[EmbeddingReconciliation] Applied name boosts:', {
    nameBoostCount
  });

  // Step 4: Iterative agglomerative clustering with adaptive thresholds.
  // Monotonic invariant: edgeThreshold may only decrease across iterations.
  // The adaptive function can suggest higher thresholds as clusters merge, but
  // letting it climb back up causes oscillation and un-merges work we already did.
  let clusterLabels = initializeSingletonClusters(embeddingEntries.length);
  let edgeThreshold = computeAdaptiveEdgeThreshold(embeddingEntries.length);
  let bestThreshold = edgeThreshold; // lowest threshold seen so far — our ratchet

  console.log('[EmbeddingReconciliation] Starting iterative clustering:', {
    initialClusters: embeddingEntries.length,
    initialEdgeThreshold: edgeThreshold.toFixed(3),
    maxIterations: ADAPTIVE_CONFIG.maxIterations
  });

  for (let iter = 0; iter < ADAPTIVE_CONFIG.maxIterations; iter++) {
    const prevClusterCount = countUniqueClusters(clusterLabels);

    console.log(`[EmbeddingReconciliation] Iteration ${iter + 1}:`, {
      clusterCount: prevClusterCount,
      edgeThreshold: edgeThreshold.toFixed(3)
    });

    // One pass of agglomerative clustering with current threshold
    clusterLabels = agglomerativeCluster(
      similarityMatrix,
      edgeThreshold,
      embeddingEntries
    );

    const newClusterCount = countUniqueClusters(clusterLabels);

    // Convergence check
    if (newClusterCount === prevClusterCount) {
      console.log('[EmbeddingReconciliation] Converged - cluster count stable');
      break;
    }

    // Recompute edge threshold for next iteration based on new cluster count,
    // but only allow it to move downward. Once we've committed to a lower threshold
    // we don't un-relax — that way oscillation dies instead of running forever.
    const candidateThreshold = computeAdaptiveEdgeThreshold(newClusterCount);
    edgeThreshold = Math.min(bestThreshold, candidateThreshold);
    bestThreshold = edgeThreshold;
  }

  // Step 5: Build clusters and compute singleton ratio
  let clusters = buildClusters(embeddingEntries, clusterLabels, similarityMatrix, chunkArtifacts);
  let singletonCount = clusters.filter(c => c.originalIds.length === 1).length;
  let singletonRatio = clusters.length > 0 ? singletonCount / clusters.length : 0;

  console.log('[EmbeddingReconciliation] Initial clustering complete:', {
    totalClusters: clusters.length,
    singletonCount,
    singletonRatio: singletonRatio.toFixed(3),
    speakersPerCluster: clusters.map(c => c.originalIds.length)
  });

  // Step 6: Check for over-fragmentation and apply adaptive relaxation if needed
  let relaxationTriggered = false;
  let relaxationIterations = 0;
  const initialEdgeThreshold = edgeThreshold;

  // >= not > — when ratio is exactly at the threshold, we should act, not shrug.
  const highSingletonRatio = singletonRatio >= ADAPTIVE_CONFIG.singletonWarningThreshold;
  const overFragmented = estimatedUniqueSpeakers > 0 && clusters.length > estimatedUniqueSpeakers * 2;

  if (highSingletonRatio) {
    console.warn(`[EmbeddingReconciliation] ⚠️  High singleton ratio detected: ${(singletonRatio * 100).toFixed(1)}% (threshold: ${(ADAPTIVE_CONFIG.singletonWarningThreshold * 100).toFixed(0)}%)`);
  }

  if (overFragmented) {
    console.warn(`[EmbeddingReconciliation] ⚠️  Over-fragmentation detected: ${clusters.length} clusters vs ${estimatedUniqueSpeakers} estimated speakers (>2x)`);
  }

  // Trigger adaptive relaxation if singleton ratio is too high OR cluster count is
  // embarrassingly larger than the speaker estimate. Two paths to the same fix.
  if (highSingletonRatio || overFragmented) {
    relaxationTriggered = true;
    const triggerReason = highSingletonRatio && overFragmented ? 'both'
      : highSingletonRatio ? 'singleton ratio'
      : 'over-fragmentation';
    console.log(`[EmbeddingReconciliation] 🔧 Triggering adaptive threshold relaxation (reason: ${triggerReason})`);

    for (let relaxIter = 0; relaxIter < ADAPTIVE_CONFIG.maxRelaxationIterations; relaxIter++) {
      // Relax edge threshold
      const newThreshold = edgeThreshold - ADAPTIVE_CONFIG.relaxationStepSize;

      // Check if we've hit the floor
      if (newThreshold < ADAPTIVE_CONFIG.relaxationThresholdFloor) {
        console.log('[EmbeddingReconciliation] Relaxation floor reached:', {
          currentThreshold: edgeThreshold.toFixed(3),
          floor: ADAPTIVE_CONFIG.relaxationThresholdFloor
        });
        break;
      }

      edgeThreshold = newThreshold;
      relaxationIterations++;

      console.log(`[EmbeddingReconciliation] Relaxation iteration ${relaxIter + 1}:`, {
        newEdgeThreshold: edgeThreshold.toFixed(3)
      });

      // Re-run clustering with relaxed threshold
      clusterLabels = agglomerativeCluster(
        similarityMatrix,
        edgeThreshold,
        embeddingEntries
      );

      // Rebuild clusters
      clusters = buildClusters(embeddingEntries, clusterLabels, similarityMatrix, chunkArtifacts);
      singletonCount = clusters.filter(c => c.originalIds.length === 1).length;
      singletonRatio = clusters.length > 0 ? singletonCount / clusters.length : 0;

      console.log(`[EmbeddingReconciliation] After relaxation ${relaxIter + 1}:`, {
        clusterCount: clusters.length,
        singletonCount,
        singletonRatio: singletonRatio.toFixed(3)
      });

      // Two ways out: singleton ratio drops to target, OR cluster count falls
      // back within 2x the speaker estimate (if over-fragmentation was the trigger).
      const singletonGoalMet = singletonRatio < ADAPTIVE_CONFIG.singletonTargetThreshold;
      const fragmentGoalMet = overFragmented && clusters.length <= estimatedUniqueSpeakers * 2;

      if (singletonGoalMet) {
        console.log('[EmbeddingReconciliation] ✅ Target singleton ratio achieved');
        break;
      }
      if (fragmentGoalMet) {
        console.log('[EmbeddingReconciliation] ✅ Over-fragmentation resolved');
        break;
      }
    }

    console.log('[EmbeddingReconciliation] Adaptive relaxation complete:', {
      initialThreshold: initialEdgeThreshold.toFixed(3),
      finalThreshold: edgeThreshold.toFixed(3),
      iterations: relaxationIterations,
      initialSingletonRatio: (singletonCount / clusters.length).toFixed(3),
      finalSingletonRatio: singletonRatio.toFixed(3),
      initialClusters: clusters.length,
      finalClusters: clusters.length
    });
  }

  // Step 7: Build speaker ID mapping
  const speakerIdMap = new Map<string, string>();
  for (const cluster of clusters) {
    for (const originalId of cluster.originalIds) {
      speakerIdMap.set(originalId, cluster.canonicalId);
    }
  }

  // Step 8: Compute overall confidence (average of cluster confidences)
  const overallConfidence = clusters.length > 0
    ? clusters.reduce((sum, c) => sum + c.confidence, 0) / clusters.length
    : 0;

  // Step 9: Compute representative cohesion threshold (based on average quality)
  const avgQuality = computeClusterAverageQuality(embeddingEntries);
  const cohesionThreshold = computeClusterCohesionThreshold(avgQuality);

  console.log('[EmbeddingReconciliation] Final result:', {
    totalMappings: speakerIdMap.size,
    overallConfidence: overallConfidence.toFixed(3),
    clusterCount: clusters.length,
    singletonCount,
    singletonRatio: singletonRatio.toFixed(3),
    estimatedUniqueSpeakers,
    edgeThreshold: edgeThreshold.toFixed(3),
    cohesionThreshold: cohesionThreshold.toFixed(3),
    qualityExclusions,
    relaxationTriggered,
    relaxationIterations,
    nameBoostCount
  });

  return {
    speakerIdMap,
    overallConfidence,
    clusterDetails: clusters,
    edgeThreshold,
    cohesionThreshold,
    qualityExclusions,
    singletonRatio,
    estimatedUniqueSpeakers,
    relaxationTriggered,
    finalEdgeThreshold: edgeThreshold,
    relaxationIterations,
    nameBoostCount
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Collect embeddings from all chunk artifacts.
 * Tracks quality exclusions for monitoring/observability.
 */
function collectEmbeddings(chunkArtifacts: ChunkArtifact[]): {
  entries: EmbeddingEntry[];
  qualityExclusions: number;
} {
  const entries: EmbeddingEntry[] = [];
  let qualityExclusions = 0;

  for (const artifact of chunkArtifacts) {
    const embeddings = artifact.speakerEmbeddings ?? {};
    const qualities = artifact.speakerQuality ?? {};

    for (const [speakerId, embedding] of Object.entries(embeddings)) {
      // Validate embedding dimension
      if (embedding.length < EmbeddingReconciliationConfig.MIN_EMBEDDING_DIM) {
        console.warn(`[EmbeddingReconciliation] Skipping invalid embedding for ${speakerId} in chunk ${artifact.chunkIndex}`);
        continue;
      }

      // Get quality score if available, default to 1.0 (neutral quality)
      const quality = qualities[speakerId]?.compositeScore ?? 1.0;

      // Apply quality floor - skip low-quality segments
      if (quality < EmbeddingReconciliationConfig.QUALITY_FLOOR) {
        console.log(
          `[EmbeddingReconciliation] Excluding ${speakerId} from chunk ${artifact.chunkIndex} ` +
          `due to low quality: ${quality.toFixed(3)} < ${EmbeddingReconciliationConfig.QUALITY_FLOOR}`
        );
        qualityExclusions++;
        continue;
      }

      entries.push({
        chunkIndex: artifact.chunkIndex,
        speakerId,
        originalId: `${speakerId}_chunk${artifact.chunkIndex}`,
        embedding,
        quality
      });
    }
  }

  return { entries, qualityExclusions };
}

/**
 * Compute cosine similarity between two vectors.
 * Returns value in range [-1, 1], where 1 = identical, 0 = orthogonal, -1 = opposite.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Compute pairwise quality-weighted cosine similarity matrix.
 * Returns NxN matrix where matrix[i][j] = quality-weighted similarity.
 */
function computeCosineSimilarityMatrix(entries: EmbeddingEntry[]): number[][] {
  const n = entries.length;
  const matrix: number[][] = Array(n).fill(null).map(() => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1.0; // Self-similarity
    for (let j = i + 1; j < n; j++) {
      const cosine = cosineSimilarity(entries[i].embedding, entries[j].embedding);

      // Apply quality weighting to reduce influence of low-quality segments
      const weighted = computeWeightedSimilarity(
        cosine,
        entries[i].quality,
        entries[j].quality
      );

      matrix[i][j] = weighted;
      matrix[j][i] = weighted; // Symmetric
    }
  }

  return matrix;
}

/**
 * Initialize cluster labels where each item is in its own cluster.
 */
function initializeSingletonClusters(n: number): number[] {
  return Array(n).fill(0).map((_, i) => i);
}

/**
 * Count the number of unique clusters in a label array.
 */
function countUniqueClusters(clusterLabels: number[]): number {
  return new Set(clusterLabels).size;
}

/**
 * Agglomerative clustering with quality-adjusted cohesion safeguard.
 *
 * Starts with each item in its own cluster, then iteratively merges
 * the two most similar clusters until similarity falls below threshold.
 *
 * QUALITY-ADJUSTED COHESION: Before merging two clusters, we check that
 * the MINIMUM pairwise similarity across all cross-cluster pairs meets
 * a quality-adjusted threshold. High-quality clusters require stricter
 * cohesion to avoid over-merging.
 *
 * @param similarityMatrix - NxN pairwise similarity matrix
 * @param threshold - Minimum similarity to merge clusters (adaptive)
 * @param entries - Embedding entries with quality scores
 * @returns Array of cluster labels (same length as matrix dimension)
 */
function agglomerativeCluster(
  similarityMatrix: number[][],
  threshold: number,
  entries: EmbeddingEntry[]
): number[] {
  const n = similarityMatrix.length;

  // Initialize: each item in its own cluster
  const clusterAssignment: number[] = Array(n).fill(0).map((_, i) => i);
  const activeClusters = new Set<number>(clusterAssignment);

  // Track which items belong to each cluster
  const clusterMembers: Map<number, number[]> = new Map();
  for (let i = 0; i < n; i++) {
    clusterMembers.set(i, [i]);
  }

  console.log('[EmbeddingReconciliation] Agglomerative clustering with quality-adjusted cohesion:', {
    itemCount: n,
    edgeThreshold: threshold.toFixed(3)
  });

  // Iteratively merge closest clusters
  while (activeClusters.size > 1) {
    // Find the two most similar clusters (by average linkage)
    // that also pass the cohesion safeguard (minimum cross-pair ≥ cohesionThreshold)
    let bestSim = -Infinity;
    let bestPair: [number, number] | null = null;

    const activeList = Array.from(activeClusters);
    for (let i = 0; i < activeList.length; i++) {
      for (let j = i + 1; j < activeList.length; j++) {
        const c1 = activeList[i];
        const c2 = activeList[j];
        const members1 = clusterMembers.get(c1)!;
        const members2 = clusterMembers.get(c2)!;

        // Quality-adjusted cohesion check
        // Compute average quality for each cluster
        const quality1 = computeClusterAverageQuality(members1.map(i => entries[i]));
        const quality2 = computeClusterAverageQuality(members2.map(i => entries[i]));

        // Use the stricter (higher) cohesion threshold of the two clusters
        const cohesion1 = computeClusterCohesionThreshold(quality1);
        const cohesion2 = computeClusterCohesionThreshold(quality2);
        const cohesionThreshold = Math.max(cohesion1, cohesion2);

        // Check minimum cross-cluster similarity
        let minCrossSim = Infinity;
        for (const m1 of members1) {
          for (const m2 of members2) {
            if (similarityMatrix[m1][m2] < minCrossSim) {
              minCrossSim = similarityMatrix[m1][m2];
            }
          }
        }

        // Skip this pair if any cross-pair is below quality-adjusted cohesion threshold
        if (minCrossSim < cohesionThreshold) {
          continue;
        }

        // Use average linkage for ranking valid pairs
        const avgSim = averageLinkageSimilarity(members1, members2, similarityMatrix);
        if (avgSim > bestSim) {
          bestSim = avgSim;
          bestPair = [c1, c2];
        }
      }
    }

    // Stop if no valid pair found (all below threshold or fail cohesion)
    if (bestSim < threshold || !bestPair) {
      break;
    }

    // Merge the two clusters
    const [c1, c2] = bestPair;
    const members1 = clusterMembers.get(c1)!;
    const members2 = clusterMembers.get(c2)!;

    // Merge into c1
    const merged = [...members1, ...members2];
    clusterMembers.set(c1, merged);

    // Update assignments
    for (const member of members2) {
      clusterAssignment[member] = c1;
    }

    // Remove c2 from active clusters
    activeClusters.delete(c2);
    clusterMembers.delete(c2);
  }

  console.log('[EmbeddingReconciliation] Clustering complete:', {
    finalClusterCount: activeClusters.size,
    clusterSizes: Array.from(clusterMembers.values()).map(m => m.length)
  });

  // Renumber clusters to be sequential (0, 1, 2, ...)
  const uniqueClusters = [...new Set(clusterAssignment)];
  const clusterMap = new Map<number, number>();
  uniqueClusters.forEach((c, idx) => clusterMap.set(c, idx));

  return clusterAssignment.map(c => clusterMap.get(c)!);
}

/**
 * Compute average linkage similarity between two clusters.
 * Average of all pairwise similarities between members.
 */
function averageLinkageSimilarity(
  cluster1: number[],
  cluster2: number[],
  similarityMatrix: number[][]
): number {
  let totalSim = 0;
  let count = 0;

  for (const i of cluster1) {
    for (const j of cluster2) {
      totalSim += similarityMatrix[i][j];
      count++;
    }
  }

  return count > 0 ? totalSim / count : 0;
}

/**
 * Build cluster details from labels and compute confidence scores.
 */
function buildClusters(
  entries: EmbeddingEntry[],
  clusterLabels: number[],
  similarityMatrix: number[][],
  chunkArtifacts: ChunkArtifact[]
): EmbeddingClusterDetails[] {
  // Group entries by cluster label
  const clusterGroups: Map<number, number[]> = new Map();
  for (let i = 0; i < clusterLabels.length; i++) {
    const label = clusterLabels[i];
    if (!clusterGroups.has(label)) {
      clusterGroups.set(label, []);
    }
    clusterGroups.get(label)!.push(i);
  }

  const clusters: EmbeddingClusterDetails[] = [];

  for (const [label, memberIndices] of clusterGroups) {
    // Compute average pairwise similarity within cluster (confidence)
    let confidence = 1.0;
    if (memberIndices.length > 1) {
      let totalSim = 0;
      let count = 0;
      for (let i = 0; i < memberIndices.length; i++) {
        for (let j = i + 1; j < memberIndices.length; j++) {
          totalSim += similarityMatrix[memberIndices[i]][memberIndices[j]];
          count++;
        }
      }
      confidence = count > 0 ? totalSim / count : 1.0;
    } else {
      // Singleton cluster - neutral confidence since "no evidence" != "bad match"
      confidence = EmbeddingReconciliationConfig.SINGLETON_CONFIDENCE;
    }

    // Compute centroid (average embedding)
    const dim = entries[0].embedding.length;
    const centroid = Array(dim).fill(0);
    for (const idx of memberIndices) {
      const emb = entries[idx].embedding;
      for (let d = 0; d < dim; d++) {
        centroid[d] += emb[d];
      }
    }
    for (let d = 0; d < dim; d++) {
      centroid[d] /= memberIndices.length;
    }

    // Infer display name from chunk artifacts (look for speaker names in the chunks)
    const originalIds = memberIndices.map(i => entries[i].originalId);
    const displayName = inferDisplayName(originalIds, chunkArtifacts);

    clusters.push({
      canonicalId: `speaker_canonical_${label}`,
      originalIds,
      confidence,
      centroid,
      displayName,
      matchEvidence: {
        nameMatches: 0,  // Not used in embedding-based reconciliation
        topicOverlap: 0,
        termOverlap: 0
      }
    });
  }

  // Sort by number of members (descending) for consistent ordering
  clusters.sort((a, b) => b.originalIds.length - a.originalIds.length);

  // Renumber canonical IDs after sorting
  clusters.forEach((c, idx) => {
    c.canonicalId = `speaker_canonical_${idx}`;
  });

  return clusters;
}

/**
 * Infer display name for a cluster by looking at speaker names in chunk artifacts.
 */
function inferDisplayName(
  originalIds: string[],
  chunkArtifacts: ChunkArtifact[]
): string {
  // Extract chunk indices and speaker IDs from original IDs
  const speakerChunks = originalIds.map(id => {
    const match = id.match(/^(SPEAKER_\d+)_chunk(\d+)$/);
    if (match) {
      return { speakerId: match[1], chunkIndex: parseInt(match[2]) };
    }
    return null;
  }).filter(x => x !== null) as { speakerId: string; chunkIndex: number }[];

  // Find the first chunk artifact that has a display name for any of these speakers
  for (const { speakerId, chunkIndex } of speakerChunks) {
    const artifact = chunkArtifacts.find(a => a.chunkIndex === chunkIndex);
    if (artifact && artifact.speakers[speakerId]) {
      const speaker = artifact.speakers[speakerId];
      if (speaker.displayName && speaker.displayName !== 'Unknown') {
        return speaker.displayName;
      }
    }
  }

  return 'Unknown';
}

// ============================================================================
// Fallback Check
// ============================================================================

/**
 * Check if embeddings are available and valid for reconciliation.
 * Returns false if we should fall back to content-based matching.
 */
export function hasValidEmbeddings(chunkArtifacts: ChunkArtifact[]): boolean {
  let totalEmbeddings = 0;

  for (const artifact of chunkArtifacts) {
    const embeddings = artifact.speakerEmbeddings ?? {};
    for (const embedding of Object.values(embeddings)) {
      if (embedding.length >= EmbeddingReconciliationConfig.MIN_EMBEDDING_DIM) {
        totalEmbeddings++;
      }
    }
  }

  // Need at least 2 embeddings to do any matching
  return totalEmbeddings >= 2;
}
