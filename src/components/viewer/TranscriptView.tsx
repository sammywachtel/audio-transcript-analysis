import React, { useState, useCallback } from 'react';
import { Conversation } from '@/config/types';
import { TranscriptSegment } from './TranscriptSegment';
import { TopicMarker } from './TopicMarker';
import { TranscriptSelectionBar } from './TranscriptSelectionBar';

interface TranscriptViewProps {
  conversation: Conversation;
  activeSegmentIndex: number;
  selectedTermId?: string;
  selectedPersonId?: string;
  personOccurrences: Record<string, { start: number; end: number; personId: string }[]>;
  highlightedSegmentId?: string | null;
  recentReassignSegmentIds?: string[];
  onSeek: (ms: number) => void;
  onTermClick: (termId: string) => void;
  onRenameSpeaker: (speakerId: string) => void;
  onReassignSpeaker?: (segmentId: string, newSpeakerId: string) => void;
  onReassignSegments?: (segmentIds: string[], toSpeakerId: string) => void;
}

/**
 * TranscriptView - Renders the scrollable transcript with segments and topics
 *
 * Handles the layout and iteration of segments with their associated
 * topics, occurrences, and highlighting. Extracted from Viewer.tsx
 * to separate rendering concerns.
 *
 * Also manages multi-segment selection via Shift+Click for bulk reassignment.
 */
export const TranscriptView: React.FC<TranscriptViewProps> = ({
  conversation,
  activeSegmentIndex,
  selectedTermId,
  selectedPersonId,
  personOccurrences,
  highlightedSegmentId,
  recentReassignSegmentIds = [],
  onSeek,
  onTermClick,
  onRenameSpeaker,
  onReassignSpeaker,
  onReassignSegments
}) => {
  // Get all speakers as an array for the reassignment dropdown
  const allSpeakers = Object.values(conversation.speakers);

  // Multi-select state for bulk operations
  const [selectedSegmentIds, setSelectedSegmentIds] = useState<Set<string>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);

  /**
   * Handle segment click with Shift modifier for multi-select
   */
  const handleSegmentClick = useCallback((segmentId: string, segmentIndex: number, shiftKey: boolean) => {
    if (!shiftKey) {
      // Regular click - toggle single selection
      setSelectedSegmentIds(prev => {
        const next = new Set(prev);
        if (next.has(segmentId)) {
          next.delete(segmentId);
        } else {
          next.add(segmentId);
        }
        return next;
      });
      setLastSelectedIndex(segmentIndex);
    } else {
      // Shift+Click - select range
      if (lastSelectedIndex !== null) {
        const start = Math.min(lastSelectedIndex, segmentIndex);
        const end = Math.max(lastSelectedIndex, segmentIndex);
        const rangeIds = conversation.segments.slice(start, end + 1).map(s => s.segmentId);

        setSelectedSegmentIds(prev => {
          const next = new Set(prev);
          rangeIds.forEach(id => next.add(id));
          return next;
        });
      } else {
        // No previous selection, just select this one
        setSelectedSegmentIds(new Set([segmentId]));
        setLastSelectedIndex(segmentIndex);
      }
    }
  }, [lastSelectedIndex, conversation.segments]);

  /**
   * Handle bulk reassignment via selection bar
   */
  const handleBulkReassign = useCallback((toSpeakerId: string) => {
    if (selectedSegmentIds.size === 0 || !onReassignSegments) return;

    onReassignSegments(Array.from(selectedSegmentIds), toSpeakerId);
    setSelectedSegmentIds(new Set()); // Clear selection after reassignment
    setLastSelectedIndex(null);
  }, [selectedSegmentIds, onReassignSegments]);

  /**
   * Clear selection
   */
  const handleClearSelection = useCallback(() => {
    setSelectedSegmentIds(new Set());
    setLastSelectedIndex(null);
  }, []);
  return (
    <div className="flex-1 overflow-y-auto relative">
      <div className="max-w-3xl mx-auto px-4 py-8 pb-32">
        {conversation.segments.map((seg, idx) => {
          // Check if a topic starts at this segment
          const topic = conversation.topics.find(t => t.startIndex === idx);
          const isActive = idx === activeSegmentIndex;
          const isHighlighted = highlightedSegmentId === seg.segmentId;
          const isSelected = selectedSegmentIds.has(seg.segmentId);
          const isRecentlyReassigned = recentReassignSegmentIds.includes(seg.segmentId);

          // Find term occurrences for this segment
          const segmentOccurrences = conversation.termOccurrences.filter(
            o => o.segmentId === seg.segmentId
          );
          const segmentPersonOccurrences = personOccurrences[seg.segmentId] || [];

          // Check if speaker changed from previous segment
          const previousSegment = idx > 0 ? conversation.segments[idx - 1] : null;
          const showSpeakerChange = !previousSegment || previousSegment.speakerId !== seg.speakerId;

          return (
            <div key={seg.segmentId} id={`segment-${seg.segmentId}`}>
              {topic && (
                <div className="mt-8 mb-4 px-4">
                  <TopicMarker topic={topic} />
                </div>
              )}

              <TranscriptSegment
                segment={seg}
                speaker={conversation.speakers[seg.speakerId] ?? {
                  speakerId: seg.speakerId,
                  displayName: seg.speakerId,
                  colorIndex: 0
                }}
                allSpeakers={allSpeakers}
                occurrences={segmentOccurrences}
                personOccurrences={segmentPersonOccurrences}
                isActive={isActive}
                isHighlighted={isHighlighted}
                isSelected={isSelected}
                isRecentlyReassigned={isRecentlyReassigned}
                activeTermId={selectedTermId}
                activePersonId={selectedPersonId}
                showSpeakerChange={showSpeakerChange}
                onSeek={onSeek}
                onTermClick={onTermClick}
                onRenameSpeaker={onRenameSpeaker}
                onReassignSpeaker={onReassignSpeaker}
                onSegmentClick={(shiftKey) => handleSegmentClick(seg.segmentId, idx, shiftKey)}
              />
            </div>
          );
        })}
      </div>

      {/* Selection bar for bulk operations */}
      {onReassignSegments && (
        <TranscriptSelectionBar
          selectedSegmentIds={selectedSegmentIds}
          allSpeakers={allSpeakers}
          onReassign={handleBulkReassign}
          onClear={handleClearSelection}
        />
      )}
    </div>
  );
};
