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
  highConfidenceMatch: ReconciliationConfig.HIGH_CONFIDENCE_MATCH,  // Pairs above this create edges (0.7)
  /**
   * Cohesion safeguard threshold: minimum similarity required across all
   * cross-cluster pairs when merging. Lower than highConfidenceMatch to allow
   * transitive merges where some pairs are slightly weaker.
   * 0.7 caused over-fragmentation (24 clusters); 0.6 is more permissive.
   */
  cohesionThreshold: 0.6,
  /**
   * Singleton cluster confidence: "no evidence" means neutral, not bad.
   * A speaker appearing in only one chunk has no cross-chunk comparisons,
   * so we assign 0.75 (neutral-ish) instead of 0.0 which tanks overall confidence.
   */
  singletonConfidence: 0.75
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

// =============================================================================
// Union-Find for Transitive Merging
// =============================================================================

/**
 * Union-Find (Disjoint Set Union) for transitive clustering.
 * Enables A+B+C to merge when A-B and B-C both exceed threshold,
 * even if we never directly compared A-C.
 */
class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = Array(size).fill(0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]); // Path compression
    }
    return this.parent[x];
  }

  union(x: number, y: number): void {
    const rootX = this.find(x);
    const rootY = this.find(y);
    if (rootX === rootY) return;

    // Union by rank
    if (this.rank[rootX] < this.rank[rootY]) {
      this.parent[rootX] = rootY;
    } else if (this.rank[rootX] > this.rank[rootY]) {
      this.parent[rootY] = rootX;
    } else {
      this.parent[rootY] = rootX;
      this.rank[rootX]++;
    }
  }

  connected(x: number, y: number): boolean {
    return this.find(x) === this.find(y);
  }
}

/**
 * Cluster speakers using union-find with cohesion safeguard.
 *
 * Algorithm:
 * 1. Build edges: all pairs with similarity ≥ threshold
 * 2. Union-find: merge transitively (A-B, B-C → A,B,C together)
 * 3. Cohesion safeguard: before finalizing a merge, check that the minimum
 *    cross-component similarity is ≥ threshold to avoid "bridge" over-merges
 *    (e.g., A-B=0.8, B-C=0.8, but A-C=0.3 should NOT merge)
 * 4. Extract connected components as clusters
 * 5. Singletons get neutral confidence (0.75)
 *
 * @param signatures - All speaker signatures
 * @param pairs - Similarity pairs (sorted by score descending)
 * @returns Array of speaker clusters
 */
function clusterSpeakers(
  signatures: SpeakerSignature[],
  pairs: SimilarityPair[]
): SpeakerCluster[] {
  const n = signatures.length;
  if (n === 0) return [];

  // Build signature index map
  const sigToIndex = new Map<SpeakerSignature, number>();
  signatures.forEach((sig, i) => sigToIndex.set(sig, i));

  // Build similarity lookup for cohesion check
  // Key: "i,j" where i < j, Value: similarity score
  const similarityLookup = new Map<string, number>();
  for (const pair of pairs) {
    const i = sigToIndex.get(pair.sig1)!;
    const j = sigToIndex.get(pair.sig2)!;
    const key = i < j ? `${i},${j}` : `${j},${i}`;
    similarityLookup.set(key, pair.score);
  }

  const getSimilarity = (i: number, j: number): number => {
    if (i === j) return 1.0;
    const key = i < j ? `${i},${j}` : `${j},${i}`;
    return similarityLookup.get(key) ?? 0.0;
  };

  // Initialize union-find
  const uf = new UnionFind(n);

  // Build edge list for pairs above threshold
  const edges: { i: number; j: number; pair: SimilarityPair }[] = [];
  for (const pair of pairs) {
    if (pair.score < THRESHOLDS.highConfidenceMatch) break; // Sorted descending
    const i = sigToIndex.get(pair.sig1)!;
    const j = sigToIndex.get(pair.sig2)!;
    edges.push({ i, j, pair });
  }

  console.log('[Reconciliation] Building transitive clusters:', {
    signatureCount: n,
    edgeCount: edges.length,
    threshold: THRESHOLDS.highConfidenceMatch
  });

  // Process edges with cohesion safeguard
  // We union if the minimum similarity across the would-be merged component
  // stays above threshold. This is an approximation of complete-linkage.
  for (const { i, j } of edges) {
    const rootI = uf.find(i);
    const rootJ = uf.find(j);
    if (rootI === rootJ) continue; // Already connected

    // Collect members of both components
    const membersI: number[] = [];
    const membersJ: number[] = [];
    for (let k = 0; k < n; k++) {
      if (uf.find(k) === rootI) membersI.push(k);
      if (uf.find(k) === rootJ) membersJ.push(k);
    }

    // Cohesion check: minimum cross-component similarity
    let minCrossSim = 1.0;
    for (const mi of membersI) {
      for (const mj of membersJ) {
        const sim = getSimilarity(mi, mj);
        if (sim < minCrossSim) minCrossSim = sim;
      }
    }

    // Only merge if all cross-pairs meet cohesion threshold (complete-linkage style)
    // Using cohesionThreshold (0.6) instead of highConfidenceMatch (0.7) to allow
    // transitive merges where some pairs are slightly weaker but still valid
    if (minCrossSim >= THRESHOLDS.cohesionThreshold) {
      uf.union(i, j);
    }
  }

  // Extract clusters from union-find
  const componentMembers = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (!componentMembers.has(root)) {
      componentMembers.set(root, []);
    }
    componentMembers.get(root)!.push(i);
  }

  // Build cluster objects with proper confidence
  const clusters: SpeakerCluster[] = [];
  for (const members of componentMembers.values()) {
    const clusterSigs = members.map(i => signatures[i]);

    // Compute average pairwise similarity within cluster
    let totalSim = 0;
    let pairCount = 0;
    let nameMatches = 0;
    let topicOverlap = 0;
    let termOverlap = 0;

    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        const sim = getSimilarity(members[a], members[b]);
        totalSim += sim;
        pairCount++;

        // Accumulate evidence from matching pairs
        const key = members[a] < members[b]
          ? `${members[a]},${members[b]}`
          : `${members[b]},${members[a]}`;
        for (const pair of pairs) {
          const pi = sigToIndex.get(pair.sig1)!;
          const pj = sigToIndex.get(pair.sig2)!;
          const pairKey = pi < pj ? `${pi},${pj}` : `${pj},${pi}`;
          if (pairKey === key) {
            if (pair.evidence.nameScore > 0) nameMatches++;
            topicOverlap += pair.evidence.topicOverlap;
            termOverlap += pair.evidence.termOverlap;
            break;
          }
        }
      }
    }

    // Singleton clusters get neutral confidence
    const avgSimilarity = pairCount > 0
      ? totalSim / pairCount
      : THRESHOLDS.singletonConfidence;

    clusters.push({
      signatures: clusterSigs,
      avgSimilarity,
      evidence: { nameMatches, topicOverlap, termOverlap }
    });
  }

  console.log('[Reconciliation] Transitive clustering complete:', {
    inputSignatures: n,
    outputClusters: clusters.length,
    clusterSizes: clusters.map(c => c.signatures.length)
  });

  return clusters;
}
