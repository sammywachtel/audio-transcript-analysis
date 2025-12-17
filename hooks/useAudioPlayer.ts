import { useState, useEffect, useRef, useCallback } from 'react';
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

  // Refs
  audioRef: React.RefObject<HTMLAudioElement | null>;

  // Actions
  togglePlay: () => void;
  seek: (ms: number) => void;
  scrub: (ms: number) => void;
  setIsPlaying: (playing: boolean) => void;
}

/**
 * useAudioPlayer - Manages audio playback and sync with transcript
 *
 * Handles all the gnarly audio element lifecycle, drift correction,
 * fallback simulation mode for mock data, and active segment tracking.
 *
 * Drift correction kicks in when the audio duration differs >5% from
 * the transcript's last segment timestamp. We linearly scale all segments
 * to match the actual audio duration. This happens because sometimes
 * sample rates mess with Gemini's timestamp predictions.
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

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioIntervalRef = useRef<number | null>(null);

  /**
   * Setup audio element and drift correction when URL is available
   */
  useEffect(() => {
    if (!audioUrl) {
      // No audio URL means mock/demo mode
      setDuration(initialDuration);
      return;
    }

    const audio = new Audio(audioUrl);
    audioRef.current = audio;

    // Handle metadata loaded
    const handleMetadata = () => {
      const audioDurMs = audio.duration * 1000;
      if (!Number.isFinite(audioDurMs) || audioDurMs === 0) return;

      setDuration(audioDurMs);

      // --- DRIFT CORRECTION LOGIC ---
      // Check if transcript timestamps are significantly off from actual audio duration
      const lastSeg = segments[segments.length - 1];
      if (lastSeg && !isSyncing) {
        const transcriptDurMs = lastSeg.endMs;
        const diff = Math.abs(audioDurMs - transcriptDurMs);
        const ratio = audioDurMs / transcriptDurMs;

        // Threshold: >5% difference AND >2 seconds (avoid tiny rounding jitter)
        if (diff > 2000 && (ratio < 0.95 || ratio > 1.05)) {
          console.log(`[Auto-Sync] Drift detected. Audio: ${audioDurMs}ms, Transcript: ${transcriptDurMs}ms. Ratio: ${ratio}`);
          setIsSyncing(true);

          // Apply linear scaling to all segments
          const scaledSegments = segments.map(seg => ({
            ...seg,
            startMs: Math.floor(seg.startMs * ratio),
            endMs: Math.floor(seg.endMs * ratio)
          }));

          // Create fixed conversation
          const fixedConversation = {
            ...conversation,
            segments: scaledSegments,
            durationMs: audioDurMs
          };

          // Notify parent to update conversation
          if (onDriftCorrected) {
            onDriftCorrected(fixedConversation, conversation);
          }

          // Reset syncing state after a short delay (for UI feedback)
          setTimeout(() => setIsSyncing(false), 1500);
        }
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
    return () => {
      audio.pause();
      audio.src = '';
      audioRef.current = null;
    };
  }, [audioUrl, segments, conversation, isSyncing, onDriftCorrected, initialDuration]);

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
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play();
      }
      setIsPlaying(!isPlaying);
    } else {
      // Fallback for mock data
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
   * Find the currently active segment based on playback time
   */
  const activeSegmentIndex = segments.findIndex(
    seg => currentTime >= seg.startMs && currentTime < seg.endMs
  );

  return {
    isPlaying,
    currentTime,
    duration,
    activeSegmentIndex,
    isSyncing,
    audioRef,
    togglePlay,
    seek,
    scrub,
    setIsPlaying
  };
};
