# HARDY Alignment — Technical Reference

**Hierarchical Anchored Resilient Dynamic Alignment**

HARDY bridges Gemini 3 Flash's content (text, speakers, topics) with WhisperX's precise word-level timestamps. Gemini produces excellent transcription but its timestamps drift ~1.6x relative to actual audio time. WhisperX provides ~50ms timestamp accuracy but no speaker diarization. HARDY aligns the two, giving you Gemini's text with WhisperX's timing.

## Algorithm Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        HARDY PIPELINE                           │
│    Hierarchical Anchored Resilient Dynamic Alignment            │
│                                                                 │
│  INPUT: Gemini segments (text + drifted timestamps)             │
│         WhisperX words (precise timestamps, no speakers)        │
│                                                                 │
│  OUTPUT: Aligned segments (Gemini text + WhisperX timestamps)   │
└─────────────────────────────────────────────────────────────────┘

          │
          ▼
┌─────────────────────────────────────────────┐
│  LEVEL 1: ANCHOR POINT IDENTIFICATION       │
│  findAnchors()                              │
│                                             │
│  For each Gemini segment:                   │
│    ├─ < 2 words? → skip (too short)         │
│    ├─ > 20 words? → extract 15-word window  │
│    │   from middle (sub-segment anchoring)  │
│    ├─ First 5 segments → global search      │
│    │   (search ALL WhisperX words)           │
│    └─ Later segments → anchor-based search  │
│        (search ±30s around nearest anchor)  │
│                                             │
│  For each candidate:                        │
│    findBestMatch() → sliding window         │
│      ├─ Try 4 window sizes (exact, ±1, -2) │
│      ├─ fuzz.partial_ratio() pre-filter     │
│      ├─ computeSimilarity() full scoring    │
│      │   ├─ token_set_ratio   (30%)         │
│      │   ├─ token_sort_ratio  (25%)         │
│      │   ├─ partial_ratio     (20%)         │
│      │   ├─ sequenceMatcherRatio (15%)      │
│      │   └─ ngramSimilarity   (10%)         │
│      ├─ Early exit at ≥ 0.95 confidence     │
│      └─ MAX_MATCH_ITERATIONS safety cap     │
│                                             │
│  Accept anchor if confidence ≥ 0.75         │
│                                             │
│  Output: List of anchors                    │
│    { segmentIdx, wordStartIdx, wordEndIdx,  │
│      startMs, endMs, confidence }           │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│  LEVEL 2: REGION SEGMENTATION               │
│  buildRegions()                             │
│                                             │
│  Divide transcript at anchor points:        │
│                                             │
│  Anchor 0 ──── Anchor 1 ──── Anchor 2      │
│     │              │              │         │
│     ▼              ▼              ▼         │
│  [Region 0]    [Region 1]    [Region 2]     │
│  segs 0-3      segs 5-8      segs 10-14    │
│  words 0-200   words 300-500  words 600-900 │
│                                             │
│  Good anchors → many small regions (fast)   │
│  Bad anchors → few huge regions (slow!)     │
│                                             │
│  This is WHERE the PoC vs production        │
│  divergence manifests:                      │
│    PoC: many anchors → small regions → fast │
│    Prod: few anchors → 1000-word regions →  │
│          timeout                            │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│  LEVEL 3: REGIONAL ALIGNMENT                │
│  alignRegion()                              │
│                                             │
│  For each region, independently:            │
│    For each segment in region:              │
│      ├─ Define search window within region  │
│      │   searchStart = currentWordIdx - 5   │
│      │   searchEnd = currentWordIdx +       │
│      │     expectedWords * 3 + 50           │
│      │                                      │
│      ├─ findBestMatch() (same as Level 1)   │
│      │                                      │
│      ├─ If match ≥ 0.40 confidence:         │
│      │   → Use WhisperX timestamps          │
│      │   → method: 'aligned'                │
│      │                                      │
│      └─ Else FALLBACK: interpolate          │
│          → Distribute evenly by word count  │
│          → Within region time bounds        │
│          → method: 'interpolated'           │
│          → confidence: 0.0                  │
│                                             │
│  Output per segment:                        │
│    { speakerId, text, startMs, endMs,       │
│      confidence, method }                   │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│  LEVEL 4: VALIDATION & FALLBACK             │
│  (in alignTimestamps / pipeline.ts)         │
│                                             │
│  Post-processing checks:                    │
│    ├─ Fix overlapping segments              │
│    │   (MAX_OVERLAP_MS = 2000)              │
│    ├─ Fix duration outliers                 │
│    │   (MIN_MS_PER_WORD=20, MAX=800)        │
│    ├─ Compute overall confidence stats      │
│    │   avg, min, max, distribution          │
│    └─ Log alignment quality metrics         │
│                                             │
│  Quality gate (in pipeline.ts):             │
│    ├─ 0 segments aligned → FATAL error      │
│    ├─ avg confidence < threshold → warning  │
│    └─ chunk failure → fall back to scaled   │
│        Gemini timestamps for that chunk     │
└─────────────────────────────────────────────┘
```

## Implementation Call Graph

All functions below live in `functions/src/alignment.ts` unless noted.

| Function                 | Role                                                | Called By                                                  |
| ------------------------ | --------------------------------------------------- | ---------------------------------------------------------- |
| `alignTimestamps()`      | Entry point — calls WhisperX, then runs HARDY       | `pipeline.ts` (orchestrator) / `newPipeline.ts` (emulator) |
| `findAnchors()`          | Level 1 — identifies high-confidence match points   | `alignTimestamps`                                          |
| `findBestMatch()`        | Sliding window search — tries multiple window sizes | `findAnchors`, `alignRegion`                               |
| `computeSimilarity()`    | 5-metric weighted fuzzy scoring                     | `findBestMatch`                                            |
| `normalizeText()`        | Lowercase, strip punctuation, collapse whitespace   | `computeSimilarity`, `findBestMatch`                       |
| `sequenceMatcherRatio()` | Gestalt pattern matching (Python difflib port)      | `computeSimilarity`                                        |
| `findMatchingBlocks()`   | Recursive longest common subsequence                | `sequenceMatcherRatio`                                     |
| `findLongestMatch()`     | Hash-based longest match in substring range         | `findMatchingBlocks`                                       |
| `ngramSimilarity()`      | Character n-gram Jaccard similarity                 | `computeSimilarity`                                        |
| `findNearestAnchor()`    | Find closest anchor to a segment index              | `findAnchors`                                              |
| `findWordAtTime()`       | Binary search for word index at a given time        | `findAnchors`                                              |
| `buildRegions()`         | Level 2 — partition transcript at anchor points     | `alignTimestamps`                                          |
| `alignRegion()`          | Level 3 — align all segments within one region      | `alignTimestamps`                                          |

## Critical Constants

```typescript
const MAX_MATCH_ITERATIONS = 50000; // Safety cap per findBestMatch() call
const GOOD_ENOUGH_THRESHOLD = 0.8; // Early exit — stop searching once we hit this score
```

**`MAX_MATCH_ITERATIONS`** prevents runaway searches. Each `findBestMatch()` call tries sliding windows across a word range. Without this cap, a single segment in a 1000-word region could spin for minutes. With it, the worst case is bounded to a few seconds. The trade-off is that some segments in very large regions may not find their optimal match — but an okay match beats a timeout.

**`GOOD_ENOUGH_THRESHOLD`** is the confidence score at which `findBestMatch()` stops searching additional window sizes. A score of 0.80 means the fuzzy match is strong enough that trying more window sizes won't meaningfully improve it. This dramatically speeds up alignment when the text is a clean match (which it usually is — Gemini and WhisperX are transcribing the same audio).

## The Bottleneck, Visualized

```
                GOOD ANCHORS (PoC)           BAD ANCHORS (production)

Anchors:   A──A──A──A──A──A──A──A     A─────────────────────────A
           │  │  │  │  │  │  │  │     │                         │
Regions:   R0 R1 R2 R3 R4 R5 R6 R7    R0 (1000+ words, 375s)   R1
           ~50 words each              ONE GIANT REGION

Time:      ~2s each = 16s total       ~300s+ = TIMEOUT
```

The algorithm's performance is entirely determined by anchor quality. Good anchors produce many small regions, each of which aligns in seconds. Poor anchors (which happen when Gemini's text diverges significantly from WhisperX's transcription) produce huge regions where `findBestMatch()` has to search through thousands of candidate positions per segment.

## Similarity Scoring

The `computeSimilarity()` function uses a weighted ensemble of five fuzzy matching algorithms. The weights were tuned empirically against production transcripts:

| Algorithm              | Weight | Strength                                                         |
| ---------------------- | ------ | ---------------------------------------------------------------- |
| `token_set_ratio`      | 30%    | Handles word reordering and extra/missing words                  |
| `token_sort_ratio`     | 25%    | Handles word reordering (order-independent)                      |
| `partial_ratio`        | 20%    | Handles substring matches (one text is subset of other)          |
| `sequenceMatcherRatio` | 15%    | Gestalt pattern matching (longest common subsequence)            |
| `ngramSimilarity`      | 10%    | Character-level similarity (catches typos and minor differences) |

All five use normalized text (lowercase, no punctuation, collapsed whitespace) to ensure fair comparison between Gemini's cleaned-up output and WhisperX's raw transcription.

## Fallback Behavior

HARDY degrades gracefully at every level:

1. **Anchor failure**: If no anchors are found, the entire transcript becomes one region. Alignment still works but is slow and less accurate.
2. **Region alignment failure**: If `findBestMatch()` can't find a match above 0.40 confidence for a segment, timestamps are interpolated from the region bounds based on word count ratio.
3. **Chunk failure**: If HARDY throws or times out for a chunk, the pipeline falls back to scaled Gemini timestamps for that chunk. The `alignmentStatus` field records `'fallback'` so the UI can inform the user.
4. **Quality gate**: If aligned segments drop below 50% of Gemini segments, the pipeline raises a `QUALITY_GATE_FAILED` error rather than silently producing garbage.

## Deployment

HARDY runs as part of the transcription pipeline. In production, it executes inside the `transcription-orchestrator` Cloud Run service (`cloud-run-orchestrator/src/pipeline.ts`). In the emulator, it runs inline via `functions/src/newPipeline.ts`.

The alignment code itself (`functions/src/alignment.ts`) is shared between both paths via tsconfig path mapping (`@functions/*`). No separate deployment is needed for the alignment module — it deploys with the orchestrator.

## Related Documentation

- [Pipeline Flow](pipeline-flow.md) — Full pipeline reference including HARDY's role in the orchestrator
- [Architecture](architecture.md) — System architecture overview
- [Data Model](data-model.md) — Firestore schema including `alignmentStatus`
