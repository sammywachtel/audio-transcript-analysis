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

### Approach 3: Gemini 3 Flash (No-Text) + WhisperX Timestamp-Overlap

Gemini's timestamps drift approximately 1.6x relative to actual audio time — the same problem that existed with Gemini 2.5 Flash. So WhisperX is still needed for precise timestamps.

The initial hybrid architecture used HARDY text-matching alignment to bridge Gemini's text with WhisperX's timestamps. However, further testing revealed that a **no-text Gemini prompt** (diarization windows only, no transcript text) produces significantly better results:

- **Better speaker detection**: 6/6 speakers vs 5/6 with the text-returning prompt
- **Lower token usage**: ~9-15% of output budget vs ~31% with text
- **Simpler pipeline**: No need for HARDY text matching — speaker assignment uses direct timestamp overlap

The trade-off: transcript text now comes from WhisperX (raw ASR output), which is slightly less polished than Gemini's cleaned-up version. In practice, WhisperX transcription quality is good enough that this is an acceptable trade for the dramatically better diarization.

The winning architecture: Gemini handles diarization (time windows + speaker names) and content analysis, WhisperX provides word-level timestamps and transcript text, and `speakerAssignment.ts` overlays Gemini's diarization windows onto WhisperX words by timestamp overlap.

## The Architecture Decision

```
Upload → Convert to WAV (for Gemini)
       → Gemini 3 Flash (no-text prompt): diarization windows + speakers + terms + topics + persons
       → Download MP3 (for WhisperX)
       → Split into 10-min chunks (for WhisperX request sizing only)
       → Per-chunk: WhisperX timestamps + text → speaker assignment by timestamp overlap
       → Assemble Firestore data → Save
```

### What Was Eliminated

| Component                    | Why It Existed                              | Why It's Gone                                            |
| ---------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| Per-chunk Gemini analysis    | Each chunk needed its own content analysis  | Gemini 3 Flash handles full audio in one call            |
| Cross-chunk speaker matching | Speaker IDs diverged across chunks          | Single Gemini call = consistent speakers                 |
| Speaker quality scoring      | Detected when matching went wrong           | No matching to go wrong                                  |
| Speaker name resolution      | Tried to infer names from introductions     | Gemini identifies speakers by name directly              |
| Embedding-based similarity   | Matched speakers by voice characteristics   | Not needed with single-pass diarization                  |
| Complex merge logic          | Stitched chunks back together               | Nothing to stitch — one Gemini result                    |
| Cloud Tasks queue            | Processing exceeded 9-min timeout           | Cloud Run orchestrator has 900s timeout; no queue needed |
| Fallback reprocessing        | Sequential mode backup when parallel failed | No parallel/sequential modes needed                      |

### What Was Kept

- **WhisperX on Cloud Run GPU** — still needed for precise word-level timestamps and transcript text (Gemini's no-text prompt returns diarization windows only)
- **Speaker assignment by timestamp overlap** — `speakerAssignment.ts` overlays Gemini diarization windows onto WhisperX words (replaced HARDY text-matching alignment)
- **Cloud Function as thin dispatcher** — `transcribeAudio` validates the upload and fires an HTTP POST to the Cloud Run orchestrator (`transcription-orchestrator`), which runs the full pipeline
- **All frontend code** — the data model is unchanged from the frontend's perspective
- **Speaker corrections** — users can still merge/rename/reassign speakers (fewer corrections needed now)
- **Stats, billing, chat** — all auxiliary functions unchanged

## Key Insights

1. **WAV format is critical for diarization.** MP3 compression hides quiet speakers. Always send WAV to Gemini for diarization tasks.

2. **Gemini timestamps still drift.** This is true for both 2.5 Flash and 3 Flash. The drift is approximately 1.6x and is systematic (linear, not random). The timestamp-overlap speaker assignment approach sidesteps this by using WhisperX's precise timestamps directly rather than trying to correct Gemini's.

3. **Single-pass beats multi-step.** The fundamental insight is that diarization must see the full conversation to assign consistent speaker identities. Chunking the audio and trying to reconcile afterward is fighting against the nature of the problem.

4. **Simpler infrastructure is more reliable.** Eliminating Cloud Tasks, cross-chunk matching, and the merge step removed several categories of failure modes. The new pipeline either succeeds or fails — there's no partially-merged, low-confidence, needs-reprocessing limbo.

5. **The Cloud Functions timeout did not work.** The PoC pipeline takes ~643s for a 45-minute recording, exceeding Cloud Functions' 540s hard limit. This drove the migration to a Cloud Run orchestrator (`transcription-orchestrator`) with a 900s timeout, where the full pipeline runs without algorithmic compromises. The Cloud Function (`transcribeAudio`) now acts as a thin dispatcher. See [Orchestrator Architecture](orchestrator-architecture.md) for the full rationale.

## Lessons Learned

The migration validated the "Enable-Before-Remove" strategy: the hybrid pipeline was built and tested as an opt-in path (activated via Storage metadata) before the legacy pipeline was removed. This allowed side-by-side comparison on the same audio files before committing to the switch.

Ground truth comparison showed the hybrid pipeline producing dramatically better results: 6 correct speakers vs. 15 fragmented ones, with WhisperX-sourced timestamps and speaker assignment by timestamp overlap.
