import React, { useMemo, useState, useRef, useEffect } from 'react';
import { Segment, TermOccurrence, Speaker } from '../../types';
import { cn, formatTime } from '../../utils';
import { SPEAKER_COLORS } from '../../constants';
import { Edit2, ChevronDown } from 'lucide-react';

interface TranscriptSegmentProps {
  segment: Segment;
  speaker: Speaker;
  allSpeakers: Speaker[];  // All available speakers for reassignment
  occurrences: TermOccurrence[];
  personOccurrences?: { start: number; end: number; personId: string }[];
  isActive: boolean;
  activeTermId?: string;
  activePersonId?: string;
  onSeek: (ms: number) => void;
  onTermClick: (termId: string) => void;
  onRenameSpeaker: (speakerId: string) => void;
  onReassignSpeaker?: (segmentId: string, newSpeakerId: string) => void;
}

export const TranscriptSegment: React.FC<TranscriptSegmentProps> = ({
  segment,
  speaker,
  allSpeakers,
  occurrences,
  personOccurrences = [],
  isActive,
  activeTermId,
  activePersonId,
  onSeek,
  onTermClick,
  onRenameSpeaker,
  onReassignSpeaker
}) => {
  const [showSpeakerDropdown, setShowSpeakerDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowSpeakerDropdown(false);
      }
    };

    if (showSpeakerDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showSpeakerDropdown]);

  const handleSpeakerSelect = (newSpeakerId: string) => {
    if (newSpeakerId !== segment.speakerId && onReassignSpeaker) {
      onReassignSpeaker(segment.segmentId, newSpeakerId);
    }
    setShowSpeakerDropdown(false);
  };

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
    <div
      className={cn(
        "group relative flex gap-4 p-4 rounded-lg transition-colors duration-200 border border-transparent",
        isActive ? "bg-blue-100 border-blue-300 shadow-sm" : "hover:bg-slate-50"
      )}
    >
      {/* Time & Speaker Column */}
      <div className="flex-shrink-0 w-32 flex flex-col gap-1 items-start">
         <button
           onClick={() => onSeek(segment.startMs + 1)}  // +1ms to avoid boundary overlap issues
           className="text-xs font-mono text-slate-400 hover:text-blue-600 tabular-nums"
         >
           {formatTime(segment.startMs)}
         </button>
         <div className="flex items-center gap-2 relative" ref={dropdownRef}>
            {/* Speaker badge - clickable to reassign */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (onReassignSpeaker && allSpeakers.length > 1) {
                  setShowSpeakerDropdown(!showSpeakerDropdown);
                }
              }}
              className={cn(
                "px-2 py-0.5 rounded text-xs font-medium border max-w-[100px] truncate flex items-center gap-1",
                SPEAKER_COLORS[speaker.colorIndex % SPEAKER_COLORS.length],
                onReassignSpeaker && allSpeakers.length > 1 && "cursor-pointer hover:opacity-80"
              )}
              title={onReassignSpeaker && allSpeakers.length > 1 ? "Click to reassign speaker" : undefined}
            >
              {speaker.displayName}
              {onReassignSpeaker && allSpeakers.length > 1 && (
                <ChevronDown size={10} className="opacity-50" />
              )}
            </button>

            {/* Speaker reassignment dropdown */}
            {showSpeakerDropdown && (
              <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 min-w-[140px] py-1">
                <div className="px-2 py-1 text-xs text-slate-500 border-b border-slate-100">
                  Reassign to:
                </div>
                {allSpeakers.map((s) => (
                  <button
                    key={s.speakerId}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSpeakerSelect(s.speakerId);
                    }}
                    className={cn(
                      "w-full px-2 py-1.5 text-left text-xs hover:bg-slate-50 flex items-center gap-2",
                      s.speakerId === segment.speakerId && "bg-slate-100"
                    )}
                  >
                    <span
                      className={cn(
                        "w-2 h-2 rounded-full",
                        SPEAKER_COLORS[s.colorIndex % SPEAKER_COLORS.length].split(' ')[0]  // Just the bg color
                      )}
                    />
                    {s.displayName}
                    {s.speakerId === segment.speakerId && (
                      <span className="ml-auto text-slate-400">✓</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* Rename button */}
            <button
              onClick={(e) => { e.stopPropagation(); onRenameSpeaker(speaker.speakerId); }}
              className="opacity-0 group-hover:opacity-100 p-1 hover:bg-slate-200 rounded text-slate-500 transition-opacity"
              title="Rename Speaker"
            >
              <Edit2 size={12} />
            </button>
         </div>
      </div>

      {/* Text Column */}
      <div className="flex-grow text-base leading-relaxed text-slate-800">
        <p>
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
                    "highlight-term",
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
            return <span key={i} onClick={() => onSeek(segment.startMs + 1)} className="cursor-text">{part.text}</span>;  // +1ms to avoid boundary overlap
          })}
        </p>
      </div>
    </div>
  );
};
