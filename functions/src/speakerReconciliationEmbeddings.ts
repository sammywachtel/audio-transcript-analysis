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
      relaxationIterations: 0
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

  // Step 4: Iterative agglomerative clustering with adaptive thresholds
  let clusterLabels = initializeSingletonClusters(embeddingEntries.length);
  let edgeThreshold = computeAdaptiveEdgeThreshold(embeddingEntries.length);

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

    // Recompute edge threshold for next iteration based on new cluster count
    edgeThreshold = computeAdaptiveEdgeThreshold(newClusterCount);
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

  // Check for warning conditions
  if (singletonRatio > ADAPTIVE_CONFIG.singletonWarningThreshold) {
    console.warn(`[EmbeddingReconciliation] ⚠️  High singleton ratio detected: ${(singletonRatio * 100).toFixed(1)}% (threshold: ${(ADAPTIVE_CONFIG.singletonWarningThreshold * 100).toFixed(0)}%)`);
  }

  if (clusters.length > estimatedUniqueSpeakers * 2) {
    console.warn(`[EmbeddingReconciliation] ⚠️  Over-fragmentation detected: ${clusters.length} clusters vs ${estimatedUniqueSpeakers} estimated speakers (>2x)`);
  }

  // Trigger adaptive relaxation if singleton ratio is too high
  if (singletonRatio > ADAPTIVE_CONFIG.singletonWarningThreshold) {
    relaxationTriggered = true;
    console.log('[EmbeddingReconciliation] 🔧 Triggering adaptive threshold relaxation');

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

      // Check if we've reached target singleton ratio
      if (singletonRatio < ADAPTIVE_CONFIG.singletonTargetThreshold) {
        console.log('[EmbeddingReconciliation] ✅ Target singleton ratio achieved');
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
    relaxationIterations
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
    relaxationIterations
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
