import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { Conversation } from '../types';

interface ContextualAppDB extends DBSchema {
  conversations: {
    key: string;
    value: Conversation & { audioBlob?: Blob };
  };
}

const DB_NAME = 'contextual-transcript-app';
const DB_VERSION = 1;

/**
 * ConversationStorageService - Handles all IndexedDB operations for conversations
 *
 * Centralizes persistence logic so components don't need to know about storage details.
 * Blob URLs are ephemeral session-only constructs, so we store actual Blobs in IDB
 * and recreate URLs on load. This service handles all that nonsense for you.
 */
export class ConversationStorageService {
  private dbPromise: Promise<IDBPDatabase<ContextualAppDB>> | null = null;

  private async getDB(): Promise<IDBPDatabase<ContextualAppDB>> {
    if (!this.dbPromise) {
      this.dbPromise = openDB<ContextualAppDB>(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains('conversations')) {
            db.createObjectStore('conversations', { keyPath: 'conversationId' });
          }
        },
      });
    }
    return this.dbPromise;
  }

  /**
   * Save a conversation to IndexedDB
   * Fetches the audio blob from the URL before storing (since blob URLs expire)
   */
  async save(conversation: Conversation): Promise<void> {
    const db = await this.getDB();

    let audioBlob: Blob | undefined;

    // If we have a blob URL, fetch the actual blob data
    if (conversation.audioUrl && conversation.audioUrl.startsWith('blob:')) {
      try {
        const response = await fetch(conversation.audioUrl);
        if (!response.ok) throw new Error('Network response was not ok');
        audioBlob = await response.blob();
      } catch (e) {
        console.warn("Could not fetch blob from URL for saving. Attempting to preserve existing blob if update.", e);
        // Fallback: Preserve existing blob if this is an update operation
        const existing = await db.get('conversations', conversation.conversationId);
        if (existing && existing.audioBlob) {
          audioBlob = existing.audioBlob;
        }
      }
    }

    // Store without the ephemeral URL, but with the permanent Blob
    const { audioUrl, ...rest } = conversation;
    const itemToStore = {
      ...rest,
      audioBlob
    };

    await db.put('conversations', itemToStore);
  }

  /**
   * Load all conversations from IndexedDB
   * Recreates blob URLs from stored Blobs for the current session
   */
  async loadAll(): Promise<Conversation[]> {
    const db = await this.getDB();
    const items = await db.getAll('conversations');

    // Sort by newest first
    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return items.map(item => {
      const { audioBlob, ...rest } = item;
      let audioUrl: string | undefined;

      // Recreate the Blob URL for this session
      if (audioBlob) {
        audioUrl = URL.createObjectURL(audioBlob);
      }

      return {
        ...rest,
        people: item.people || [], // Migration safety for older records
        audioUrl
      } as Conversation;
    });
  }

  /**
   * Load a single conversation by ID
   */
  async loadById(id: string): Promise<Conversation | null> {
    const db = await this.getDB();
    const item = await db.get('conversations', id);

    if (!item) return null;

    const { audioBlob, ...rest } = item;
    let audioUrl: string | undefined;

    if (audioBlob) {
      audioUrl = URL.createObjectURL(audioBlob);
    }

    return {
      ...rest,
      people: item.people || [],
      audioUrl
    } as Conversation;
  }

  /**
   * Delete a conversation by ID
   */
  async delete(id: string): Promise<void> {
    const db = await this.getDB();
    await db.delete('conversations', id);
  }

  /**
   * Clear all conversations (useful for testing/debugging)
   */
  async clearAll(): Promise<void> {
    const db = await this.getDB();
    await db.clear('conversations');
  }
}

// Export a singleton instance
export const conversationStorage = new ConversationStorageService();
