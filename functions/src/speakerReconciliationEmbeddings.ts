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
}

// ============================================================================
// Configuration
// ============================================================================

export const EmbeddingReconciliationConfig = {
  /** Cosine similarity threshold for clustering (0.65-0.75 typical) */
  SIMILARITY_THRESHOLD: 0.70,

  /** Minimum embedding dimension (wespeaker uses 256) */
  MIN_EMBEDDING_DIM: 256,

  /** Confidence threshold below which we trigger fallback */
  CONFIDENCE_THRESHOLD: 0.60,
};

// ============================================================================
// Main Entry Point
// ============================================================================

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

  // Step 1: Collect all embeddings with metadata
  const embeddingEntries = collectEmbeddings(chunkArtifacts);

  if (embeddingEntries.length === 0) {
    console.warn('[EmbeddingReconciliation] No embeddings found, returning empty result');
    return {
      speakerIdMap: new Map(),
      overallConfidence: 0,
      clusterDetails: []
    };
  }

  console.log('[EmbeddingReconciliation] Collected embeddings:', {
    totalSpeakers: embeddingEntries.length,
    embeddingDim: embeddingEntries[0].embedding.length
  });

  // Step 2: Compute pairwise cosine similarity matrix
  const similarityMatrix = computeCosineSimilarityMatrix(
    embeddingEntries.map(e => e.embedding)
  );

  // Step 3: Cluster using agglomerative clustering
  const clusterLabels = agglomerativeCluster(
    similarityMatrix,
    EmbeddingReconciliationConfig.SIMILARITY_THRESHOLD
  );

  // Step 4: Build clusters and compute confidence
  const clusters = buildClusters(embeddingEntries, clusterLabels, similarityMatrix, chunkArtifacts);

  console.log('[EmbeddingReconciliation] Clustering complete:', {
    totalClusters: clusters.length,
    speakersPerCluster: clusters.map(c => c.originalIds.length)
  });

  // Step 5: Build speaker ID mapping
  const speakerIdMap = new Map<string, string>();
  for (const cluster of clusters) {
    for (const originalId of cluster.originalIds) {
      speakerIdMap.set(originalId, cluster.canonicalId);
    }
  }

  // Step 6: Compute overall confidence (average of cluster confidences)
  const overallConfidence = clusters.length > 0
    ? clusters.reduce((sum, c) => sum + c.confidence, 0) / clusters.length
    : 0;

  console.log('[EmbeddingReconciliation] Result:', {
    totalMappings: speakerIdMap.size,
    overallConfidence: overallConfidence.toFixed(3),
    clusterCount: clusters.length
  });

  return {
    speakerIdMap,
    overallConfidence,
    clusterDetails: clusters
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Collect embeddings from all chunk artifacts.
 */
function collectEmbeddings(chunkArtifacts: ChunkArtifact[]): EmbeddingEntry[] {
  const entries: EmbeddingEntry[] = [];

  for (const artifact of chunkArtifacts) {
    const embeddings = artifact.speakerEmbeddings ?? {};

    for (const [speakerId, embedding] of Object.entries(embeddings)) {
      // Validate embedding dimension
      if (embedding.length < EmbeddingReconciliationConfig.MIN_EMBEDDING_DIM) {
        console.warn(`[EmbeddingReconciliation] Skipping invalid embedding for ${speakerId} in chunk ${artifact.chunkIndex}`);
        continue;
      }

      entries.push({
        chunkIndex: artifact.chunkIndex,
        speakerId,
        originalId: `${speakerId}_chunk${artifact.chunkIndex}`,
        embedding
      });
    }
  }

  return entries;
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
 * Compute pairwise cosine similarity matrix for all embeddings.
 * Returns NxN matrix where matrix[i][j] = similarity between embedding i and j.
 */
function computeCosineSimilarityMatrix(embeddings: number[][]): number[][] {
  const n = embeddings.length;
  const matrix: number[][] = Array(n).fill(null).map(() => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1.0; // Self-similarity
    for (let j = i + 1; j < n; j++) {
      const sim = cosineSimilarity(embeddings[i], embeddings[j]);
      matrix[i][j] = sim;
      matrix[j][i] = sim; // Symmetric
    }
  }

  return matrix;
}

/**
 * Agglomerative clustering using average linkage.
 *
 * Starts with each item in its own cluster, then iteratively merges
 * the two most similar clusters until similarity falls below threshold.
 *
 * @param similarityMatrix - NxN pairwise similarity matrix
 * @param threshold - Minimum similarity to merge clusters (e.g., 0.70)
 * @returns Array of cluster labels (same length as matrix dimension)
 */
function agglomerativeCluster(
  similarityMatrix: number[][],
  threshold: number
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

  // Iteratively merge closest clusters
  while (activeClusters.size > 1) {
    // Find the two most similar clusters
    let bestSim = -Infinity;
    let bestPair: [number, number] | null = null;

    const activeList = Array.from(activeClusters);
    for (let i = 0; i < activeList.length; i++) {
      for (let j = i + 1; j < activeList.length; j++) {
        const c1 = activeList[i];
        const c2 = activeList[j];
        const sim = averageLinkageSimilarity(
          clusterMembers.get(c1)!,
          clusterMembers.get(c2)!,
          similarityMatrix
        );
        if (sim > bestSim) {
          bestSim = sim;
          bestPair = [c1, c2];
        }
      }
    }

    // Stop if best similarity is below threshold
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
      // Singleton cluster - lower confidence since we couldn't match anyone
      confidence = 0.5;
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
