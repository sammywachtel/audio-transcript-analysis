# Timestamp Alignment Architecture Decision

## Problem Statement

Gemini 3 Flash produces excellent transcription content (text, speakers, terms, topics) but unreliable timestamps:
- **Observed drift**: Timestamps drift ~1.6x relative to actual audio time
- **Pattern**: Linear drift that worsens over time (systematic, not random)
- **Root cause**: Gemini likely estimates timestamps from text features rather than actual audio analysis

This problem existed with Gemini 2.5 Flash and persists with Gemini 3 Flash. The solution is the same: use WhisperX for precise timestamps and HARDY alignment to bridge the two.

## Expert Analysis Summary

A multi-expert analysis was conducted with perspectives from:
- Speech Recognition Researchers
- Audio Signal Processing Engineers
- Python Backend Architects
- ML Engineers
- Cost Optimization Specialists

### Key Insights

1. **Linear drift pattern** indicates simple ratio scaling could provide immediate improvement
2. **Forced alignment** is the proper solution (matching text to audio waveform)
3. **Hybrid approach** recommended: Keep Gemini for content, add timing from WhisperX or similar
4. **Don't sync in real-time** - process once, store accurate timestamps

## Phased Implementation Plan

### Phase 1: Client-Side Drift Compensation (Immediate)
**Status**: Complete
**Effort**: 1-2 hours
**Accuracy Target**: <2 seconds (down from 8-10)

Simple ratio-based scaling using actual audio duration vs. transcript duration:
```javascript
function compensateDrift(segments, audioDuration) {
  const transcriptDuration = segments[segments.length-1].endMs;
  const ratio = audioDuration / transcriptDuration;
  return segments.map(s => ({
    ...s,
    startMs: Math.round(s.startMs * ratio),
    endMs: Math.round(s.endMs * ratio)
  }));
}
```

This leverages the existing drift detection code but applies it more aggressively.

### Phase 2: WhisperX via Cloud Run GPU (Current Architecture)
**Status**: Complete
**Effort**: 14-21 hours initial, then consolidated into Functions
**Accuracy Target**: <1 second (~50ms with forced alignment)

Architecture (Current - Direct Pipeline):
```
┌─────────────────┐     ┌──────────────────────────────────────────────────┐
│  React Client   │────▶│            Firebase Cloud Functions              │
│                 │     │                                                  │
│                 │     │  ┌────────────────┐                              │
│                 │     │  │ transcribeAudio│                              │
│                 │     │  │ (Storage Trig) │                              │
│                 │     │  │  - 540s max    │                              │
│                 │◀────│  └───────┬────────┘                              │
│                 │     │          │                                       │
│                 │     │          ▼                                       │
│                 │     │  ┌──────────────────────┐                        │
│                 │     │  │processWithNewPipeline │                       │
│                 │     │  │  - Gemini 3 Flash    │                        │
│                 │     │  │  - Split MP3 chunks  │                        │
│                 │     │  │  - Per-chunk HARDY   │                        │
│                 │     │  │  - Assemble + save   │                        │
│                 │     │  └───────┬──────────────┘                        │
│                 │     └──────────┼────────────────────────────────────────┘
│                 │                │
└─────────────────┘                ▼
                           ┌──────────────────┐
                           │  Cloud Run GPU   │
                           │  (WhisperX)      │
                           │  IAM-auth HTTP   │
                           └──────────────────┘
```

**Why Cloud Run GPU instead of a third-party API?**
- IAM-authenticated HTTP (no API keys to manage)
- NVIDIA L4 GPU for fast inference
- Scale-to-zero when idle (no cost when not processing)
- Full control over model version and configuration
- Max 3 instances as cost safeguard

**Why WhisperX over OpenAI Whisper API?**
- OpenAI's API has word-level timestamps but they can still drift on long-form audio
- WhisperX adds **forced alignment** with wav2vec2 phoneme model
- Forced alignment matches audio waveforms to phonemes = ~50ms accuracy

**Implementation:**
1. **functions/src/alignment.ts** - HARDY algorithm in TypeScript
   - Complete port from Python `aligner.py`
   - Uses `fuzzball` npm package for fuzzy matching
   - Calls Cloud Run WhisperX service via IAM-authenticated HTTP
   - Called by `newPipeline.ts` for each 10-minute audio chunk

2. **Server-side processing:**
   - Alignment runs automatically during transcription
   - No client-side "Improve Timestamps" button needed
   - Status stored in Firestore: `alignmentStatus: 'aligned'` or `'fallback'`

3. **HARDY Alignment Algorithm (4 levels):**
   - **Level 1**: Anchor Point Identification (high-confidence matches)
   - **Level 2**: Region Segmentation (divide transcript at anchors)
   - **Level 3**: Regional Alignment (DTW-style matching per region)
   - **Level 4**: Validation & Fallback (quality gates, graceful degradation)

**Cost:** ~$0.02 per 10-minute audio file (Cloud Run GPU compute)
**Accuracy:** Median 1.1s error vs ground truth (down from ~1.6x drift)

### Phase 3: Manual Offset Control (Optional)
**Status**: Complete
**Effort**: 4-8 hours

Add UI slider for users to manually fine-tune sync if automated alignment isn't perfect.

**Implementation:**
- "Sync" button in AudioPlayer footer (desktop only)
- Click to reveal offset controls popup
- Quick buttons: -1s, -0.5s, +0.5s, +1s
- Full slider: -30s to +30s range
- Reset button to return to 0
- Visual indicator when offset is applied (amber color)

## Cost Analysis

| Solution | Cost per Audio Hour | Dev Time | Accuracy |
|----------|---------------------|----------|----------|
| Phase 1 (ratio scaling) | $0 | 2 hours | ~2 seconds |
| AssemblyAI API | $0.65 | 8 hours | <0.5 seconds |
| Cloud Run WhisperX | ~$0.12 | 14 hours | <0.5 seconds |

## Implementation Notes

### Phase 1 Changes Completed

1. **Enhanced drift correction** in `useAudioPlayer.ts`:
   - Lowered threshold from >5% AND >2s to just >1s difference
   - Added drift metrics tracking: `driftRatio`, `driftCorrectionApplied`, `driftMs`
   - Improved rounding with `Math.round()` instead of `Math.floor()`
   - Added detailed console logging for debugging

2. **Added sync indicator** in UI (`ViewerHeader.tsx`):
   - "Sync Adjusted" badge appears when drift correction was applied
   - Tooltip shows percentage adjustment and milliseconds of drift detected
   - "Auto-Syncing" spinner shows during correction

### Success Metrics

- Timestamp accuracy within 2 seconds (Phase 1)
- Timestamp accuracy within 1 second (Phase 2)
- No user-reported sync issues

## Deployment Instructions (Current Architecture)

### Prerequisites
1. Firebase project with Cloud Functions enabled
2. WhisperX Cloud Run GPU service deployed (see [Deployment Guide](../how-to/deploy.md#whisper-gpu-service-cloud-run))
3. `WHISPER_SERVICE_URL` secret set in Firebase

### Deployment (Automated via CI/CD)

Alignment is part of Firebase Functions and deploys automatically:

1. **On merge to main**: GitHub Actions runs `deploy-firebase-functions` job
2. **Job steps**:
   - `npm ci` - Install dependencies (including `fuzzball`)
   - `npm run build` - Compile TypeScript
   - `firebase deploy --only functions` - Deploy to Firebase

No separate alignment service deployment needed (WhisperX runs on Cloud Run independently).

### Manual Deployment

```bash
# Build and deploy functions
cd functions && npm install && npm run build && cd ..
npx firebase deploy --only functions
```

### Local Development

```bash
# Start frontend dev server
npm run dev

# Functions run in Firebase emulator (optional)
npx firebase emulators:start --only functions
```

### Verify Deployment

```bash
# Check function logs after uploading an audio file
npx firebase functions:log --only transcribeAudio

# Look for:
# [Alignment] Preparing request...
# [WhisperX] Transcription complete
# [HARDY] Alignment complete, avg_confidence=X.XXX
```

## References

- [WhisperX GitHub](https://github.com/m-bain/whisperX)
- [Montreal Forced Aligner](https://montreal-forced-aligner.readthedocs.io/)
- [Gentle Forced Aligner](https://github.com/lowerquality/gentle)
- [stable-ts (Stable Whisper)](https://github.com/jianfch/stable-ts)
