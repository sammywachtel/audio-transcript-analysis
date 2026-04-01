/**
 * Unit tests for speakerAssignment.ts
 *
 * The module is pure data transformation, so no mocks needed. Just throw
 * data at it and check what comes out. Keep fixtures small and obvious.
 */

import { assignSpeakersToWords } from '../speakerAssignment';
import { Word } from '../alignment';
import { GeminiSegment } from '../gemini3Pipeline';

// =============================================================================
// Helpers — build test fixtures without boilerplate noise
// =============================================================================

/** Build a Word. start/end are in SECONDS, as WhisperX produces them. */
function word(text: string, startSec: number, endSec: number, idx: number, segBreak?: boolean): Word {
  return { word: text, start: startSec, end: endSec, index: idx, segmentBreak: segBreak };
}

/**
 * Build a GeminiSegment. startMs/endMs are in MILLISECONDS,
 * matching what Gemini returns.
 */
function seg(speaker: string, startMs: number, endMs: number): GeminiSegment {
  return { speaker, startMs, endMs };
}

// =============================================================================
// Tests
// =============================================================================

describe('assignSpeakersToWords', () => {
  // ---------------------------------------------------------------------------
  // Edge cases first — always good to know the floor before testing the ceiling
  // ---------------------------------------------------------------------------

  it('returns empty array when words input is empty', () => {
    const segments = [seg('Alice', 0, 5000)];
    expect(assignSpeakersToWords([], segments)).toEqual([]);
  });

  it('returns empty array when segments input is empty', () => {
    const words = [word('hello', 0, 0.5, 0)];
    expect(assignSpeakersToWords(words, [])).toEqual([]);
  });

  it('handles a single word cleanly', () => {
    const words = [word('hello', 1.0, 1.5, 0)];
    const segments = [seg('Alice', 0, 3000)];

    const result = assignSpeakersToWords(words, segments);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      speakerId: 'Alice',
      text: 'hello',
      startMs: 1000,
      endMs: 1500,
    });
  });

  // ---------------------------------------------------------------------------
  // Basic overlap assignment
  // ---------------------------------------------------------------------------

  it('assigns correct speakers when words clearly fall within diarization windows', () => {
    // Alice speaks 0-5s, Bob speaks 5-10s
    const words = [
      word('first',  0.5, 1.0, 0),
      word('second', 1.5, 2.0, 1),
      word('third',  6.0, 6.5, 2),
      word('fourth', 7.0, 7.5, 3),
    ];
    const segments = [
      seg('Alice', 0,    5000),
      seg('Bob',   5000, 10000),
    ];

    const result = assignSpeakersToWords(words, segments);

    expect(result).toHaveLength(2);

    expect(result[0].speakerId).toBe('Alice');
    expect(result[0].text).toBe('first second');
    expect(result[0].startMs).toBe(500);
    expect(result[0].endMs).toBe(2000);

    expect(result[1].speakerId).toBe('Bob');
    expect(result[1].text).toBe('third fourth');
    expect(result[1].startMs).toBe(6000);
    expect(result[1].endMs).toBe(7500);
  });

  // ---------------------------------------------------------------------------
  // Nearest-neighbor fallback for words in gaps
  // ---------------------------------------------------------------------------

  it('assigns gap word to the nearest segment via nearest-neighbor', () => {
    // Alice 0-2s, Bob 4-6s, gap at 2-4s. Word at 2.9-3.1s should go to Alice
    // (closer to Alice's end at 2000ms than Bob's start at 4000ms).
    const words = [word('gap-word', 2.9, 3.1, 0)];
    const segments = [
      seg('Alice', 0,    2000),
      seg('Bob',   4000, 6000),
    ];

    const result = assignSpeakersToWords(words, segments);

    expect(result).toHaveLength(1);
    // Word midpoint = 3000ms. Distance to Alice end (2000) = 1000ms. Distance to Bob start (4000) = 1000ms.
    // Equal distance — nearest-neighbor picks Alice because it comes first in iteration.
    // This is fine; the spec just says "nearest boundary". Ties go to whoever hits the threshold first.
    expect(result[0].speakerId).toBe('Alice');
  });

  it('assigns gap word to Bob when clearly closer to Bob', () => {
    // Gap at 2-4s, word at 3.7-3.9s (220ms from Bob start, 1800ms from Alice end).
    const words = [word('yo', 3.7, 3.9, 0)];
    const segments = [
      seg('Alice', 0,    2000),
      seg('Bob',   4000, 6000),
    ];

    const result = assignSpeakersToWords(words, segments);

    expect(result[0].speakerId).toBe('Bob');
  });

  // ---------------------------------------------------------------------------
  // Grouping and text concatenation
  // ---------------------------------------------------------------------------

  it('concatenates consecutive same-speaker words into one segment', () => {
    const words = [
      word('the',    0.0, 0.2, 0),
      word('quick',  0.2, 0.5, 1),
      word('brown',  0.5, 0.8, 2),
      word('fox',    0.8, 1.1, 3),
    ];
    const segments = [seg('Narrator', 0, 5000)];

    const result = assignSpeakersToWords(words, segments);

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('the quick brown fox');
    expect(result[0].startMs).toBe(0);
    expect(result[0].endMs).toBe(1100);
  });

  it('produces multiple segments on speaker change mid-stream', () => {
    // Three distinct speakers, interleaved just enough to produce 3 output segments.
    const words = [
      word('hello',   0.0, 0.4, 0),  // Alice
      word('there',   0.5, 0.9, 1),  // Alice
      word('howdy',   1.5, 1.9, 2),  // Bob
      word('partner', 2.0, 2.4, 3),  // Bob
      word('indeed',  3.5, 3.9, 4),  // Carol
    ];
    const segments = [
      seg('Alice', 0,    1200),
      seg('Bob',   1200, 3000),
      seg('Carol', 3000, 5000),
    ];

    const result = assignSpeakersToWords(words, segments);

    expect(result).toHaveLength(3);

    expect(result[0].speakerId).toBe('Alice');
    expect(result[0].text).toBe('hello there');

    expect(result[1].speakerId).toBe('Bob');
    expect(result[1].text).toBe('howdy partner');

    expect(result[2].speakerId).toBe('Carol');
    expect(result[2].text).toBe('indeed');
  });

  // ---------------------------------------------------------------------------
  // Multiple overlapping segments — pick greatest overlap
  // ---------------------------------------------------------------------------

  it('picks the segment with greater overlap when two segments both touch a word', () => {
    // Word spans 4.5s-5.5s (4500ms-5500ms).
    // Alice ends at 5000ms → overlap with word = 500ms.
    // Bob starts at 4000ms, ends at 6000ms → overlap with word = 1000ms.
    // Should pick Bob.
    const words = [word('borderline', 4.5, 5.5, 0)];
    const segments = [
      seg('Alice', 0,    5000),
      seg('Bob',   4000, 6000),
    ];

    const result = assignSpeakersToWords(words, segments);

    expect(result[0].speakerId).toBe('Bob');
  });

  // ---------------------------------------------------------------------------
  // Words entirely before or after all segments
  // ---------------------------------------------------------------------------

  it('assigns words before all segments to the first segment via nearest-neighbor', () => {
    // Word ends at 0.3s (300ms), first segment starts at 2s (2000ms).
    const words = [word('preamble', 0.1, 0.3, 0)];
    const segments = [
      seg('Alice', 2000, 4000),
      seg('Bob',   4000, 6000),
    ];

    const result = assignSpeakersToWords(words, segments);

    // Word midpoint = 200ms. Nearest boundary is Alice start (2000ms).
    expect(result[0].speakerId).toBe('Alice');
  });

  it('assigns words after all segments to the last segment via nearest-neighbor', () => {
    // Word starts well past the last segment end.
    const words = [word('trailing', 10.0, 10.5, 0)];
    const segments = [
      seg('Alice', 0,    2000),
      seg('Bob',   2000, 5000),
    ];

    const result = assignSpeakersToWords(words, segments);

    // Word midpoint = 10250ms. Bob ends at 5000ms — nearest boundary in the whole set.
    expect(result[0].speakerId).toBe('Bob');
  });

  // ---------------------------------------------------------------------------
  // All words in one segment → single output segment
  // ---------------------------------------------------------------------------

  it('produces one output segment when all words fall within a single diarization window (no segment breaks)', () => {
    const words = [
      word('one',   0.5, 0.8, 0),
      word('two',   0.9, 1.2, 1),
      word('three', 1.3, 1.6, 2),
    ];
    const segments = [
      seg('Alice', 0, 10000),
      seg('Bob',   10000, 20000),
    ];

    const result = assignSpeakersToWords(words, segments);

    expect(result).toHaveLength(1);
    expect(result[0].speakerId).toBe('Alice');
    expect(result[0].text).toBe('one two three');
    expect(result[0].startMs).toBe(500);
    expect(result[0].endMs).toBe(1600);
  });

  // ---------------------------------------------------------------------------
  // WhisperX segment boundary breaks
  // ---------------------------------------------------------------------------

  it('breaks same-speaker words at WhisperX segment boundaries', () => {
    // Same speaker for all words, but a natural pause (segmentBreak) at word 3.
    // Should produce two segments for readability, both attributed to Alice.
    const words = [
      word('first',    0.0, 0.3, 0, true),   // start of WhisperX segment 1
      word('sentence', 0.3, 0.7, 1),
      word('here',     0.7, 1.0, 2),
      word('second',   2.0, 2.3, 3, true),   // start of WhisperX segment 2
      word('sentence', 2.3, 2.6, 4),
      word('there',    2.6, 3.0, 5),
    ];
    const segments = [seg('Alice', 0, 10000)];

    const result = assignSpeakersToWords(words, segments);

    expect(result).toHaveLength(2);
    expect(result[0].speakerId).toBe('Alice');
    expect(result[0].text).toBe('first sentence here');
    expect(result[1].speakerId).toBe('Alice');
    expect(result[1].text).toBe('second sentence there');
  });

  it('breaks on both speaker change and segment boundary', () => {
    // Alice speaks two WhisperX segments, then Bob speaks one.
    const words = [
      word('alice1', 0.0, 0.5, 0, true),
      word('alice2', 0.5, 1.0, 1),
      word('alice3', 2.0, 2.5, 2, true),   // segment break, same speaker
      word('alice4', 2.5, 3.0, 3),
      word('bob1',   5.0, 5.5, 4, true),   // segment break + speaker change
      word('bob2',   5.5, 6.0, 5),
    ];
    const segments = [
      seg('Alice', 0, 4000),
      seg('Bob', 4000, 8000),
    ];

    const result = assignSpeakersToWords(words, segments);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ speakerId: 'Alice', text: 'alice1 alice2' });
    expect(result[1]).toMatchObject({ speakerId: 'Alice', text: 'alice3 alice4' });
    expect(result[2]).toMatchObject({ speakerId: 'Bob', text: 'bob1 bob2' });
  });
});
