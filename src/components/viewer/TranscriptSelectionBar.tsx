import React, { useState, useRef, useEffect } from 'react';
import { Speaker } from '@/config/types';
import { SPEAKER_DOT_COLORS } from '@/config/constants';
import { X, ChevronDown, MousePointerClick } from 'lucide-react';
import { cn } from '@/utils';

interface TranscriptSelectionBarProps {
  selectedSegmentIds: Set<string>;
  allSpeakers: Speaker[];
  isSelectionMode?: boolean;
  onToggleSelectionMode?: () => void;
  onReassign: (toSpeakerId: string) => void;
  onClear: () => void;
}

/**
 * TranscriptSelectionBar - Floating action bar for multi-segment operations
 *
 * Three-state rendering:
 * 1. Not in selection mode, no selections → compact "Select" toggle button
 * 2. In selection mode (0 or more selections) → full bar with controls
 * 3. Not in selection mode, selections exist → "Resume" bar with count
 */
export const TranscriptSelectionBar: React.FC<TranscriptSelectionBarProps> = ({
  selectedSegmentIds,
  allSpeakers,
  isSelectionMode = false,
  onToggleSelectionMode,
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

  // Close dropdown when exiting selection mode
  useEffect(() => {
    if (!isSelectionMode) {
      setShowDropdown(false);
    }
  }, [isSelectionMode]);

  const handleSpeakerSelect = (speakerId: string) => {
    onReassign(speakerId);
    setShowDropdown(false);
  };

  const count = selectedSegmentIds.size;

  // State 1: Not in selection mode, no selections → compact toggle button
  if (!isSelectionMode && count === 0) {
    return (
      <div className="fixed bottom-20 right-4 z-30 animate-in fade-in duration-200">
        <button
          onClick={onToggleSelectionMode}
          className="flex items-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-white text-sm rounded-lg shadow-lg transition-colors"
          title="Enter selection mode (S)"
        >
          <MousePointerClick size={16} />
          <span>Select</span>
        </button>
      </div>
    );
  }

  // State 3: Not in selection mode, but selections exist → resume bar
  if (!isSelectionMode && count > 0) {
    return (
      <div
        className="fixed bottom-20 left-1/2 -translate-x-1/2 z-30 bg-slate-800 text-white rounded-lg shadow-2xl px-4 py-3 flex items-center gap-3 animate-in slide-in-from-bottom duration-200"
        style={{ minWidth: '280px' }}
      >
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-purple-500 flex items-center justify-center text-xs font-semibold">
            {count}
          </div>
          <span className="text-sm text-slate-300">
            {count === 1 ? 'segment selected' : 'segments selected'}
          </span>
        </div>

        <div className="flex-1" />

        <button
          onClick={onToggleSelectionMode}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 rounded text-sm font-medium transition-colors"
        >
          <MousePointerClick size={14} />
          Resume
        </button>

        <button
          onClick={onClear}
          className="p-1.5 hover:bg-slate-700 rounded transition-colors"
          aria-label="Clear selection"
          title="Clear selection"
        >
          <X size={16} />
        </button>
      </div>
    );
  }

  // State 2: In selection mode → full bar with all controls
  return (
    <div
      className="fixed bottom-20 left-1/2 -translate-x-1/2 z-30 bg-slate-900 text-white rounded-lg shadow-2xl px-4 py-3 flex items-center gap-4 animate-in slide-in-from-bottom duration-200"
      style={{ minWidth: '340px' }}
    >
      {/* Mode indicator + count */}
      <div className="flex items-center gap-2">
        {count > 0 ? (
          <div className="w-8 h-8 rounded-full bg-purple-500 flex items-center justify-center text-sm font-semibold">
            {count}
          </div>
        ) : (
          <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center">
            <MousePointerClick size={16} className="text-purple-400" />
          </div>
        )}
        <span className="text-sm font-medium">
          {count === 0
            ? 'Click segments to select'
            : count === 1
              ? '1 segment selected'
              : `${count} segments selected`}
        </span>
      </div>

      {/* Reassign dropdown — only when segments are selected */}
      {count > 0 && (
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
      )}

      {/* Spacer when no dropdown */}
      {count === 0 && <div className="flex-1" />}

      {/* Clear button — only when segments are selected */}
      {count > 0 && (
        <button
          onClick={onClear}
          className="p-1.5 hover:bg-slate-700 rounded transition-colors"
          aria-label="Clear selection"
          title="Clear selection"
        >
          <X size={16} />
        </button>
      )}

      {/* Exit selection mode */}
      <button
        onClick={onToggleSelectionMode}
        className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm transition-colors"
        title="Exit selection mode (Esc)"
      >
        Done
      </button>
    </div>
  );
};
