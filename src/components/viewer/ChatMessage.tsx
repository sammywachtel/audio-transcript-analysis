/**
 * ChatMessage Component
 *
 * Renders user and assistant chat messages with:
 * - Timestamp citations as interactive TimestampLinks
 * - Per-message cost indicator
 * - Special styling for unanswerable responses
 * - Error recovery for missing segments/audio
 */

import React from 'react';
import { User, Bot, Info } from 'lucide-react';
import { cn } from '@/utils';
import { CostIndicator } from '../shared/CostIndicator';
import { ChatHistoryMessage } from '@/services/chatHistoryService';
import { Speaker } from '@/config/types';
import { TimestampLink } from './TimestampLink';
import { MarkdownWithSources } from './MarkdownWithSources';

interface ChatMessageProps {
  message: ChatHistoryMessage;
  speakers: Record<string, Speaker>;
  conversationId: string;
  onSeek?: (timeMs: number) => void;
  onPlay?: () => void;
  onHighlight?: (segmentId: string | null) => void;
}

/**
 * ChatMessage - renders a single chat message (user or assistant)
 */
export const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  speakers,
  conversationId,
  onSeek,
  onPlay,
  onHighlight
}) => {
  const isUser = message.role === 'user';
  const isUnanswerable = message.isUnanswerable;
  const [unconsumedSources, setUnconsumedSources] = React.useState<Array<{ segmentId: string; startMs: number; speaker?: string }>>([]);

  return (
    <div
      className={cn(
        'flex gap-3 p-3 rounded-lg',
        isUser ? 'bg-blue-50/50' : isUnanswerable ? 'bg-slate-50' : 'bg-white border border-slate-200'
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          'shrink-0 w-7 h-7 rounded-full flex items-center justify-center',
          isUser ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-600'
        )}
      >
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>

      {/* Message Content */}
      <div className="flex-1 min-w-0">
        {/* Header: Role + Cost */}
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-medium text-slate-500">
            {isUser ? 'You' : 'Assistant'}
          </span>
          {!isUser && message.costUsd !== undefined && (
            <CostIndicator cost={message.costUsd} size="sm" showIcon={false} showBreakdown={false} />
          )}
        </div>

        {/* Message Text */}
        <div className={cn(
          'text-sm leading-relaxed',
          isUnanswerable ? 'text-slate-500 italic' : 'text-slate-900'
        )}>
          {isUnanswerable && (
            <div className="flex items-start gap-2 mb-1">
              <Info size={14} className="text-slate-400 mt-0.5 shrink-0" />
              <span className="text-xs text-slate-500">
                This information couldn't be found in the transcript.
              </span>
            </div>
          )}
          {/* Render markdown for all assistant messages (even without sources), plain text for user/unanswerable */}
          {!isUser && !isUnanswerable ? (
            <MarkdownWithSources
              content={message.content}
              sources={message.sources ?? []}
              speakers={speakers}
              conversationId={conversationId}
              onSeek={onSeek}
              onPlay={onPlay}
              onHighlight={onHighlight}
              onUnconsumedSources={setUnconsumedSources}
            />
          ) : (
            message.content
          )}
        </div>

        {/* Additional sources section - only show if there are unconsumed sources */}
        {!isUser && !isUnanswerable && unconsumedSources.length > 0 && (
          <div className="mt-2 pt-2 border-t border-slate-100">
            <div className="text-[10px] uppercase font-semibold text-slate-400 tracking-wider mb-1.5">
              Additional sources
            </div>
            <div className="flex flex-wrap gap-1.5">
              {unconsumedSources.map((source, idx) => {
                const speaker = source.speaker ? speakers[source.speaker] : null;
                const speakerName = speaker?.displayName || source.speaker || 'Unknown';

                return (
                  <TimestampLink
                    key={`${source.segmentId}-${idx}`}
                    segmentId={source.segmentId}
                    startMs={source.startMs}
                    speakerName={speakerName}
                    conversationId={conversationId}
                    analyticsSource="chat"
                    onSeek={onSeek}
                    onPlay={onPlay}
                    onHighlight={onHighlight}
                    autoPlay={true}
                  />
                );
              })}
            </div>
          </div>
        )}

        {/* Timestamp */}
        <div className="mt-1.5 text-[10px] text-slate-400">
          {message.createdAt
            ? new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : 'Just now'}
        </div>
      </div>
    </div>
  );
};
