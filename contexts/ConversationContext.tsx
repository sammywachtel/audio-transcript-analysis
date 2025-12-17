import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { Conversation } from '../types';
import { conversationStorage } from '../services/conversationStorage';
import { MOCK_CONVERSATION } from '../constants';

interface ConversationContextValue {
  // State
  conversations: Conversation[];
  activeConversationId: string | null;
  isLoaded: boolean;

  // Computed
  activeConversation: Conversation | null;

  // Actions
  loadConversations: () => Promise<void>;
  addConversation: (conversation: Conversation) => Promise<void>;
  updateConversation: (conversation: Conversation) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  setActiveConversationId: (id: string | null) => void;
}

const ConversationContext = createContext<ConversationContextValue | null>(null);

/**
 * ConversationProvider - Manages all conversation state and persistence
 *
 * This context separates data management from UI rendering.
 * Components can subscribe to conversation state without knowing
 * about IndexedDB, API calls, or other implementation details.
 */
export const ConversationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [conversations, setConversations] = useState<Conversation[]>([MOCK_CONVERSATION]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  // Derived state: find the active conversation
  const activeConversation = conversations.find(c => c.conversationId === activeConversationId) || null;

  /**
   * Load all conversations from storage on mount
   */
  const loadConversations = useCallback(async () => {
    try {
      const stored = await conversationStorage.loadAll();
      if (stored.length > 0) {
        setConversations(stored);
      }
    } catch (e) {
      console.error("Failed to load conversations from storage", e);
      // Don't throw - just keep the mock data loaded
    } finally {
      setIsLoaded(true);
    }
  }, []);

  /**
   * Add a new conversation (typically after upload/processing)
   */
  const addConversation = useCallback(async (conversation: Conversation) => {
    try {
      // Persist first for data safety
      await conversationStorage.save(conversation);

      // Then update UI
      setConversations(prev => [conversation, ...prev]);
    } catch (err) {
      console.error("Failed to save conversation", err);
      throw new Error("Failed to save conversation to storage. Please try again.");
    }
  }, []);

  /**
   * Update an existing conversation (e.g., speaker rename, person notes)
   */
  const updateConversation = useCallback(async (conversation: Conversation) => {
    // Update UI immediately for responsive feel
    setConversations(prev =>
      prev.map(c => c.conversationId === conversation.conversationId ? conversation : c)
    );

    // Persist in background
    try {
      await conversationStorage.save(conversation);
    } catch (err) {
      console.error("Failed to persist conversation update", err);
      // Already updated UI, so just log the error
    }
  }, []);

  /**
   * Delete a conversation
   */
  const deleteConversation = useCallback(async (id: string) => {
    try {
      // Optimistic UI update
      setConversations(prev => prev.filter(c => c.conversationId !== id));

      // Clear active if we just deleted it
      if (activeConversationId === id) {
        setActiveConversationId(null);
      }

      // Persist deletion
      await conversationStorage.delete(id);
    } catch (err) {
      console.error("Failed to delete conversation", err);
      // Could implement revert logic here, but for now just log
    }
  }, [activeConversationId]);

  // Load conversations on mount
  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const value: ConversationContextValue = {
    conversations,
    activeConversationId,
    isLoaded,
    activeConversation,
    loadConversations,
    addConversation,
    updateConversation,
    deleteConversation,
    setActiveConversationId
  };

  return (
    <ConversationContext.Provider value={value}>
      {children}
    </ConversationContext.Provider>
  );
};

/**
 * useConversations - Hook to access conversation context
 * Throws if used outside of ConversationProvider
 */
export const useConversations = (): ConversationContextValue => {
  const context = useContext(ConversationContext);
  if (!context) {
    throw new Error('useConversations must be used within a ConversationProvider');
  }
  return context;
};
