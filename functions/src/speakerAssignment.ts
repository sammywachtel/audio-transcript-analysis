/**
 * Speaker Assignment Module
 *
 * Bridges Gemini diarization windows (who spoke when, no text) with
 * WhisperX word-level timestamps (text with timing, no speaker labels).
 *
 * The whole trick is just overlap detection + grouping. No ML, no magic.
 * If this breaks, check the ms vs seconds conversion first — it always is.
 */

import { Word } from './alignment';
import { GeminiSegment, AlignedSegment } from './gemini3Pipeline';

// =============================================================================
// Core Assignment Logic
// =============================================================================

/**
 * For a given word time range (in ms), find how many milliseconds it overlaps
 * with a given segment. Returns 0 if no overlap.
 */
function overlapMs(wordStartMs: number, wordEndMs: number, seg: GeminiSegment): number {
  const overlapStart = Math.max(wordStartMs, seg.startMs);
  const overlapEnd = Math.min(wordEndMs, seg.endMs);
  return Math.max(0, overlapEnd - overlapStart);
}

/**
 * Assigns a speaker to each WhisperX word using Gemini diarization windows,
 * then groups consecutive same-speaker words into AlignedSegments.
 *
 * Two-phase:
 *   1. For each word, find the best-fitting Gemini segment (overlap-first,
 *      nearest-neighbor fallback when the word lands in a gap).
 *   2. Merge consecutive words with the same speaker into segments.
 *
 * Unit note: Word.start/end are seconds (float). GeminiSegment times are ms.
 * Convert words to ms before any comparison — don't get clever and skip it.
 */
/**
 * Filter out WhisperX hallucination loops. When the model hits noisy audio
 * it sometimes gets stuck repeating the same word ("uh, uh, uh, uh...")
 * dozens of times. Collapse runs of 3+ identical words down to 1.
 */
function deduplicateHallucinatedWords(words: Word[]): Word[] {
  if (words.length < 3) return words;

  const result: Word[] = [words[0]];
  let runLength = 1;

  for (let i = 1; i < words.length; i++) {
    const same = words[i].word.trim().toLowerCase() === words[i - 1].word.trim().toLowerCase();
    if (same) {
      runLength++;
      // Keep the first 2 of any run, drop the rest
      if (runLength <= 2) result.push(words[i]);
    } else {
      runLength = 1;
      result.push(words[i]);
    }
  }

  const dropped = words.length - result.length;
  if (dropped > 0) {
    console.log(`[SpeakerAssignment] Filtered ${dropped} hallucinated repeat words`);
  }
  return result;
}

export function assignSpeakersToWords(words: Word[], segments: GeminiSegment[]): AlignedSegment[] {
  // Nothing to do — bail early to keep the rest of the logic simple.
  if (words.length === 0 || segments.length === 0) {
    return [];
  }

  // Phase 0: strip WhisperX hallucination loops before any processing.
  words = deduplicateHallucinatedWords(words);

  // Phase 1: assign each word a speaker label.
  const wordSpeakers: string[] = words.map((word) => {
    const wordStartMs = word.start * 1000;
    const wordEndMs = word.end * 1000;

    // Find all segments that overlap this word's time range.
    // Overlap condition: wordStart < segEnd AND wordEnd > segStart
    let bestSeg: GeminiSegment | null = null;
    let bestOverlap = 0;

    for (const seg of segments) {
      const overlap = overlapMs(wordStartMs, wordEndMs, seg);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestSeg = seg;
      }
    }

    if (bestSeg !== null) {
      return bestSeg.speaker;
    }

    // No overlap — word fell in a gap between diarization windows.
    // Nearest-neighbor: find the segment whose nearest boundary is closest
    // to the word's midpoint. Works for words at the very start/end too.
    const wordMidMs = (wordStartMs + wordEndMs) / 2;
    let nearestSeg = segments[0];
    let nearestDist = Infinity;

    for (const seg of segments) {
      // Distance from midpoint to segment's nearest boundary
      const distToStart = Math.abs(wordMidMs - seg.startMs);
      const distToEnd = Math.abs(wordMidMs - seg.endMs);
      const dist = Math.min(distToStart, distToEnd);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestSeg = seg;
      }
    }

    return nearestSeg.speaker;
  });

  // Phase 2: group words into segments, breaking on:
  //   - Speaker change (different Gemini diarization window)
  //   - WhisperX segment boundary (natural pause in speech)
  // This preserves the readable sentence-level chunking that WhisperX
  // detects from pauses, while still assigning the correct speaker.
  const result: AlignedSegment[] = [];
  let groupStart = 0;

  for (let i = 1; i <= words.length; i++) {
    const isEnd = i === words.length;
    const speakerChanged = !isEnd && wordSpeakers[i] !== wordSpeakers[groupStart];
    const segmentBoundary = !isEnd && words[i].segmentBreak === true;

    if (isEnd || speakerChanged || segmentBoundary) {
      const groupWords = words.slice(groupStart, i);
      result.push({
        speakerId: wordSpeakers[groupStart],
        text: groupWords.map((w) => w.word).join(' '),
        startMs: groupWords[0].start * 1000,
        endMs: groupWords[groupWords.length - 1].end * 1000,
      });
      groupStart = i;
    }
  }

  return result;
}
