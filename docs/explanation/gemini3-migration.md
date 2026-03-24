# Gemini 3 Flash + WhisperX Hybrid Pipeline Migration

Why and how the transcription pipeline was redesigned from a multi-step chunked architecture to a single-pass hybrid approach.

## The Problem with the Legacy Pipeline

The original pipeline processed audio in multiple steps: chunk the audio, run each chunk through Gemini for content analysis, run each chunk through WhisperX for diarization and timestamps, match speakers across chunks, merge everything together. For a 45-minute conversation with 6 speakers, this produced:

- **15 distinct speaker labels** instead of 6 (each chunk invented its own speaker IDs)
- **392 manual speaker corrections** needed to fix the mess
- **Complex infrastructure**: Cloud Tasks queue, per-chunk processing, cross-chunk speaker matching, embedding-based similarity, quality scoring, fallback reprocessing
- **Fragile merge logic** that tried to reconcile divergent speaker identities after the fact

The core issue: diarization was happening per-chunk, and no amount of post-hoc matching could reliably reconstruct who was who when each chunk had its own view of the conversation.

## What We Tested

### Approach 1: Chirp-3 (Google Cloud Speech-to-Text v2)

Google's latest STT service (Chirp-3) was tested as a potential replacement for the WhisperX diarization step.

**Results**: Failed. It found only 3 speakers instead of 6. The service aggressively merged similar voices — speakers with low participation (4% and 2.7% of speaking time) were absorbed into dominant speakers. It also required chunking for word-level timestamps (20-minute limit), reintroducing the cross-chunk speaker problem we were trying to solve.

**Verdict**: Not viable for diarization. Good transcription quality, but redundant if WhisperX provides timestamps.

### Approach 2: Gemini 3 Flash (WAV)

Gemini 3 Flash was tested with the full 45-minute audio file in WAV format, asking it to perform diarization + content analysis in a single pass.

**Results**: Exceeded expectations.
- **6 of 6 speakers identified correctly**, most by real name
- Full-audio analysis with no truncation
- 9-31% of output token budget used (well under limits)
- 42-109 seconds per API call
- Terms, topics, and persons extracted simultaneously

**Critical finding**: WAV format matters. When the same audio was sent as MP3, Gemini found only 5 speakers. The lossy compression hid the quietest speaker. WAV preserves the full audio fidelity that Gemini needs for accurate diarization.

### Approach 3: Gemini 3 Flash + WhisperX Hybrid

Gemini's timestamps drift approximately 1.6x relative to actual audio time — the same problem that existed with Gemini 2.5 Flash. So WhisperX is still needed for precise timestamps.

The winning architecture: Gemini handles diarization and content, WhisperX handles timestamps, HARDY alignment bridges them. Testing showed the HARDY algorithm achieved a median 1.1-second error vs ground truth, correcting Gemini's systematic drift.

## The Architecture Decision

```
Upload → Convert to WAV (for Gemini)
       → Gemini 3 Flash: diarization + speakers + terms + topics + persons
       → Download MP3 (for WhisperX)
       → Split into 10-min chunks (for WhisperX request sizing only)
       → Per-chunk: WhisperX timestamps → HARDY alignment
       → Assemble Firestore data → Save
```

### What Was Eliminated

| Component | Why It Existed | Why It's Gone |
|-----------|---------------|---------------|
| Per-chunk Gemini analysis | Each chunk needed its own content analysis | Gemini 3 Flash handles full audio in one call |
| Cross-chunk speaker matching | Speaker IDs diverged across chunks | Single Gemini call = consistent speakers |
| Speaker quality scoring | Detected when matching went wrong | No matching to go wrong |
| Speaker name resolution | Tried to infer names from introductions | Gemini identifies speakers by name directly |
| Embedding-based similarity | Matched speakers by voice characteristics | Not needed with single-pass diarization |
| Complex merge logic | Stitched chunks back together | Nothing to stitch — one Gemini result |
| Cloud Tasks queue | Processing exceeded 9-min timeout | Hybrid pipeline runs within timeout |
| Fallback reprocessing | Sequential mode backup when parallel failed | No parallel/sequential modes needed |

### What Was Kept

- **WhisperX on Cloud Run GPU** — still needed for precise word-level timestamps (Gemini's timestamps drift)
- **HARDY alignment algorithm** — bridges Gemini text with WhisperX timing
- **Cloud Functions** — orchestration simplified but still runs on Functions
- **All frontend code** — the data model is unchanged from the frontend's perspective
- **Speaker corrections** — users can still merge/rename/reassign speakers (fewer corrections needed now)
- **Stats, billing, chat** — all auxiliary functions unchanged

## Key Insights

1. **WAV format is critical for diarization.** MP3 compression hides quiet speakers. Always send WAV to Gemini for diarization tasks.

2. **Gemini timestamps still drift.** This is true for both 2.5 Flash and 3 Flash. The drift is approximately 1.6x and is systematic (linear, not random). HARDY alignment corrects this to a median 1.1-second error.

3. **Single-pass beats multi-step.** The fundamental insight is that diarization must see the full conversation to assign consistent speaker identities. Chunking the audio and trying to reconcile afterward is fighting against the nature of the problem.

4. **Simpler infrastructure is more reliable.** Eliminating Cloud Tasks, cross-chunk matching, and the merge step removed several categories of failure modes. The new pipeline either succeeds or fails — there's no partially-merged, low-confidence, needs-reprocessing limbo.

5. **The 9-minute timeout works.** Gemini 3 Flash processes a 45-minute file in under 2 minutes. WhisperX chunks process quickly on GPU. The total pipeline time is well within the Storage trigger timeout for most real-world audio files.

## Lessons Learned

The migration validated the "Enable-Before-Remove" strategy: the hybrid pipeline was built and tested as an opt-in path (activated via Storage metadata) before the legacy pipeline was removed. This allowed side-by-side comparison on the same audio files before committing to the switch.

Ground truth comparison showed the hybrid pipeline producing dramatically better results: 6 correct speakers vs. 15 fragmented ones, with HARDY-corrected timestamps that tracked the audio within 1-2 seconds.
