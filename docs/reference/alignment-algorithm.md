# HARDY: Hierarchical Anchored Resilient Dynamic Alignment

## Overview

HARDY is a robust timestamp alignment algorithm designed to map Gemini transcript segments to precise WhisperX word-level timestamps. It addresses the fundamental limitation of sequential matching approaches by using hierarchical, anchor-based alignment with cascade failure prevention.

## Problem Statement

### Input
1. **Gemini Segments**: Speaker-aware transcript with approximate timestamps
   - High semantic accuracy
   - Speaker diarization
   - Temporally imprecise (can drift significantly)

2. **WhisperX Words**: Word-level timestamps from forced alignment
   - Precise timing (typically within 50ms)
   - May differ from Gemini's text (different word choices, punctuation, filler words)
   - No speaker information

### Challenge
The transcriptions from Gemini and WhisperX often differ:
- Different word choices ("gonna" vs "going to")
- Punctuation variations
- Filler word handling ("um", "uh")
- Compound word splitting
- Contractions

A naive sequential matching approach fails catastrophically: once a match is missed, all subsequent segments are aligned to wrong positions.

## Algorithm Architecture

### Level 1: Anchor Point Identification

Anchors are high-confidence reference points that divide the transcript into independent regions.

**Anchor Types (in priority order):**

1. **High-Confidence Text Matches** (>90% similarity)
   - Unique phrases that appear exactly in both transcripts
   - Beginning of sentences after pauses
   - Proper nouns, numbers, technical terms

2. **Temporal Anchors**
   - Use Gemini timestamps as soft constraints
   - Create time windows (±15% of segment duration)

3. **Silence/Pause Boundaries** (future enhancement)
   - Natural speech boundaries from audio analysis
   - Speaker change points

**Anchor Selection Criteria:**
```python
def is_valid_anchor(match):
    return (
        match.similarity >= 0.90 and
        match.is_unique_in_window and
        match.temporal_proximity <= 0.15 * segment_duration
    )
```

### Level 2: Region Segmentation

Divide the transcript into independent regions between anchors:

```
[Anchor 1] ---- Region A ---- [Anchor 2] ---- Region B ---- [Anchor 3]
```

**Benefits:**
- Cascade failure prevention: errors in Region A don't affect Region B
- Parallel processing: regions can be aligned concurrently
- Graceful degradation: failed regions fall back to original timestamps

### Level 3: Regional Alignment

Within each region, use a modified Dynamic Time Warping (DTW) approach:

**3.1 Scoring Function**
```python
def compute_similarity(gemini_text, whisperx_words):
    """Multi-factor similarity scoring"""

    # Normalize texts
    g_normalized = normalize(gemini_text)  # lowercase, remove punctuation
    w_normalized = normalize(' '.join(whisperx_words))

    # Score 1: Token-based fuzzy matching
    token_score = fuzz.token_set_ratio(g_normalized, w_normalized) / 100

    # Score 2: N-gram overlap (handles word boundary differences)
    ngram_score = compute_ngram_overlap(g_normalized, w_normalized, n=3)

    # Score 3: Sequence matcher ratio (handles insertions/deletions)
    seq_score = SequenceMatcher(None, g_normalized, w_normalized).ratio()

    # Weighted combination
    return 0.4 * token_score + 0.3 * ngram_score + 0.3 * seq_score
```

**3.2 Search Strategy**

For each Gemini segment within a region:
1. Define search window based on temporal hints
2. Score all candidate word spans
3. Select best match above confidence threshold
4. Update search position for next segment

```python
def align_region(segments, words, start_hint, end_hint):
    """Align segments within a bounded region"""

    aligned = []
    current_word_idx = 0

    for segment in segments:
        # Time-bounded search window
        time_window = compute_time_window(
            segment.start_ms,
            segment.end_ms,
            start_hint,
            end_hint,
            expansion_factor=0.20  # 20% flexibility
        )

        # Find best matching word span
        best_match = find_best_span(
            segment.text,
            words,
            search_start=max(current_word_idx - 10, time_window.word_start),
            search_end=time_window.word_end,
            expected_word_count=len(segment.text.split())
        )

        if best_match.confidence >= MIN_CONFIDENCE:
            aligned.append(AlignedSegment(
                segment=segment,
                start_ms=best_match.start_ms,
                end_ms=best_match.end_ms,
                confidence=best_match.confidence
            ))
            current_word_idx = best_match.end_word_idx
        else:
            # Fallback: interpolate or use original
            aligned.append(fallback_alignment(segment, words, current_word_idx))

    return aligned
```

**3.3 Multi-Window Search**

Search multiple window sizes to handle transcription length differences:

```python
window_sizes = [
    word_count,      # Exact match
    word_count - 1,  # Slightly shorter
    word_count + 1,  # Slightly longer
    word_count - 2,
    word_count + 2,
    int(word_count * 0.8),  # Significant variation
    int(word_count * 1.2),
]
```

### Level 4: Validation and Quality Control

**4.1 Monotonicity Check**
Timestamps must increase (with small overlap tolerance):
```python
def validate_monotonicity(segments, max_overlap_ms=500):
    for i in range(1, len(segments)):
        if segments[i].start_ms < segments[i-1].end_ms - max_overlap_ms:
            return False, i
    return True, -1
```

**4.2 Duration Sanity Check**
Segment durations should be reasonable:
```python
def validate_durations(segments):
    for seg in segments:
        duration = seg.end_ms - seg.start_ms
        words = len(seg.text.split())
        ms_per_word = duration / max(words, 1)

        # Typical speech: 100-300ms per word
        if not (50 <= ms_per_word <= 500):
            return False, seg
    return True, None
```

**4.3 Confidence Threshold**
Reject low-confidence alignments:
```python
MIN_REGION_CONFIDENCE = 0.65  # Average confidence for region
MIN_SEGMENT_CONFIDENCE = 0.50  # Per-segment minimum
```

### Level 5: Fallback Strategies

When alignment fails, gracefully degrade:

**Strategy 1: Interpolation**
If surrounding segments are aligned, interpolate timestamps:
```python
def interpolate_timestamp(prev_aligned, next_aligned, segment_index, total_segments):
    progress = segment_index / total_segments
    return prev_aligned.end_ms + progress * (next_aligned.start_ms - prev_aligned.end_ms)
```

**Strategy 2: Proportional Scaling**
Scale original timestamps within the region:
```python
def scale_timestamps(segments, region_start_ms, region_end_ms):
    original_start = segments[0].start_ms
    original_end = segments[-1].end_ms
    original_duration = original_end - original_start
    new_duration = region_end_ms - region_start_ms

    for seg in segments:
        progress = (seg.start_ms - original_start) / original_duration
        seg.start_ms = region_start_ms + progress * new_duration
        # Similarly for end_ms
```

**Strategy 3: Original Timestamps**
Last resort - keep Gemini's timestamps if they're within the audio bounds.

## Configuration Parameters

```python
# Anchor detection
ANCHOR_MIN_CONFIDENCE = 0.90
ANCHOR_MIN_WORDS = 3
ANCHOR_MAX_WORDS = 10

# Search window
TIME_WINDOW_EXPANSION = 0.20  # 20% expansion from hint
MIN_SEARCH_WORDS = 20
MAX_SEARCH_WORDS = 100

# Matching thresholds
MIN_SEGMENT_CONFIDENCE = 0.50
MIN_REGION_CONFIDENCE = 0.65
MIN_OVERALL_CONFIDENCE = 0.70

# Validation
MAX_OVERLAP_MS = 500
MIN_MS_PER_WORD = 50
MAX_MS_PER_WORD = 500
```

## Performance Characteristics

**Time Complexity:** O(S × W × K) where:
- S = number of segments
- W = average words per search window
- K = number of window sizes tried

**Space Complexity:** O(W) for the scoring matrix

**Typical Performance:**
- 10-minute audio (~200 segments): 1-2 seconds
- 60-minute audio (~1200 segments): 5-10 seconds

## Future Enhancements

1. **Phonetic Matching**: Convert to phoneme sequences for better matching
2. **VAD Integration**: Use voice activity detection for anchor points
3. **Speaker Consistency**: Validate speaker labels against diarization
4. **Multi-ASR Consensus**: Combine multiple transcription sources
5. **Adaptive Thresholds**: Learn optimal parameters per audio type

## References

- Dynamic Time Warping: Sakoe & Chiba (1978)
- Fuzzy String Matching: FuzzyWuzzy library
- Sequence Alignment: Needleman-Wunsch, Smith-Waterman algorithms
- WhisperX: Bain et al. (2023) - Word-level timestamps via forced alignment
