/**
 * Unit tests for segment boundary repair and speaker correction application.
 *
 * Tests cover:
 * - fixSegmentBoundaries: forward pass (leading fragment to prev segment)
 * - fixSegmentBoundaries: comma/semicolon secondary pattern
 * - fixSegmentBoundaries: reverse pass (trailing fragment to next segment)
 * - fixSegmentBoundaries: no-op cases (fragment too long, same speaker, starter threshold)
 * - fixSegmentBoundaries: timestamp interpolation correctness
 * - applySpeakerReassignments: reassign action
 * - applySpeakerReassignments: split at sentence boundary with guarded validation
 * - applySpeakerReassignments: max 3 splits enforced
 * - applySpeakerReassignments: graceful skip on invalid corrections
 * - applySpeakerReassignments: adjacent same-speaker merge after split
 * - applySpeakerReassignments: mixed reassign + split
 * - applySpeakerReassignments: sequential re-indexing after corrections
 */

// Mock every Firebase/GCP module before any import that touches index.ts.
// These functions don't need any of that infrastructure — we just need the
// module to load without blowing up on missing credentials.
jest.mock('firebase-admin/app', () => ({
  initializeApp: jest.fn(),
  getApp: jest.fn(),
  cert: jest.fn()
}));

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => ({})),
  FieldValue: { serverTimestamp: jest.fn() }
}));

jest.mock('firebase-admin/storage', () => ({
  getStorage: jest.fn(() => ({
    bucket: jest.fn(() => ({
      file: jest.fn(),
      upload: jest.fn()
    }))
  }))
}));

jest.mock('@google-cloud/vertexai', () => ({
  VertexAI: jest.fn(() => ({
    getGenerativeModel: jest.fn()
  })),
  SchemaType: {
    OBJECT: 'object',
    ARRAY: 'array',
    STRING: 'string',
    INTEGER: 'integer',
    BOOLEAN: 'boolean'
  }
}));

jest.mock('firebase-functions/v2/storage', () => ({
  onObjectFinalized: jest.fn()
}));

jest.mock('firebase-functions/params', () => ({
  defineSecret: jest.fn(() => ({ value: jest.fn(() => 'mock-secret') }))
}));

jest.mock('../index', () => ({
  db: {},
  bucket: { file: jest.fn(), upload: jest.fn() }
}));

// Silence noisy module-level console.log from index.ts and version loading
jest.mock('../progressManager', () => ({ ProgressManager: jest.fn(), ProcessingStep: {} }));
jest.mock('../alignment', () => ({
  transcribeWithWhisperX: jest.fn(),
  transcribeWithWhisperXRobust: jest.fn()
}));
jest.mock('../metrics', () => ({
  recordMetrics: jest.fn(),
  calculateCost: jest.fn(),
}));
jest.mock('../userEvents', () => ({ recordUserEvent: jest.fn() }));
jest.mock('../chunking', () => ({
  chunkAudioFile: jest.fn(),
  cleanupChunks: jest.fn(),
  reencodeForPlayback: jest.fn()
}));
jest.mock('../chunkBounds', () => ({ validateChunkSequence: jest.fn() }));
jest.mock('../chunkContext', () => ({
  createInitialChunkStatuses: jest.fn(),
  sanitizeForFirestore: jest.fn()
}));
jest.mock('../speakerQuality', () => ({
  computeSpeakerQualityMapFromWhisperXSegments: jest.fn()
}));
jest.mock('../utils/llmMetadata', () => ({ buildGeminiLabels: jest.fn(() => ({})) }));

// Now it's safe to pull in the functions under test
import { fixSegmentBoundaries, applySpeakerReassignments } from '../transcribe';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Seg = { text: string; startMs: number; endMs: number; speakerId: string; index: number };

function makeSeg(index: number, speakerId: string, text: string, startMs: number, endMs: number): Seg {
  return { index, speakerId, text, startMs, endMs };
}

// ---------------------------------------------------------------------------
// fixSegmentBoundaries
// ---------------------------------------------------------------------------

describe('fixSegmentBoundaries', () => {
  describe('forward pass — leading fragment moves to previous segment', () => {
    it('moves a sentence-ending fragment at the start of a new-speaker segment', () => {
      const segs = [
        makeSeg(0, 'A', 'And then she left.', 0, 1000),
        makeSeg(1, 'B', 'walked out. But I stayed behind and kept working.', 1000, 3000)
      ];
      const result = fixSegmentBoundaries(segs);

      // "walked out." should move to speaker A; "But I stayed..." stays with B
      expect(result[0].speakerId).toBe('A');
      expect(result[0].text).toContain('walked out.');
      expect(result[1].speakerId).toBe('B');
      expect(result[1].text).toMatch(/^But I stayed/);
    });

    it('moves a comma/semicolon fragment under the secondary pattern (short enough)', () => {
      const segs = [
        makeSeg(0, 'A', 'Right, I see.', 0, 1000),
        // "yeah, sure." is <= 40 chars and ends before "Anyway" (new-speaker content)
        makeSeg(1, 'B', 'yeah, sure. Anyway this is the real topic here.', 1000, 3000)
      ];
      const result = fixSegmentBoundaries(segs);

      expect(result[0].text).toContain('yeah, sure.');
      expect(result[1].text).toMatch(/^Anyway/);
    });

    it('does NOT move a fragment exceeding MAX_FRAGMENT_CHARS (80 chars)', () => {
      // Build a fragment that is definitely > 80 chars: 78 'A's + "xyz." = 82 chars
      // The lazy primary regex will stop at the first "." in "xyz." — so the fragment
      // captured is all 82 chars. That exceeds MAX_FRAGMENT_CHARS (80).
      const longFrag = 'A'.repeat(78) + 'xyz.';
      const segs = [
        makeSeg(0, 'A', 'Blah blah.', 0, 1000),
        makeSeg(1, 'B', longFrag + ' Something else entirely different from speaker B now.', 1000, 4000)
      ];
      const result = fixSegmentBoundaries(segs);

      // Nothing moved — original text preserved
      expect(result[1].text).toBe(segs[1].text);
    });

    it('does NOT move a sentence-starter fragment longer than 25 chars', () => {
      // "The quick brown fox jumped." is 27 chars and starts with "The" → rejected
      const segs = [
        makeSeg(0, 'A', 'Right okay.', 0, 1000),
        makeSeg(1, 'B', 'The quick brown fox jumped over. And the rest belongs to B too.', 1000, 3000)
      ];
      const result = fixSegmentBoundaries(segs);

      expect(result[1].text).toBe(segs[1].text);
    });

    it('DOES move a short sentence-starter fragment (≤ 25 chars)', () => {
      // "So yeah." is 8 chars — under the 25-char threshold → should move
      const segs = [
        makeSeg(0, 'A', 'Mmm hmm.', 0, 500),
        makeSeg(1, 'B', 'So yeah. That is actually what happened back then.', 500, 2500)
      ];
      const result = fixSegmentBoundaries(segs);

      expect(result[0].text).toContain('So yeah.');
      expect(result[1].text).toMatch(/^That is actually/);
    });

    it('skips adjacent same-speaker segments', () => {
      const segs = [
        makeSeg(0, 'A', 'First part of A.', 0, 1000),
        makeSeg(1, 'A', 'continued. And then more from A.', 1000, 2000)
      ];
      const result = fixSegmentBoundaries(segs);

      expect(result[0].text).toBe(segs[0].text);
      expect(result[1].text).toBe(segs[1].text);
    });

    it('interpolates timestamps correctly after forward move', () => {
      const segs = [
        makeSeg(0, 'A', 'Hello world.', 0, 1000),
        makeSeg(1, 'B', 'done. The rest of it here.', 1000, 3000)
      ];
      const result = fixSegmentBoundaries(segs);

      // "done." = 5 chars; full text = 26 chars → ratio ≈ 5/26
      const fragLen = 'done.'.length;
      const totalLen = 'done. The rest of it here.'.length;
      const expectedBoundary = 1000 + Math.floor(2000 * (fragLen / totalLen));

      expect(result[0].endMs).toBe(expectedBoundary);
      expect(result[1].startMs).toBe(expectedBoundary);
    });
  });

  describe('reverse pass — trailing fragment moves to next segment', () => {
    it('moves a trailing orphan after the last sentence end to the next segment', () => {
      // Segment A ends with "main point." followed by "but also this" (short trailing blob)
      const segs = [
        makeSeg(0, 'A', 'I wanted to make the main point. but also this', 0, 2000),
        makeSeg(1, 'B', 'is actually important to consider.', 2000, 3000)
      ];
      const result = fixSegmentBoundaries(segs);

      expect(result[0].text.trimEnd()).toMatch(/main point\.$/);
      expect(result[1].text).toMatch(/^but also this/);
    });

    it('does NOT move a trailing fragment over 80 chars', () => {
      const longTrail = 'b'.repeat(85);
      const segs = [
        makeSeg(0, 'A', `Good sentence. ${longTrail}`, 0, 3000),
        makeSeg(1, 'B', 'And now speaker B talks.', 3000, 5000)
      ];
      const result = fixSegmentBoundaries(segs);

      expect(result[0].text).toBe(segs[0].text);
      expect(result[1].text).toBe(segs[1].text);
    });

    it('skips same-speaker adjacent pairs in reverse pass', () => {
      const segs = [
        makeSeg(0, 'A', 'One sentence. trailing bit', 0, 2000),
        makeSeg(1, 'A', 'Continues on.', 2000, 3000)
      ];
      const result = fixSegmentBoundaries(segs);

      expect(result[0].text).toBe(segs[0].text);
      expect(result[1].text).toBe(segs[1].text);
    });

    it('interpolates timestamps correctly after reverse move', () => {
      // "keep" must be >= MIN_REMAINING_CHARS (20) so the guard passes.
      // "I really wanted this indeed." = 29 chars (keep)
      // "trailing bit" = 12 chars (moved to next segment)
      // Total = "I really wanted this indeed. trailing bit" = 41 chars
      const segText = 'I really wanted this indeed. trailing bit';
      const segs = [
        makeSeg(0, 'A', segText, 0, 4100),
        makeSeg(1, 'B', 'speaker B content here.', 4100, 6000)
      ];
      const result = fixSegmentBoundaries(segs);

      const keepLen = 'I really wanted this indeed.'.length; // 28
      const totalLen = segText.length;                       // 41
      const expectedBoundary = 0 + Math.floor(4100 * (keepLen / totalLen));

      expect(result[0].endMs).toBe(expectedBoundary);
      expect(result[1].startMs).toBe(expectedBoundary);
    });
  });

  describe('edge cases', () => {
    it('returns single segment unchanged', () => {
      const segs = [makeSeg(0, 'A', 'Solo speaker here.', 0, 1000)];
      expect(fixSegmentBoundaries(segs)).toEqual(segs);
    });

    it('returns empty array unchanged', () => {
      expect(fixSegmentBoundaries([])).toEqual([]);
    });

    it('re-indexes segments after moves', () => {
      const segs = [
        makeSeg(5, 'A', 'First.', 0, 1000),
        makeSeg(6, 'B', 'bleed. Real second segment content here.', 1000, 2000)
      ];
      const result = fixSegmentBoundaries(segs);
      result.forEach((seg, idx) => expect(seg.index).toBe(idx));
    });
  });
});

// ---------------------------------------------------------------------------
// applySpeakerReassignments
// ---------------------------------------------------------------------------

const SPEAKERS = ['SPEAKER_00', 'SPEAKER_01'];

function makeCorrection(
  segmentIndex: number,
  action: 'reassign' | 'split',
  opts: {
    newSpeaker?: string;
    splitAfterSentence?: string;
    speakerBefore?: string;
    speakerAfter?: string;
    reason?: string;
  } = {}
) {
  return {
    segmentIndex,
    action,
    reason: opts.reason ?? 'test correction',
    newSpeaker: opts.newSpeaker,
    splitAfterSentence: opts.splitAfterSentence,
    speakerBefore: opts.speakerBefore,
    speakerAfter: opts.speakerAfter
  };
}

describe('applySpeakerReassignments', () => {
  describe('reassign action', () => {
    it('reassigns a whole segment to a different speaker', () => {
      const segs = [
        makeSeg(0, 'SPEAKER_00', 'This is the first segment.', 0, 1000),
        makeSeg(1, 'SPEAKER_00', 'Actually this belongs to speaker one.', 1000, 2000)
      ];
      const result = applySpeakerReassignments(segs, [
        makeCorrection(1, 'reassign', { newSpeaker: 'SPEAKER_01' })
      ], SPEAKERS);

      expect(result[1].speakerId).toBe('SPEAKER_01');
      expect(result[0].speakerId).toBe('SPEAKER_00');
    });

    it('skips reassignment with unknown speaker', () => {
      const segs = [makeSeg(0, 'SPEAKER_00', 'Segment text.', 0, 1000)];
      const result = applySpeakerReassignments(segs, [
        makeCorrection(0, 'reassign', { newSpeaker: 'SPEAKER_GHOST' })
      ], SPEAKERS);

      expect(result[0].speakerId).toBe('SPEAKER_00'); // unchanged
    });

    it('skips reassignment with out-of-range segment index', () => {
      const segs = [makeSeg(0, 'SPEAKER_00', 'Segment text.', 0, 1000)];
      const result = applySpeakerReassignments(segs, [
        makeCorrection(99, 'reassign', { newSpeaker: 'SPEAKER_01' })
      ], SPEAKERS);

      expect(result[0].speakerId).toBe('SPEAKER_00');
    });
  });

  describe('split action', () => {
    it('splits at a sentence boundary with correct speakers and timestamps', () => {
      const text = 'This is what speaker zero said. And here speaker one takes over.';
      const segs = [makeSeg(0, 'SPEAKER_00', text, 0, 6400)];

      const result = applySpeakerReassignments(segs, [
        makeCorrection(0, 'split', {
          splitAfterSentence: 'This is what speaker zero said.',
          speakerBefore: 'SPEAKER_00',
          speakerAfter: 'SPEAKER_01'
        })
      ], SPEAKERS);

      expect(result).toHaveLength(2);
      expect(result[0].speakerId).toBe('SPEAKER_00');
      expect(result[1].speakerId).toBe('SPEAKER_01');
      expect(result[0].text).toBe('This is what speaker zero said.');
      expect(result[1].text).toBe('And here speaker one takes over.');

      // Timestamp interpolation
      const anchorLen = 'This is what speaker zero said.'.length;
      const totalLen = text.length;
      const expectedSplit = Math.floor(6400 * (anchorLen / totalLen));
      expect(result[0].endMs).toBe(expectedSplit);
      expect(result[1].startMs).toBe(expectedSplit);
    });

    it('enforces MAX_SPLITS of 3 — 4th split correction is silently dropped', () => {
      // To make the test deterministic about which segments got split, use alternating
      // speakers so the SPEAKER_01 halves don't merge with SPEAKER_00 halves.
      // After 3 splits on segs 0,1,2 (descending: 2,1,0), segment 3 is untouched.
      // The adjacent SPEAKER_01 halves (end of each split) will merge with their
      // SPEAKER_00 neighbours only if they share speakerId — they won't here since
      // speakerBefore=00 and speakerAfter=01 throughout.
      //
      // Result structure after 3 splits + merges:
      //   seg0-before(00) + seg1-before(00) + seg2-before(00) all merge → 1 big SPEAKER_00
      //   BUT the 01 half of seg0 is between 00s, so they don't merge freely.
      //   To keep the assertion simple: just check the original seg3 text appears verbatim.
      const segs = [
        makeSeg(0, 'SPEAKER_00', 'Alpha sentence done. Beta content here now.', 0, 4300),
        makeSeg(1, 'SPEAKER_00', 'Charlie sentence done. Delta content here.', 4300, 8600),
        makeSeg(2, 'SPEAKER_00', 'Echo sentence done. Foxtrot content here.', 8600, 12900),
        makeSeg(3, 'SPEAKER_00', 'Golf sentence done. Hotel content here now.', 12900, 17200)
      ];

      const corrections = [
        makeCorrection(0, 'split', { splitAfterSentence: 'Alpha sentence done.', speakerBefore: 'SPEAKER_00', speakerAfter: 'SPEAKER_01' }),
        makeCorrection(1, 'split', { splitAfterSentence: 'Charlie sentence done.', speakerBefore: 'SPEAKER_00', speakerAfter: 'SPEAKER_01' }),
        makeCorrection(2, 'split', { splitAfterSentence: 'Echo sentence done.', speakerBefore: 'SPEAKER_00', speakerAfter: 'SPEAKER_01' }),
        makeCorrection(3, 'split', { splitAfterSentence: 'Golf sentence done.', speakerBefore: 'SPEAKER_00', speakerAfter: 'SPEAKER_01' }) // 4th → dropped
      ];

      const result = applySpeakerReassignments(segs, corrections, SPEAKERS);

      // Seg 3 (the dropped one) must appear verbatim somewhere in the result
      const seg3Text = 'Golf sentence done. Hotel content here now.';
      const hasSeg3 = result.some(s => s.text.includes(seg3Text));
      expect(hasSeg3).toBe(true);

      // The result must have FEWER segments than if all 4 had been split (which would be 8)
      // With MAX_SPLITS=3 and merging, we get fewer. Without the limit guard we'd have 8→more merges.
      // The simplest assertion: result.length < 8
      expect(result.length).toBeLessThan(8);
    });

    it('skips split when splitAfterSentence is not found in segment', () => {
      const segs = [makeSeg(0, 'SPEAKER_00', 'Completely different text here.', 0, 3000)];
      const result = applySpeakerReassignments(segs, [
        makeCorrection(0, 'split', {
          splitAfterSentence: 'This text does not exist in segment.',
          speakerBefore: 'SPEAKER_00',
          speakerAfter: 'SPEAKER_01'
        })
      ], SPEAKERS);

      expect(result).toHaveLength(1);
      expect(result[0].speakerId).toBe('SPEAKER_00');
    });

    it('skips split when anchor does not end with sentence punctuation', () => {
      const segs = [
        makeSeg(0, 'SPEAKER_00', 'I was going to say something and then more content here.', 0, 5600)
      ];
      const result = applySpeakerReassignments(segs, [
        makeCorrection(0, 'split', {
          splitAfterSentence: 'I was going to say something', // no trailing . ! or ?
          speakerBefore: 'SPEAKER_00',
          speakerAfter: 'SPEAKER_01'
        })
      ], SPEAKERS);

      expect(result).toHaveLength(1);
    });

    it('skips split when the before-half would be < 20 chars', () => {
      // "Hi." is only 3 chars — too short to be a valid first half
      const segs = [makeSeg(0, 'SPEAKER_00', 'Hi. This is the real content from speaker one here.', 0, 5100)];
      const result = applySpeakerReassignments(segs, [
        makeCorrection(0, 'split', {
          splitAfterSentence: 'Hi.',
          speakerBefore: 'SPEAKER_00',
          speakerAfter: 'SPEAKER_01'
        })
      ], SPEAKERS);

      expect(result).toHaveLength(1);
    });

    it('skips split when speakerBefore is unknown', () => {
      const segs = [
        makeSeg(0, 'SPEAKER_00', 'This is a good sentence. And here is the continuation text.', 0, 5900)
      ];
      const result = applySpeakerReassignments(segs, [
        makeCorrection(0, 'split', {
          splitAfterSentence: 'This is a good sentence.',
          speakerBefore: 'SPEAKER_PHANTOM',
          speakerAfter: 'SPEAKER_01'
        })
      ], SPEAKERS);

      expect(result).toHaveLength(1);
    });

    it('skips split when speakerAfter is unknown', () => {
      const segs = [
        makeSeg(0, 'SPEAKER_00', 'This is a good sentence. And here is the continuation text.', 0, 5900)
      ];
      const result = applySpeakerReassignments(segs, [
        makeCorrection(0, 'split', {
          splitAfterSentence: 'This is a good sentence.',
          speakerBefore: 'SPEAKER_00',
          speakerAfter: 'SPEAKER_GHOST'
        })
      ], SPEAKERS);

      expect(result).toHaveLength(1);
    });

    it('merges adjacent same-speaker segments created by a split', () => {
      // Segment layout designed to demonstrate merge behavior clearly:
      //   seg0: SPEAKER_01 (stays)
      //   seg1: SPEAKER_00 (gets split → SPEAKER_00 first half, SPEAKER_01 second half)
      //   seg2: SPEAKER_01 (stays)
      //
      // After split: [SPEAKER_01][SPEAKER_00][SPEAKER_01][SPEAKER_01]
      //                                         ↑ these two merge ↑
      // Final:       [SPEAKER_01][SPEAKER_00][SPEAKER_01(merged)]  → 3 segments
      const segs = [
        makeSeg(0, 'SPEAKER_01', 'Speaker one speaks first here.', 0, 3100),
        makeSeg(1, 'SPEAKER_00', 'This belongs to zero. And this bit belongs to one.', 3100, 8100),
        makeSeg(2, 'SPEAKER_01', 'Continuing on from speaker one now.', 8100, 11600)
      ];

      const result = applySpeakerReassignments(segs, [
        makeCorrection(1, 'split', {
          splitAfterSentence: 'This belongs to zero.',
          speakerBefore: 'SPEAKER_00',
          speakerAfter: 'SPEAKER_01'
        })
      ], SPEAKERS);

      // Split makes 4 segments → SPEAKER_01(seg1-after) + SPEAKER_01(seg2) merge → 3 final
      expect(result).toHaveLength(3);
      expect(result[0].speakerId).toBe('SPEAKER_01');
      expect(result[1].speakerId).toBe('SPEAKER_00');
      expect(result[2].speakerId).toBe('SPEAKER_01');
      expect(result[2].text).toContain('And this bit belongs to one.');
      expect(result[2].text).toContain('Continuing on from speaker one now.');
      // Merged segment spans the full combined time range
      expect(result[2].startMs).toBeLessThan(result[2].endMs);
    });

    it('handles mixed reassign + split corrections correctly', () => {
      const segs = [
        makeSeg(0, 'SPEAKER_00', 'Speaker zero speaks here.', 0, 2500),
        makeSeg(1, 'SPEAKER_00', 'First part here now. Second part here too.', 2500, 6700)
      ];

      const result = applySpeakerReassignments(segs, [
        makeCorrection(0, 'reassign', { newSpeaker: 'SPEAKER_01' }),
        makeCorrection(1, 'split', {
          splitAfterSentence: 'First part here now.',
          speakerBefore: 'SPEAKER_00',
          speakerAfter: 'SPEAKER_01'
        })
      ], SPEAKERS);

      // seg0 reassigned → SPEAKER_01
      // seg1 split → SPEAKER_00 + SPEAKER_01
      // SPEAKER_01(seg0) is adjacent to SPEAKER_00(first split half) — different, no merge
      // SPEAKER_01(seg0) is NOT adjacent to SPEAKER_01(second split half) — they're separated
      expect(result[0].speakerId).toBe('SPEAKER_01');
      expect(result[1].speakerId).toBe('SPEAKER_00');
      expect(result[2].speakerId).toBe('SPEAKER_01');
    });

    it('re-indexes all segments sequentially after corrections', () => {
      const segs = [
        makeSeg(0, 'SPEAKER_00', 'Alpha sentence done. Beta content here.', 0, 3900),
        makeSeg(1, 'SPEAKER_01', 'Another segment from speaker one.', 3900, 6900)
      ];
      const result = applySpeakerReassignments(segs, [
        makeCorrection(0, 'split', {
          splitAfterSentence: 'Alpha sentence done.',
          speakerBefore: 'SPEAKER_00',
          speakerAfter: 'SPEAKER_01'
        })
      ], SPEAKERS);

      // Split half (SPEAKER_01) + seg1 (SPEAKER_01) merge → 2 segments total
      result.forEach((seg, idx) => {
        expect(seg.index).toBe(idx);
      });
    });

    it('returns segments unchanged when no corrections are provided', () => {
      const segs = [
        makeSeg(0, 'SPEAKER_00', 'Segment one.', 0, 1000),
        makeSeg(1, 'SPEAKER_01', 'Segment two.', 1000, 2000)
      ];
      const result = applySpeakerReassignments(segs, [], SPEAKERS);
      expect(result).toEqual(segs);
    });
  });
});
