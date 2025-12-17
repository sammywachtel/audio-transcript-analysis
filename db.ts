import { openDB, DBSchema } from 'idb';
import { Conversation } from './types';

interface ContextualAppDB extends DBSchema {
  conversations: {
    key: string;
    value: Conversation & { audioBlob?: Blob };
  };
}

const DB_NAME = 'contextual-transcript-app';

export const initDB = async () => {
  return openDB<ContextualAppDB>(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('conversations')) {
        db.createObjectStore('conversations', { keyPath: 'conversationId' });
      }
    },
  });
};

export const saveConversationToDB = async (conversation: Conversation) => {
  const db = await initDB();

  // Prepare for storage
  // We need to store the audio data as a Blob, not a blob:URL (which expires)
  let audioBlob: Blob | undefined;

  // Check if we need to fetch the blob from the URL
  if (conversation.audioUrl && conversation.audioUrl.startsWith('blob:')) {
    try {
      const response = await fetch(conversation.audioUrl);
      if (!response.ok) throw new Error('Network response was not ok');
      audioBlob = await response.blob();
    } catch (e) {
      console.warn("Could not fetch blob from URL for saving. Attempting to preserve existing blob if update.", e);
      // Fallback: If we can't fetch the blob (e.g. during an update where the URL might be stale or tricky),
      // we try to fetch the *existing* record to preserve its blob.
      const existing = await db.get('conversations', conversation.conversationId);
      if (existing && existing.audioBlob) {
        audioBlob = existing.audioBlob;
      }
    }
  }

  // Create a storage object that excludes the ephemeral URL but includes the Blob
  const { audioUrl, ...rest } = conversation;
  const itemToStore = {
    ...rest,
    audioBlob
  };

  await db.put('conversations', itemToStore);
};

export const deleteConversationFromDB = async (conversationId: string) => {
    const db = await initDB();
    await db.delete('conversations', conversationId);
};

export const loadConversationsFromDB = async (): Promise<Conversation[]> => {
  const db = await initDB();
  const items = await db.getAll('conversations');

  // Sort by newest first (using createdAt string comparison is usually fine for ISO)
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return items.map(item => {
    const { audioBlob, ...rest } = item;
    let audioUrl: string | undefined;

    // Recreate the Blob URL for the current session
    if (audioBlob) {
      audioUrl = URL.createObjectURL(audioBlob);
    }

    return {
      ...rest,
      // Migration: Ensure 'people' array exists for older records
      people: item.people || [],
      audioUrl
    } as Conversation;
  });
};
