/**
 * Speaker Reconciliation Module
 *
 * Matches speakers across independently-processed audio chunks in parallel mode.
 * Uses name, topic, and term signals to cluster speakers and generate canonical IDs.
 *
 * Core Algorithm:
 * 1. Compute similarity matrix between all speaker pairs (cross-chunk only)
 * 2. Greedy clustering: merge high-confidence pairs (>0.7)
 * 3. Generate canonical IDs and confidence scores
 * 4. Throw error if overall confidence below threshold (0.6)
 */

import { SpeakerSignature } from './types';
import { ReconciliationConfig } from './config/reconciliation';

/**
 * Result of speaker reconciliation with canonical mappings and confidence details.
 */
export interface ReconciliationResult {
  /** Map from original chunk speaker IDs to canonical IDs (e.g., "SPEAKER_00_chunk0" → "speaker_canonical_0") */
  speakerIdMap: Map<string, string>;
  /** Overall reconciliation confidence (0-1, min of cluster confidences) */
  overallConfidence: number;
  /** Per-cluster match details for debugging and transparency */
  clusterDetails: ClusterDetails[];
}

/**
 * Details for a single speaker cluster (canonical speaker).
 */
export interface ClusterDetails {
  /** Canonical speaker ID (e.g., "speaker_canonical_0") */
  canonicalId: string;
  /** Original speaker IDs that were merged into this cluster */
  originalIds: string[];
  /** Average similarity score for this cluster (0-1) */
  confidence: number;
  /** Best display name from the cluster (prefer named speakers) */
  displayName: string;
  /** Match evidence (for debugging) */
  matchEvidence: {
    nameMatches: number;
    topicOverlap: number;
    termOverlap: number;
  };
}

/**
 * Custom error thrown when reconciliation confidence is below threshold.
 * Indicates speaker matching is too uncertain to proceed.
 */
export class ReconciliationLowConfidenceError extends Error {
  constructor(
    message: string,
    public overallConfidence: number,
    public clusterDetails: ClusterDetails[]
  ) {
    super(message);
    this.name = 'ReconciliationLowConfidenceError';
  }
}

/**
 * Similarity pair between two speakers from different chunks.
 */
interface SimilarityPair {
  sig1: SpeakerSignature;
  sig2: SpeakerSignature;
  score: number;
  evidence: {
    nameScore: number;
    topicOverlap: number;
    termOverlap: number;
  };
}

/**
 * Weighting constants for similarity scoring.
 * These are tuned for the expected signal quality from our pipeline:
 * - Names are most reliable (when present)
 * - Topic/term overlap provides corroborating evidence
 */
const WEIGHTS = {
  name: 0.5,      // 50% - strongest signal when available
  topic: 0.25,    // 25% - subject matter correlation
  term: 0.25      // 25% - vocabulary fingerprint
};

/**
 * Confidence thresholds for clustering.
 * Note: The low-confidence threshold check is performed in chunkMerge.ts
 * against ReconciliationConfig.CONFIDENCE_THRESHOLD for env var override support.
 * This module only computes confidence - it does not enforce thresholds.
 */
const THRESHOLDS = {
  highConfidenceMatch: ReconciliationConfig.HIGH_CONFIDENCE_MATCH   // Pairs above this are merged greedily
};

/**
 * Main entry point: reconcile speakers across chunks.
 *
 * Note: This function no longer throws on low confidence. The caller
 * (chunkMerge.ts) is responsible for checking the overallConfidence
 * against ReconciliationConfig.CONFIDENCE_THRESHOLD and handling fallback.
 *
 * @param signatures - Speaker signatures from all chunks
 * @returns Reconciliation result with canonical IDs and confidence
 */
export function reconcileSpeakers(signatures: SpeakerSignature[]): ReconciliationResult {
  console.log('[Reconciliation] Starting speaker reconciliation:', {
    totalSignatures: signatures.length,
    chunks: new Set(signatures.map(s => s.chunkIndex)).size
  });

  // Step 1: Compute similarity matrix (only cross-chunk pairs)
  const similarityPairs = computeSimilarityMatrix(signatures);

  console.log('[Reconciliation] Similarity matrix computed:', {
    totalPairs: similarityPairs.length,
    highConfidencePairs: similarityPairs.filter(p => p.score >= THRESHOLDS.highConfidenceMatch).length
  });

  // Step 2: Greedy clustering
  const clusters = clusterSpeakers(signatures, similarityPairs);

  console.log('[Reconciliation] Clustering complete:', {
    totalClusters: clusters.length
  });

  // Step 3: Build result with canonical IDs
  const speakerIdMap = new Map<string, string>();
  const clusterDetails: ClusterDetails[] = [];

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    const canonicalId = `speaker_canonical_${i}`;

    // Map all original IDs to canonical ID
    for (const sig of cluster.signatures) {
      const originalId = `${sig.speakerId}_chunk${sig.chunkIndex}`;
      speakerIdMap.set(originalId, canonicalId);
    }

    // Pick best display name (prefer longer, more complete names)
    const namedSignatures = cluster.signatures.filter(s => s.inferredName);
    let displayName: string;
    if (namedSignatures.length > 0) {
      // Pick the longest name (more complete)
      displayName = namedSignatures.reduce((longest, sig) =>
        sig.inferredName!.length > longest.inferredName!.length ? sig : longest
      ).inferredName!;
    } else {
      displayName = cluster.signatures[0].speakerId;
    }

    // Compute cluster confidence (average of pair similarities)
    const confidence = cluster.avgSimilarity;

    // Aggregate match evidence
    const matchEvidence = {
      nameMatches: cluster.evidence.nameMatches,
      topicOverlap: cluster.evidence.topicOverlap,
      termOverlap: cluster.evidence.termOverlap
    };

    clusterDetails.push({
      canonicalId,
      originalIds: cluster.signatures.map(s => `${s.speakerId}_chunk${s.chunkIndex}`),
      confidence,
      displayName,
      matchEvidence
    });
  }

  // Step 4: Calculate overall confidence (min of cluster confidences)
  const overallConfidence = clusterDetails.length > 0
    ? Math.min(...clusterDetails.map(c => c.confidence))
    : 1.0; // No clusters = perfect confidence (single speaker or no speakers)

  console.log('[Reconciliation] Result:', {
    totalMappings: speakerIdMap.size,
    overallConfidence,
    clusterCount: clusterDetails.length
  });

  // Note: Threshold enforcement moved to chunkMerge.ts
  // This module returns the result; the caller decides how to handle low confidence

  return {
    speakerIdMap,
    overallConfidence,
    clusterDetails
  };
}

/**
 * Compute similarity matrix between all speaker pairs (cross-chunk only).
 *
 * @param signatures - All speaker signatures
 * @returns Array of similarity pairs, sorted by score descending
 */
function computeSimilarityMatrix(signatures: SpeakerSignature[]): SimilarityPair[] {
  const pairs: SimilarityPair[] = [];

  // Compare each signature with every other signature
  for (let i = 0; i < signatures.length; i++) {
    for (let j = i + 1; j < signatures.length; j++) {
      const sig1 = signatures[i];
      const sig2 = signatures[j];

      // Only compare speakers from DIFFERENT chunks
      if (sig1.chunkIndex === sig2.chunkIndex) {
        continue;
      }

      const similarity = computeSimilarity(sig1, sig2);
      pairs.push(similarity);
    }
  }

  // Sort by score descending (best matches first)
  pairs.sort((a, b) => b.score - a.score);

  return pairs;
}

/**
 * Compute similarity between two speakers from different chunks.
 *
 * Combines three signals:
 * 1. Name matching (fuzzy, high weight)
 * 2. Topic overlap (Jaccard similarity)
 * 3. Term overlap (Jaccard similarity)
 *
 * @returns Similarity pair with score and evidence breakdown
 */
function computeSimilarity(sig1: SpeakerSignature, sig2: SpeakerSignature): SimilarityPair {
  let score = 0;
  const evidence = {
    nameScore: 0,
    topicOverlap: 0,
    termOverlap: 0
  };

  // 1. Name matching (high weight when both names present)
  if (sig1.inferredName && sig2.inferredName) {
    const nameScore = fuzzyNameMatch(sig1.inferredName, sig2.inferredName);
    evidence.nameScore = nameScore;
    score += nameScore * WEIGHTS.name;
  }

  // 2. Topic overlap (Jaccard similarity)
  const topicOverlap = jaccardSimilarity(sig1.topicSignatures, sig2.topicSignatures);
  evidence.topicOverlap = topicOverlap;
  score += topicOverlap * WEIGHTS.topic;

  // 3. Term overlap (Jaccard similarity)
  const termOverlap = jaccardSimilarity(sig1.termSignatures, sig2.termSignatures);
  evidence.termOverlap = termOverlap;
  score += termOverlap * WEIGHTS.term;

  return { sig1, sig2, score, evidence };
}

/**
 * Fuzzy name matching with normalization.
 * Handles common variations (case, whitespace, punctuation).
 *
 * @returns Score from 0 (no match) to 1 (exact match)
 */
function fuzzyNameMatch(name1: string, name2: string): number {
  // Normalize: lowercase, trim, remove punctuation
  const normalize = (s: string) =>
    s.toLowerCase().trim().replace(/[^\w\s]/g, '');

  const n1 = normalize(name1);
  const n2 = normalize(name2);

  // Exact match after normalization
  if (n1 === n2) {
    return 1.0;
  }

  // Check if one name contains the other (e.g., "John" vs "John Smith")
  if (n1.includes(n2) || n2.includes(n1)) {
    return 0.8;
  }

  // Check first word match (common first name)
  const firstName1 = n1.split(/\s+/)[0];
  const firstName2 = n2.split(/\s+/)[0];
  if (firstName1 === firstName2 && firstName1.length > 2) {
    return 0.6;
  }

  // No match
  return 0.0;
}

/**
 * Jaccard similarity coefficient: |A ∩ B| / |A ∪ B|
 *
 * Measures overlap between two sets.
 * Returns 1.0 for identical sets, 0.0 for disjoint sets.
 */
function jaccardSimilarity(set1: string[], set2: string[]): number {
  if (set1.length === 0 && set2.length === 0) {
    return 1.0; // Empty sets are identical
  }

  const s1 = new Set(set1);
  const s2 = new Set(set2);

  // Intersection
  const intersection = new Set([...s1].filter(x => s2.has(x)));

  // Union
  const union = new Set([...s1, ...s2]);

  return intersection.size / union.size;
}

/**
 * Speaker cluster (group of speakers identified as the same person).
 */
interface SpeakerCluster {
  signatures: SpeakerSignature[];
  avgSimilarity: number;
  evidence: {
    nameMatches: number;
    topicOverlap: number;
    termOverlap: number;
  };
}

/**
 * Cluster speakers using greedy algorithm.
 *
 * Algorithm:
 * 1. Sort pairs by similarity (descending)
 * 2. For each high-confidence pair (>0.7):
 *    - If neither speaker is clustered, create new cluster
 *    - If one speaker is clustered, add other to same cluster
 *    - If both are clustered, skip (already matched)
 * 3. Unclustered speakers become singleton clusters
 *
 * @param signatures - All speaker signatures
 * @param pairs - Similarity pairs (sorted by score descending)
 * @returns Array of speaker clusters
 */
function clusterSpeakers(
  signatures: SpeakerSignature[],
  pairs: SimilarityPair[]
): SpeakerCluster[] {
  // Track which signature belongs to which cluster
  const sigToClusterId = new Map<SpeakerSignature, number>();
  const clusters: SpeakerCluster[] = [];

  // Helper: Get or create cluster for a signature
  const getClusterId = (sig: SpeakerSignature): number | null => {
    return sigToClusterId.get(sig) ?? null;
  };

  // Helper: Create a new cluster
  const createCluster = (sig: SpeakerSignature): number => {
    const clusterId = clusters.length;
    clusters.push({
      signatures: [sig],
      avgSimilarity: 0.0, // Singleton clusters have no similarity evidence (not 1.0!)
      evidence: { nameMatches: 0, topicOverlap: 0, termOverlap: 0 }
    });
    sigToClusterId.set(sig, clusterId);
    return clusterId;
  };

  // Helper: Add signature to existing cluster
  const addToCluster = (sig: SpeakerSignature, clusterId: number): void => {
    clusters[clusterId].signatures.push(sig);
    sigToClusterId.set(sig, clusterId);
  };

  // Process high-confidence pairs in order (greedy)
  for (const pair of pairs) {
    if (pair.score < THRESHOLDS.highConfidenceMatch) {
      break; // Pairs are sorted, rest are below threshold
    }

    const cluster1 = getClusterId(pair.sig1);
    const cluster2 = getClusterId(pair.sig2);

    if (cluster1 === null && cluster2 === null) {
      // Neither clustered - create new cluster with both
      const clusterId = createCluster(pair.sig1);
      addToCluster(pair.sig2, clusterId);

      // Update cluster evidence
      clusters[clusterId].evidence.nameMatches += pair.evidence.nameScore > 0 ? 1 : 0;
      clusters[clusterId].evidence.topicOverlap += pair.evidence.topicOverlap;
      clusters[clusterId].evidence.termOverlap += pair.evidence.termOverlap;
      clusters[clusterId].avgSimilarity = pair.score;

    } else if (cluster1 !== null && cluster2 === null) {
      // sig1 clustered, sig2 not - add sig2 to sig1's cluster
      addToCluster(pair.sig2, cluster1);

      // Update average similarity
      const cluster = clusters[cluster1];
      const pairCount = cluster.signatures.length - 1; // Exclude the new signature
      cluster.avgSimilarity = (cluster.avgSimilarity * pairCount + pair.score) / (pairCount + 1);
      cluster.evidence.nameMatches += pair.evidence.nameScore > 0 ? 1 : 0;
      cluster.evidence.topicOverlap += pair.evidence.topicOverlap;
      cluster.evidence.termOverlap += pair.evidence.termOverlap;

    } else if (cluster1 === null && cluster2 !== null) {
      // sig2 clustered, sig1 not - add sig1 to sig2's cluster
      addToCluster(pair.sig1, cluster2);

      // Update average similarity
      const cluster = clusters[cluster2];
      const pairCount = cluster.signatures.length - 1;
      cluster.avgSimilarity = (cluster.avgSimilarity * pairCount + pair.score) / (pairCount + 1);
      cluster.evidence.nameMatches += pair.evidence.nameScore > 0 ? 1 : 0;
      cluster.evidence.topicOverlap += pair.evidence.topicOverlap;
      cluster.evidence.termOverlap += pair.evidence.termOverlap;

    } else if (cluster1 === cluster2) {
      // Already in same cluster - skip
      continue;

    } else {
      // Both in different clusters - don't merge (avoid cluster merging complexity)
      // This is a simplification; in practice, we'd merge clusters here
      continue;
    }
  }

  // Add unclustered signatures as singletons
  for (const sig of signatures) {
    if (!sigToClusterId.has(sig)) {
      createCluster(sig);
    }
  }

  return clusters;
}
