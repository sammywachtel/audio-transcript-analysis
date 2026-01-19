/**
 * useChatHistory Hook
 *
 * Manages chat history loading and pagination:
 * - Subscribes to real-time message updates
 * - Loads initial 10 messages
 * - Provides pagination for older messages
 * - Tracks message count for limit enforcement
 * - Cleans up listener on unmount
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  chatHistoryService,
  ChatHistoryMessage
} from '../services/chatHistoryService';

interface UseChatHistoryOptions {
  conversationId: string | null;
  enabled?: boolean; // Allow disabling subscription (e.g., when chat tab not active)
}

interface UseChatHistoryReturn {
  messages: ChatHistoryMessage[];
  isLoading: boolean;
  hasOlder: boolean;
  messageCount: number;
  loadOlder: () => Promise<void>;
  refreshCount: () => Promise<void>;
}

/**
 * Chat history management hook
 *
 * Features:
 * - Real-time Firestore listener for new messages
 * - Pagination support for loading older messages
 * - Message count tracking for 50 message limit
 * - Automatic cleanup when conversation changes
 */
export function useChatHistory({
  conversationId,
  enabled = true
}: UseChatHistoryOptions): UseChatHistoryReturn {
  const [messages, setMessages] = useState<ChatHistoryMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [messageCount, setMessageCount] = useState(0);

  // Track unsubscribe function for cleanup
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Track if we've loaded the initial batch (to avoid duplicate subscriptions)
  const initialLoadRef = useRef(false);

  /**
   * Refresh message count
   * Call this after adding/clearing messages
   */
  const refreshCount = useCallback(async () => {
    if (!conversationId) {
      setMessageCount(0);
      return;
    }

    try {
      const count = await chatHistoryService.getMessageCount(conversationId);
      setMessageCount(count);
    } catch (error) {
      console.error('[useChatHistory] Failed to refresh count:', error);
    }
  }, [conversationId]);

  /**
   * Load older messages for pagination
   * Loads messages before the oldest currently loaded message
   */
  const loadOlder = useCallback(async () => {
    if (!conversationId || messages.length === 0 || !hasOlder || isLoading) {
      return;
    }

    setIsLoading(true);

    try {
      const oldestMessage = messages[0];
      const olderMessages = await chatHistoryService.loadOlderMessages(
        conversationId,
        oldestMessage.createdAt,
        10
      );

      if (olderMessages.length > 0) {
        // Prepend older messages to the list
        setMessages(prev => [...olderMessages, ...prev]);

        // Check if there might be even older messages
        // If we got fewer than requested, we've hit the beginning
        setHasOlder(olderMessages.length === 10);
      } else {
        setHasOlder(false);
      }
    } catch (error) {
      console.error('[useChatHistory] Failed to load older messages:', error);
    } finally {
      setIsLoading(false);
    }
  }, [conversationId, messages, hasOlder, isLoading]);

  /**
   * Set up real-time listener when conversation changes
   */
  useEffect(() => {
    // Reset state when conversation changes
    setMessages([]);
    setMessageCount(0);
    setHasOlder(false);
    initialLoadRef.current = false;

    // Clean up previous listener
    if (unsubscribeRef.current) {
      console.log('[useChatHistory] Cleaning up previous listener');
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }

    // Don't subscribe if disabled or no conversation
    if (!enabled || !conversationId) {
      return;
    }

    // Set up new listener
    console.log('[useChatHistory] Setting up listener for:', conversationId);

    unsubscribeRef.current = chatHistoryService.subscribeToMessages(
      conversationId,
      10, // Load most recent 10 messages initially
      (updatedMessages) => {
        setMessages(updatedMessages);

        // After initial load, check if there are older messages
        if (!initialLoadRef.current) {
          initialLoadRef.current = true;
          // If we got exactly 10 messages, there might be more
          setHasOlder(updatedMessages.length === 10);
        }

        // Refresh the count whenever the snapshot changes - this ensures
        // export/clear buttons enable immediately when messages arrive.
        // The count may differ from updatedMessages.length due to pagination
        // (we only load 10 most recent), so we need the server count.
        refreshCount();
      }
    );

    // Cleanup on unmount or conversation change
    return () => {
      if (unsubscribeRef.current) {
        console.log('[useChatHistory] Cleaning up listener on unmount');
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, [conversationId, enabled, refreshCount]);

  return {
    messages,
    isLoading,
    hasOlder,
    messageCount,
    loadOlder,
    refreshCount
  };
}
