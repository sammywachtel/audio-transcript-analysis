/**
 * useChat Hook
 *
 * Manages chat state for a conversation:
 * - Integrates with chatHistoryService for persistence
 * - Draft input text
 * - Loading and error states
 * - Optimistic updates for responsive UX
 * - Cost accumulation and warnings
 * - Rotating question suggestions
 * - Analytics tracking
 */

import { useState, useCallback, useEffect } from 'react';
import { sendChatMessage } from '../services/chatService';
import { chatHistoryService, TimestampSource, ChatHistoryMessage } from '../services/chatHistoryService';
import { analyticsService } from '../services/analyticsService';

/**
 * Chat message for display
 * Note: messages come from useChatHistory, this hook just handles sending
 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: TimestampSource[];
  costUsd?: number;
  isUnanswerable?: boolean;
  createdAt: string; // ISO timestamp
}

interface UseChatOptions {
  conversationId: string;
  messageCount: number; // From useChatHistory, used for limit checking
  messages?: ChatHistoryMessage[]; // Chat messages for cost calculation
}

interface UseChatReturn {
  draftInput: string;
  setDraftInput: (input: string) => void;
  isLoading: boolean;
  error: string | null;
  sendMessage: (message: string) => Promise<void>;
  clearError: () => void;
  isAtLimit: boolean; // True when at 50 message limit
  cumulativeCostUsd: number; // Total cost across all messages
  suggestions: string[]; // Current question suggestions
  costWarningLevel: 'none' | 'primary' | 'escalated'; // Progressive cost warning
}

/**
 * Base question suggestions pool
 * Rotates after each query to keep suggestions fresh
 */
const BASE_SUGGESTIONS = [
  'What are the main topics discussed?',
  'Who are the key people mentioned?',
  'What decisions were made?',
  'Can you summarize the conversation?',
  'What action items were mentioned?',
  'What are the key takeaways?',
  'What questions were raised?',
  'What was the main outcome?'
];

/**
 * Chat state management hook
 *
 * Handles message sending and persistence.
 * Works with useChatHistory for message loading/display.
 */
export function useChat({ conversationId, messageCount, messages = [] }: UseChatOptions): UseChatReturn {
  const [draftInput, setDraftInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestionOffset, setSuggestionOffset] = useState(0);

  // Check if we're at the 50 message limit
  const isAtLimit = messageCount >= 50;

  // Calculate cumulative cost from messages
  const cumulativeCostUsd = messages.reduce((total, msg) => {
    return total + (msg.costUsd || 0);
  }, 0);

  // Determine cost warning level
  const costWarningLevel: 'none' | 'primary' | 'escalated' =
    cumulativeCostUsd >= 1.25 ? 'escalated' :
    cumulativeCostUsd >= 0.50 ? 'primary' :
    'none';

  // Track cost warnings (fire once when threshold is crossed)
  useEffect(() => {
    if (costWarningLevel !== 'none') {
      analyticsService.trackCostWarning({
        conversationId,
        cumulativeCostUsd,
        warningLevel: costWarningLevel,
        messageCount
      });
    }
  }, [costWarningLevel, conversationId, cumulativeCostUsd, messageCount]);

  // Generate rotating suggestions (3 at a time)
  const suggestions = BASE_SUGGESTIONS
    .slice(suggestionOffset, suggestionOffset + 3)
    .concat(BASE_SUGGESTIONS.slice(0, Math.max(0, (suggestionOffset + 3) - BASE_SUGGESTIONS.length)));

  /**
   * Send a chat message and persist to Firestore
   * Adds both user message and assistant response to history
   */
  const sendMessage = useCallback(async (message: string) => {
    if (!message.trim() || isLoading || isAtLimit) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Track question analytics
      analyticsService.trackChatQuestion({
        conversationId,
        messageLength: message.length,
        messageCount
      });

      // Add user message to Firestore
      // Real-time listener in useChatHistory will show it immediately
      await chatHistoryService.addMessage(conversationId, {
        role: 'user',
        content: message
      });

      // Call backend for AI response
      const response = await sendChatMessage(conversationId, message);

      // Convert chatService sources to chatHistoryService format
      // Backend returns validated sources with speaker (not speakerId)
      const sources: TimestampSource[] = response.sources
        .filter(s => s.segmentId && s.startMs !== undefined && s.endMs !== undefined)
        .map(s => ({
          segmentId: s.segmentId!,
          startMs: s.startMs!,
          endMs: s.endMs!,
          speaker: s.speaker || 'Unknown',
          text: s.text || '' // Backend includes text; fallback if missing
        }));

      // Add assistant response to Firestore
      const assistantMessageId = await chatHistoryService.addMessage(conversationId, {
        role: 'assistant',
        content: response.answer,
        sources: sources.length > 0 ? sources : undefined,
        costUsd: response.costUsd,
        isUnanswerable: response.isUnanswerable
      });

      // Track response analytics
      analyticsService.trackChatResponse({
        conversationId,
        messageId: assistantMessageId,
        costUsd: response.costUsd || 0,
        isUnanswerable: response.isUnanswerable || false,
        sourceCount: sources.length
      });

      // Rotate suggestions after each query
      setSuggestionOffset((offset) => (offset + 3) % BASE_SUGGESTIONS.length);

      setDraftInput(''); // Clear input on success

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to send message';
      setError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  }, [conversationId, isLoading, isAtLimit, messageCount]);

  /**
   * Clear error state
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    draftInput,
    setDraftInput,
    isLoading,
    error,
    sendMessage,
    clearError,
    isAtLimit,
    cumulativeCostUsd,
    suggestions,
    costWarningLevel
  };
}
