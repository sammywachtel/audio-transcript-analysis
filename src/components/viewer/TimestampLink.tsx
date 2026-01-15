/**
 * TimestampLink Component
 *
 * Reusable timestamp citation link for chat messages.
 * Handles click interactions with centralized timestamp logic.
 *
 * Features:
 * - Auto-play audio on click
 * - Scroll and highlight segment
 * - Analytics tracking
 * - Error state handling (missing segment/audio)
 */

import React, { useState } from 'react';
import { Play, AlertCircle } from 'lucide-react';
import { cn } from '@/utils';
import { formatTime } from '@/utils';
import { handleTimestampLink } from '@/utils/timestampLinking';
import { analyticsService } from '@/services/analyticsService';

export interface TimestampLinkProps {
  /** Segment ID to link to */
  segmentId: string;
  /** Timestamp in milliseconds */
  startMs: number;
  /** Speaker display name (optional) */
  speakerName?: string;
  /** Conversation ID for analytics */
  conversationId: string;
  /** Analytics source context */
  analyticsSource?: 'chat' | 'transcript' | 'people' | 'search';
  /** Callback to seek audio */
  onSeek?: (timeMs: number) => void;
  /** Callback to trigger playback */
  onPlay?: () => void;
  /** Callback to set highlighted segment */
  onHighlight?: (segmentId: string | null) => void;
  /** Whether to auto-play after clicking (default: true) */
  autoPlay?: boolean;
}

/**
 * TimestampLink - clickable timestamp citation
 *
 * Used in chat messages to provide interactive timestamp sources.
 * Centralizes all timestamp interaction logic for consistency.
 */
export const TimestampLink: React.FC<TimestampLinkProps> = ({
  segmentId,
  startMs,
  speakerName,
  conversationId,
  analyticsSource = 'chat' as const,
  onSeek,
  onPlay,
  onHighlight,
  autoPlay = true
}) => {
  const [errorState, setErrorState] = useState<string | null>(null);

  const handleClick = () => {
    // Clear any previous error
    setErrorState(null);

    // Track analytics
    analyticsService.trackTimestampClick({
      conversationId,
      segmentId,
      startMs,
      source: analyticsSource
    });

    // Execute timestamp interaction
    const result = handleTimestampLink({
      segmentId,
      startMs,
      onSeek,
      onPlay,
      onHighlight,
      autoPlay
    });

    // Show error state if interaction failed
    if (!result.success && result.message) {
      setErrorState(result.message);
      // Auto-clear error after 3 seconds
      setTimeout(() => setErrorState(null), 3000);
    }
  };

  const timestamp = formatTime(startMs);
  const hasError = errorState !== null;

  return (
    <span className="relative inline-block">
      <button
        onClick={handleClick}
        className={cn(
          'inline-flex items-center gap-1 px-2 py-1 rounded text-xs',
          'transition-colors cursor-pointer font-medium',
          // Min-height for 44px touch target on mobile
          'min-h-[44px] sm:min-h-0',
          hasError
            ? 'bg-red-50 border border-red-200 text-red-700 hover:bg-red-100'
            : 'bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100'
        )}
        title={hasError ? errorState : `Jump to ${timestamp}${speakerName ? ` - ${speakerName}` : ''}`}
      >
        {hasError ? (
          <AlertCircle size={10} />
        ) : (
          <Play size={10} className="fill-current" />
        )}
        <span>{timestamp}</span>
        {speakerName && !hasError && (
          <>
            <span className="text-blue-400">-</span>
            <span className="text-blue-600">{speakerName}</span>
          </>
        )}
      </button>

      {/* Error tooltip */}
      {hasError && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-slate-900 text-white text-[10px] rounded whitespace-nowrap z-10 animate-in fade-in slide-in-from-bottom-1 duration-200">
          {errorState}
        </span>
      )}
    </span>
  );
};
