/**
 * SpeakerMergeModal - Modal for merging speakers
 *
 * Simple 3-click workflow:
 * 1. Click merge button on source speaker (opens modal)
 * 2. Click target speaker from list
 * 3. Confirm merge
 *
 * Design: Extracted from Viewer to keep components focused.
 * Follows RenameSpeakerModal pattern for consistency.
 */

import React, { useState } from 'react';
import { X, Users } from 'lucide-react';
import { Speaker } from '@/config/types';
import { Button } from '../Button';
import { cn } from '@/utils';

interface SpeakerMergeModalProps {
  /** The speaker being merged away (will be removed) */
  sourceSpeaker: Speaker;
  /** All speakers EXCEPT the source (these are merge targets) */
  targetSpeakers: Speaker[];
  /** Close modal without merging */
  onClose: () => void;
  /** Confirm merge with selected target */
  onConfirm: (targetSpeakerId: string) => void;
}

/**
 * Get color class for speaker color index
 * Matches the colors used in TranscriptSegment component
 */
function getSpeakerColorClass(colorIndex: number): string {
  const colors = [
    'bg-blue-100 text-blue-800',
    'bg-purple-100 text-purple-800',
    'bg-green-100 text-green-800',
    'bg-orange-100 text-orange-800',
    'bg-pink-100 text-pink-800',
    'bg-teal-100 text-teal-800',
    'bg-yellow-100 text-yellow-800',
    'bg-red-100 text-red-800'
  ];
  return colors[colorIndex % colors.length];
}

/**
 * SpeakerMergeModal component
 *
 * Shows list of target speakers to merge into.
 * User clicks a target speaker and then confirms.
 */
export const SpeakerMergeModal: React.FC<SpeakerMergeModalProps> = ({
  sourceSpeaker,
  targetSpeakers,
  onClose,
  onConfirm
}) => {
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);

  const handleConfirm = () => {
    if (!selectedTargetId) return;
    onConfirm(selectedTargetId);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-md rounded-xl shadow-2xl p-6 scale-100 animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex justify-between items-start mb-4">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Merge Speaker</h3>
            <p className="text-sm text-slate-600 mt-1">
              Merge <span className="font-medium text-slate-900">{sourceSpeaker.displayName}</span> into another speaker
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Target Speaker List */}
        <div className="mb-6 max-h-64 overflow-y-auto">
          {targetSpeakers.length === 0 ? (
            <div className="text-center py-8 text-slate-500">
              <Users size={32} className="mx-auto mb-2 text-slate-300" />
              <p className="text-sm">No other speakers available</p>
            </div>
          ) : (
            <div className="space-y-2">
              {targetSpeakers.map(speaker => (
                <button
                  key={speaker.speakerId}
                  onClick={() => setSelectedTargetId(speaker.speakerId)}
                  className={cn(
                    "w-full p-3 rounded-lg border-2 transition-all text-left",
                    selectedTargetId === speaker.speakerId
                      ? "border-blue-500 bg-blue-50 shadow-sm"
                      : "border-slate-200 hover:border-blue-300 hover:bg-slate-50"
                  )}
                >
                  <div className="flex items-center gap-3">
                    {/* Speaker color badge */}
                    <div className={cn(
                      "px-2 py-1 rounded text-xs font-medium",
                      getSpeakerColorClass(speaker.colorIndex)
                    )}>
                      {speaker.displayName}
                    </div>
                    {selectedTargetId === speaker.speakerId && (
                      <span className="text-xs text-blue-600 font-medium ml-auto">Selected</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={!selectedTargetId}
          >
            Merge Speakers
          </Button>
        </div>
      </div>
    </div>
  );
};
