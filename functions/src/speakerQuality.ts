/**
 * Speaker Quality Assessment Module
 *
 * Computes quality scores for speaker segments to reduce false merges from
 * low-quality audio. Quality is computed from WhisperX word-level confidence,
 * timing consistency, and speaker overlap detection.
 */

// ============================================================================
// Constants
// ============================================================================

/** Common filler words that reduce clarity score */
const FILLER_WORDS = new Set([
  'um', 'uh', 'like', 'you know', 'basically', 'actually',
  'literally', 'sort of', 'kind of', 'i mean'
]);

/** Window size for overlap contamination detection (milliseconds) */
const OVERLAP_WINDOW_MS = 10000; // 10 seconds

/** Maximum acceptable speaker transitions per window */
const MAX_TRANSITIONS_PER_WINDOW = 2;

/** Minimum timing gap that counts as inconsistency (milliseconds) */
const MIN_TIMING_GAP_MS = 200; // 200ms

// ============================================================================
// Quality Score Components
// ============================================================================

/**
 * Compute SNR proxy from WhisperX word-level confidence scores.
 * Higher confidence = cleaner audio with less noise.
 *
 * @param wordConfidences - Array of word confidence scores [0-1]
 * @returns Mean confidence as SNR proxy [0-1]
 */
export function computeSNRProxy(wordConfidences: number[]): number {
  if (wordConfidences.length === 0) {
    // No word scores available - assume neutral quality
    return 1.0;
  }

  // Simple mean - Whisper already calibrates confidence to noise levels
  const sum = wordConfidences.reduce((acc, conf) => acc + conf, 0);
  return sum / wordConfidences.length;
}

/**
 * Compute clarity score from timing consistency and filler word detection.
 * Inconsistent timing suggests disfluent speech or transcription errors.
 *
 * @param wordTimings - Array of word timing objects with start/end in seconds
 * @param text - Full text of the segment
 * @returns Clarity score [0-1]
 */
export function computeClarityScore(
  wordTimings: Array<{ start: number; end: number }>,
  text: string
): number {
  if (wordTimings.length === 0) {
    // No timing data - assume neutral clarity
    return 1.0;
  }

  // Component 1: Timing consistency
  // Count gaps between consecutive words
  let gapCount = 0;
  for (let i = 0; i < wordTimings.length - 1; i++) {
    const gapMs = (wordTimings[i + 1].start - wordTimings[i].end) * 1000;
    if (gapMs > MIN_TIMING_GAP_MS) {
      gapCount++;
    }
  }

  // Normalize: fewer gaps = higher consistency
  const timingConsistency = Math.max(0, 1 - (gapCount / wordTimings.length));

  // Component 2: Filler word penalty
  // Tokenize text (simple whitespace split, case-insensitive)
  const words = text.toLowerCase().split(/\s+/);
  let fillerCount = 0;

  for (const word of words) {
    // Clean punctuation for matching
    const cleanWord = word.replace(/[.,!?;:]/g, '');
    if (FILLER_WORDS.has(cleanWord)) {
      fillerCount++;
    }
  }

  // Check for multi-word fillers ("you know", "sort of", etc.)
  const textLower = text.toLowerCase();
  for (const filler of FILLER_WORDS) {
    if (filler.includes(' ')) {
      // Count occurrences of multi-word filler
      const regex = new RegExp(filler.replace(/\s+/g, '\\s+'), 'g');
      const matches = textLower.match(regex);
      if (matches) {
        fillerCount += matches.length;
      }
    }
  }

  // Normalize: fewer fillers = higher clarity
  const fillerPenalty = Math.max(0, 1 - (fillerCount / Math.max(1, words.length)));

  // Combine: equal weight to timing and filler detection
  return (timingConsistency * 0.5) + (fillerPenalty * 0.5);
}

/**
 * Detect overlap contamination from rapid speaker transitions.
 * Segments with multiple overlapping speakers are unreliable for reconciliation.
 *
 * @param speakerTransitions - Array of speaker change timestamps in milliseconds
 * @returns True if segment has excessive speaker overlap
 */
export function detectOverlapContamination(
  speakerTransitions: Array<{ timeMs: number }>
): boolean {
  if (speakerTransitions.length === 0) {
    return false;
  }

  // Sort transitions by time
  const sorted = [...speakerTransitions].sort((a, b) => a.timeMs - b.timeMs);

  // Count transitions in each window
  for (let i = 0; i < sorted.length; i++) {
    const windowStart = sorted[i].timeMs;
    const windowEnd = windowStart + OVERLAP_WINDOW_MS;

    let transitionsInWindow = 0;
    for (let j = i; j < sorted.length && sorted[j].timeMs < windowEnd; j++) {
      transitionsInWindow++;
    }

    if (transitionsInWindow > MAX_TRANSITIONS_PER_WINDOW) {
      return true;
    }
  }

  return false;
}

/**
 * Compute composite quality score from individual components.
 * Uses weighted formula: 0.4*snr + 0.3*clarity + 0.3*(1-overlap_penalty)
 *
 * @param snr - SNR proxy from word confidences [0-1]
 * @param clarity - Clarity score from timing/filler analysis [0-1]
 * @param isContaminated - Whether segment has overlap contamination
 * @returns Composite quality score [0-1]
 */
export function computeCompositeQuality(
  snr: number,
  clarity: number,
  isContaminated: boolean
): number {
  // Overlap penalty: contaminated segments get 0, clean segments get 1
  const overlapScore = isContaminated ? 0 : 1;

  // Weighted combination - SNR is most important for embedding quality
  const composite = (0.4 * snr) + (0.3 * clarity) + (0.3 * overlapScore);

  // Clamp to [0, 1] range
  return Math.max(0, Math.min(1, composite));
}

/**
 * Compute quality-weighted similarity between two speakers.
 * Lower quality segments contribute less to similarity score.
 *
 * @param cosine - Raw cosine similarity [-1, 1]
 * @param qualityA - Quality score for speaker A [0-1]
 * @param qualityB - Quality score for speaker B [0-1]
 * @returns Weighted similarity, attenuated by quality
 */
export function computeWeightedSimilarity(
  cosine: number,
  qualityA: number,
  qualityB: number
): number {
  // Geometric mean of qualities - penalizes if either quality is low
  const qualityWeight = Math.sqrt(qualityA * qualityB);

  // Similarity is attenuated by quality
  return cosine * qualityWeight;
}

// ============================================================================
// WhisperX Integration
// ============================================================================

/**
 * WhisperX segment format (subset of what we need for quality computation)
 */
export interface WhisperXSegmentForQuality {
  text: string;
  start: number;  // seconds
  end: number;    // seconds
  speaker?: string;
  words?: Array<{
    word: string;
    start: number;
    end: number;
    score?: number;  // WhisperX confidence [0-1]
  }>;
}

/**
 * SpeakerQuality matches the interface in types.ts
 */
export interface SpeakerQualityResult {
  snrProxy: number;
  clarityScore: number;
  isContaminated: boolean;
  compositeScore: number;
}

/**
 * Compute per-speaker quality map from WhisperX segments.
 *
 * Aggregates all segments for each speaker, extracts quality signals
 * (SNR proxy from word confidence, clarity from timing/fillers, overlap
 * from speaker transitions), and computes composite quality scores.
 *
 * @param segments - WhisperX segments with optional word-level scores
 * @returns Map of speaker ID to SpeakerQuality
 */
export function computeSpeakerQualityMapFromWhisperXSegments(
  segments: WhisperXSegmentForQuality[]
): Record<string, SpeakerQualityResult> {
  // Accumulate data per speaker
  const speakerData: Record<string, {
    wordConfidences: number[];
    wordTimings: Array<{ start: number; end: number }>;
    allText: string;
    transitions: Array<{ timeMs: number }>;
  }> = {};

  // Track speaker transitions for overlap detection
  let lastSpeaker: string | null = null;

  for (const segment of segments) {
    const speakerId = segment.speaker ?? 'UNKNOWN';

    // Initialize speaker data if first time seeing this speaker
    if (!speakerData[speakerId]) {
      speakerData[speakerId] = {
        wordConfidences: [],
        wordTimings: [],
        allText: '',
        transitions: []
      };
    }

    const data = speakerData[speakerId];

    // Aggregate text (for filler detection)
    if (segment.text) {
      data.allText += (data.allText ? ' ' : '') + segment.text;
    }

    // Aggregate word-level data
    if (segment.words && segment.words.length > 0) {
      for (const word of segment.words) {
        // Collect confidence scores (defaulting to 1.0 if missing)
        if (word.score !== undefined && word.score !== null) {
          data.wordConfidences.push(word.score);
        }

        // Collect timings
        if (word.start !== undefined && word.end !== undefined) {
          data.wordTimings.push({ start: word.start, end: word.end });
        }
      }
    }

    // Track speaker transitions (for overlap contamination)
    if (lastSpeaker !== null && lastSpeaker !== speakerId) {
      // Record transition time in milliseconds
      const transitionTimeMs = segment.start * 1000;
      // Both speakers involved in transition get marked
      data.transitions.push({ timeMs: transitionTimeMs });
      if (speakerData[lastSpeaker]) {
        speakerData[lastSpeaker].transitions.push({ timeMs: transitionTimeMs });
      }
    }
    lastSpeaker = speakerId;
  }

  // Compute quality for each speaker
  const result: Record<string, SpeakerQualityResult> = {};

  for (const [speakerId, data] of Object.entries(speakerData)) {
    // SNR proxy from word confidences
    const snrProxy = computeSNRProxy(data.wordConfidences);

    // Clarity from timing consistency and filler words
    const clarityScore = computeClarityScore(data.wordTimings, data.allText);

    // Overlap contamination from rapid speaker transitions
    const isContaminated = detectOverlapContamination(data.transitions);

    // Composite score using the locked formula
    const compositeScore = computeCompositeQuality(snrProxy, clarityScore, isContaminated);

    result[speakerId] = {
      snrProxy,
      clarityScore,
      isContaminated,
      compositeScore
    };
  }

  return result;
}
