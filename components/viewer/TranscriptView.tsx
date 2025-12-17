import React from 'react';
import { Conversation, Speaker, TermOccurrence } from '../../types';
import { TranscriptSegment } from './TranscriptSegment';
import { TopicMarker } from './TopicMarker';

interface TranscriptViewProps {
  conversation: Conversation;
  activeSegmentIndex: number;
  selectedTermId?: string;
  selectedPersonId?: string;
  personOccurrences: Record<string, { start: number; end: number; personId: string }[]>;
  onSeek: (ms: number) => void;
  onTermClick: (termId: string) => void;
  onRenameSpeaker: (speakerId: string) => void;
}

/**
 * TranscriptView - Renders the scrollable transcript with segments and topics
 *
 * Handles the layout and iteration of segments with their associated
 * topics, occurrences, and highlighting. Extracted from Viewer.tsx
 * to separate rendering concerns.
 */
export const TranscriptView: React.FC<TranscriptViewProps> = ({
  conversation,
  activeSegmentIndex,
  selectedTermId,
  selectedPersonId,
  personOccurrences,
  onSeek,
  onTermClick,
  onRenameSpeaker
}) => {
  return (
    <div className="flex-1 overflow-y-auto relative">
      <div className="max-w-3xl mx-auto px-4 py-8 pb-32">
        {conversation.segments.map((seg, idx) => {
          // Check if a topic starts at this segment
          const topic = conversation.topics.find(t => t.startIndex === idx);
          const isActive = idx === activeSegmentIndex;

          // Find term occurrences for this segment
          const segmentOccurrences = conversation.termOccurrences.filter(
            o => o.segmentId === seg.segmentId
          );
          const segmentPersonOccurrences = personOccurrences[seg.segmentId] || [];

          return (
            <div key={seg.segmentId} id={`segment-${seg.segmentId}`} className="mb-2">
              {topic && (
                <div className="mt-8 mb-4 px-4">
                  <TopicMarker topic={topic} />
                </div>
              )}

              <TranscriptSegment
                segment={seg}
                speaker={conversation.speakers[seg.speakerId]}
                occurrences={segmentOccurrences}
                personOccurrences={segmentPersonOccurrences}
                isActive={isActive}
                activeTermId={selectedTermId}
                activePersonId={selectedPersonId}
                onSeek={onSeek}
                onTermClick={onTermClick}
                onRenameSpeaker={onRenameSpeaker}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};
