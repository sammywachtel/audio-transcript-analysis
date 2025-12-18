"""
HARDY: Hierarchical Anchored Resilient Dynamic Alignment

A robust timestamp alignment algorithm that maps Gemini transcript segments
to precise WhisperX word-level timestamps. Uses hierarchical anchor-based
alignment with cascade failure prevention.

Architecture:
    Level 1: Anchor Point Identification (high-confidence matches)
    Level 2: Region Segmentation (divide transcript at anchors)
    Level 3: Regional Alignment (independent DTW-style matching)
    Level 4: Validation & Fallback (quality gates, graceful degradation)
"""

import base64
import logging
import os
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional

import replicate
from fuzzywuzzy import fuzz

# Configure logging
logger = logging.getLogger(__name__)

# WhisperX model on Replicate - provides word-level timestamps via forced alignment
WHISPERX_MODEL = "victor-upmeet/whisperx:84d2ad2d6194fe98a17d2b60bef1c7f910c46b2f6fd38996ca457afd9c8abfcb"  # noqa: E501 pragma: allowlist secret

# =============================================================================
# Configuration
# =============================================================================

# Anchor detection thresholds
ANCHOR_MIN_CONFIDENCE = 0.75  # Minimum similarity for anchor points (lowered from 0.85)
ANCHOR_MIN_WORDS = 2  # Minimum words for an anchor (lowered from 3)
ANCHOR_MAX_WORDS = 20  # Maximum words for an anchor (raised from 15)

# Search window configuration - FIXED: use absolute values, not percentages
TIME_WINDOW_SECONDS = 30  # Search ±30 seconds around time hint
MIN_SEARCH_BUFFER = 50  # Minimum words to search around hint (raised from 30)

# Matching thresholds
MIN_SEGMENT_CONFIDENCE = 0.40  # Per-segment minimum to accept (lowered from 0.45)
MIN_REGION_CONFIDENCE = 0.50  # Average confidence for a region (lowered from 0.55)

# Validation
MAX_OVERLAP_MS = 2000  # Max overlap between consecutive segments (raised from 1000)
MIN_MS_PER_WORD = 20  # Minimum milliseconds per word (lowered from 30)
MAX_MS_PER_WORD = 800  # Maximum milliseconds per word (raised from 600)


# =============================================================================
# Data Classes
# =============================================================================


@dataclass
class Word:
    """A single word with timestamp from WhisperX."""

    word: str
    start: float  # seconds
    end: float  # seconds
    index: int = 0  # Position in word list


@dataclass
class Segment:
    """Input segment from Gemini (timestamps may be inaccurate)."""

    speaker_id: str
    text: str
    start_ms: int
    end_ms: int
    index: int = 0  # Position in segment list


@dataclass
class AlignedSegment:
    """Output segment with corrected timestamps."""

    speaker_id: str
    text: str
    start_ms: int
    end_ms: int
    confidence: float  # 0-1, how well we matched
    method: str = "aligned"  # aligned, interpolated, original


@dataclass
class Anchor:
    """A high-confidence reference point between transcripts."""

    segment_idx: int
    word_start_idx: int
    word_end_idx: int
    confidence: float
    start_ms: int
    end_ms: int


@dataclass
class Region:
    """A region of segments between anchor points."""

    segments: List[Segment]
    start_segment_idx: int
    end_segment_idx: int
    word_start_idx: int
    word_end_idx: int
    time_start_ms: int
    time_end_ms: int


@dataclass
class MatchResult:
    """Result of matching a segment to word span."""

    start_idx: int
    end_idx: int
    start_ms: int
    end_ms: int
    confidence: float
    method: str = "matched"


class AlignmentError(Exception):
    """Raised when alignment fails."""

    pass


# =============================================================================
# Text Normalization
# =============================================================================


def normalize_text(text: str) -> str:
    """
    Normalize text for fuzzy matching.
    Lowercase, remove punctuation, collapse whitespace.
    """
    text = text.lower()
    text = re.sub(r"[^\w\s]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def get_ngrams(text: str, n: int = 3) -> set:
    """Extract character n-grams from text."""
    text = normalize_text(text)
    if len(text) < n:
        return {text}
    return {text[i : i + n] for i in range(len(text) - n + 1)}


def ngram_similarity(text1: str, text2: str, n: int = 3) -> float:
    """Compute n-gram based similarity between two texts."""
    ngrams1 = get_ngrams(text1, n)
    ngrams2 = get_ngrams(text2, n)
    if not ngrams1 or not ngrams2:
        return 0.0
    intersection = len(ngrams1 & ngrams2)
    union = len(ngrams1 | ngrams2)
    return intersection / union if union > 0 else 0.0


# =============================================================================
# Multi-Factor Similarity Scoring
# =============================================================================


def compute_similarity(gemini_text: str, whisperx_text: str) -> float:
    """
    Multi-factor similarity scoring for robust matching.

    Combines:
    - Token set ratio (handles word order, extra words)
    - Token sort ratio (handles reordering)
    - Sequence matcher (handles insertions/deletions)
    - N-gram overlap (handles word boundary differences)
    """
    g_norm = normalize_text(gemini_text)
    w_norm = normalize_text(whisperx_text)

    if not g_norm or not w_norm:
        return 0.0

    # Score 1: Token set ratio - ignores duplicates and order
    token_set = fuzz.token_set_ratio(g_norm, w_norm) / 100.0

    # Score 2: Token sort ratio - sorts tokens before comparing
    token_sort = fuzz.token_sort_ratio(g_norm, w_norm) / 100.0

    # Score 3: Partial ratio - finds best partial match
    partial = fuzz.partial_ratio(g_norm, w_norm) / 100.0

    # Score 4: Sequence matcher - handles insertions/deletions
    seq_match = SequenceMatcher(None, g_norm, w_norm).ratio()

    # Score 5: N-gram similarity - handles word boundary issues
    ngram = ngram_similarity(g_norm, w_norm, n=3)

    # Weighted combination - emphasize token-based for speech
    return (
        0.30 * token_set
        + 0.25 * token_sort
        + 0.20 * partial
        + 0.15 * seq_match
        + 0.10 * ngram
    )


# =============================================================================
# Level 1: Anchor Point Identification
# =============================================================================


def find_anchors(
    segments: List[Segment], words: List[Word], audio_duration_ms: int
) -> List[Anchor]:
    """
    Identify high-confidence anchor points between Gemini segments and WhisperX.

    Strategy:
    1. For each segment, compute time-bounded search window
    2. Find best match within that window
    3. Keep only high-confidence matches as anchors
    4. Ensure anchors are well-distributed (not clustered)
    """
    anchors = []
    last_anchor_word_idx = 0

    for seg_idx, segment in enumerate(segments):
        # Skip very short segments - not reliable anchors
        word_count = len(segment.text.split())
        if word_count < ANCHOR_MIN_WORDS or word_count > ANCHOR_MAX_WORDS:
            continue

        # Compute time-bounded search window using FIXED window size
        time_hint_start = segment.start_ms
        time_hint_end = segment.end_ms

        # FIXED: Use absolute time window, not percentage of time
        # This was causing wrong windows (at 10min mark, ±20% = ±2min which is insane)
        window_expansion_ms = TIME_WINDOW_SECONDS * 1000
        window_start_ms = max(0, time_hint_start - window_expansion_ms)
        window_end_ms = min(audio_duration_ms, time_hint_end + window_expansion_ms)

        # Convert time window to word indices
        word_start_idx = find_word_at_time(words, window_start_ms / 1000.0)
        word_end_idx = find_word_at_time(words, window_end_ms / 1000.0)

        # Ensure we search forward from last anchor
        word_start_idx = max(word_start_idx, last_anchor_word_idx)

        # Ensure minimum search range
        if word_end_idx - word_start_idx < word_count + 10:
            word_end_idx = min(len(words), word_start_idx + word_count + 20)

        # Search for best match
        match = find_best_match(
            segment.text,
            words,
            word_start_idx,
            word_end_idx,
            expected_word_count=word_count,
        )

        if match and match.confidence >= ANCHOR_MIN_CONFIDENCE:
            anchor = Anchor(
                segment_idx=seg_idx,
                word_start_idx=match.start_idx,
                word_end_idx=match.end_idx,
                confidence=match.confidence,
                start_ms=match.start_ms,
                end_ms=match.end_ms,
            )
            anchors.append(anchor)
            last_anchor_word_idx = match.end_idx

            logger.debug(
                f"Anchor found: segment {seg_idx} -> words {match.start_idx}-"
                f"{match.end_idx} (conf={match.confidence:.2f})"
            )

    logger.info(
        f"Found {len(anchors)} anchors from {len(segments)} segments "
        f"(anchor rate: {len(anchors)/len(segments)*100:.1f}%)"
    )

    # Log anchor distribution
    if anchors:
        anchor_indices = [a.segment_idx for a in anchors]
        anchor_times = [a.start_ms / 1000 for a in anchors]
        ellipsis = "..." if len(anchors) > 10 else ""
        logger.info(f"Anchor segment indices: {anchor_indices[:10]}{ellipsis}")
        times_fmt = [f"{t:.1f}" for t in anchor_times[:10]]
        logger.info(f"Anchor times (s): {times_fmt}{ellipsis}")

        # Warn if anchors are all clustered at the beginning
        if anchors and anchor_indices[-1] < len(segments) * 0.3:
            logger.warning(
                f"Anchors clustered in first 30% of transcript! "
                f"Last anchor at segment {anchor_indices[-1]}/{len(segments)}"
            )

    return anchors


def find_word_at_time(words: List[Word], time_sec: float) -> int:
    """Find the word index closest to a given time."""
    if not words:
        return 0
    for i, word in enumerate(words):
        if word.start >= time_sec:
            return max(0, i - 1)
    return len(words) - 1


# =============================================================================
# Level 2: Region Segmentation
# =============================================================================


def segment_into_regions(
    segments: List[Segment], words: List[Word], anchors: List[Anchor]
) -> List[Region]:
    """
    Divide transcript into independent regions between anchor points.

    Each region can be aligned independently, preventing cascade failures.
    """
    if not anchors:
        # No anchors - treat entire transcript as one region
        return [
            Region(
                segments=segments,
                start_segment_idx=0,
                end_segment_idx=len(segments) - 1,
                word_start_idx=0,
                word_end_idx=len(words) - 1,
                time_start_ms=0,
                time_end_ms=int(words[-1].end * 1000) if words else 0,
            )
        ]

    regions = []

    # Region before first anchor
    if anchors[0].segment_idx > 0:
        regions.append(
            Region(
                segments=segments[: anchors[0].segment_idx],
                start_segment_idx=0,
                end_segment_idx=anchors[0].segment_idx - 1,
                word_start_idx=0,
                word_end_idx=anchors[0].word_start_idx,
                time_start_ms=0,
                time_end_ms=anchors[0].start_ms,
            )
        )

    # Regions between anchors
    for i in range(len(anchors) - 1):
        curr_anchor = anchors[i]
        next_anchor = anchors[i + 1]

        if next_anchor.segment_idx > curr_anchor.segment_idx + 1:
            regions.append(
                Region(
                    segments=segments[
                        curr_anchor.segment_idx + 1 : next_anchor.segment_idx
                    ],
                    start_segment_idx=curr_anchor.segment_idx + 1,
                    end_segment_idx=next_anchor.segment_idx - 1,
                    word_start_idx=curr_anchor.word_end_idx,
                    word_end_idx=next_anchor.word_start_idx,
                    time_start_ms=curr_anchor.end_ms,
                    time_end_ms=next_anchor.start_ms,
                )
            )

    # Region after last anchor
    if anchors[-1].segment_idx < len(segments) - 1:
        regions.append(
            Region(
                segments=segments[anchors[-1].segment_idx + 1 :],
                start_segment_idx=anchors[-1].segment_idx + 1,
                end_segment_idx=len(segments) - 1,
                word_start_idx=anchors[-1].word_end_idx,
                word_end_idx=len(words) - 1,
                time_start_ms=anchors[-1].end_ms,
                time_end_ms=int(words[-1].end * 1000) if words else 0,
            )
        )

    logger.info(f"Created {len(regions)} regions from {len(anchors)} anchors")

    # Log region details for debugging
    for i, region in enumerate(regions):
        logger.info(
            f"Region {i}: segments {region.start_segment_idx}-{region.end_segment_idx} "
            f"({len(region.segments)} segs), "
            f"words {region.word_start_idx}-{region.word_end_idx}, "
            f"time {region.time_start_ms/1000:.1f}s-{region.time_end_ms/1000:.1f}s"
        )

    return regions


# =============================================================================
# Level 3: Regional Alignment
# =============================================================================


def find_best_match(
    text: str,
    words: List[Word],
    search_start: int,
    search_end: int,
    expected_word_count: int,
) -> Optional[MatchResult]:
    """
    Find the best matching word span for a text segment.

    OPTIMIZED: Uses coarse-to-fine search with early exit for high-confidence matches.
    """
    if search_start >= search_end or search_start >= len(words):
        return None

    search_end = min(search_end, len(words))
    norm_text = normalize_text(text)

    if not norm_text:
        return None

    best_match: Optional[MatchResult] = None
    best_score = 0.0

    # Window sizes to try - balanced between accuracy and speed
    # Using 6 sizes (down from original 9, but more than aggressive 5)
    window_sizes = sorted(
        set(
            [
                expected_word_count,
                max(1, expected_word_count - 1),
                expected_word_count + 1,
                max(1, expected_word_count - 2),
                expected_word_count + 2,
                max(1, int(expected_word_count * 0.7)),
            ]
        )
    )

    # Early exit threshold - stop on excellent match
    EARLY_EXIT_THRESHOLD = 0.95

    for window_size in window_sizes:
        if window_size <= 0:
            continue

        for i in range(search_start, search_end - window_size + 1):
            window_words = words[i : i + window_size]
            window_text = " ".join(w.word for w in window_words)

            # Quick pre-filter - only skip very bad matches
            quick_score = fuzz.partial_ratio(norm_text, normalize_text(window_text))
            if quick_score < 35:  # Very permissive threshold
                continue

            score = compute_similarity(text, window_text)

            if score > best_score:
                best_score = score
                best_match = MatchResult(
                    start_idx=i,
                    end_idx=i + window_size,
                    start_ms=int(window_words[0].start * 1000),
                    end_ms=int(window_words[-1].end * 1000),
                    confidence=score,
                )

                # Early exit on excellent match
                if score >= EARLY_EXIT_THRESHOLD:
                    return best_match

    return best_match


def align_region(
    region: Region, words: List[Word], all_segments: List[Segment]
) -> List[AlignedSegment]:
    """
    Align all segments within a region independently.

    Uses time hints from Gemini and region boundaries as constraints.
    """
    if not region.segments:
        return []

    aligned = []
    current_word_idx = region.word_start_idx

    # Calculate time budget per segment for interpolation fallback
    region_duration = region.time_end_ms - region.time_start_ms
    segment_count = len(region.segments)

    matched_count = 0
    interpolated_count = 0

    for i, segment in enumerate(region.segments):
        expected_words = len(segment.text.split())

        # Define search window within region bounds
        search_start = max(region.word_start_idx, current_word_idx - 5)
        search_end = min(
            region.word_end_idx + 1,
            current_word_idx + expected_words * 3 + MIN_SEARCH_BUFFER,
        )

        # Find best match
        match = find_best_match(
            segment.text,
            words,
            search_start,
            search_end,
            expected_word_count=expected_words,
        )

        if match and match.confidence >= MIN_SEGMENT_CONFIDENCE:
            aligned.append(
                AlignedSegment(
                    speaker_id=segment.speaker_id,
                    text=segment.text,
                    start_ms=match.start_ms,
                    end_ms=match.end_ms,
                    confidence=match.confidence,
                    method="aligned",
                )
            )
            current_word_idx = match.end_idx
            matched_count += 1
        else:
            # Fallback: interpolate evenly within region bounds
            # DON'T use original Gemini durations - they're broken!
            # Instead, distribute segments proportionally by word count
            total_words_in_region = sum(len(s.text.split()) for s in region.segments)
            words_before = sum(len(region.segments[j].text.split()) for j in range(i))
            segment_words = len(segment.text.split())

            # Calculate start/end based on word proportion within region
            if total_words_in_region > 0:
                start_ratio = words_before / total_words_in_region
                end_ratio = (words_before + segment_words) / total_words_in_region
            else:
                start_ratio = i / max(segment_count, 1)
                end_ratio = (i + 1) / max(segment_count, 1)

            interp_start = region.time_start_ms + int(start_ratio * region_duration)
            interp_end = region.time_start_ms + int(end_ratio * region_duration)

            # Ensure we stay within region bounds
            interp_end = min(interp_end, region.time_end_ms)
            interp_start = min(interp_start, interp_end - 50)  # Min 50ms duration

            aligned.append(
                AlignedSegment(
                    speaker_id=segment.speaker_id,
                    text=segment.text,
                    start_ms=interp_start,
                    end_ms=interp_end,
                    confidence=match.confidence if match else 0.0,
                    method="interpolated",
                )
            )
            interpolated_count += 1

    # Log region alignment results
    if segment_count > 0:
        logger.info(
            f"Region {region.start_segment_idx}-{region.end_segment_idx}: "
            f"matched={matched_count}/{segment_count} "
            f"({matched_count/segment_count*100:.0f}%), "
            f"interpolated={interpolated_count}"
        )

    return aligned


# =============================================================================
# Level 4: Validation and Fallback
# =============================================================================


def validate_and_fix_alignment(
    aligned: List[AlignedSegment],
    original_segments: List[Segment],
    audio_duration_ms: int = 0,
) -> List[AlignedSegment]:
    """
    Validate aligned segments and fix issues.

    Checks:
    1. Temporal monotonicity (times must increase)
    2. Duration sanity (reasonable ms per word)
    3. No gaps larger than reasonable
    4. No timestamps exceeding audio duration (THE CLOUD BUG)
    """
    if not aligned:
        return aligned

    fixed = []

    for i, seg in enumerate(aligned):
        # Fix monotonicity issues
        if i > 0 and seg.start_ms < fixed[-1].end_ms - MAX_OVERLAP_MS:
            # Segment starts too early - push it forward
            new_start = fixed[-1].end_ms
            duration = seg.end_ms - seg.start_ms
            seg = AlignedSegment(
                speaker_id=seg.speaker_id,
                text=seg.text,
                start_ms=new_start,
                end_ms=new_start + duration,
                confidence=seg.confidence * 0.9,  # Penalize confidence
                method=seg.method + "_fixed",
            )

        # Validate duration sanity
        duration = seg.end_ms - seg.start_ms
        word_count = max(len(seg.text.split()), 1)
        ms_per_word = duration / word_count

        if ms_per_word < MIN_MS_PER_WORD or ms_per_word > MAX_MS_PER_WORD:
            # Duration is unreasonable - estimate based on word count
            # DO NOT use original timestamps - they're the broken ones we're fixing!
            # Use average speech rate of ~150ms per word
            estimated_duration = word_count * 150
            if i > 0:
                new_start = fixed[-1].end_ms + 50  # Small gap after previous
            else:
                new_start = seg.start_ms  # Keep start if first segment

            logger.warning(
                f"Duration fallback for segment {i}: "
                f"ms_per_word={ms_per_word:.0f} out of range "
                f"[{MIN_MS_PER_WORD}-{MAX_MS_PER_WORD}], "
                f"estimated {estimated_duration}ms"
            )

            seg = AlignedSegment(
                speaker_id=seg.speaker_id,
                text=seg.text,
                start_ms=new_start,
                end_ms=new_start + estimated_duration,
                confidence=0.3,  # Low confidence for fallback
                method="duration_fallback",
            )

        fixed.append(seg)

    # === CRITICAL FIX: Cap timestamps at audio duration ===
    # This prevents the cloud bug where alignment produces timestamps
    # longer than the actual audio (e.g., 690s timestamps for 596s audio)
    if audio_duration_ms > 0 and fixed:
        last_end = fixed[-1].end_ms
        if last_end > audio_duration_ms:
            overflow_ms = last_end - audio_duration_ms
            logger.warning(
                f"Timestamps exceed audio duration by {overflow_ms}ms "
                f"({overflow_ms/1000:.1f}s). Applying proportional scaling."
            )

            # Find where timestamps start exceeding duration
            # Scale all segments proportionally to fit within audio
            scale_factor = audio_duration_ms / last_end
            logger.info(f"Scaling all timestamps by {scale_factor:.4f}")

            fixed = [
                AlignedSegment(
                    speaker_id=seg.speaker_id,
                    text=seg.text,
                    start_ms=int(seg.start_ms * scale_factor),
                    end_ms=int(seg.end_ms * scale_factor),
                    confidence=seg.confidence * 0.8,  # Penalize for needing scaling
                    method=(
                        seg.method + "_scaled"
                        if "_scaled" not in seg.method
                        else seg.method
                    ),
                )
                for seg in fixed
            ]

            # Final sanity check - ensure last segment doesn't exceed duration
            if fixed[-1].end_ms > audio_duration_ms:
                fixed[-1] = AlignedSegment(
                    speaker_id=fixed[-1].speaker_id,
                    text=fixed[-1].text,
                    start_ms=fixed[-1].start_ms,
                    end_ms=audio_duration_ms,
                    confidence=fixed[-1].confidence,
                    method=fixed[-1].method,
                )

    return fixed


def compute_region_confidence(aligned: List[AlignedSegment]) -> float:
    """Compute average confidence for a list of aligned segments."""
    if not aligned:
        return 0.0
    return sum(s.confidence for s in aligned) / len(aligned)


# =============================================================================
# Main Alignment Pipeline
# =============================================================================


def align_segments_hardy(
    segments: List[Segment], words: List[Word]
) -> List[AlignedSegment]:
    """
    HARDY alignment algorithm - main entry point.

    Steps:
    1. Find anchor points (high-confidence matches)
    2. Divide into regions between anchors
    3. Align each region independently
    4. Validate and fix issues
    """
    if not segments or not words:
        return []

    audio_duration_ms = int(words[-1].end * 1000) if words else 0

    logger.info(
        f"Starting HARDY alignment: {len(segments)} segments, "
        f"{len(words)} words, {audio_duration_ms}ms audio"
    )

    # Level 1: Find anchor points
    anchors = find_anchors(segments, words, audio_duration_ms)

    # Level 2: Segment into regions
    regions = segment_into_regions(segments, words, anchors)

    # Level 3: Align each region
    aligned_all = [None] * len(segments)  # Pre-allocate for correct ordering

    # First, place anchored segments
    for anchor in anchors:
        aligned_all[anchor.segment_idx] = AlignedSegment(
            speaker_id=segments[anchor.segment_idx].speaker_id,
            text=segments[anchor.segment_idx].text,
            start_ms=anchor.start_ms,
            end_ms=anchor.end_ms,
            confidence=anchor.confidence,
            method="anchor",
        )

    # Then align regions
    for region in regions:
        region_aligned = align_region(region, words, segments)

        for j, aligned_seg in enumerate(region_aligned):
            global_idx = region.start_segment_idx + j
            if aligned_all[global_idx] is None:  # Don't overwrite anchors
                aligned_all[global_idx] = aligned_seg

    # Fill any gaps (shouldn't happen, but safety)
    for i, seg in enumerate(aligned_all):
        if seg is None:
            aligned_all[i] = AlignedSegment(
                speaker_id=segments[i].speaker_id,
                text=segments[i].text,
                start_ms=segments[i].start_ms,
                end_ms=segments[i].end_ms,
                confidence=0.0,
                method="original",
            )

    # Level 4: Validate and fix (now with audio duration to prevent overflow)
    aligned_final = validate_and_fix_alignment(aligned_all, segments, audio_duration_ms)

    # Log statistics
    methods = {}
    for seg in aligned_final:
        methods[seg.method] = methods.get(seg.method, 0) + 1

    avg_confidence = compute_region_confidence(aligned_final)
    logger.info(
        f"HARDY alignment complete: avg_confidence={avg_confidence:.2f}, "
        f"methods={methods}"
    )

    return aligned_final


# =============================================================================
# WhisperX Integration
# =============================================================================


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

    logger.info(f"Calling WhisperX with {len(audio_bytes)} bytes of audio")

    # Use data URI - more reliable than file handles in Docker containers
    # Replicate accepts data URIs in the format: data:audio/mpeg;base64,<data>
    audio_data_uri = f"data:audio/mpeg;base64,{audio_base64}"

    try:
        # Call WhisperX via Replicate
        client = replicate.Client(api_token=api_token)

        output = client.run(
            WHISPERX_MODEL,
            input={
                "audio_file": audio_data_uri,
                "align_output": True,
                "batch_size": 16,
                "language": "en",
            },
        )

        # Parse the output to extract words with timestamps
        words = []
        word_idx = 0

        if isinstance(output, dict) and "segments" in output:
            for segment in output["segments"]:
                if "words" in segment:
                    for w in segment["words"]:
                        words.append(
                            Word(
                                word=w.get("word", ""),
                                start=w.get("start", 0.0),
                                end=w.get("end", 0.0),
                                index=word_idx,
                            )
                        )
                        word_idx += 1

        if not words:
            raise AlignmentError("WhisperX returned no words - check audio format")

        # Diagnostic logging - understand what WhisperX returned
        first_word = words[0] if words else None
        last_word = words[-1] if words else None
        logger.info(
            f"WhisperX returned {len(words)} words spanning "
            f"{first_word.start:.1f}s to {last_word.end:.1f}s "
            f"({last_word.end - first_word.start:.1f}s total)"
        )

        # Log sample words for debugging
        if len(words) > 10:
            sample_words = [w.word for w in words[:5]]
            sample_end = [w.word for w in words[-5:]]
            logger.info(f"First 5 words: {sample_words}")
            logger.info(f"Last 5 words: {sample_end}")

        return words

    except Exception as e:
        logger.error(f"WhisperX API call failed: {e}")
        raise AlignmentError(f"WhisperX API call failed: {e}")


# =============================================================================
# Public API
# =============================================================================


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
            index=i,
        )
        for i, s in enumerate(segments)
    ]

    # Get word-level timestamps from WhisperX
    words = await get_whisperx_timestamps(audio_base64)

    # Run HARDY alignment
    aligned = align_segments_hardy(input_segments, words)

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
