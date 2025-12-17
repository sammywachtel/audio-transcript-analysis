# Timestamp Alignment Architecture Decision

## Problem Statement

Gemini 2.5 Flash produces excellent transcription content (text, speakers, terms, topics) but unreliable timestamps:
- **Observed drift**: 8-10 seconds off in a 2-minute file
- **Pattern**: Linear drift that worsens over time (systematic, not random)
- **Root cause**: Gemini likely estimates timestamps from text features rather than actual audio analysis

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
**Status**: ✅ Complete
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

### Phase 2: Python Backend with WhisperX (1-2 Week Sprint)
**Status**: Planned
**Effort**: 40-60 hours
**Accuracy Target**: <1 second

Architecture:
```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  React Client   │────▶│  FastAPI Backend │────▶│  WhisperX GPU   │
│  (Gemini API)   │◀────│  (Alignment)     │◀────│  Processing     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
         │                       │
         │                       ▼
         │              ┌──────────────────┐
         └─────────────▶│  Redis Cache     │
                        └──────────────────┘
```

Components:
1. **FastAPI service** (~400 lines Python)
2. **WhisperX** for word-level timestamp extraction
3. **Fuzzy matching** to align Gemini segments to Whisper timestamps
4. **Redis cache** for processed results (audio processing is expensive)

Deployment options:
- Railway/Render: ~$20/month
- Self-hosted GPU (g4dn.xlarge spot): ~$0.0125/audio hour

### Phase 3: Manual Offset Control (Optional)
**Status**: ✅ Complete
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
| Self-hosted WhisperX | $0.0125 | 40 hours | <0.5 seconds |
| Replicate Whisper | $0.03 | 4 hours | <0.5 seconds |

## Decision

**Proceed with Phase 1 immediately**, then evaluate if Phase 2 is needed based on user feedback.

Rationale:
- Phase 1 provides immediate improvement with zero infrastructure changes
- Linear drift pattern suggests ratio scaling will be effective
- Can measure improvement before investing in backend infrastructure

## Implementation Notes

### Phase 1 Changes Completed

1. **Enhanced drift correction** in `useAudioPlayer.ts`:
   - ✅ Lowered threshold from >5% AND >2s to just >1s difference
   - ✅ Added drift metrics tracking: `driftRatio`, `driftCorrectionApplied`, `driftMs`
   - ✅ Improved rounding with `Math.round()` instead of `Math.floor()`
   - ✅ Added detailed console logging for debugging

2. **Added sync indicator** in UI (`ViewerHeader.tsx`):
   - ✅ "⚡ Sync Adjusted" badge appears when drift correction was applied
   - ✅ Tooltip shows percentage adjustment and milliseconds of drift detected
   - ✅ "Auto-Syncing" spinner shows during correction

3. **Testing** (remaining):
   - Short (2 min), medium (10 min), long (1+ hour)
   - Different audio qualities and speaker counts

### Success Metrics

- Timestamp accuracy within 2 seconds (Phase 1)
- Timestamp accuracy within 1 second (Phase 2)
- No user-reported sync issues
- Processing time under 30 seconds for 2-hour files

## References

- [WhisperX GitHub](https://github.com/m-bain/whisperX)
- [Montreal Forced Aligner](https://montreal-forced-aligner.readthedocs.io/)
- [Gentle Forced Aligner](https://github.com/lowerquality/gentle)
- [stable-ts (Stable Whisper)](https://github.com/jianfch/stable-ts)
