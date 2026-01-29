import React, { useState, useRef, useEffect } from 'react';
import { Speaker } from '@/config/types';
import { SPEAKER_DOT_COLORS } from '@/config/constants';
import { X, ChevronDown } from 'lucide-react';
import { cn } from '@/utils';

interface TranscriptSelectionBarProps {
  selectedSegmentIds: Set<string>;
  allSpeakers: Speaker[];
  onReassign: (toSpeakerId: string) => void;
  onClear: () => void;
}

/**
 * TranscriptSelectionBar - Floating action bar for multi-segment operations
 *
 * Appears when segments are selected via Shift+Click.
 * Provides UI for bulk reassignment to a different speaker.
 */
export const TranscriptSelectionBar: React.FC<TranscriptSelectionBarProps> = ({
  selectedSegmentIds,
  allSpeakers,
  onReassign,
  onClear
}) => {
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };

    if (showDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showDropdown]);

  const handleSpeakerSelect = (speakerId: string) => {
    onReassign(speakerId);
    setShowDropdown(false);
  };

  if (selectedSegmentIds.size === 0) return null;

  return (
    <div
      className="fixed bottom-20 left-1/2 -translate-x-1/2 z-30 bg-slate-900 text-white rounded-lg shadow-2xl px-4 py-3 flex items-center gap-4 animate-in slide-in-from-bottom duration-200"
      style={{ minWidth: '320px' }}
    >
      {/* Selection count */}
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-sm font-semibold">
          {selectedSegmentIds.size}
        </div>
        <span className="text-sm font-medium">
          {selectedSegmentIds.size === 1 ? '1 segment selected' : `${selectedSegmentIds.size} segments selected`}
        </span>
      </div>

      {/* Reassign dropdown */}
      <div className="flex-1 relative" ref={dropdownRef}>
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          className="w-full px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm flex items-center justify-between gap-2 transition-colors"
        >
          <span>Reassign to...</span>
          <ChevronDown size={14} className={cn("transition-transform", showDropdown && "rotate-180")} />
        </button>

        {showDropdown && (
          <div className="absolute bottom-full left-0 right-0 mb-2 bg-white text-slate-900 border border-slate-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
            <div className="px-3 py-2 text-xs text-slate-500 border-b border-slate-100 font-medium">
              Select speaker:
            </div>
            {allSpeakers.map((speaker) => (
              <button
                key={speaker.speakerId}
                onClick={() => handleSpeakerSelect(speaker.speakerId)}
                className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50 flex items-center gap-2 transition-colors"
              >
                <span className={cn("w-2 h-2 rounded-full", SPEAKER_DOT_COLORS[speaker.colorIndex % SPEAKER_DOT_COLORS.length])} />
                <span className="flex-1">{speaker.displayName}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Clear button */}
      <button
        onClick={onClear}
        className="p-2 hover:bg-slate-700 rounded transition-colors"
        aria-label="Clear selection"
      >
        <X size={18} />
      </button>
    </div>
  );
};
