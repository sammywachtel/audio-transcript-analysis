import { useEffect } from 'react';
import { Segment } from '../types';

/**
 * useAutoScroll - Auto-scrolls transcript to active segment during playback
 *
 * When audio is playing, automatically keeps the active segment visible
 * in the transcript view. Uses 'nearest' block positioning to avoid
 * jarring jumps if the segment is already visible.
 */
export const useAutoScroll = (
  isPlaying: boolean,
  activeSegmentIndex: number,
  segments: Segment[]
): void => {
  useEffect(() => {
    if (isPlaying && activeSegmentIndex !== -1) {
      const segment = segments[activeSegmentIndex];
      if (segment) {
        const el = document.getElementById(`segment-${segment.segmentId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
    }
  }, [activeSegmentIndex, isPlaying, segments]);
};
