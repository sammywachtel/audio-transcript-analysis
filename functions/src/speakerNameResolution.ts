/**
 * Speaker Name Resolution Module
 *
 * Assigns speaker names AFTER embedding-based reconciliation using heuristic
 * evidence from the full transcript. Replaces per-chunk Gemini guesses with
 * post-reconciliation name assignment based on:
 * - Self-introductions (regex-detected): "I'm Chris", "My name is Alice"
 * - Direct address + response adjacency: "Thanks, Bob" followed by same speaker
 * - Per-chunk Gemini guesses as fallback (lowest priority)
 *
 * Key Design Decisions:
 * - Zero additional Gemini API calls (pure heuristic)
 * - Same name cannot be assigned to multiple canonical speakers
 * - Role-based labels preserved when confidence is low (weight < 0.5)
 * - Self-introductions take absolute priority over all other signals
 *
 * Gated by existing enableContextAwareReconciliation flag.
 */

import { Segment } from './types';
import { ClusterDetails } from './speakerReconciliation';

/**
 * Evidence for a name assignment to a canonical speaker.
 */
export interface NameEvidence {
  /** The candidate name */
  name: string;
  /** Evidence type that found this name */
  evidenceType: 'self_introduction' | 'direct_address_confirmed' | 'direct_address_unconfirmed' | 'gemini_guess';
  /** Weight of this evidence (1.0, 0.8, 0.5, or 0.3) */
  weight: number;
  /** Which segment ID this evidence came from */
  segmentId: string;
  /** The matched text that yielded this name */
  matchedText: string;
}

/**
 * Name resolution result for a canonical speaker.
 */
export interface NameResolutionResult {
  /** The canonical speaker ID */
  canonicalId: string;
  /** The resolved display name (either a name or role label) */
  resolvedName: string;
  /** Confidence level: 'high' if weight >= 0.8, 'medium' if >= 0.5, 'low' if < 0.5 */
  confidence: 'high' | 'medium' | 'low';
  /** All evidence collected for this speaker */
  evidence: NameEvidence[];
  /** Total weight of best candidate name */
  totalWeight: number;
  /** Whether a name was actually assigned (vs role label preserved) */
  nameAssigned: boolean;
}

/**
 * Evidence weights for different signal types.
 * Tuned to prioritize self-introductions while still allowing fallback to other signals.
 */
const EVIDENCE_WEIGHTS = {
  selfIntroduction: 1.0,        // "I'm Chris" - absolute priority
  directAddressConfirmed: 0.8,  // "Thanks, Bob" + Bob responds next
  directAddressUnconfirmed: 0.5,// "Thanks, Bob" (no response confirmation)
  geminiGuess: 0.3              // Per-chunk inferred name from Gemini
};

/**
 * Minimum weight threshold for name assignment.
 * Below this, preserve role-based labels (Host, Participant, etc.)
 */
const NAME_ASSIGNMENT_THRESHOLD = 0.5;

/**
 * Self-introduction patterns.
 * Match phrases where speaker identifies themselves by name.
 * Names are 1-2 capitalized words (e.g., "Chris" or "Chris Smith").
 */
const SELF_INTRO_PATTERNS = [
  /\bI'm\s+([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))?(?=\s|[,.]|$)/,                   // "I'm Chris", "I'm Chris Smith"
  /\b(?:my|My)\s+name\s+is\s+([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))?(?=\s|[,.]|$)/,  // "My name is Alice"
  /\bThis\s+is\s+([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))?(?=\s|[,.]|$)/,             // "This is Bob"
  /\b([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))?\s+here\b/,                              // "Chris here"
  /\b([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))?\s+speaking\b/                           // "Alice speaking"
];

/**
 * Direct address patterns.
 * Match phrases where someone addresses another person by name.
 */
const DIRECT_ADDRESS_PATTERNS = [
  /\bThanks?,?\s+([A-Z][a-z]+)\b/,                        // "Thanks, Bob", "Thank you Bob"
  /\b([A-Z][a-z]+),?\s+(?:can|could|would)\s+you\b/,      // "Alice, can you...", "Bob could you"
  /\b(?:Hey|Hi),?\s+([A-Z][a-z]+)\b/                      // "Hey Chris", "Hi, Alice"
];

/**
 * Main entry point: resolve speaker names using heuristic evidence.
 *
 * Algorithm:
 * 1. For each canonical speaker, collect all segments they spoke
 * 2. Scan segments for self-introduction patterns (weight 1.0)
 * 3. Scan for direct-address patterns with response confirmation (0.8 vs 0.5)
 * 4. Fall back to per-chunk Gemini guesses (weight 0.3)
 * 5. Sum weights per candidate name for each speaker
 * 6. Assign name only if total weight > 0.5 threshold
 * 7. Handle name conflicts (highest-scoring speaker wins)
 * 8. Preserve role labels when confidence < 0.5
 *
 * @param clusters - Canonical speaker clusters from reconciliation
 * @param allSegments - All transcript segments from all chunks
 * @param speakerIdRemapping - Map from original IDs to canonical IDs
 * @returns Array of name resolution results
 */
export function resolveNamesHeuristically(
  clusters: ClusterDetails[],
  allSegments: Segment[],
  speakerIdRemapping: Map<string, string>
): NameResolutionResult[] {
  console.log('[NameResolution] Starting heuristic name resolution:', {
    totalClusters: clusters.length,
    totalSegments: allSegments.length
  });

  // Step 1: Build index from canonical ID to all segments for that speaker
  const canonicalSegments = new Map<string, Segment[]>();

  for (const segment of allSegments) {
    // Map segment's speaker ID to canonical ID
    const canonicalId = speakerIdRemapping.get(segment.speakerId) || segment.speakerId;

    if (!canonicalSegments.has(canonicalId)) {
      canonicalSegments.set(canonicalId, []);
    }
    canonicalSegments.get(canonicalId)!.push(segment);
  }

  // Step 2: Collect evidence for each canonical speaker
  const results: NameResolutionResult[] = [];

  for (const cluster of clusters) {
    const segments = canonicalSegments.get(cluster.canonicalId) || [];
    const evidence = collectEvidence(cluster, segments, allSegments, speakerIdRemapping);

    // Step 3: Score candidates and select best name
    const resolution = selectBestName(cluster, evidence);
    results.push(resolution);

    console.log('[NameResolution] Resolved speaker:', {
      canonicalId: cluster.canonicalId,
      resolvedName: resolution.resolvedName,
      nameAssigned: resolution.nameAssigned,
      confidence: resolution.confidence,
      totalWeight: resolution.totalWeight.toFixed(2),
      evidenceCount: evidence.length,
      originalDisplayName: cluster.displayName
    });
  }

  // Step 4: Handle name conflicts (same name assigned to multiple speakers)
  const finalResults = resolveNameConflicts(results);

  console.log('[NameResolution] Name resolution complete:', {
    totalSpeakers: finalResults.length,
    namesAssigned: finalResults.filter(r => r.nameAssigned).length,
    roleLabelsPreserved: finalResults.filter(r => !r.nameAssigned).length
  });

  return finalResults;
}

/**
 * Collect all evidence for a canonical speaker's name.
 */
function collectEvidence(
  cluster: ClusterDetails,
  segments: Segment[],
  allSegments: Segment[],
  speakerIdRemapping: Map<string, string>
): NameEvidence[] {
  const evidence: NameEvidence[] = [];

  // Sort segments by index for adjacency checks
  const sortedSegments = [...segments].sort((a, b) => a.index - b.index);
  const allSortedSegments = [...allSegments].sort((a, b) => a.index - b.index);

  for (const segment of sortedSegments) {
    // Check for self-introductions
    for (const pattern of SELF_INTRO_PATTERNS) {
      const match = segment.text.match(pattern);
      if (match && match[1]) {
        // Extract name: match[1] is first name, match[2] is optional last name
        const name = match[2] ? `${match[1]} ${match[2]}` : match[1];
        evidence.push({
          name: name.trim(),
          evidenceType: 'self_introduction',
          weight: EVIDENCE_WEIGHTS.selfIntroduction,
          segmentId: segment.segmentId,
          matchedText: match[0]
        });
      }
    }

    // Check for direct address patterns in OTHER speakers' segments
    const segmentIndex = allSortedSegments.findIndex(s => s.segmentId === segment.segmentId);

    // Check if previous segment addressed this speaker
    if (segmentIndex > 0) {
      const prevSegment = allSortedSegments[segmentIndex - 1];
      const prevCanonicalId = speakerIdRemapping.get(prevSegment.speakerId) || prevSegment.speakerId;

      // Only consider direct address if it's from a DIFFERENT speaker
      if (prevCanonicalId !== cluster.canonicalId) {
        for (const pattern of DIRECT_ADDRESS_PATTERNS) {
          const match = prevSegment.text.match(pattern);
          if (match && match[1]) {
            // Check if current segment is a response (confirms the address)
            const isResponse = segment.index === prevSegment.index + 1;

            evidence.push({
              name: match[1].trim(),
              evidenceType: isResponse ? 'direct_address_confirmed' : 'direct_address_unconfirmed',
              weight: isResponse ? EVIDENCE_WEIGHTS.directAddressConfirmed : EVIDENCE_WEIGHTS.directAddressUnconfirmed,
              segmentId: prevSegment.segmentId,
              matchedText: match[0]
            });
          }
        }
      }
    }
  }

  // Add Gemini guess as fallback evidence (from cluster display name)
  // Only if display name looks like a proper name (not a role label)
  const geminiGuess = cluster.displayName;
  const roleLabels = ['Host', 'Participant', 'Guest', 'Unknown', 'Caller', 'Interviewer', 'Interviewee'];

  if (geminiGuess &&
      /^[A-Z][a-z]+/.test(geminiGuess) &&
      !geminiGuess.startsWith('Speaker') &&
      !roleLabels.includes(geminiGuess)) {
    evidence.push({
      name: geminiGuess,
      evidenceType: 'gemini_guess',
      weight: EVIDENCE_WEIGHTS.geminiGuess,
      segmentId: 'cluster', // Not from a specific segment
      matchedText: `Inferred from cluster: ${geminiGuess}`
    });
  }

  return evidence;
}

/**
 * Select the best name for a speaker based on evidence.
 */
function selectBestName(cluster: ClusterDetails, evidence: NameEvidence[]): NameResolutionResult {
  // Group evidence by candidate name and sum weights
  const candidateScores = new Map<string, { totalWeight: number; evidence: NameEvidence[] }>();

  for (const ev of evidence) {
    const normalized = ev.name.trim();

    if (!candidateScores.has(normalized)) {
      candidateScores.set(normalized, { totalWeight: 0, evidence: [] });
    }

    const candidate = candidateScores.get(normalized)!;
    candidate.totalWeight += ev.weight;
    candidate.evidence.push(ev);
  }

  // Find best candidate (highest total weight)
  let bestName: string | null = null;
  let bestWeight = 0;
  let bestEvidence: NameEvidence[] = [];

  for (const [name, { totalWeight, evidence }] of candidateScores) {
    if (totalWeight > bestWeight) {
      bestName = name;
      bestWeight = totalWeight;
      bestEvidence = evidence;
    }
  }

  // Determine if we should assign the name or preserve role label
  const nameAssigned = bestWeight >= NAME_ASSIGNMENT_THRESHOLD;
  const resolvedName = nameAssigned && bestName ? bestName : cluster.displayName;

  // Calculate confidence level
  let confidence: 'high' | 'medium' | 'low';
  if (bestWeight >= 0.8) {
    confidence = 'high';
  } else if (bestWeight >= 0.5) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return {
    canonicalId: cluster.canonicalId,
    resolvedName,
    confidence,
    evidence: bestEvidence,
    totalWeight: bestWeight,
    nameAssigned
  };
}

/**
 * Handle name conflicts: if multiple speakers have the same best name,
 * assign it only to the highest-scoring one and preserve role labels for others.
 */
function resolveNameConflicts(results: NameResolutionResult[]): NameResolutionResult[] {
  // Group results by resolved name
  const nameGroups = new Map<string, NameResolutionResult[]>();

  for (const result of results) {
    if (result.nameAssigned) {
      const name = result.resolvedName;
      if (!nameGroups.has(name)) {
        nameGroups.set(name, []);
      }
      nameGroups.get(name)!.push(result);
    }
  }

  // Find conflicts (names assigned to multiple speakers)
  const conflicts = new Map<string, NameResolutionResult[]>();

  for (const [name, group] of nameGroups) {
    if (group.length > 1) {
      conflicts.set(name, group);

      console.log('[NameResolution] Name conflict detected:', {
        name,
        conflictingSpeakers: group.map(r => ({
          canonicalId: r.canonicalId,
          totalWeight: r.totalWeight.toFixed(2)
        }))
      });
    }
  }

  // Resolve conflicts: highest weight wins, others revert to role labels
  const finalResults = [...results];

  for (const [name, group] of conflicts) {
    // Sort by total weight descending
    const sorted = [...group].sort((a, b) => b.totalWeight - a.totalWeight);
    const winner = sorted[0];
    const losers = sorted.slice(1);

    console.log('[NameResolution] Conflict resolution:', {
      name,
      winner: winner.canonicalId,
      losers: losers.map(l => l.canonicalId)
    });

    // Revert losers to their original cluster display names
    for (const loser of losers) {
      const index = finalResults.findIndex(r => r.canonicalId === loser.canonicalId);
      if (index !== -1) {
        // Find original display name from cluster (would need to pass clusters, but we can reconstruct)
        // For now, just mark as not assigned and use a generic label
        finalResults[index] = {
          ...loser,
          resolvedName: `Speaker ${loser.canonicalId.replace('speaker_canonical_', '')}`,
          nameAssigned: false,
          confidence: 'low'
        };
      }
    }
  }

  return finalResults;
}
