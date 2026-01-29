import React, { useMemo, useState, useRef, useEffect } from 'react';
import { Segment, TermOccurrence, Speaker } from '@/config/types';
import { cn, formatTime } from '@/utils';
import { SPEAKER_BORDER_COLORS, SPEAKER_BADGE_COLORS, SPEAKER_DOT_COLORS } from '@/config/constants';
import { Edit2, ChevronDown } from 'lucide-react';
import { useLongPress, Position } from '@/hooks/useLongPress';
import { SpeakerContextMenu } from './SpeakerContextMenu';

interface TranscriptSegmentProps {
  segment: Segment;
  speaker: Speaker;
  allSpeakers: Speaker[];  // All available speakers for reassignment
  occurrences: TermOccurrence[];
  personOccurrences?: { start: number; end: number; personId: string }[];
  isActive: boolean;
  isHighlighted?: boolean; // True when segment is highlighted from timestamp click
  isSelected?: boolean; // True when segment is part of multi-select
  showSpeakerChange: boolean; // True when speaker changes from previous segment
  activeTermId?: string;
  activePersonId?: string;
  onSeek: (ms: number) => void;
  onTermClick: (termId: string) => void;
  onRenameSpeaker: (speakerId: string) => void;
  onReassignSpeaker?: (segmentId: string, newSpeakerId: string) => void;
  onSegmentClick?: (shiftKey: boolean) => void;
}

export const TranscriptSegment: React.FC<TranscriptSegmentProps> = ({
  segment,
  speaker,
  allSpeakers,
  occurrences,
  personOccurrences = [],
  isActive,
  isHighlighted = false,
  isSelected = false,
  showSpeakerChange,
  activeTermId,
  activePersonId,
  onSeek,
  onTermClick,
  onRenameSpeaker,
  onReassignSpeaker,
  onSegmentClick
}) => {
  // State for speaker change header dropdown (bulk reassignment)
  const [showHeaderDropdown, setShowHeaderDropdown] = useState(false);
  const headerDropdownRef = useRef<HTMLDivElement>(null);

  // State for context menu (per-segment reassignment via long-press/right-click)
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState<Position>({ x: 0, y: 0 });

  // Close header dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (headerDropdownRef.current && !headerDropdownRef.current.contains(event.target as Node)) {
        setShowHeaderDropdown(false);
      }
    };

    if (showHeaderDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showHeaderDropdown]);

  const handleHeaderSpeakerSelect = (newSpeakerId: string) => {
    if (newSpeakerId !== segment.speakerId && onReassignSpeaker) {
      onReassignSpeaker(segment.segmentId, newSpeakerId);
    }
    setShowHeaderDropdown(false);
  };

  // Long-press handlers for context menu
  const handleLongPress = (position: Position) => {
    if (onReassignSpeaker && allSpeakers.length > 1) {
      setContextMenuPosition(position);
      setShowContextMenu(true);
    }
  };

  const longPressHandlers = useLongPress({
    onLongPress: handleLongPress,
    delay: 500,
    shouldPreventDefault: false // Don't prevent default to allow text selection
  });

  const handleContextMenuReassign = (newSpeakerId: string) => {
    if (newSpeakerId !== segment.speakerId && onReassignSpeaker) {
      onReassignSpeaker(segment.segmentId, newSpeakerId);
    }
    setShowContextMenu(false);
  };

  const handleContextMenuRename = () => {
    onRenameSpeaker(speaker.speakerId);
    setShowContextMenu(false);
  };

  // Get speaker colors based on colorIndex
  const speakerBorderColor = SPEAKER_BORDER_COLORS[speaker.colorIndex % SPEAKER_BORDER_COLORS.length];
  const speakerBadgeColors = SPEAKER_BADGE_COLORS[speaker.colorIndex % SPEAKER_BADGE_COLORS.length];
  const speakerDotColor = SPEAKER_DOT_COLORS[speaker.colorIndex % SPEAKER_DOT_COLORS.length];

  // Splitting text to inject highlights
  const textParts = useMemo(() => {
    // Combine term occurrences and person occurrences into a single sorted list
    const highlights = [
      ...occurrences.map(o => ({ start: o.startChar, end: o.endChar, id: o.termId, type: 'term' as const })),
      ...personOccurrences.map(p => ({ start: p.start, end: p.end, id: p.personId, type: 'person' as const }))
    ].sort((a, b) => a.start - b.start);

    if (highlights.length === 0) return [{ text: segment.text, type: 'text' }];

    const parts = [];
    let lastIndex = 0;

    highlights.forEach((h) => {
      // Handle overlaps (skip if start is before lastIndex)
      if (h.start < lastIndex) return;

      // Text before highlight
      if (h.start > lastIndex) {
        parts.push({
          text: segment.text.slice(lastIndex, h.start),
          type: 'text'
        });
      }

      // The highlight itself
      parts.push({
        text: segment.text.slice(h.start, h.end),
        type: h.type,
        id: h.id,
        isActive: h.type === 'term' ? h.id === activeTermId : h.id === activePersonId
      });

      lastIndex = h.end;
    });

    // Text after last highlight
    if (lastIndex < segment.text.length) {
      parts.push({
        text: segment.text.slice(lastIndex),
        type: 'text'
      });
    }

    return parts;
  }, [segment.text, occurrences, personOccurrences, activeTermId, activePersonId]);

  return (
    <>
      {/* Speaker Change Header - comfortable spacing */}
      {showSpeakerChange && (
        <div className="relative px-3 pt-3 pb-2 flex items-center gap-2 group">
          <div className="relative" ref={headerDropdownRef}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (onReassignSpeaker && allSpeakers.length > 1) {
                  setShowHeaderDropdown(!showHeaderDropdown);
                }
              }}
              className={cn(
                "flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium border transition-all",
                speakerBadgeColors,
                onReassignSpeaker && allSpeakers.length > 1 && "cursor-pointer hover:shadow-sm hover:scale-[1.02]"
              )}
              title={onReassignSpeaker && allSpeakers.length > 1 ? "Click to reassign all segments" : undefined}
            >
              {/* Speaker color dot - slightly larger for visibility */}
              <span className={cn("w-2 h-2 rounded-full", speakerDotColor)} />

              {/* Speaker name */}
              <span className="max-w-[120px] truncate">{speaker.displayName}</span>

              {/* Chevron for reassignment affordance */}
              {onReassignSpeaker && allSpeakers.length > 1 && (
                <ChevronDown size={12} className="opacity-60" />
              )}
            </button>

            {/* Rename button - shows on hover */}
            <button
              onClick={(e) => { e.stopPropagation(); onRenameSpeaker(speaker.speakerId); }}
              className="absolute -right-6 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1 hover:bg-slate-200 rounded transition-all"
              title="Rename Speaker"
            >
              <Edit2 size={12} className="text-slate-600" />
            </button>

            {/* Speaker reassignment dropdown (bulk reassignment) */}
            {showHeaderDropdown && (
              <div className="absolute left-0 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 min-w-[140px] py-1">
                <div className="px-2 py-1 text-xs text-slate-500 border-b border-slate-100">
                  Reassign all to:
                </div>
                {allSpeakers.map((s) => (
                  <button
                    key={s.speakerId}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleHeaderSpeakerSelect(s.speakerId);
                    }}
                    className={cn(
                      "w-full px-2 py-1.5 text-left text-xs hover:bg-slate-50 flex items-center gap-2 transition-colors",
                      s.speakerId === segment.speakerId && "bg-slate-100 font-medium"
                    )}
                  >
                    <span className={cn("w-2 h-2 rounded-full", SPEAKER_DOT_COLORS[s.colorIndex % SPEAKER_DOT_COLORS.length])} />
                    <span className="flex-1">{s.displayName}</span>
                    {s.speakerId === segment.speakerId && (
                      <span className="text-blue-500 text-sm">✓</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Minimal divider line */}
          <div className="flex-1 h-px bg-slate-200" />
        </div>
      )}

      {/* Segment with comfortable spacing */}
      <div
        {...(onReassignSpeaker && allSpeakers.length > 1 ? longPressHandlers : {})}
        onClick={(e) => {
          // Handle selection with Shift key
          if (onSegmentClick && e.shiftKey) {
            e.preventDefault();
            onSegmentClick(true);
          } else if (onSegmentClick && !e.shiftKey && !isActive) {
            // Regular click when not active - toggle selection
            onSegmentClick(false);
          } else if (!e.shiftKey) {
            // No selection handler or active segment - seek to timestamp
            onSeek(segment.startMs + 1);
          }
        }}
        className={cn(
          "group relative flex items-start gap-3 px-3 border-l-[3px] transition-all",
          // Tight vertical spacing - segments flow together
          "py-1.5",
          speakerBorderColor,
          isActive && "bg-blue-50/80 border border-blue-200 shadow-sm",
          isHighlighted && "bg-yellow-50 border border-yellow-300 shadow-md ring-1 ring-yellow-200",
          isSelected && "bg-purple-50 border border-purple-300 ring-1 ring-purple-200",
          !isActive && !isHighlighted && !isSelected && "hover:bg-slate-50/50",
          // Long-press visual feedback
          longPressHandlers.isLongPressing && onReassignSpeaker && allSpeakers.length > 1 && "scale-[1.02] opacity-95 cursor-context-menu",
          // Selection cursor
          onSegmentClick && "cursor-pointer"
        )}
      >
        {/* Timestamp Button - pill-shaped with proper touch targets */}
        <button
          onClick={() => onSeek(segment.startMs + 1)}
          className={cn(
            "text-[11px] font-mono shrink-0 tabular-nums transition-all rounded-full px-2 py-1 min-w-[44px] min-h-[28px] flex items-center justify-center",
            isActive
              ? "bg-blue-100 text-blue-700 font-semibold border border-blue-200"
              : "bg-slate-100 text-slate-600 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 border border-transparent"
          )}
          aria-label={`Seek to ${formatTime(segment.startMs)}`}
        >
          {formatTime(segment.startMs)}
        </button>

        {/* Text Content - comfortable line height for readability */}
        <p className={cn(
          "flex-1 text-[15px] leading-relaxed",  // Comfortable line height for better readability
          isActive ? "text-slate-900 font-medium" : "text-slate-800"
        )}>
          {textParts.map((part, i) => {
            if (part.type === 'term') {
              return (
                <span
                  key={i}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (part.id) onTermClick(part.id);
                  }}
                  className={cn(
                    "highlight-term cursor-pointer",
                    part.isActive && "active"
                  )}
                >
                  {part.text}
                </span>
              );
            }
            if (part.type === 'person') {
              return (
                <span
                  key={i}
                  className={cn(
                    "rounded px-0.5 transition-colors",
                    part.isActive ? "bg-purple-100 text-purple-900 font-medium" : "text-slate-900"
                  )}
                >
                  {part.text}
                </span>
              );
            }
            return <span key={i} onClick={() => onSeek(segment.startMs + 1)} className="cursor-pointer">{part.text}</span>;
          })}
        </p>
      </div>

      {/* Context Menu for Speaker Reassignment (long-press/right-click) */}
      {onReassignSpeaker && allSpeakers.length > 1 && (
        <SpeakerContextMenu
          isOpen={showContextMenu}
          position={contextMenuPosition}
          currentSpeaker={speaker}
          allSpeakers={allSpeakers}
          onReassign={handleContextMenuReassign}
          onRename={handleContextMenuRename}
          onClose={() => setShowContextMenu(false)}
        />
      )}
    </>
  );
};
