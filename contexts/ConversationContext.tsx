import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { Conversation } from '../types';
import { firestoreService } from '../services/firestoreService';
import { storageService } from '../services/storageService';
import { useAuth } from './AuthContext';

interface ConversationContextValue {
  // State
  conversations: Conversation[];
  activeConversationId: string | null;
  isLoaded: boolean;
  syncStatus: 'offline' | 'syncing' | 'synced' | 'error';

  // Computed
  activeConversation: Conversation | null;

  // Actions
  loadConversations: () => Promise<void>;
  addConversation: (conversation: Conversation, audioFile?: File) => Promise<void>;
  updateConversation: (conversation: Conversation) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  setActiveConversationId: (id: string | null) => void;
  getAudioUrl: (conversationId: string) => Promise<string | null>;
}

const ConversationContext = createContext<ConversationContextValue | null>(null);

/**
 * ConversationProvider - Manages all conversation state and persistence
 *
 * Uses Firebase backend:
 * - Firestore for conversation metadata and transcripts
 * - Firebase Storage for audio files
 * - Cloud Functions for Gemini API processing
 *
 * Key features:
 * - Real-time listeners for instant cross-device updates
 * - Optimistic UI updates for responsive feel
 * - Audio URL caching to avoid repeated Storage calls
 * - Automatic cleanup of resources on unmount
 */
export const ConversationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'offline' | 'syncing' | 'synced' | 'error'>('offline');

  // Cache for audio URLs (audioStoragePath -> blobUrl)
  const audioUrlCache = useRef<Map<string, string>>(new Map());

  // Track the unsubscribe function for Firestore listener
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Derived state: find the active conversation
  const activeConversation = conversations.find(c => c.conversationId === activeConversationId) || null;

  /**
   * Get audio URL for a conversation
   * Fetches from Firebase Storage and caches the result
   */
  const getAudioUrl = useCallback(async (conversationId: string): Promise<string | null> => {
    const conversation = conversations.find(c => c.conversationId === conversationId);
    if (!conversation) return null;

    // Check if we already have a URL (e.g., from initial load)
    if (conversation.audioUrl) {
      return conversation.audioUrl;
    }

    // Get the URL from Storage
    const storagePath = (conversation as any).audioStoragePath;
    if (!storagePath) return null;

    // Check cache first
    if (audioUrlCache.current.has(storagePath)) {
      return audioUrlCache.current.get(storagePath)!;
    }

    try {
      const url = await storageService.getAudioUrl(storagePath);
      audioUrlCache.current.set(storagePath, url);
      return url;
    } catch (error) {
      console.error('[ConversationContext] Failed to get audio URL:', error);
      return null;
    }
  }, [conversations]);

  /**
   * Load conversations for the current user
   * Uses real-time Firestore listener for instant updates
   */
  const loadConversations = useCallback(async () => {
    if (!user) {
      console.log('[ConversationContext] No user, skipping conversation load');
      setConversations([]);
      setIsLoaded(true);
      setSyncStatus('offline');
      return;
    }

    setSyncStatus('syncing');

    // Set up real-time listener for Firestore
    console.log('[ConversationContext] Setting up Firestore real-time listener for user:', user.uid);

    // Unsubscribe from previous listener if exists
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
    }

    unsubscribeRef.current = firestoreService.subscribeToUserConversations(
      user.uid,
      (updatedConversations) => {
        setConversations(updatedConversations);
        setIsLoaded(true);
        setSyncStatus('synced');
      },
      (error) => {
        console.error('[ConversationContext] Firestore listener error:', error);
        setSyncStatus('error');
        setIsLoaded(true);
      }
    );
  }, [user]);

  /**
   * Add a new conversation (typically after upload/processing)
   * Automatically associates the conversation with the current user
   * Uploads audio to Firebase Storage, triggering Cloud Function for transcription
   */
  const addConversation = useCallback(async (conversation: Conversation, audioFile?: File) => {
    if (!user) {
      throw new Error("Must be signed in to save conversations");
    }

    // Ensure conversation has userId and updatedAt
    const conversationWithUser: Conversation = {
      ...conversation,
      userId: user.uid,
      updatedAt: conversation.updatedAt || new Date().toISOString()
    };

    try {
      let audioStoragePath: string | undefined;

      // Upload audio to Firebase Storage if provided
      if (audioFile) {
        console.log('[ConversationContext] Uploading audio to Firebase Storage...');
        const result = await storageService.uploadAudio(
          user.uid,
          conversation.conversationId,
          audioFile
        );
        audioStoragePath = result.storagePath;
        // Note: We don't need to store the cancel function here since we wait for completion
      }

      // Save to Firestore
      await firestoreService.save(conversationWithUser, audioStoragePath);
      console.log('[ConversationContext] Saved to Firestore:', conversation.conversationId);

      // Real-time listener will update the UI automatically
    } catch (err) {
      console.error('[ConversationContext] Failed to save conversation to Firestore', err);
      throw new Error('Failed to save conversation to cloud. Please try again.');
    }
  }, [user]);

  /**
   * Update an existing conversation (e.g., speaker rename, person notes)
   * Updates the updatedAt timestamp automatically
   */
  const updateConversation = useCallback(async (conversation: Conversation) => {
    if (!user) {
      throw new Error("Must be signed in to update conversations");
    }

    const conversationWithTimestamp: Conversation = {
      ...conversation,
      updatedAt: new Date().toISOString()
    };

    // Optimistic UI update for responsive feel
    setConversations(prev =>
      prev.map(c => c.conversationId === conversationWithTimestamp.conversationId ? conversationWithTimestamp : c)
    );

    try {
      await firestoreService.save(conversationWithTimestamp);
      // Real-time listener will confirm the update
    } catch (err) {
      console.error('[ConversationContext] Failed to persist conversation update to Firestore', err);
      // Could revert optimistic update here, but keeping it simple
    }
  }, [user]);

  /**
   * Delete a conversation
   * Also deletes the audio file from Firebase Storage
   */
  const deleteConversation = useCallback(async (id: string) => {
    // Get the conversation before deleting (for audio cleanup)
    const conversation = conversations.find(c => c.conversationId === id);

    // Optimistic UI update
    setConversations(prev => prev.filter(c => c.conversationId !== id));

    if (activeConversationId === id) {
      setActiveConversationId(null);
    }

    try {
      // Delete from Firestore
      await firestoreService.delete(id);

      // Delete audio from Storage if it exists
      const audioStoragePath = (conversation as any)?.audioStoragePath;
      if (audioStoragePath) {
        await storageService.deleteAudio(audioStoragePath);
        audioUrlCache.current.delete(audioStoragePath);
      }

      console.log('[ConversationContext] Deleted conversation and audio:', id);
    } catch (err) {
      console.error('[ConversationContext] Failed to delete conversation from Firestore', err);
      // Could revert optimistic update here
    }
  }, [activeConversationId, conversations]);

  // Set up listener on mount, clean up on unmount
  useEffect(() => {
    loadConversations();

    // Cleanup function
    return () => {
      // Unsubscribe from Firestore listener
      if (unsubscribeRef.current) {
        console.log('[ConversationContext] Cleaning up Firestore listener');
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }

      // Revoke any cached blob URLs to free memory
      audioUrlCache.current.forEach((url) => {
        if (url.startsWith('blob:')) {
          URL.revokeObjectURL(url);
        }
      });
      audioUrlCache.current.clear();
    };
  }, [loadConversations]);

  const value: ConversationContextValue = {
    conversations,
    activeConversationId,
    isLoaded,
    syncStatus,
    activeConversation,
    loadConversations,
    addConversation,
    updateConversation,
    deleteConversation,
    setActiveConversationId,
    getAudioUrl
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
