/**
 * ChatMessage Component
 *
 * Renders user and assistant chat messages with:
 * - Timestamp citations as interactive TimestampLinks
 * - Per-message cost indicator
 * - Special styling for unanswerable responses
 * - Error recovery for missing segments/audio
 * - Copy-to-clipboard for assistant messages (strips citations)
 */

import React, { useState, useCallback } from 'react';
import { User, Bot, Info, Copy, Check } from 'lucide-react';
import { cn } from '@/utils';
import { CostIndicator } from '../shared/CostIndicator';
import { ChatHistoryMessage } from '@/services/chatHistoryService';
import { Speaker } from '@/config/types';
import { TimestampLink } from './TimestampLink';
import { MarkdownWithSources } from './MarkdownWithSources';

/**
 * Strips [segment N] citations and converts markdown to readable plain text.
 *
 * We intentionally do a lightweight conversion rather than pulling in a heavy
 * markdown-to-text library. Good enough for chat messages.
 */
function prepareTextForClipboard(content: string): string {
  let text = content;

  // Strip [segment N] citations (including comma-separated lists)
  text = text.replace(/\[segment\s+\d+(?:\s*,\s*segment\s+\d+)*\]/gi, '');

  // Strip {{SOURCE_n}} markers if any remain
  text = text.replace(/\{\{SOURCE_\d+\}\}/g, '');

  // Convert markdown to plain text (lightweight):
  // Bold/italic: **text** or *text* or __text__ or _text_ -> text
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/\*(.+?)\*/g, '$1');
  text = text.replace(/__(.+?)__/g, '$1');
  text = text.replace(/_(.+?)_/g, '$1');

  // Strikethrough: ~~text~~ -> text
  text = text.replace(/~~(.+?)~~/g, '$1');

  // Inline code: `code` -> code
  text = text.replace(/`(.+?)`/g, '$1');

  // Links: [text](url) -> text
  text = text.replace(/\[(.+?)\]\(.+?\)/g, '$1');

  // Headers: # Header -> Header (strip leading #s)
  text = text.replace(/^#{1,6}\s+/gm, '');

  // List markers: - item or * item or 1. item -> • item
  text = text.replace(/^[-*]\s+/gm, '• ');
  text = text.replace(/^\d+\.\s+/gm, '• ');

  // Blockquotes: > text -> text
  text = text.replace(/^>\s*/gm, '');

  // Horizontal rules: --- or *** or ___ -> empty
  text = text.replace(/^[-*_]{3,}$/gm, '');

  // Clean up multiple blank lines
  text = text.replace(/\n{3,}/g, '\n\n');

  // Trim leading/trailing whitespace
  return text.trim();
}

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
  const [unconsumedSources, setUnconsumedSources] = useState<Array<{ segmentId: string; startMs: number; speaker?: string }>>([]);
  const [copied, setCopied] = useState(false);

  /**
   * Copy message content to clipboard, stripping citations and markdown.
   * Shows brief "Copied!" feedback, then reverts.
   */
  const handleCopy = useCallback(async () => {
    const plainText = prepareTextForClipboard(message.content);

    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers or permission issues
      const textArea = document.createElement('textarea');
      textArea.value = plainText;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        console.error('[ChatMessage] Copy fallback failed');
      }
      document.body.removeChild(textArea);
    }
  }, [message.content]);

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
        {/* Header: Role + Copy + Cost */}
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-medium text-slate-500">
            {isUser ? 'You' : 'Assistant'}
          </span>
          <div className="flex items-center gap-2">
            {/* Copy button - all assistant messages (including unanswerable) */}
            {!isUser && (
              <button
                onClick={handleCopy}
                className={cn(
                  'p-1 rounded transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1',
                  copied
                    ? 'text-green-600 bg-green-50'
                    : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
                )}
                aria-label={copied ? 'Copied to clipboard' : 'Copy message'}
                title={copied ? 'Copied!' : 'Copy message'}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            )}
            {!isUser && message.costUsd !== undefined && (
              <CostIndicator cost={message.costUsd} size="sm" showIcon={false} showBreakdown={false} />
            )}
          </div>
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
