/**
 * Tests for Speaker Quality Assessment Module
 */

import {
  computeSNRProxy,
  computeClarityScore,
  detectOverlapContamination,
  computeCompositeQuality,
  computeWeightedSimilarity,
  computeSpeakerQualityMapFromWhisperXSegments,
  WhisperXSegmentForQuality,
} from '../speakerQuality';

describe('computeSNRProxy', () => {
  it('should return 1.0 for empty confidence array', () => {
    expect(computeSNRProxy([])).toBe(1.0);
  });

  it('should compute mean of word confidences', () => {
    const confidences = [0.9, 0.8, 0.7];
    const expected = (0.9 + 0.8 + 0.7) / 3;
    expect(computeSNRProxy(confidences)).toBeCloseTo(expected, 5);
  });

  it('should handle perfect confidence', () => {
    const confidences = [1.0, 1.0, 1.0, 1.0];
    expect(computeSNRProxy(confidences)).toBe(1.0);
  });

  it('should handle low confidence audio', () => {
    const confidences = [0.3, 0.2, 0.4, 0.3];
    const expected = (0.3 + 0.2 + 0.4 + 0.3) / 4;
    expect(computeSNRProxy(confidences)).toBeCloseTo(expected, 5);
  });

  it('should handle single word segment', () => {
    expect(computeSNRProxy([0.85])).toBe(0.85);
  });
});

describe('computeClarityScore', () => {
  it('should return 1.0 for empty timing array', () => {
    expect(computeClarityScore([], '')).toBe(1.0);
  });

  it('should give high score to consistent timing with no fillers', () => {
    const timings = [
      { start: 0.0, end: 0.5 },
      { start: 0.55, end: 1.0 },
      { start: 1.05, end: 1.5 },
    ];
    const text = 'Hello there friend';
    const score = computeClarityScore(timings, text);
    expect(score).toBeGreaterThan(0.8);
  });

  it('should penalize timing gaps', () => {
    const timingsGood = [
      { start: 0.0, end: 0.5 },
      { start: 0.55, end: 1.0 },
    ];
    const timingsBad = [
      { start: 0.0, end: 0.5 },
      { start: 1.0, end: 1.5 }, // 500ms gap
    ];
    const text = 'Hello there';

    const scoreGood = computeClarityScore(timingsGood, text);
    const scoreBad = computeClarityScore(timingsBad, text);

    expect(scoreGood).toBeGreaterThan(scoreBad);
  });

  it('should penalize filler words', () => {
    const timings = [
      { start: 0.0, end: 0.5 },
      { start: 0.55, end: 1.0 },
      { start: 1.05, end: 1.5 },
    ];
    const textClean = 'I think we should proceed';
    const textFilled = 'Um like I think basically';

    const scoreClean = computeClarityScore(timings, textClean);
    const scoreFilled = computeClarityScore(timings, textFilled);

    expect(scoreClean).toBeGreaterThan(scoreFilled);
  });

  it('should detect multi-word fillers', () => {
    const timings = [
      { start: 0.0, end: 0.5 },
      { start: 0.55, end: 1.0 },
    ];
    const text = 'You know I mean sort of';
    const score = computeClarityScore(timings, text);

    // Should be penalized for multiple multi-word fillers
    expect(score).toBeLessThan(0.8);
  });

  it('should be case-insensitive for filler detection', () => {
    const timings = [{ start: 0.0, end: 0.5 }];
    const textLower = 'um actually';
    const textUpper = 'Um Actually';

    const scoreLower = computeClarityScore(timings, textLower);
    const scoreUpper = computeClarityScore(timings, textUpper);

    expect(scoreLower).toBeCloseTo(scoreUpper, 5);
  });

  it('should handle punctuation in filler matching', () => {
    const timings = [{ start: 0.0, end: 0.5 }];
    const text = 'Um, like, you know.';
    const score = computeClarityScore(timings, text);

    // Should still detect fillers despite punctuation
    expect(score).toBeLessThan(0.7);
  });
});

describe('detectOverlapContamination', () => {
  it('should return false for empty transitions', () => {
    expect(detectOverlapContamination([])).toBe(false);
  });

  it('should return false for few transitions', () => {
    const transitions = [
      { timeMs: 0 },
      { timeMs: 5000 },
    ];
    expect(detectOverlapContamination(transitions)).toBe(false);
  });

  it('should detect excessive transitions in 10-second window', () => {
    // More than 2 transitions in 10 seconds = contaminated
    const transitions = [
      { timeMs: 0 },
      { timeMs: 2000 },
      { timeMs: 4000 },
      { timeMs: 6000 }, // 4 transitions in 6 seconds
    ];
    expect(detectOverlapContamination(transitions)).toBe(true);
  });

  it('should not flag well-spaced transitions', () => {
    const transitions = [
      { timeMs: 0 },
      { timeMs: 15000 },
      { timeMs: 30000 },
    ];
    expect(detectOverlapContamination(transitions)).toBe(false);
  });

  it('should detect contamination in middle of segment', () => {
    const transitions = [
      { timeMs: 0 },
      { timeMs: 20000 }, // Fine spacing
      { timeMs: 25000 }, // Cluster starts here
      { timeMs: 27000 },
      { timeMs: 29000 }, // 3 transitions in 4 seconds
    ];
    expect(detectOverlapContamination(transitions)).toBe(true);
  });

  it('should handle unsorted transitions', () => {
    const transitions = [
      { timeMs: 6000 },
      { timeMs: 0 },
      { timeMs: 4000 },
      { timeMs: 2000 },
    ];
    // Should sort internally and detect contamination
    expect(detectOverlapContamination(transitions)).toBe(true);
  });

  it('should allow exactly 2 transitions per window', () => {
    const transitions = [
      { timeMs: 0 },
      { timeMs: 5000 },
      { timeMs: 20000 }, // New window
    ];
    expect(detectOverlapContamination(transitions)).toBe(false);
  });
});

describe('computeCompositeQuality', () => {
  it('should use weighted formula correctly', () => {
    const snr = 0.8;
    const clarity = 0.7;
    const isContaminated = false;

    const expected = (0.4 * snr) + (0.3 * clarity) + (0.3 * 1);
    const result = computeCompositeQuality(snr, clarity, isContaminated);

    expect(result).toBeCloseTo(expected, 5);
  });

  it('should penalize contaminated segments', () => {
    const snr = 0.9;
    const clarity = 0.8;

    const clean = computeCompositeQuality(snr, clarity, false);
    const contaminated = computeCompositeQuality(snr, clarity, true);

    expect(contaminated).toBeLessThan(clean);
    expect(contaminated - clean).toBeCloseTo(-0.3, 5); // 0.3 penalty
  });

  it('should clamp result to [0, 1] range', () => {
    // Edge case: all zeros
    expect(computeCompositeQuality(0, 0, true)).toBeGreaterThanOrEqual(0);
    expect(computeCompositeQuality(0, 0, true)).toBeLessThanOrEqual(1);

    // Edge case: all ones
    expect(computeCompositeQuality(1, 1, false)).toBeGreaterThanOrEqual(0);
    expect(computeCompositeQuality(1, 1, false)).toBeLessThanOrEqual(1);
  });

  it('should give perfect score for perfect inputs', () => {
    const result = computeCompositeQuality(1.0, 1.0, false);
    expect(result).toBe(1.0);
  });

  it('should weight SNR most heavily', () => {
    // High SNR, low others
    const highSNR = computeCompositeQuality(1.0, 0.5, true);
    // Low SNR, high others
    const lowSNR = computeCompositeQuality(0.5, 1.0, false);

    // SNR has 0.4 weight, so high SNR should score better despite contamination
    expect(highSNR).toBeCloseTo(0.4 + 0.15 + 0, 5);
    expect(lowSNR).toBeCloseTo(0.2 + 0.3 + 0.3, 5);
    expect(lowSNR).toBeGreaterThan(highSNR); // In this case, other factors win
  });
});

describe('computeWeightedSimilarity', () => {
  it('should not modify similarity when both qualities are perfect', () => {
    const cosine = 0.85;
    const result = computeWeightedSimilarity(cosine, 1.0, 1.0);
    expect(result).toBe(cosine);
  });

  it('should attenuate similarity when one quality is low', () => {
    const cosine = 0.9;
    const highQuality = computeWeightedSimilarity(cosine, 1.0, 1.0);
    const lowQuality = computeWeightedSimilarity(cosine, 1.0, 0.5);

    expect(lowQuality).toBeLessThan(highQuality);
  });

  it('should use geometric mean of qualities', () => {
    const cosine = 0.8;
    const qualityA = 0.9;
    const qualityB = 0.7;

    const expected = cosine * Math.sqrt(qualityA * qualityB);
    const result = computeWeightedSimilarity(cosine, qualityA, qualityB);

    expect(result).toBeCloseTo(expected, 5);
  });

  it('should heavily penalize if both qualities are low', () => {
    const cosine = 0.95; // High similarity
    const result = computeWeightedSimilarity(cosine, 0.3, 0.3);

    // sqrt(0.3 * 0.3) = 0.3, so result should be 0.95 * 0.3 = 0.285
    expect(result).toBeCloseTo(0.285, 5);
    expect(result).toBeLessThan(0.5); // Significantly reduced
  });

  it('should handle zero quality', () => {
    const cosine = 0.8;
    const result = computeWeightedSimilarity(cosine, 0.0, 1.0);

    // sqrt(0 * 1) = 0
    expect(result).toBe(0);
  });

  it('should be symmetric in quality arguments', () => {
    const cosine = 0.7;
    const result1 = computeWeightedSimilarity(cosine, 0.6, 0.8);
    const result2 = computeWeightedSimilarity(cosine, 0.8, 0.6);

    expect(result1).toBeCloseTo(result2, 5);
  });

  it('should preserve negative similarities', () => {
    // Cosine can be negative for very dissimilar vectors
    const cosine = -0.5;
    const result = computeWeightedSimilarity(cosine, 0.8, 0.8);

    expect(result).toBeLessThan(0);
    expect(result).toBeCloseTo(-0.5 * 0.8, 5);
  });
});

describe('Integration: Quality Floor Filtering', () => {
  it('should exclude segments below quality floor (0.3)', () => {
    // Segment with composite quality < 0.3
    const snr = 0.2;
    const clarity = 0.3;
    const isContaminated = true;

    const quality = computeCompositeQuality(snr, clarity, isContaminated);

    expect(quality).toBeLessThan(0.3);
    // This segment should be excluded from reconciliation
  });

  it('should include segments at or above quality floor', () => {
    const snr = 0.5;
    const clarity = 0.5;
    const isContaminated = false;

    const quality = computeCompositeQuality(snr, clarity, isContaminated);

    expect(quality).toBeGreaterThanOrEqual(0.3);
    // This segment should be included in reconciliation
  });

  it('should handle edge case at exactly 0.3', () => {
    // Construct inputs that yield exactly 0.3
    // 0.4*snr + 0.3*clarity + 0.3*overlap = 0.3
    // If snr=0.5, clarity=0.5, contaminated=true:
    // 0.4*0.5 + 0.3*0.5 + 0.3*0 = 0.2 + 0.15 + 0 = 0.35 (above floor)

    // If snr=0.25, clarity=0.5, contaminated=true:
    // 0.4*0.25 + 0.3*0.5 + 0.3*0 = 0.1 + 0.15 + 0 = 0.25 (below floor)

    const aboveFloor = computeCompositeQuality(0.5, 0.5, true);
    const belowFloor = computeCompositeQuality(0.25, 0.5, true);

    expect(aboveFloor).toBeGreaterThan(0.3);
    expect(belowFloor).toBeLessThan(0.3);
  });
});

describe('computeSpeakerQualityMapFromWhisperXSegments', () => {
  it('should return empty map for empty segments', () => {
    const result = computeSpeakerQualityMapFromWhisperXSegments([]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('should compute quality for single speaker with word scores', () => {
    const segments: WhisperXSegmentForQuality[] = [
      {
        text: 'Hello world',
        start: 0,
        end: 2,
        speaker: 'SPEAKER_00',
        words: [
          { word: 'Hello', start: 0, end: 0.5, score: 0.9 },
          { word: 'world', start: 0.6, end: 1.0, score: 0.85 },
        ],
      },
    ];

    const result = computeSpeakerQualityMapFromWhisperXSegments(segments);

    expect(result).toHaveProperty('SPEAKER_00');
    expect(result['SPEAKER_00'].snrProxy).toBeCloseTo((0.9 + 0.85) / 2, 3);
    expect(result['SPEAKER_00'].compositeScore).toBeGreaterThan(0);
    expect(result['SPEAKER_00'].isContaminated).toBe(false);
  });

  it('should aggregate across multiple segments for same speaker', () => {
    const segments: WhisperXSegmentForQuality[] = [
      {
        text: 'First part',
        start: 0,
        end: 1,
        speaker: 'SPEAKER_00',
        words: [
          { word: 'First', start: 0, end: 0.4, score: 0.8 },
          { word: 'part', start: 0.5, end: 1.0, score: 0.8 },
        ],
      },
      {
        text: 'Second part',
        start: 5,
        end: 6,
        speaker: 'SPEAKER_00',
        words: [
          { word: 'Second', start: 5, end: 5.4, score: 0.9 },
          { word: 'part', start: 5.5, end: 6.0, score: 0.9 },
        ],
      },
    ];

    const result = computeSpeakerQualityMapFromWhisperXSegments(segments);

    expect(result).toHaveProperty('SPEAKER_00');
    // SNR should be mean of all 4 word scores
    expect(result['SPEAKER_00'].snrProxy).toBeCloseTo((0.8 + 0.8 + 0.9 + 0.9) / 4, 3);
  });

  it('should compute separate quality for multiple speakers', () => {
    const segments: WhisperXSegmentForQuality[] = [
      {
        text: 'Speaker one talks',
        start: 0,
        end: 2,
        speaker: 'SPEAKER_00',
        words: [
          { word: 'Speaker', start: 0, end: 0.4, score: 0.95 },
          { word: 'one', start: 0.5, end: 0.8, score: 0.95 },
          { word: 'talks', start: 0.9, end: 1.2, score: 0.95 },
        ],
      },
      {
        text: 'Speaker two mumbles um like',
        start: 3,
        end: 5,
        speaker: 'SPEAKER_01',
        words: [
          { word: 'Speaker', start: 3, end: 3.3, score: 0.4 },
          { word: 'two', start: 3.4, end: 3.6, score: 0.4 },
          { word: 'mumbles', start: 3.7, end: 4.0, score: 0.3 },
          { word: 'um', start: 4.1, end: 4.2, score: 0.3 },
          { word: 'like', start: 4.3, end: 4.5, score: 0.3 },
        ],
      },
    ];

    const result = computeSpeakerQualityMapFromWhisperXSegments(segments);

    expect(Object.keys(result)).toHaveLength(2);
    expect(result).toHaveProperty('SPEAKER_00');
    expect(result).toHaveProperty('SPEAKER_01');

    // SPEAKER_00 should have higher quality (high scores, no fillers)
    expect(result['SPEAKER_00'].snrProxy).toBeGreaterThan(result['SPEAKER_01'].snrProxy);
    expect(result['SPEAKER_00'].compositeScore).toBeGreaterThan(result['SPEAKER_01'].compositeScore);
  });

  it('should detect overlap contamination from rapid speaker transitions', () => {
    // Rapid back-and-forth in 10-second window triggers contamination
    const segments: WhisperXSegmentForQuality[] = [
      { text: 'A1', start: 0, end: 1, speaker: 'SPEAKER_00' },
      { text: 'B1', start: 1.5, end: 2.5, speaker: 'SPEAKER_01' },
      { text: 'A2', start: 3, end: 4, speaker: 'SPEAKER_00' },
      { text: 'B2', start: 4.5, end: 5.5, speaker: 'SPEAKER_01' },
      { text: 'A3', start: 6, end: 7, speaker: 'SPEAKER_00' },
    ];

    const result = computeSpeakerQualityMapFromWhisperXSegments(segments);

    // Both speakers should be marked as contaminated due to rapid transitions
    expect(result['SPEAKER_00'].isContaminated).toBe(true);
    expect(result['SPEAKER_01'].isContaminated).toBe(true);
  });

  it('should handle segments without speaker label', () => {
    const segments: WhisperXSegmentForQuality[] = [
      {
        text: 'Unknown speaker',
        start: 0,
        end: 1,
        // No speaker field
        words: [
          { word: 'Unknown', start: 0, end: 0.4, score: 0.7 },
          { word: 'speaker', start: 0.5, end: 1.0, score: 0.7 },
        ],
      },
    ];

    const result = computeSpeakerQualityMapFromWhisperXSegments(segments);

    expect(result).toHaveProperty('UNKNOWN');
    expect(result['UNKNOWN'].snrProxy).toBeCloseTo(0.7, 3);
  });

  it('should handle segments without word scores (default to 1.0)', () => {
    const segments: WhisperXSegmentForQuality[] = [
      {
        text: 'No word scores here',
        start: 0,
        end: 1,
        speaker: 'SPEAKER_00',
        words: [
          { word: 'No', start: 0, end: 0.2 },  // No score field
          { word: 'word', start: 0.25, end: 0.4 },
          { word: 'scores', start: 0.45, end: 0.6 },
          { word: 'here', start: 0.65, end: 0.8 },
        ],
      },
    ];

    const result = computeSpeakerQualityMapFromWhisperXSegments(segments);

    // Without word scores, SNR defaults to 1.0 (computeSNRProxy returns 1.0 for empty array)
    expect(result['SPEAKER_00'].snrProxy).toBe(1.0);
  });

  it('should apply locked composite formula correctly', () => {
    // Construct a scenario where we can predict the composite score
    // Clean speaker with high confidence words
    const segments: WhisperXSegmentForQuality[] = [
      {
        text: 'Perfect audio quality here',
        start: 0,
        end: 2,
        speaker: 'SPEAKER_00',
        words: [
          { word: 'Perfect', start: 0, end: 0.4, score: 1.0 },
          { word: 'audio', start: 0.45, end: 0.8, score: 1.0 },
          { word: 'quality', start: 0.85, end: 1.2, score: 1.0 },
          { word: 'here', start: 1.25, end: 1.5, score: 1.0 },
        ],
      },
    ];

    const result = computeSpeakerQualityMapFromWhisperXSegments(segments);

    // SNR = 1.0 (all perfect scores)
    // Clarity = high (no gaps, no fillers)
    // Contamination = false (single speaker)
    // Formula: 0.4*snr + 0.3*clarity + 0.3*(1-overlap)
    // With all perfect: 0.4*1 + 0.3*1 + 0.3*1 = 1.0
    expect(result['SPEAKER_00'].compositeScore).toBeCloseTo(1.0, 1);
    expect(result['SPEAKER_00'].isContaminated).toBe(false);
  });

  it('should produce low quality for noisy audio with fillers', () => {
    const segments: WhisperXSegmentForQuality[] = [
      {
        text: 'Um like basically you know',
        start: 0,
        end: 3,
        speaker: 'SPEAKER_00',
        words: [
          { word: 'Um', start: 0, end: 0.3, score: 0.3 },
          { word: 'like', start: 0.5, end: 0.8, score: 0.35 },
          { word: 'basically', start: 1.2, end: 1.8, score: 0.25 },  // Gap before this
          { word: 'you', start: 2.3, end: 2.5, score: 0.3 },         // Another gap
          { word: 'know', start: 2.6, end: 2.9, score: 0.3 },
        ],
      },
    ];

    const result = computeSpeakerQualityMapFromWhisperXSegments(segments);

    // Low SNR from poor word scores
    expect(result['SPEAKER_00'].snrProxy).toBeLessThan(0.4);
    // Low clarity from gaps and fillers
    expect(result['SPEAKER_00'].clarityScore).toBeLessThan(0.7);
    // Composite should be below high quality threshold (0.7)
    // With SNR ~0.3, clarity ~0.5, no contamination: 0.4*0.3 + 0.3*0.5 + 0.3*1 = 0.12 + 0.15 + 0.3 = 0.57
    expect(result['SPEAKER_00'].compositeScore).toBeLessThan(0.6);
  });
});
