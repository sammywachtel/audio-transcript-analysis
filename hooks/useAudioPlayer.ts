import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Conversation, Segment } from '../types';

interface UseAudioPlayerOptions {
  audioUrl?: string;
  initialDuration: number;
  segments: Segment[];
  onDriftCorrected?: (fixedConversation: Conversation, originalConversation: Conversation) => void;
}

interface UseAudioPlayerReturn {
  // State
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  activeSegmentIndex: number;
  isSyncing: boolean;

  // Drift correction metrics
  driftRatio: number;
  driftCorrectionApplied: boolean;
  driftMs: number;

  // Manual sync offset (ms) - positive = transcript ahead, negative = transcript behind
  syncOffset: number;

  // Refs
  audioRef: React.RefObject<HTMLAudioElement | null>;

  // Actions
  togglePlay: () => void;
  seek: (ms: number) => void;
  scrub: (ms: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setSyncOffset: (offset: number) => void;
}

/**
 * useAudioPlayer - Manages audio playback and sync with transcript
 *
 * Handles all the gnarly audio element lifecycle, drift correction,
 * fallback simulation mode for mock data, and active segment tracking.
 *
 * Drift correction kicks in when the audio duration differs by >1 second from
 * the transcript's last segment timestamp. We linearly scale all segments
 * to match the actual audio duration. This happens because Gemini's timestamps
 * often have linear drift (e.g., 8-10 seconds off in a 2-minute file).
 *
 * Phase 1: More aggressive threshold (>1s vs previous >5% AND >2s)
 * Exposes drift metrics for UI display: ratio, correctionApplied, and absolute drift in ms.
 */
export const useAudioPlayer = (
  conversation: Conversation,
  options: UseAudioPlayerOptions
): UseAudioPlayerReturn => {
  const { audioUrl, initialDuration, segments, onDriftCorrected } = options;

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(initialDuration);
  const [isSyncing, setIsSyncing] = useState(false);

  // Drift correction metrics
  const [driftRatio, setDriftRatio] = useState(1.0);
  const [driftCorrectionApplied, setDriftCorrectionApplied] = useState(false);
  const [driftMs, setDriftMs] = useState(0);

  // Manual sync offset (ms) - user-adjustable fine-tuning
  // Positive = shift transcript forward (highlight later segments for current audio time)
  // Negative = shift transcript backward (highlight earlier segments)
  const [syncOffset, setSyncOffset] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioIntervalRef = useRef<number | null>(null);
  const lastAudioUrlRef = useRef<string | undefined>(undefined);

  // Refs for values needed by drift correction (to avoid stale closures)
  const segmentsRef = useRef(segments);
  const conversationRef = useRef(conversation);
  const onDriftCorrectedRef = useRef(onDriftCorrected);
  const isSyncingRef = useRef(isSyncing);

  // Keep refs updated
  segmentsRef.current = segments;
  conversationRef.current = conversation;
  onDriftCorrectedRef.current = onDriftCorrected;
  isSyncingRef.current = isSyncing;

  /**
   * Setup audio element when URL is available
   * IMPORTANT: Only depends on audioUrl to prevent unnecessary recreation
   */
  useEffect(() => {
    console.log('[AudioPlayer] Audio setup effect', {
      hasAudioUrl: !!audioUrl,
      audioUrl: audioUrl ? audioUrl.substring(0, 80) : 'none',
      lastUrl: lastAudioUrlRef.current?.substring(0, 80) || 'none',
      hasExistingAudio: !!audioRef.current
    });

    if (!audioUrl) {
      console.log('[AudioPlayer] No audio URL - mock/demo mode');
      setDuration(initialDuration);
      return;
    }

    // Only create new Audio element if URL actually changed
    if (audioUrl === lastAudioUrlRef.current) {
      console.log('[AudioPlayer] Same URL, keeping existing audio element');
      return;
    }

    // Clean up old audio element if exists
    if (audioRef.current) {
      console.log('[AudioPlayer] Cleaning up old audio element');
      audioRef.current.pause();
      audioRef.current.src = '';
    }

    lastAudioUrlRef.current = audioUrl;
    console.log('[AudioPlayer] Creating NEW Audio element');
    const audio = new Audio(audioUrl);
    audioRef.current = audio;

    // Error handler
    audio.addEventListener('error', (e) => {
      const error = audio.error;
      console.error('[AudioPlayer] Audio error:', {
        code: error?.code,
        message: error?.message
      });
    });

    audio.addEventListener('canplay', () => {
      console.log('[AudioPlayer] canplay - ready to play');
    });

    audio.addEventListener('canplaythrough', () => {
      console.log('[AudioPlayer] canplaythrough - fully buffered');
    });

    // Handle metadata loaded
    const handleMetadata = () => {
      const audioDurMs = audio.duration * 1000;
      console.log('[AudioPlayer] Metadata loaded', {
        durationMs: audioDurMs,
        durationSec: audio.duration,
        readyState: audio.readyState
      });

      if (!Number.isFinite(audioDurMs) || audioDurMs === 0) {
        console.warn('[AudioPlayer] Invalid duration, skipping metadata handling');
        return;
      }

      setDuration(audioDurMs);

      // --- DRIFT CORRECTION LOGIC ---
      // Use refs to get current values (avoids stale closures)
      const currentSegments = segmentsRef.current;
      const currentConversation = conversationRef.current;
      const currentOnDriftCorrected = onDriftCorrectedRef.current;
      const currentIsSyncing = isSyncingRef.current;

      const lastSeg = currentSegments[currentSegments.length - 1];
      if (lastSeg && !currentIsSyncing) {
        const transcriptDurMs = lastSeg.endMs;
        const diff = Math.abs(audioDurMs - transcriptDurMs);
        const ratio = audioDurMs / transcriptDurMs;

        // ALWAYS log drift analysis for debugging
        console.log(`[Drift Analysis] Audio vs Transcript comparison:`, {
          audioDurationMs: audioDurMs,
          audioDurationFormatted: `${Math.floor(audioDurMs / 60000)}:${((audioDurMs % 60000) / 1000).toFixed(1)}`,
          transcriptDurationMs: transcriptDurMs,
          transcriptDurationFormatted: `${Math.floor(transcriptDurMs / 60000)}:${((transcriptDurMs % 60000) / 1000).toFixed(1)}`,
          driftMs: diff,
          driftRatio: ratio.toFixed(4),
          percentageDrift: ((ratio - 1) * 100).toFixed(2) + '%',
          willCorrect: diff > 1000
        });

        // Set drift metrics for UI display
        setDriftRatio(ratio);
        setDriftMs(diff);

        // Phase 1: More aggressive threshold - apply drift compensation when >1 second difference
        // Removed the 5% requirement to catch linear drift (e.g., 8-10 seconds in 2-minute files)
        if (diff > 1000) {
          console.log(`[Auto-Sync] 🔧 Applying drift correction...`);
          setIsSyncing(true);
          setDriftCorrectionApplied(true);

          // Apply linear scaling to all segments with improved rounding
          const scaledSegments = currentSegments.map(seg => ({
            ...seg,
            startMs: Math.round(seg.startMs * ratio),
            endMs: Math.round(seg.endMs * ratio)
          }));

          // Log first and last segment before/after for verification
          console.log(`[Auto-Sync] Segment adjustment preview:`, {
            firstSegment: {
              before: { start: currentSegments[0].startMs, end: currentSegments[0].endMs },
              after: { start: scaledSegments[0].startMs, end: scaledSegments[0].endMs }
            },
            lastSegment: {
              before: { start: lastSeg.startMs, end: lastSeg.endMs },
              after: { start: scaledSegments[scaledSegments.length - 1].startMs, end: scaledSegments[scaledSegments.length - 1].endMs }
            }
          });

          // Create fixed conversation
          const fixedConversation = {
            ...currentConversation,
            segments: scaledSegments,
            durationMs: audioDurMs
          };

          // Notify parent to update conversation
          if (currentOnDriftCorrected) {
            currentOnDriftCorrected(fixedConversation, currentConversation);
            console.log(`[Auto-Sync] ✅ Drift correction applied and saved`);
          }

          // Reset syncing state after a short delay (for UI feedback)
          setTimeout(() => setIsSyncing(false), 1500);
        } else {
          console.log(`[Drift Analysis] ℹ️ No correction needed (diff ${diff}ms < 1000ms threshold)`);
          setDriftCorrectionApplied(false);
        }
      } else {
        console.log(`[Drift Analysis] ⚠️ Skipped:`, {
          hasLastSegment: !!lastSeg,
          isSyncing: currentIsSyncing
        });
      }
    };

    // Check immediately if metadata already loaded
    if (audio.readyState >= 1) {
      handleMetadata();
    }

    audio.addEventListener('loadedmetadata', handleMetadata);

    // Handle duration changes (can happen after initial load)
    audio.addEventListener('durationchange', () => {
      const d = audio.duration * 1000;
      if (d > 0) setDuration(d);
    });

    // Handle time updates during playback
    audio.addEventListener('timeupdate', () => {
      const nowMs = audio.currentTime * 1000;
      setCurrentTime(nowMs);
      // Fallback: If audio plays past known duration, expand it
      setDuration(prev => (nowMs > prev ? nowMs : prev));
    });

    // Handle playback end
    audio.addEventListener('ended', () => {
      setIsPlaying(false);
    });

    // Cleanup
    // Cleanup only runs when audioUrl changes or component unmounts
    return () => {
      console.log('[AudioPlayer] Cleanup running');
      audio.pause();
      audio.src = '';
      audioRef.current = null;
      lastAudioUrlRef.current = undefined;
    };
  }, [audioUrl]); // ONLY depend on audioUrl - other deps cause unnecessary recreation

  /**
   * Fallback simulation mode for mock data (no real audio)
   */
  useEffect(() => {
    if (!audioUrl && isPlaying) {
      audioIntervalRef.current = window.setInterval(() => {
        setCurrentTime(prev => {
          if (prev >= duration) {
            setIsPlaying(false);
            return duration;
          }
          return prev + 100; // Increment 100ms every 100ms
        });
      }, 100);
    } else {
      if (audioIntervalRef.current) clearInterval(audioIntervalRef.current);
    }

    return () => {
      if (audioIntervalRef.current) clearInterval(audioIntervalRef.current);
    };
  }, [isPlaying, audioUrl, duration]);

  /**
   * Toggle play/pause
   */
  const togglePlay = useCallback(() => {
    console.log('[AudioPlayer] togglePlay called', {
      hasAudioRef: !!audioRef.current,
      currentlyPlaying: isPlaying,
      readyState: audioRef.current?.readyState,
      currentTime: audioRef.current?.currentTime,
      duration: audioRef.current?.duration
    });

    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
        console.log('[AudioPlayer] Paused');
      } else {
        const playPromise = audioRef.current.play();
        if (playPromise !== undefined) {
          playPromise
            .then(() => {
              console.log('[AudioPlayer] Playback started successfully');
            })
            .catch((error) => {
              console.error('[AudioPlayer] Playback failed:', error);
            });
        }
      }
      setIsPlaying(!isPlaying);
    } else {
      // Fallback for mock data
      console.log('[AudioPlayer] No audio ref - using mock playback');
      setIsPlaying(prev => !prev);
    }
  }, [isPlaying]);

  /**
   * Seek to a specific time (updates both visual and audio position)
   */
  const seek = useCallback((ms: number) => {
    setCurrentTime(ms);
    if (audioRef.current) {
      const seekTimeSec = ms / 1000;
      console.log(`[Seek] Requesting seek to ${ms}ms (${seekTimeSec}s)`);
      audioRef.current.currentTime = seekTimeSec;

      // Debug log
      setTimeout(() => {
        if (audioRef.current) {
          console.log(`[Seek] Audio currentTime after seek: ${audioRef.current.currentTime}s`);
        }
      }, 50);
    }
  }, []);

  /**
   * Scrub (visual update only, no audio seek until commit)
   */
  const scrub = useCallback((ms: number) => {
    setCurrentTime(ms);
  }, []);

  /**
   * Find the currently active segment based on playback time + manual offset
   * The offset shifts which segment is highlighted relative to audio position
   */
  const adjustedTime = currentTime + syncOffset;
  const activeSegmentIndex = segments.findIndex(
    seg => adjustedTime >= seg.startMs && adjustedTime < seg.endMs
  );

  return {
    isPlaying,
    currentTime,
    duration,
    activeSegmentIndex,
    isSyncing,
    driftRatio,
    driftCorrectionApplied,
    driftMs,
    syncOffset,
    audioRef,
    togglePlay,
    seek,
    scrub,
    setIsPlaying,
    setSyncOffset
  };
};
