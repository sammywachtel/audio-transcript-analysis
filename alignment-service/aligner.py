"""
Alignment logic for matching Gemini segments to WhisperX word-level timestamps.

The magic happens in two steps:
1. Call Replicate's WhisperX model to get word-level timestamps
2. Fuzzy-match each Gemini segment to the corresponding word sequence

This gives us Gemini's excellent content extraction (terms, topics, speakers)
combined with WhisperX's precise timing from forced alignment.
"""

import base64
import os
import re
import tempfile
from dataclasses import dataclass
from typing import Any, Dict, List

import replicate
from fuzzywuzzy import fuzz

# WhisperX model on Replicate - provides word-level timestamps via forced alignment
WHISPERX_MODEL = "victor-upmeet/whisperx:84d2ad2d6194fe98a17d2b60bef1c7f910c46b2f6fd38996ca457afd9c8abfcb"  # noqa: E501 pragma: allowlist secret


@dataclass
class Word:
    """A single word with timestamp from WhisperX."""

    word: str
    start: float  # seconds
    end: float  # seconds


@dataclass
class Segment:
    """Input segment from Gemini (timestamps may be inaccurate)."""

    speaker_id: str
    text: str
    start_ms: int
    end_ms: int


@dataclass
class AlignedSegment:
    """Output segment with corrected timestamps."""

    speaker_id: str
    text: str
    start_ms: int
    end_ms: int
    confidence: float  # 0-1, how well we matched


class AlignmentError(Exception):
    """Raised when alignment fails."""

    pass


def normalize_text(text: str) -> str:
    """
    Normalize text for fuzzy matching.
    Lowercase, remove punctuation, collapse whitespace.
    """
    text = text.lower()
    text = re.sub(r"[^\w\s]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def find_best_word_span(
    segment_text: str, words: List[Word], start_hint_idx: int = 0
) -> tuple[int, int, float]:
    """
    Find the best matching span of words for a segment's text.

    Uses a sliding window with fuzzy matching to find where in the
    word sequence this segment's text best fits.

    Returns (start_idx, end_idx, confidence) where indices are into words list.
    """
    norm_segment = normalize_text(segment_text)
    segment_words = norm_segment.split()
    segment_word_count = len(segment_words)

    if segment_word_count == 0:
        return (start_hint_idx, start_hint_idx, 0.0)

    best_score = 0
    best_start = start_hint_idx
    best_end = start_hint_idx

    # Search window: start from hint, look forward with some buffer
    search_start = max(0, start_hint_idx - 10)
    search_end = min(len(words), start_hint_idx + segment_word_count * 3 + 50)

    # Slide a window of approximately segment_word_count words
    window_sizes = [
        segment_word_count,
        segment_word_count - 1,
        segment_word_count + 1,
        segment_word_count - 2,
        segment_word_count + 2,
    ]

    for window_size in window_sizes:
        if window_size <= 0:
            continue

        for i in range(search_start, search_end - window_size + 1):
            window_words = [normalize_text(w.word) for w in words[i : i + window_size]]
            window_text = " ".join(window_words)

            # Use token_sort_ratio for word order flexibility
            score = fuzz.token_sort_ratio(norm_segment, window_text)

            if score > best_score:
                best_score = score
                best_start = i
                best_end = i + window_size

    confidence = best_score / 100.0
    return (best_start, best_end, confidence)


async def get_whisperx_timestamps(audio_base64: str) -> List[Word]:
    """
    Call Replicate's WhisperX model to get word-level timestamps.

    Uses victor-upmeet/whisperx which provides word-level timestamps
    and speaker diarization.
    """
    api_token = os.environ.get("REPLICATE_API_TOKEN")
    if not api_token:
        raise AlignmentError("REPLICATE_API_TOKEN environment variable not set")

    # Decode base64 to get audio bytes
    audio_bytes = base64.b64decode(audio_base64)

    # Write to temp file (Replicate needs a file or URL)
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        f.write(audio_bytes)
        temp_path = f.name

    try:
        # Call WhisperX via Replicate
        # Using victor-upmeet/whisperx for word-level timestamps
        client = replicate.Client(api_token=api_token)

        with open(temp_path, "rb") as audio_file:
            output = client.run(
                WHISPERX_MODEL,
                input={
                    "audio": audio_file,
                    "align_output": True,  # Get word-level alignment
                    "batch_size": 16,
                    "language": "en",  # Can make this configurable
                },
            )

        # Parse the output to extract words with timestamps
        words = []

        # WhisperX returns segments with word-level timestamps
        if isinstance(output, dict) and "segments" in output:
            for segment in output["segments"]:
                if "words" in segment:
                    for w in segment["words"]:
                        words.append(
                            Word(
                                word=w.get("word", ""),
                                start=w.get("start", 0.0),
                                end=w.get("end", 0.0),
                            )
                        )

        if not words:
            raise AlignmentError("WhisperX returned no words - check audio format")

        return words

    finally:
        # Clean up temp file
        os.unlink(temp_path)


def align_segments(segments: List[Segment], words: List[Word]) -> List[AlignedSegment]:
    """
    Align Gemini segments to WhisperX word-level timestamps.

    For each segment, finds the best matching word span and uses
    those timestamps. Maintains segment order and text.
    """
    aligned = []
    current_word_idx = 0

    for seg in segments:
        # Find best matching word span
        start_idx, end_idx, confidence = find_best_word_span(
            seg.text, words, current_word_idx
        )

        # Get timestamps from matched words
        if start_idx < len(words) and end_idx > start_idx:
            start_word = words[start_idx]
            end_word = words[min(end_idx - 1, len(words) - 1)]

            aligned.append(
                AlignedSegment(
                    speaker_id=seg.speaker_id,
                    text=seg.text,  # Keep original Gemini text
                    start_ms=int(start_word.start * 1000),
                    end_ms=int(end_word.end * 1000),
                    confidence=confidence,
                )
            )

            # Move hint forward for next segment
            current_word_idx = end_idx
        else:
            # Fallback: keep original timestamps if no match
            aligned.append(
                AlignedSegment(
                    speaker_id=seg.speaker_id,
                    text=seg.text,
                    start_ms=seg.start_ms,
                    end_ms=seg.end_ms,
                    confidence=0.0,
                )
            )

    return aligned


async def align_transcript(
    audio_base64: str, segments: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    Main entry point: align a Gemini transcript to accurate timestamps.

    Args:
        audio_base64: Base64-encoded audio file
        segments: List of segment dicts with speakerId, text, startMs, endMs

    Returns:
        List of segment dicts with corrected timestamps and confidence scores
    """
    # Parse input segments
    input_segments = [
        Segment(
            speaker_id=s["speakerId"],
            text=s["text"],
            start_ms=s["startMs"],
            end_ms=s["endMs"],
        )
        for s in segments
    ]

    # Get word-level timestamps from WhisperX
    words = await get_whisperx_timestamps(audio_base64)

    # Align segments to words
    aligned = align_segments(input_segments, words)

    # Convert back to dicts
    return [
        {
            "speakerId": s.speaker_id,
            "text": s.text,
            "startMs": s.start_ms,
            "endMs": s.end_ms,
            "confidence": s.confidence,
        }
        for s in aligned
    ]
