/**
 * HARDY: Hierarchical Anchored Resilient Dynamic Alignment
 *
 * A robust timestamp alignment algorithm that maps Gemini transcript segments
 * to precise WhisperX word-level timestamps. Uses hierarchical anchor-based
 * alignment with cascade failure prevention.
 *
 * Architecture:
 *    Level 1: Anchor Point Identification (high-confidence matches)
 *    Level 2: Region Segmentation (divide transcript at anchors)
 *    Level 3: Regional Alignment (independent DTW-style matching)
 *    Level 4: Validation & Fallback (quality gates, graceful degradation)
 */

import Replicate from 'replicate';
import fuzz from 'fuzzball';

// WhisperX model on Replicate - provides word-level timestamps via forced alignment
const WHISPERX_MODEL = 'victor-upmeet/whisperx:84d2ad2d6194fe98a17d2b60bef1c7f910c46b2f6fd38996ca457afd9c8abfcb';

// =============================================================================
// Configuration
// =============================================================================

// Anchor detection thresholds
const ANCHOR_MIN_CONFIDENCE = 0.75;  // Minimum similarity for anchor points (lowered from 0.85)
const ANCHOR_MIN_WORDS = 2;  // Minimum words for an anchor (lowered from 3)
const ANCHOR_MAX_WORDS = 20;  // Maximum words for an anchor (raised from 15)

// Search window configuration - FIXED: use absolute values, not percentages
const TIME_WINDOW_SECONDS = 30;  // Search ±30 seconds around time hint
const MIN_SEARCH_BUFFER = 50;  // Minimum words to search around hint (raised from 30)

// Global anchor search configuration
const GLOBAL_ANCHOR_COUNT = 5;  // First N segments use global search (ignores Gemini timestamps)

// Matching thresholds
const MIN_SEGMENT_CONFIDENCE = 0.40;  // Per-segment minimum to accept (lowered from 0.45)
// Note: MIN_REGION_CONFIDENCE is kept for potential future quality gate implementation
// const MIN_REGION_CONFIDENCE = 0.50;  // Average confidence for a region (lowered from 0.55)

// Validation
const MAX_OVERLAP_MS = 2000;  // Max overlap between consecutive segments (raised from 1000)
const MIN_MS_PER_WORD = 20;  // Minimum milliseconds per word (lowered from 30)
const MAX_MS_PER_WORD = 800;  // Maximum milliseconds per word (raised from 600)

// =============================================================================
// Data Types
// =============================================================================

export interface Word {
  word: string;
  start: number;  // seconds
  end: number;    // seconds
  index: number;
}

export interface Segment {
  speakerId: string;
  text: string;
  startMs: number;
  endMs: number;
  index: number;
}

export interface AlignedSegment {
  speakerId: string;
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
  method: string;  // 'aligned', 'interpolated', 'original', 'anchor'
}

interface Anchor {
  segmentIdx: number;
  wordStartIdx: number;
  wordEndIdx: number;
  confidence: number;
  startMs: number;
  endMs: number;
}

interface Region {
  segments: Segment[];
  startSegmentIdx: number;
  endSegmentIdx: number;
  wordStartIdx: number;
  wordEndIdx: number;
  timeStartMs: number;
  timeEndMs: number;
}

interface MatchResult {
  startIdx: number;
  endIdx: number;
  startMs: number;
  endMs: number;
  confidence: number;
  method: string;
}

export interface AlignmentResult {
  segments: { speakerId: string; text: string; startMs: number; endMs: number }[];
  alignmentStatus: 'aligned' | 'fallback';
  alignmentError?: string;
}

class AlignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlignmentError';
  }
}

// =============================================================================
// Text Normalization
// =============================================================================

function normalizeText(text: string): string {
  /**
   * Normalize text for fuzzy matching.
   * Lowercase, remove punctuation, collapse whitespace.
   */
  let normalized = text.toLowerCase();
  normalized = normalized.replace(/[^\w\s]/g, '');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized;
}

function getNgrams(text: string, n: number = 3): Set<string> {
  /** Extract character n-grams from text. */
  const normalized = normalizeText(text);
  if (normalized.length < n) {
    return new Set([normalized]);
  }
  const ngrams = new Set<string>();
  for (let i = 0; i < normalized.length - n + 1; i++) {
    ngrams.add(normalized.substring(i, i + n));
  }
  return ngrams;
}

function ngramSimilarity(text1: string, text2: string, n: number = 3): number {
  /** Compute n-gram based similarity between two texts. */
  const ngrams1 = getNgrams(text1, n);
  const ngrams2 = getNgrams(text2, n);

  if (ngrams1.size === 0 || ngrams2.size === 0) {
    return 0.0;
  }

  const intersection = new Set([...ngrams1].filter(x => ngrams2.has(x)));
  const union = new Set([...ngrams1, ...ngrams2]);

  return union.size > 0 ? intersection.size / union.size : 0.0;
}

// =============================================================================
// Multi-Factor Similarity Scoring
// =============================================================================

function computeSimilarity(geminiText: string, whisperxText: string, enableDiagnostics: boolean = false): number {
  /**
   * Multi-factor similarity scoring for robust matching.
   *
   * Combines:
   * - Token set ratio (handles word order, extra words)
   * - Token sort ratio (handles reordering)
   * - Sequence matcher (handles insertions/deletions) - FIXED: now uses Gestalt pattern matching
   * - N-gram overlap (handles word boundary differences)
   */
  const gNorm = normalizeText(geminiText);
  const wNorm = normalizeText(whisperxText);

  if (!gNorm || !wNorm) {
    return 0.0;
  }

  // Score 1: Token set ratio - ignores duplicates and order
  const tokenSet = fuzz.token_set_ratio(gNorm, wNorm) / 100.0;

  // Score 2: Token sort ratio - sorts tokens before comparing
  const tokenSort = fuzz.token_sort_ratio(gNorm, wNorm) / 100.0;

  // Score 3: Partial ratio - finds best partial match
  const partial = fuzz.partial_ratio(gNorm, wNorm) / 100.0;

  // Score 4: Sequence matcher - FIXED: use Gestalt pattern matching like Python
  const seqMatch = sequenceMatcherRatio(gNorm, wNorm);

  // Score 5: N-gram similarity - handles word boundary issues
  const ngram = ngramSimilarity(gNorm, wNorm, 3);

  // Diagnostic comparison (only when enabled for anchor detection)
  if (enableDiagnostics) {
    const levenshteinScore = simpleRatio(gNorm, wNorm);
    const scoreDiff = seqMatch - levenshteinScore;
    console.debug(
      `[DIAGNOSTIC] Similarity algorithm comparison: ` +
      `text1="${gNorm.slice(0, 50)}", text2="${wNorm.slice(0, 50)}", ` +
      `levenshtein=${levenshteinScore.toFixed(3)}, gestalt=${seqMatch.toFixed(3)}, ` +
      `diff=${scoreDiff.toFixed(3)}`
    );
  }

  // Weighted combination - emphasize token-based for speech
  return (
    0.30 * tokenSet +
    0.25 * tokenSort +
    0.20 * partial +
    0.15 * seqMatch +
    0.10 * ngram
  );
}

function simpleRatio(s1: string, s2: string): number {
  /** Simple Levenshtein-based ratio (0-1) - DEPRECATED: use sequenceMatcherRatio for better accuracy */
  const distance = levenshteinDistance(s1, s2);
  const maxLen = Math.max(s1.length, s2.length);
  return maxLen > 0 ? 1 - (distance / maxLen) : 1.0;
}

interface MatchingBlock {
  aStart: number;
  bStart: number;
  size: number;
}

function sequenceMatcherRatio(a: string, b: string): number {
  /**
   * Implementation of Python's difflib.SequenceMatcher.ratio()
   * Uses Gestalt pattern matching: finds longest common subsequence,
   * then recursively matches the unmatched parts.
   *
   * This is CRITICAL for alignment quality - Levenshtein distance produces
   * different scores than Python's SequenceMatcher for the same text pairs.
   */
  if (a.length === 0 && b.length === 0) {
    return 1.0;
  }
  if (a.length === 0 || b.length === 0) {
    return 0.0;
  }

  // Find all matching blocks
  const matches = findMatchingBlocks(a, b);

  // Calculate ratio: 2 * M / T where M is matches and T is total chars
  const totalMatched = matches.reduce((sum, m) => sum + m.size, 0);
  const totalLength = a.length + b.length;

  return totalLength > 0 ? (2 * totalMatched) / totalLength : 1.0;
}

function findMatchingBlocks(a: string, b: string): MatchingBlock[] {
  /**
   * Find all matching blocks between two strings using Gestalt pattern matching.
   * Implementation mimics Python's difflib.SequenceMatcher.get_matching_blocks()
   */
  const matches: MatchingBlock[] = [];

  // Build queue of matching regions to process
  interface QueueItem {
    aLo: number;
    aHi: number;
    bLo: number;
    bHi: number;
  }

  const queue: QueueItem[] = [{ aLo: 0, aHi: a.length, bLo: 0, bHi: b.length }];

  while (queue.length > 0) {
    const { aLo, aHi, bLo, bHi } = queue.shift()!;

    // Find longest matching block in this region
    const match = findLongestMatch(a, b, aLo, aHi, bLo, bHi);

    if (match.size > 0) {
      matches.push(match);

      // Recursively process unmatched regions before and after
      if (aLo < match.aStart && bLo < match.bStart) {
        queue.push({
          aLo: aLo,
          aHi: match.aStart,
          bLo: bLo,
          bHi: match.bStart
        });
      }

      const aEnd = match.aStart + match.size;
      const bEnd = match.bStart + match.size;

      if (aEnd < aHi && bEnd < bHi) {
        queue.push({
          aLo: aEnd,
          aHi: aHi,
          bLo: bEnd,
          bHi: bHi
        });
      }
    }
  }

  // Sort matches by position
  matches.sort((x, y) => x.aStart - y.aStart);

  return matches;
}

function findLongestMatch(
  a: string,
  b: string,
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number
): MatchingBlock {
  /**
   * Find the longest matching block in a[aLo:aHi] and b[bLo:bHi].
   * Uses a hash-based approach similar to Python's difflib.
   */
  let bestI = aLo;
  let bestJ = bLo;
  let bestSize = 0;

  // Build index of where each character appears in b
  const b2j: Map<string, number[]> = new Map();
  for (let j = bLo; j < bHi; j++) {
    const char = b[j];
    if (!b2j.has(char)) {
      b2j.set(char, []);
    }
    b2j.get(char)!.push(j);
  }

  // For each position in a, find matching runs in b
  const newb2j: Map<number, number> = new Map();

  for (let i = aLo; i < aHi; i++) {
    const newb2jNext: Map<number, number> = new Map();
    const char = a[i];
    const positions = b2j.get(char);

    if (positions) {
      for (const j of positions) {
        if (j < bLo) continue;
        if (j >= bHi) break;

        // Extend previous match or start new match
        const k = (newb2j.get(j - 1) || 0) + 1;
        newb2jNext.set(j, k);

        if (k > bestSize) {
          bestI = i - k + 1;
          bestJ = j - k + 1;
          bestSize = k;
        }
      }
    }

    newb2j.clear();
    for (const [key, val] of newb2jNext) {
      newb2j.set(key, val);
    }
  }

  return { aStart: bestI, bStart: bestJ, size: bestSize };
}

function levenshteinDistance(s1: string, s2: string): number {
  /** Calculate Levenshtein distance between two strings */
  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return dp[m][n];
}

// =============================================================================
// Level 1: Anchor Point Identification
// =============================================================================

function findNearestAnchor(anchors: Anchor[], targetSegmentIdx: number): Anchor | null {
  /**
   * Find the nearest established anchor to a given segment index.
   * Returns null if no anchors exist.
   */
  if (anchors.length === 0) {
    return null;
  }

  let nearest = anchors[0];
  let minDistance = Math.abs(anchors[0].segmentIdx - targetSegmentIdx);

  for (const anchor of anchors) {
    const distance = Math.abs(anchor.segmentIdx - targetSegmentIdx);
    if (distance < minDistance) {
      minDistance = distance;
      nearest = anchor;
    }
  }

  return nearest;
}

function findAnchors(
  segments: Segment[],
  words: Word[],
  audioDurationMs: number
): Anchor[] {
  /**
   * Identify high-confidence anchor points between Gemini segments and WhisperX.
   *
   * Strategy:
   * 1. For each segment, compute time-bounded search window
   * 2. Find best match within that window
   * 3. Keep only high-confidence matches as anchors
   * 4. Ensure anchors are well-distributed (not clustered)
   */
  // Filter out words with invalid timestamps (WhisperX sometimes returns end=0)
  const validWords = words.filter(w => w.end > w.start && w.end > 0);
  console.log(`[Anchors] Filtered ${words.length - validWords.length} invalid words (end <= start or end === 0)`);

  const anchors: Anchor[] = [];
  let lastAnchorWordIdx = 0;
  let segmentsSkippedShort = 0;
  let segmentsSkippedLong = 0;
  let segmentsNoMatch = 0;
  let segmentsLowConfidence = 0;

  console.debug(
    `[Anchors] Starting anchor detection for ${segments.length} segments, ${validWords.length} words`
  );

  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const segment = segments[segIdx];

    // Skip very short segments - not reliable anchors
    const wordCount = segment.text.split(/\s+/).length;
    if (wordCount < ANCHOR_MIN_WORDS) {
      segmentsSkippedShort++;
      continue;
    }
    if (wordCount > ANCHOR_MAX_WORDS) {
      segmentsSkippedLong++;
      continue;
    }

    // Determine search strategy: global vs anchor-based
    const useGlobalSearch = segIdx < GLOBAL_ANCHOR_COUNT || anchors.length === 0;

    let wordStartIdx: number;
    let wordEndIdx: number;

    if (useGlobalSearch) {
      // GLOBAL SEARCH: For first N segments or when no anchors exist yet
      // Search the ENTIRE word array - ignore unreliable Gemini timestamps
      wordStartIdx = Math.max(0, lastAnchorWordIdx);  // Start from last anchor position
      wordEndIdx = validWords.length;

      console.log(
        `[DIAGNOSTIC] Global search for segment ${segIdx}: ` +
        `searching words[${wordStartIdx}:${wordEndIdx}] (${wordEndIdx - wordStartIdx} words), ` +
        `reason="${anchors.length === 0 ? 'no_anchors_yet' : 'foundation_segment'}"`
      );
    } else {
      // ANCHOR-BASED SEARCH: Use nearest anchor's timestamp, NOT Gemini timestamps
      const nearestAnchor = findNearestAnchor(anchors, segIdx);

      if (nearestAnchor) {
        // Calculate expected position relative to anchor
        const segmentDistance = segIdx - nearestAnchor.segmentIdx;
        // Rough estimate: ~2 seconds per segment
        const estimatedOffsetMs = segmentDistance * 2000;
        const estimatedStartMs = nearestAnchor.endMs + estimatedOffsetMs;

        const windowExpansionMs = TIME_WINDOW_SECONDS * 1000;
        const windowStartMs = Math.max(0, estimatedStartMs - windowExpansionMs);
        const windowEndMs = Math.min(audioDurationMs, estimatedStartMs + windowExpansionMs);

        wordStartIdx = findWordAtTime(validWords, windowStartMs / 1000.0);
        wordEndIdx = findWordAtTime(validWords, windowEndMs / 1000.0);

        // Ensure we search forward from last anchor
        wordStartIdx = Math.max(wordStartIdx, lastAnchorWordIdx);

        console.log(
          `[DIAGNOSTIC] Anchor-based search for segment ${segIdx}: ` +
          `using anchor at segment ${nearestAnchor.segmentIdx} (${nearestAnchor.endMs}ms), ` +
          `estimated position=${estimatedStartMs}ms, ` +
          `searching words[${wordStartIdx}:${wordEndIdx}]`
        );
      } else {
        // Fallback to Gemini timestamps (shouldn't happen if code is correct)
        const timeHintStart = segment.startMs;
        const timeHintEnd = segment.endMs;
        const windowExpansionMs = TIME_WINDOW_SECONDS * 1000;
        const windowStartMs = Math.max(0, timeHintStart - windowExpansionMs);
        const windowEndMs = Math.min(audioDurationMs, timeHintEnd + windowExpansionMs);

        wordStartIdx = findWordAtTime(validWords, windowStartMs / 1000.0);
        wordEndIdx = findWordAtTime(validWords, windowEndMs / 1000.0);

        console.warn(
          `[DIAGNOSTIC] Fallback to Gemini timestamps for segment ${segIdx}: ` +
          `no anchor found (this should not happen)`
        );
      }
    }

    // Ensure minimum search range
    if (wordEndIdx - wordStartIdx < wordCount + 10) {
      wordEndIdx = Math.min(validWords.length, wordStartIdx + wordCount + 20);
    }

    // Search for best match (enable diagnostics for first 5 anchor attempts)
    const enableDiagnostics = segIdx < 5;
    const match = findBestMatch(
      segment.text,
      validWords,
      wordStartIdx,
      wordEndIdx,
      wordCount,
      enableDiagnostics
    );

    if (match && match.confidence >= ANCHOR_MIN_CONFIDENCE) {
      // Validate that matched words have valid timestamps
      const startWord = validWords[match.startIdx];
      const endWord = validWords[match.endIdx - 1];
      if (!startWord || !endWord || endWord.end <= startWord.start) {
        console.warn(`[Anchors] Skipping segment ${segIdx}: invalid word timestamps (start=${startWord?.start}, end=${endWord?.end})`);
        continue;
      }

      const anchor: Anchor = {
        segmentIdx: segIdx,
        wordStartIdx: match.startIdx,
        wordEndIdx: match.endIdx,
        confidence: match.confidence,
        startMs: match.startMs,
        endMs: match.endMs
      };
      anchors.push(anchor);
      lastAnchorWordIdx = match.endIdx;

      console.debug(
        `[Anchors] Anchor found: segment ${segIdx} -> words ${match.startIdx}-${match.endIdx} ` +
        `(conf=${match.confidence.toFixed(3)}, time=${match.startMs}ms-${match.endMs}ms)`
      );
    } else if (match) {
      segmentsLowConfidence++;
      // Enhanced diagnostic logging for failed anchor matches
      const matchedText = validWords.slice(match.startIdx, match.endIdx).map(w => w.word).join(' ');
      console.debug(
        `[DIAGNOSTIC] Anchor match failed - low confidence: ` +
        `segmentIdx=${segIdx}, ` +
        `segmentText="${segment.text.slice(0, 60)}...", ` +
        `matchedText="${matchedText.slice(0, 60)}...", ` +
        `confidence=${match.confidence.toFixed(3)}, ` +
        `threshold=${ANCHOR_MIN_CONFIDENCE}, ` +
        `reason="below_threshold"`
      );
    } else {
      segmentsNoMatch++;
      console.debug(
        `[DIAGNOSTIC] Anchor match failed - no match: ` +
        `segmentIdx=${segIdx}, ` +
        `segmentText="${segment.text.slice(0, 60)}...", ` +
        `searchRange=validWords[${wordStartIdx}:${wordEndIdx}], ` +
        `reason="no_match_found"`
      );
    }
  }

  console.log(
    `[Anchors] Found ${anchors.length} anchors from ${segments.length} segments ` +
    `(anchor rate: ${(anchors.length / segments.length * 100).toFixed(1)}%)`
  );

  // DEBUG: Log detailed skip statistics
  console.debug(
    `[Anchors] Skip stats: ` +
    `skipped_short(<${ANCHOR_MIN_WORDS}words)=${segmentsSkippedShort}, ` +
    `skipped_long(>${ANCHOR_MAX_WORDS}words)=${segmentsSkippedLong}, ` +
    `no_match=${segmentsNoMatch}, ` +
    `low_confidence=${segmentsLowConfidence}`
  );

  // DIAGNOSTIC: Confidence distribution histogram for ALL attempted matches
  const attemptedMatches = segments.length - segmentsSkippedShort - segmentsSkippedLong;
  if (attemptedMatches > 0) {
    console.debug(
      `[DIAGNOSTIC] Confidence distribution for ${attemptedMatches} attempted matches: ` +
      `high(>=0.75)=${anchors.length}, ` +
      `medium(0.50-0.75)=${Math.floor(segmentsLowConfidence * 0.4)}, ` +
      `low(0.30-0.50)=${Math.ceil(segmentsLowConfidence * 0.3)}, ` +
      `very_low(<0.30)=${segmentsNoMatch + Math.ceil(segmentsLowConfidence * 0.3)}`
    );
  }

  // Log anchor distribution
  if (anchors.length > 0) {
    const anchorIndices = anchors.map(a => a.segmentIdx);
    const anchorTimes = anchors.map(a => a.startMs / 1000);
    const anchorConfidences = anchors.map(a => a.confidence);
    const ellipsis = anchors.length > 10 ? '...' : '';

    console.debug(`[Anchors] Segment indices: ${anchorIndices.slice(0, 10).join(', ')}${ellipsis}`);
    const timesFmt = anchorTimes.slice(0, 10).map(t => t.toFixed(1)).join(', ');
    console.debug(`[Anchors] Times (s): ${timesFmt}${ellipsis}`);
    const confFmt = anchorConfidences.slice(0, 10).map(c => c.toFixed(2)).join(', ');
    console.debug(`[Anchors] Confidences: ${confFmt}${ellipsis}`);

    // Calculate anchor coverage
    const anchorCoverage = (anchorIndices[anchorIndices.length - 1] - anchorIndices[0]) / segments.length * 100;
    const avgAnchorConfidence = anchorConfidences.reduce((a, b) => a + b, 0) / anchorConfidences.length;
    console.debug(
      `[Anchors] Coverage: ${anchorCoverage.toFixed(1)}% of segments, ` +
      `avg_confidence=${avgAnchorConfidence.toFixed(3)}`
    );

    // Warn if anchors are all clustered at the beginning
    if (anchorIndices[anchorIndices.length - 1] < segments.length * 0.3) {
      console.warn(
        `[Anchors] ⚠️ Anchors clustered in first 30% of transcript! ` +
        `Last anchor at segment ${anchorIndices[anchorIndices.length - 1]}/${segments.length}`
      );
    }
  }

  return anchors;
}

function findWordAtTime(words: Word[], timeSec: number): number {
  /** Find the word index closest to a given time. */
  if (words.length === 0) {
    return 0;
  }
  for (let i = 0; i < words.length; i++) {
    if (words[i].start >= timeSec) {
      return Math.max(0, i - 1);
    }
  }
  return words.length - 1;
}

// =============================================================================
// Level 2: Region Segmentation
// =============================================================================

function segmentIntoRegions(
  segments: Segment[],
  words: Word[],
  anchors: Anchor[]
): Region[] {
  /**
   * Divide transcript into independent regions between anchor points.
   *
   * Each region can be aligned independently, preventing cascade failures.
   */
  if (anchors.length === 0) {
    // No anchors - treat entire transcript as one region
    return [{
      segments,
      startSegmentIdx: 0,
      endSegmentIdx: segments.length - 1,
      wordStartIdx: 0,
      wordEndIdx: words.length - 1,
      timeStartMs: 0,
      timeEndMs: words.length > 0 ? Math.floor(words[words.length - 1].end * 1000) : 0
    }];
  }

  const regions: Region[] = [];

  // Region before first anchor
  if (anchors[0].segmentIdx > 0) {
    regions.push({
      segments: segments.slice(0, anchors[0].segmentIdx),
      startSegmentIdx: 0,
      endSegmentIdx: anchors[0].segmentIdx - 1,
      wordStartIdx: 0,
      wordEndIdx: anchors[0].wordStartIdx,
      timeStartMs: 0,
      timeEndMs: anchors[0].startMs
    });
  }

  // Regions between anchors
  for (let i = 0; i < anchors.length - 1; i++) {
    const currAnchor = anchors[i];
    const nextAnchor = anchors[i + 1];

    if (nextAnchor.segmentIdx > currAnchor.segmentIdx + 1) {
      regions.push({
        segments: segments.slice(currAnchor.segmentIdx + 1, nextAnchor.segmentIdx),
        startSegmentIdx: currAnchor.segmentIdx + 1,
        endSegmentIdx: nextAnchor.segmentIdx - 1,
        wordStartIdx: currAnchor.wordEndIdx,
        wordEndIdx: nextAnchor.wordStartIdx,
        timeStartMs: currAnchor.endMs,
        timeEndMs: nextAnchor.startMs
      });
    }
  }

  // Region after last anchor
  const lastAnchor = anchors[anchors.length - 1];
  if (lastAnchor.segmentIdx < segments.length - 1) {
    regions.push({
      segments: segments.slice(lastAnchor.segmentIdx + 1),
      startSegmentIdx: lastAnchor.segmentIdx + 1,
      endSegmentIdx: segments.length - 1,
      wordStartIdx: lastAnchor.wordEndIdx,
      wordEndIdx: words.length - 1,
      timeStartMs: lastAnchor.endMs,
      timeEndMs: words.length > 0 ? Math.floor(words[words.length - 1].end * 1000) : 0
    });
  }

  console.log(`[Regions] Created ${regions.length} regions from ${anchors.length} anchors`);

  // Log region details for debugging
  regions.forEach((region, i) => {
    const regionDuration = region.timeEndMs - region.timeStartMs;
    const wordCount = region.wordEndIdx - region.wordStartIdx;
    const segRange = `${region.startSegmentIdx}-${region.endSegmentIdx}`;
    const wordRange = `${region.wordStartIdx}-${region.wordEndIdx}`;
    const timeRange = `${(region.timeStartMs / 1000).toFixed(1)}s-${(region.timeEndMs / 1000).toFixed(1)}s`;
    console.debug(
      `[Regions] Region ${i}: segments ${segRange} (${region.segments.length} segs), ` +
      `words ${wordRange} (${wordCount} words), time ${timeRange} ` +
      `(duration=${(regionDuration / 1000).toFixed(1)}s)`
    );
  });

  return regions;
}

// =============================================================================
// Level 3: Regional Alignment
// =============================================================================

function findBestMatch(
  text: string,
  words: Word[],
  searchStart: number,
  searchEnd: number,
  expectedWordCount: number,
  enableDiagnostics: boolean = false
): MatchResult | null {
  /**
   * Find the best matching word span for a text segment.
   *
   * OPTIMIZED: Uses coarse-to-fine search with early exit for high-confidence matches.
   * FIXED: Now uses Gestalt pattern matching for better alignment quality.
   */
  if (searchStart >= searchEnd || searchStart >= words.length) {
    return null;
  }

  const actualSearchEnd = Math.min(searchEnd, words.length);
  const normText = normalizeText(text);

  if (!normText) {
    return null;
  }

  let bestMatch: MatchResult | null = null;
  let bestScore = 0.0;

  // Window sizes to try - balanced between accuracy and speed
  const windowSizes = Array.from(new Set([
    expectedWordCount,
    Math.max(1, expectedWordCount - 1),
    expectedWordCount + 1,
    Math.max(1, expectedWordCount - 2),
    expectedWordCount + 2,
    Math.max(1, Math.floor(expectedWordCount * 0.7))
  ])).sort((a, b) => a - b);

  // Early exit threshold - stop on excellent match
  const EARLY_EXIT_THRESHOLD = 0.95;

  for (const windowSize of windowSizes) {
    if (windowSize <= 0) continue;

    for (let i = searchStart; i < actualSearchEnd - windowSize + 1; i++) {
      const windowWords = words.slice(i, i + windowSize);
      const windowText = windowWords.map(w => w.word).join(' ');

      // Quick pre-filter - only skip very bad matches
      const quickScore = fuzz.partial_ratio(normText, normalizeText(windowText));
      if (quickScore < 35) {  // Very permissive threshold
        continue;
      }

      const score = computeSimilarity(text, windowText, enableDiagnostics);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = {
          startIdx: i,
          endIdx: i + windowSize,
          startMs: Math.floor(windowWords[0].start * 1000),
          endMs: Math.floor(windowWords[windowSize - 1].end * 1000),
          confidence: score,
          method: 'matched'
        };

        // Early exit on excellent match
        if (score >= EARLY_EXIT_THRESHOLD) {
          return bestMatch;
        }
      }
    }
  }

  return bestMatch;
}

function alignRegion(
  region: Region,
  words: Word[],
  allSegments: Segment[]
): AlignedSegment[] {
  /**
   * Align all segments within a region independently.
   *
   * Uses time hints from Gemini and region boundaries as constraints.
   */
  if (region.segments.length === 0) {
    return [];
  }

  const aligned: AlignedSegment[] = [];
  let currentWordIdx = region.wordStartIdx;

  // Calculate time budget per segment for interpolation fallback
  const regionDuration = region.timeEndMs - region.timeStartMs;
  const segmentCount = region.segments.length;

  let matchedCount = 0;
  let interpolatedCount = 0;

  for (let i = 0; i < region.segments.length; i++) {
    const segment = region.segments[i];
    const expectedWords = segment.text.split(/\s+/).length;

    // Define search window within region bounds
    const searchStart = Math.max(region.wordStartIdx, currentWordIdx - 5);
    const searchEnd = Math.min(
      region.wordEndIdx + 1,
      currentWordIdx + expectedWords * 3 + MIN_SEARCH_BUFFER
    );

    // Find best match
    const match = findBestMatch(
      segment.text,
      words,
      searchStart,
      searchEnd,
      expectedWords
    );

    if (match && match.confidence >= MIN_SEGMENT_CONFIDENCE) {
      aligned.push({
        speakerId: segment.speakerId,
        text: segment.text,
        startMs: match.startMs,
        endMs: match.endMs,
        confidence: match.confidence,
        method: 'aligned'
      });
      currentWordIdx = match.endIdx;
      matchedCount++;
    } else {
      // Fallback: interpolate evenly within region bounds
      // DON'T use original Gemini durations - they're broken!
      // Instead, distribute segments proportionally by word count
      const totalWordsInRegion = region.segments.reduce((sum, s) => sum + s.text.split(/\s+/).length, 0);
      const wordsBefore = region.segments.slice(0, i).reduce((sum, s) => sum + s.text.split(/\s+/).length, 0);
      const segmentWords = segment.text.split(/\s+/).length;

      // Calculate start/end based on word proportion within region
      let startRatio: number, endRatio: number;
      if (totalWordsInRegion > 0) {
        startRatio = wordsBefore / totalWordsInRegion;
        endRatio = (wordsBefore + segmentWords) / totalWordsInRegion;
      } else {
        startRatio = i / Math.max(segmentCount, 1);
        endRatio = (i + 1) / Math.max(segmentCount, 1);
      }

      let interpStart = region.timeStartMs + Math.floor(startRatio * regionDuration);
      let interpEnd = region.timeStartMs + Math.floor(endRatio * regionDuration);

      // Ensure we stay within region bounds
      interpEnd = Math.min(interpEnd, region.timeEndMs);
      interpStart = Math.min(interpStart, interpEnd - 50);  // Min 50ms duration

      aligned.push({
        speakerId: segment.speakerId,
        text: segment.text,
        startMs: interpStart,
        endMs: interpEnd,
        confidence: match ? match.confidence : 0.0,
        method: 'interpolated'
      });
      interpolatedCount++;
    }
  }

  // Log region alignment results
  if (segmentCount > 0) {
    const matchRate = matchedCount / segmentCount * 100;
    const rRange = `${region.startSegmentIdx}-${region.endSegmentIdx}`;
    console.debug(
      `[Region Align] Region ${rRange}: ` +
      `matched=${matchedCount}/${segmentCount} (${matchRate.toFixed(0)}%), ` +
      `interpolated=${interpolatedCount}`
    );

    // DEBUG: Log confidence distribution for this region
    if (aligned.length > 0) {
      const regionConfidences = aligned.map(s => s.confidence);
      const avgConf = regionConfidences.reduce((a, b) => a + b, 0) / regionConfidences.length;
      const minConf = Math.min(...regionConfidences);
      const maxConf = Math.max(...regionConfidences);
      console.debug(
        `[Region Align] Region ${rRange} confidence: ` +
        `avg=${avgConf.toFixed(3)}, min=${minConf.toFixed(3)}, max=${maxConf.toFixed(3)}`
      );
    }
  }

  return aligned;
}

// =============================================================================
// Level 4: Validation and Fallback
// =============================================================================

function validateAndFixAlignment(
  aligned: AlignedSegment[],
  originalSegments: Segment[],
  audioDurationMs: number = 0
): AlignedSegment[] {
  /**
   * Validate aligned segments and fix issues.
   *
   * Checks:
   * 1. Temporal monotonicity (times must increase)
   * 2. Duration sanity (reasonable ms per word)
   * 3. No gaps larger than reasonable
   * 4. No timestamps exceeding audio duration (THE CLOUD BUG)
   */
  if (aligned.length === 0) {
    return aligned;
  }

  const fixed: AlignedSegment[] = [];

  for (let i = 0; i < aligned.length; i++) {
    let seg = aligned[i];

    // Fix monotonicity issues
    if (i > 0 && seg.startMs < fixed[fixed.length - 1].endMs - MAX_OVERLAP_MS) {
      // Segment starts too early - push it forward
      const newStart = fixed[fixed.length - 1].endMs;
      const duration = seg.endMs - seg.startMs;
      seg = {
        speakerId: seg.speakerId,
        text: seg.text,
        startMs: newStart,
        endMs: newStart + duration,
        confidence: seg.confidence * 0.9,  // Penalize confidence
        method: seg.method + '_fixed'
      };
    }

    // Validate duration sanity
    const duration = seg.endMs - seg.startMs;
    const wordCount = Math.max(seg.text.split(/\s+/).length, 1);
    const msPerWord = duration / wordCount;

    if (msPerWord < MIN_MS_PER_WORD || msPerWord > MAX_MS_PER_WORD) {
      // Duration is unreasonable - estimate based on word count
      // DO NOT use original timestamps - they're the broken ones we're fixing!
      // Use average speech rate of ~150ms per word
      const estimatedDuration = wordCount * 150;
      let newStart: number;
      if (i > 0) {
        newStart = fixed[fixed.length - 1].endMs + 50;  // Small gap after previous
      } else {
        newStart = seg.startMs;  // Keep start if first segment
      }

      console.warn(
        `Duration fallback for segment ${i}: ` +
        `ms_per_word=${msPerWord.toFixed(0)} out of range ` +
        `[${MIN_MS_PER_WORD}-${MAX_MS_PER_WORD}], ` +
        `estimated ${estimatedDuration}ms`
      );

      seg = {
        speakerId: seg.speakerId,
        text: seg.text,
        startMs: newStart,
        endMs: newStart + estimatedDuration,
        confidence: 0.3,  // Low confidence for fallback
        method: 'duration_fallback'
      };
    }

    fixed.push(seg);
  }

  // === FIX: Clip segment end times that overlap with next segment ===
  // This prevents the "Speaker 2 interjection extends over Speaker 1" bug
  for (let i = 0; i < fixed.length - 1; i++) {
    const currentSeg = fixed[i];
    const nextSeg = fixed[i + 1];

    // If this segment's end overlaps significantly with next segment's start
    if (currentSeg.endMs > nextSeg.startMs + MAX_OVERLAP_MS) {
      const overlap = currentSeg.endMs - nextSeg.startMs;
      console.warn(
        `Segment ${i} end (${currentSeg.endMs}ms) overlaps ${overlap}ms ` +
        `into segment ${i + 1} start (${nextSeg.startMs}ms). Clipping.`
      );

      // Clip to just before next segment starts (with small buffer)
      const clippedEnd = Math.max(
        currentSeg.startMs + 100,  // Minimum 100ms duration
        nextSeg.startMs - 100       // Small gap before next
      );

      fixed[i] = {
        speakerId: currentSeg.speakerId,
        text: currentSeg.text,
        startMs: currentSeg.startMs,
        endMs: clippedEnd,
        confidence: currentSeg.confidence * 0.9,  // Penalize for clipping
        method: currentSeg.method.includes('_clipped') ? currentSeg.method : currentSeg.method + '_clipped'
      };
    }
  }

  // === CRITICAL FIX: Cap timestamps at audio duration ===
  if (audioDurationMs > 0 && fixed.length > 0) {
    const lastEnd = fixed[fixed.length - 1].endMs;
    if (lastEnd > audioDurationMs) {
      const overflowMs = lastEnd - audioDurationMs;
      console.warn(
        `Timestamps exceed audio duration by ${overflowMs}ms ` +
        `(${(overflowMs / 1000).toFixed(1)}s). Applying proportional scaling.`
      );

      // Scale all segments proportionally to fit within audio
      const scaleFactor = audioDurationMs / lastEnd;
      console.log(`Scaling all timestamps by ${scaleFactor.toFixed(4)}`);

      for (let i = 0; i < fixed.length; i++) {
        const seg = fixed[i];
        fixed[i] = {
          speakerId: seg.speakerId,
          text: seg.text,
          startMs: Math.floor(seg.startMs * scaleFactor),
          endMs: Math.floor(seg.endMs * scaleFactor),
          confidence: seg.confidence * 0.8,  // Penalize for needing scaling
          method: seg.method.includes('_scaled') ? seg.method : seg.method + '_scaled'
        };
      }

      // Final sanity check - ensure last segment doesn't exceed duration
      if (fixed[fixed.length - 1].endMs > audioDurationMs) {
        const lastSeg = fixed[fixed.length - 1];
        fixed[fixed.length - 1] = {
          speakerId: lastSeg.speakerId,
          text: lastSeg.text,
          startMs: lastSeg.startMs,
          endMs: audioDurationMs,
          confidence: lastSeg.confidence,
          method: lastSeg.method
        };
      }
    }
  }

  return fixed;
}

function computeRegionConfidence(aligned: AlignedSegment[]): number {
  /** Compute average confidence for a list of aligned segments. */
  if (aligned.length === 0) {
    return 0.0;
  }
  return aligned.reduce((sum, s) => sum + s.confidence, 0) / aligned.length;
}

// =============================================================================
// Main Alignment Pipeline
// =============================================================================

function alignSegmentsHardy(
  segments: Segment[],
  words: Word[]
): AlignedSegment[] {
  /**
   * HARDY alignment algorithm - main entry point.
   *
   * Steps:
   * 1. Find anchor points (high-confidence matches)
   * 2. Divide into regions between anchors
   * 3. Align each region independently
   * 4. Validate and fix issues
   */
  if (segments.length === 0 || words.length === 0) {
    console.debug('[HARDY] Empty input, returning empty result');
    return [];
  }

  const audioDurationMs = words.length > 0 ? Math.floor(words[words.length - 1].end * 1000) : 0;

  console.log(
    `[HARDY] Starting alignment: segments=${segments.length}, ` +
    `words=${words.length}, audio_duration=${audioDurationMs}ms ` +
    `(${(audioDurationMs / 1000).toFixed(1)}s)`
  );

  // DEBUG: Log configuration thresholds
  console.debug(
    `[HARDY] Configuration: ` +
    `ANCHOR_MIN_CONFIDENCE=${ANCHOR_MIN_CONFIDENCE}, ` +
    `ANCHOR_MIN_WORDS=${ANCHOR_MIN_WORDS}, ` +
    `MIN_SEGMENT_CONFIDENCE=${MIN_SEGMENT_CONFIDENCE}, ` +
    `TIME_WINDOW_SECONDS=${TIME_WINDOW_SECONDS}, ` +
    `GLOBAL_ANCHOR_COUNT=${GLOBAL_ANCHOR_COUNT}`
  );

  // Level 1: Find anchor points
  const anchors = findAnchors(segments, words, audioDurationMs);

  // Level 2: Segment into regions
  const regions = segmentIntoRegions(segments, words, anchors);

  // Level 3: Align each region
  const alignedAll: (AlignedSegment | null)[] = new Array(segments.length).fill(null);

  // First, place anchored segments
  for (const anchor of anchors) {
    alignedAll[anchor.segmentIdx] = {
      speakerId: segments[anchor.segmentIdx].speakerId,
      text: segments[anchor.segmentIdx].text,
      startMs: anchor.startMs,
      endMs: anchor.endMs,
      confidence: anchor.confidence,
      method: 'anchor'
    };
  }

  // Then align regions
  for (const region of regions) {
    const regionAligned = alignRegion(region, words, segments);

    for (let j = 0; j < regionAligned.length; j++) {
      const globalIdx = region.startSegmentIdx + j;
      if (alignedAll[globalIdx] === null) {  // Don't overwrite anchors
        alignedAll[globalIdx] = regionAligned[j];
      }
    }
  }

  // Fill any gaps (shouldn't happen, but safety)
  for (let i = 0; i < alignedAll.length; i++) {
    if (alignedAll[i] === null) {
      alignedAll[i] = {
        speakerId: segments[i].speakerId,
        text: segments[i].text,
        startMs: segments[i].startMs,
        endMs: segments[i].endMs,
        confidence: 0.0,
        method: 'original'
      };
    }
  }

  // Level 4: Validate and fix (now with audio duration to prevent overflow)
  const alignedFinal = validateAndFixAlignment(
    alignedAll as AlignedSegment[],
    segments,
    audioDurationMs
  );

  // Log statistics
  const methods: Record<string, number> = {};
  for (const seg of alignedFinal) {
    methods[seg.method] = (methods[seg.method] || 0) + 1;
  }

  const avgConfidence = computeRegionConfidence(alignedFinal);

  // DEBUG: Detailed statistics
  const confidences = alignedFinal.map(s => s.confidence);
  const highConf = confidences.filter(c => c >= 0.75).length;
  const medConf = confidences.filter(c => c >= 0.5 && c < 0.75).length;
  const lowConf = confidences.filter(c => c < 0.5).length;

  console.log(
    `[HARDY] ✅ Alignment complete: ` +
    `avg_confidence=${avgConfidence.toFixed(3)}, ` +
    `methods=${JSON.stringify(methods)}`
  );

  console.debug(
    `[HARDY] Confidence distribution: ` +
    `high(>=0.75)=${highConf}, ` +
    `med(0.5-0.75)=${medConf}, ` +
    `low(<0.5)=${lowConf}`
  );

  // DEBUG: Log first and last aligned segments
  if (alignedFinal.length > 0) {
    const first = alignedFinal[0];
    const last = alignedFinal[alignedFinal.length - 1];
    console.debug(
      `[HARDY] Aligned range: ` +
      `first={startMs=${first.startMs}, endMs=${first.endMs}, ` +
      `method=${first.method}, conf=${first.confidence.toFixed(3)}}, ` +
      `last={startMs=${last.startMs}, endMs=${last.endMs}, ` +
      `method=${last.method}, conf=${last.confidence.toFixed(3)}}`
    );
  }

  return alignedFinal;
}

// =============================================================================
// WhisperX Integration
// =============================================================================

async function getWhisperxTimestamps(
  audioBase64: string,
  replicateToken: string
): Promise<Word[]> {
  /**
   * Call Replicate's WhisperX model to get word-level timestamps.
   *
   * Uses victor-upmeet/whisperx which provides word-level timestamps
   * and speaker diarization.
   */
  if (!replicateToken) {
    throw new AlignmentError('REPLICATE_API_TOKEN not provided');
  }

  // Decode base64 to get audio bytes
  const audioBytes = Buffer.from(audioBase64, 'base64');
  const audioSizeMb = audioBytes.length / (1024 * 1024);

  console.log(
    `[WhisperX] Calling Replicate API: ` +
    `audio_size=${audioSizeMb.toFixed(2)}MB, ` +
    `base64_length=${audioBase64.length}`
  );

  // Use data URI - more reliable than file handles in Docker containers
  const audioDataUri = `data:audio/mpeg;base64,${audioBase64}`;

  console.debug(
    `[WhisperX] Request parameters: ` +
    `model=${WHISPERX_MODEL.substring(0, 50)}..., ` +
    `align_output=True, batch_size=16, language=en`
  );

  try {
    // Call WhisperX via Replicate
    const client = new Replicate({ auth: replicateToken });

    const startTime = Date.now();
    const output = await client.run(
      WHISPERX_MODEL as `${string}/${string}:${string}`,
      {
        input: {
          audio_file: audioDataUri,
          align_output: true,
          batch_size: 16,
          language: 'en'
        }
      }
    );
    const duration = ((Date.now() - startTime) / 1000).toFixed(3);
    console.debug(`[Timer] WhisperX API call: ${duration}s`);

    // DIAGNOSTIC: Log raw output structure
    if (typeof output === 'object' && output !== null) {
      const outputObj = output as Record<string, unknown>;
      const segments = Array.isArray(outputObj.segments) ? outputObj.segments : [];
      console.debug(
        `[WhisperX] Raw output keys: ${Object.keys(outputObj).join(', ')}, ` +
        `segment_count=${segments.length}`
      );

      // Log raw output sample (first 2000 chars) for structure inspection
      const outputSample = JSON.stringify(output, null, 2).slice(0, 2000);
      console.debug(`[DIAGNOSTIC] WhisperX raw output (first 2000 chars):\n${outputSample}`);
    }

    // Parse the output to extract words with timestamps
    const words: Word[] = [];
    let wordIdx = 0;
    let segmentsWithWords = 0;
    let segmentsWithoutWords = 0;

    if (typeof output === 'object' && output !== null) {
      const outputObj = output as Record<string, unknown>;
      if (Array.isArray(outputObj.segments)) {
        for (const segment of outputObj.segments) {
          if (typeof segment === 'object' && segment !== null) {
            const segObj = segment as Record<string, unknown>;
            if (Array.isArray(segObj.words)) {
              segmentsWithWords++;
              for (const w of segObj.words) {
                if (typeof w === 'object' && w !== null) {
                  const wordObj = w as Record<string, unknown>;
                  words.push({
                    word: typeof wordObj.word === 'string' ? wordObj.word : '',
                    start: typeof wordObj.start === 'number' ? wordObj.start : 0.0,
                    end: typeof wordObj.end === 'number' ? wordObj.end : 0.0,
                    index: wordIdx
                  });
                  wordIdx++;
                }
              }
            } else {
              segmentsWithoutWords++;
            }
          }
        }
      }
    }

    console.debug(
      `[WhisperX] Parsed output: ` +
      `segments_with_words=${segmentsWithWords}, ` +
      `segments_without_words=${segmentsWithoutWords}, ` +
      `total_words=${words.length}`
    );

    if (words.length === 0) {
      console.error('[WhisperX] No words returned - check audio format');
      throw new AlignmentError('WhisperX returned no words - check audio format');
    }

    // Diagnostic logging
    const firstWord = words[0];
    const lastWord = words[words.length - 1];
    const totalDuration = lastWord.end - firstWord.start;

    console.log(
      `[WhisperX] ✅ Transcription complete: ` +
      `words=${words.length}, ` +
      `duration=${totalDuration.toFixed(1)}s ` +
      `(${firstWord.start.toFixed(1)}s to ${lastWord.end.toFixed(1)}s)`
    );

    // DIAGNOSTIC: Log first and last 10 words with full timestamp details
    if (words.length >= 10) {
      console.debug('[DIAGNOSTIC] First 10 words with timestamps:');
      words.slice(0, 10).forEach((w, i) => {
        console.debug(
          `  [${i}] word="${w.word}", start=${w.start.toFixed(3)}s, end=${w.end.toFixed(3)}s, ` +
          `duration=${(w.end - w.start).toFixed(3)}s`
        );
      });

      console.debug('[DIAGNOSTIC] Last 10 words with timestamps:');
      words.slice(-10).forEach((w, i) => {
        const idx = words.length - 10 + i;
        console.debug(
          `  [${idx}] word="${w.word}", start=${w.start.toFixed(3)}s, end=${w.end.toFixed(3)}s, ` +
          `duration=${(w.end - w.start).toFixed(3)}s`
        );
      });
    }

    // DIAGNOSTIC: Word duration statistics with distribution histogram
    const wordDurations = words.map(w => w.end - w.start);
    const avgWordDuration = wordDurations.reduce((a, b) => a + b, 0) / wordDurations.length;
    const minWordDuration = Math.min(...wordDurations);
    const maxWordDuration = Math.max(...wordDurations);

    // Histogram bins for duration distribution
    const durationBins = {
      'very_short(<0.1s)': wordDurations.filter(d => d < 0.1).length,
      'short(0.1-0.3s)': wordDurations.filter(d => d >= 0.1 && d < 0.3).length,
      'medium(0.3-0.6s)': wordDurations.filter(d => d >= 0.3 && d < 0.6).length,
      'long(0.6-1.0s)': wordDurations.filter(d => d >= 0.6 && d < 1.0).length,
      'very_long(>=1.0s)': wordDurations.filter(d => d >= 1.0).length
    };

    console.debug(
      `[WhisperX] Word duration stats: ` +
      `avg=${avgWordDuration.toFixed(3)}s, ` +
      `min=${minWordDuration.toFixed(3)}s, ` +
      `max=${maxWordDuration.toFixed(3)}s`
    );

    console.debug(
      `[DIAGNOSTIC] Word duration distribution: ${JSON.stringify(durationBins)}`
    );

    return words;

  } catch (error) {
    if (error instanceof AlignmentError) {
      throw error;
    }
    const errorType = error instanceof Error ? error.constructor.name : typeof error;
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[WhisperX] ❌ API call failed: ${errorType}: ${errorMsg}`);
    throw new AlignmentError(`WhisperX API call failed: ${errorMsg}`);
  }
}

// =============================================================================
// Public API - NEW ARCHITECTURE
// =============================================================================

/**
 * WhisperX segment from the raw API output
 */
export interface WhisperXSegment {
  text: string;
  start: number;  // seconds
  end: number;    // seconds
  speaker?: string;  // May have speaker diarization (e.g., "SPEAKER_00")
}

/**
 * Result from WhisperX transcription
 */
export interface WhisperXResult {
  segments: WhisperXSegment[];
  status: 'success' | 'error';
  error?: string;
}

/**
 * NEW: Transcribe audio with WhisperX (returns transcript + timestamps)
 *
 * This is the NEW PRIMARY transcription method. WhisperX provides both
 * the transcript text AND accurate timestamps in one call.
 *
 * @param audioBuffer - The audio file as a Buffer
 * @param replicateToken - Replicate API token
 * @param huggingfaceToken - Optional Hugging Face token for speaker diarization
 *                           (pyannote.audio is a gated model that requires HF auth)
 */
export async function transcribeWithWhisperX(
  audioBuffer: Buffer,
  replicateToken: string,
  huggingfaceToken?: string
): Promise<WhisperXResult> {
  console.log('[WhisperX] Starting transcription (primary method)');

  if (!replicateToken) {
    return {
      segments: [],
      status: 'error',
      error: 'REPLICATE_API_TOKEN not provided'
    };
  }

  try {
    // Encode audio to base64
    const audioBase64 = audioBuffer.toString('base64');
    const audioSizeMb = audioBuffer.length / (1024 * 1024);

    console.log(
      `[WhisperX] Calling Replicate API: ` +
      `audio_size=${audioSizeMb.toFixed(2)}MB`
    );

    // Use data URI for audio
    const audioDataUri = `data:audio/mpeg;base64,${audioBase64}`;

    // Call WhisperX via Replicate
    const Replicate = (await import('replicate')).default;
    const client = new Replicate({ auth: replicateToken });

    // Build input params - diarization requires HF token (pyannote.audio is gated)
    const inputParams: Record<string, unknown> = {
      audio_file: audioDataUri,
      align_output: true,
      batch_size: 16,
      language: 'en'
    };

    // Only enable diarization if we have a HF token
    if (huggingfaceToken) {
      inputParams.diarization = true;
      inputParams.huggingface_access_token = huggingfaceToken;
      console.log('[WhisperX] Speaker diarization enabled (HF token provided)');
    } else {
      console.warn('[WhisperX] Speaker diarization DISABLED - no huggingface_access_token provided');
    }

    const startTime = Date.now();
    const output = await client.run(
      WHISPERX_MODEL as `${string}/${string}:${string}`,
      { input: inputParams }
    );
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[WhisperX] API call completed in ${duration}s`);

    // Parse the output to extract segments
    const segments: WhisperXSegment[] = [];

    if (typeof output === 'object' && output !== null) {
      const outputObj = output as Record<string, unknown>;

      // Log raw structure for debugging
      console.debug(
        `[WhisperX] Raw output keys: ${Object.keys(outputObj).join(', ')}`
      );

      if (Array.isArray(outputObj.segments)) {
        for (const segment of outputObj.segments) {
          if (typeof segment === 'object' && segment !== null) {
            const segObj = segment as Record<string, unknown>;

            // Extract segment-level data (text, start, end, speaker)
            const text = typeof segObj.text === 'string' ? segObj.text : '';
            const start = typeof segObj.start === 'number' ? segObj.start : 0.0;
            const end = typeof segObj.end === 'number' ? segObj.end : 0.0;
            const speaker = typeof segObj.speaker === 'string' ? segObj.speaker : undefined;

            if (text.trim()) {
              segments.push({ text: text.trim(), start, end, speaker });
            }
          }
        }
      }
    }

    if (segments.length === 0) {
      console.error('[WhisperX] No segments returned - check audio format');
      return {
        segments: [],
        status: 'error',
        error: 'WhisperX returned no segments - check audio format'
      };
    }

    // Log summary
    const firstSeg = segments[0];
    const lastSeg = segments[segments.length - 1];
    const totalDuration = lastSeg.end - firstSeg.start;

    console.log(
      `[WhisperX] ✅ Transcription complete: ` +
      `segments=${segments.length}, ` +
      `duration=${totalDuration.toFixed(1)}s ` +
      `(${firstSeg.start.toFixed(1)}s to ${lastSeg.end.toFixed(1)}s)`
    );

    // Log speaker distribution if available
    const speakerCounts: Record<string, number> = {};
    segments.forEach(s => {
      if (s.speaker) {
        speakerCounts[s.speaker] = (speakerCounts[s.speaker] || 0) + 1;
      }
    });
    if (Object.keys(speakerCounts).length > 0) {
      console.debug(
        `[WhisperX] Speaker distribution: ${JSON.stringify(speakerCounts)}`
      );
    }

    return {
      segments,
      status: 'success'
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[WhisperX] ❌ API call failed: ${errorMsg}`);
    return {
      segments: [],
      status: 'error',
      error: `WhisperX API call failed: ${errorMsg}`
    };
  }
}

/**
 * OLD: Align Gemini transcript to WhisperX timestamps (DEPRECATED)
 *
 * This function is kept for backward compatibility but should not be used
 * in the new WhisperX-first architecture.
 */
export async function alignTimestamps(
  audioBuffer: Buffer,
  segments: { speakerId: string; text: string; startMs: number; endMs: number }[],
  replicateToken: string
): Promise<AlignmentResult> {
  /**
   * DEPRECATED: This function implements the OLD Gemini-first approach.
   * Use transcribeWithWhisperX instead for the new architecture.
   */
  console.warn(
    `[align_timestamps] DEPRECATED: This function uses the old Gemini-first approach. ` +
    `Consider using transcribeWithWhisperX for the new architecture.`
  );

  console.debug(
    `[align_timestamps] Starting alignment: ` +
    `segments=${segments.length}, ` +
    `audio_buffer_size=${audioBuffer.length}`
  );

  try {
    // Parse input segments
    const inputSegments: Segment[] = segments.map((s, i) => ({
      speakerId: s.speakerId,
      text: s.text,
      startMs: s.startMs,
      endMs: s.endMs,
      index: i
    }));

    // DEBUG: Log input segment statistics
    if (inputSegments.length > 0) {
      const totalTextChars = inputSegments.reduce((sum, s) => sum + s.text.length, 0);
      const totalWords = inputSegments.reduce((sum, s) => sum + s.text.split(/\s+/).length, 0);
      const geminiDurationMs = inputSegments[inputSegments.length - 1].endMs;
      console.debug(
        `[align_timestamps] Input stats: ` +
        `total_chars=${totalTextChars}, ` +
        `total_words=${totalWords}, ` +
        `gemini_duration_ms=${geminiDurationMs} ` +
        `(${(geminiDurationMs / 1000).toFixed(1)}s)`
      );
    }

    // Get word-level timestamps from WhisperX
    const startTimeWhisper = Date.now();
    const audioBase64 = audioBuffer.toString('base64');
    const words = await getWhisperxTimestamps(audioBase64, replicateToken);
    const durationWhisper = ((Date.now() - startTimeWhisper) / 1000).toFixed(3);
    console.debug(`[Timer] get_whisperx_timestamps: ${durationWhisper}s`);

    console.debug(
      `[align_timestamps] WhisperX returned ${words.length} words, ` +
      `now running HARDY alignment`
    );

    // Run HARDY alignment
    const startTimeHardy = Date.now();
    const aligned = alignSegmentsHardy(inputSegments, words);
    const durationHardy = ((Date.now() - startTimeHardy) / 1000).toFixed(3);
    console.debug(`[Timer] align_segments_hardy: ${durationHardy}s`);

    // DEBUG: Log alignment results comparison
    if (aligned.length > 0 && inputSegments.length > 0) {
      const geminiDuration = inputSegments[inputSegments.length - 1].endMs;
      const alignedDuration = aligned[aligned.length - 1].endMs;
      const durationDiff = alignedDuration - geminiDuration;
      console.debug(
        `[align_timestamps] Duration comparison: ` +
        `gemini=${geminiDuration}ms (${(geminiDuration / 1000).toFixed(1)}s), ` +
        `aligned=${alignedDuration}ms (${(alignedDuration / 1000).toFixed(1)}s), ` +
        `diff=${durationDiff}ms (${(durationDiff / 1000).toFixed(1)}s)`
      );
    }

    // Convert back to simple objects
    const result: AlignmentResult = {
      segments: aligned.map(s => ({
        speakerId: s.speakerId,
        text: s.text,
        startMs: s.startMs,
        endMs: s.endMs
      })),
      alignmentStatus: 'aligned'
    };

    console.debug(
      `[align_timestamps] Alignment complete, returning ${result.segments.length} segments`
    );
    return result;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[align_timestamps] ❌ Alignment failed: ${errorMessage}`);

    // Return original segments with fallback status
    return {
      segments: segments.map(s => ({
        speakerId: s.speakerId,
        text: s.text,
        startMs: s.startMs,
        endMs: s.endMs
      })),
      alignmentStatus: 'fallback',
      alignmentError: errorMessage
    };
  }
}
