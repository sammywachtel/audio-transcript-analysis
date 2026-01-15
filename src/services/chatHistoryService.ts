import {
  collection,
  doc,
  setDoc,
  getDocs,
  query,
  orderBy,
  limit as firestoreLimit,
  startAfter,
  onSnapshot,
  Timestamp,
  serverTimestamp,
  Unsubscribe,
  QuerySnapshot,
  DocumentData,
  writeBatch,
  getCountFromServer
} from 'firebase/firestore';
import { db } from '@/config/firebase-config';

/**
 * Chat message timestamp source - links to transcript segment
 */
export interface TimestampSource {
  segmentIndex: number;
  segmentId: string;
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
}

/**
 * Firestore document type for chat history messages
 * Stored at conversations/{conversationId}/chatHistory/{messageId}
 */
interface ChatHistoryDoc {
  role: 'user' | 'assistant';
  content: string;
  sources?: TimestampSource[];
  costUsd?: number;
  isUnanswerable?: boolean;
  createdAt: Timestamp;
}

/**
 * Client-side chat message (with ISO string timestamp)
 */
export interface ChatHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: TimestampSource[];
  costUsd?: number;
  isUnanswerable?: boolean;
  createdAt: string; // ISO string
}

/**
 * ChatHistoryService - Manages chat message persistence in Firestore
 *
 * Messages are stored in a subcollection under each conversation:
 * conversations/{conversationId}/chatHistory/{messageId}
 *
 * Features:
 * - Real-time message sync across tabs/devices
 * - Pagination for loading older messages
 * - Message count tracking for limits (50 message cap)
 * - Batch deletion for clearing history
 * - JSON export for user data portability
 */
export class ChatHistoryService {
  /**
   * Add a new message to chat history
   * Auto-generates message ID and server timestamp
   */
  async addMessage(
    conversationId: string,
    message: Omit<ChatHistoryMessage, 'id' | 'createdAt'>
  ): Promise<string> {
    const chatHistoryRef = collection(db, 'conversations', conversationId, 'chatHistory');
    const messageDoc = doc(chatHistoryRef); // Auto-generate ID

    const firestoreDoc: ChatHistoryDoc = {
      role: message.role,
      content: message.content,
      ...(message.sources ? { sources: message.sources } : {}),
      ...(message.costUsd !== undefined ? { costUsd: message.costUsd } : {}),
      ...(message.isUnanswerable !== undefined ? { isUnanswerable: message.isUnanswerable } : {}),
      createdAt: serverTimestamp() as Timestamp
    };

    console.log('[ChatHistoryService] Adding message:', {
      conversationId,
      messageId: messageDoc.id,
      role: message.role
    });

    await setDoc(messageDoc, firestoreDoc);
    return messageDoc.id;
  }

  /**
   * Subscribe to real-time chat messages
   * Returns unsubscribe function
   *
   * @param conversationId - Conversation to subscribe to
   * @param limitCount - Max messages to load (default: 10)
   * @param callback - Called when messages update
   */
  subscribeToMessages(
    conversationId: string,
    limitCount: number = 10,
    callback: (messages: ChatHistoryMessage[]) => void
  ): Unsubscribe {
    const chatHistoryRef = collection(db, 'conversations', conversationId, 'chatHistory');

    // Query most recent messages, ordered by creation time descending
    const q = query(
      chatHistoryRef,
      orderBy('createdAt', 'desc'),
      firestoreLimit(limitCount)
    );

    console.log('[ChatHistoryService] Setting up real-time listener:', {
      conversationId,
      limit: limitCount
    });

    return onSnapshot(
      q,
      (snapshot: QuerySnapshot<DocumentData>) => {
        const messages = snapshot.docs
          .map(doc => this.docToMessage(doc.id, doc.data() as ChatHistoryDoc))
          .reverse(); // Reverse to get chronological order (oldest first)

        console.log('[ChatHistoryService] Real-time update:', {
          conversationId,
          count: messages.length,
          changes: snapshot.docChanges().map(c => ({ type: c.type, id: c.doc.id }))
        });

        callback(messages);
      },
      (error) => {
        console.error('[ChatHistoryService] Real-time listener error:', error);
      }
    );
  }

  /**
   * Load older messages for pagination
   * Returns messages before the given timestamp
   *
   * @param conversationId - Conversation ID
   * @param beforeTimestamp - ISO timestamp to load messages before
   * @param limitCount - Max messages to load (default: 10)
   */
  async loadOlderMessages(
    conversationId: string,
    beforeTimestamp: string,
    limitCount: number = 10
  ): Promise<ChatHistoryMessage[]> {
    const chatHistoryRef = collection(db, 'conversations', conversationId, 'chatHistory');
    const beforeFirestoreTimestamp = Timestamp.fromDate(new Date(beforeTimestamp));

    const q = query(
      chatHistoryRef,
      orderBy('createdAt', 'desc'),
      startAfter(beforeFirestoreTimestamp),
      firestoreLimit(limitCount)
    );

    console.log('[ChatHistoryService] Loading older messages:', {
      conversationId,
      beforeTimestamp,
      limit: limitCount
    });

    const snapshot = await getDocs(q);
    const messages = snapshot.docs
      .map(doc => this.docToMessage(doc.id, doc.data() as ChatHistoryDoc))
      .reverse(); // Chronological order

    console.log('[ChatHistoryService] Loaded older messages:', {
      conversationId,
      count: messages.length
    });

    return messages;
  }

  /**
   * Get total message count for a conversation
   * Used to enforce 50 message limit
   */
  async getMessageCount(conversationId: string): Promise<number> {
    const chatHistoryRef = collection(db, 'conversations', conversationId, 'chatHistory');
    const snapshot = await getCountFromServer(chatHistoryRef);

    const count = snapshot.data().count;
    console.log('[ChatHistoryService] Message count:', { conversationId, count });

    return count;
  }

  /**
   * Clear all chat history for a conversation
   * Uses batch deletion for efficiency
   */
  async clearHistory(conversationId: string): Promise<void> {
    const chatHistoryRef = collection(db, 'conversations', conversationId, 'chatHistory');

    console.log('[ChatHistoryService] Clearing history for:', conversationId);

    // Fetch all messages
    const snapshot = await getDocs(chatHistoryRef);

    if (snapshot.empty) {
      console.log('[ChatHistoryService] No messages to delete');
      return;
    }

    // Firestore batch has a 500 operation limit, so chunk if needed
    const chunkSize = 500;
    const docs = snapshot.docs;

    for (let i = 0; i < docs.length; i += chunkSize) {
      const batch = writeBatch(db);
      const chunk = docs.slice(i, i + chunkSize);

      chunk.forEach(docSnapshot => {
        batch.delete(docSnapshot.ref);
      });

      await batch.commit();
      console.log('[ChatHistoryService] Deleted chunk:', {
        conversationId,
        chunkStart: i,
        chunkSize: chunk.length
      });
    }

    console.log('[ChatHistoryService] Cleared all messages:', {
      conversationId,
      deletedCount: docs.length
    });
  }

  /**
   * Export all chat history as JSON
   * Returns messages in chronological order (oldest first)
   */
  async exportHistory(conversationId: string): Promise<ChatHistoryMessage[]> {
    const chatHistoryRef = collection(db, 'conversations', conversationId, 'chatHistory');

    const q = query(
      chatHistoryRef,
      orderBy('createdAt', 'asc') // Chronological for export
    );

    console.log('[ChatHistoryService] Exporting history:', conversationId);

    const snapshot = await getDocs(q);
    const messages = snapshot.docs.map(doc =>
      this.docToMessage(doc.id, doc.data() as ChatHistoryDoc)
    );

    console.log('[ChatHistoryService] Exported messages:', {
      conversationId,
      count: messages.length
    });

    return messages;
  }

  /**
   * Convert Firestore document to client message format
   * Handles Timestamp -> ISO string conversion
   */
  private docToMessage(id: string, doc: ChatHistoryDoc): ChatHistoryMessage {
    // Handle null createdAt (can happen before serverTimestamp() is resolved)
    // Real-time listener will update with actual timestamp shortly
    const createdAt = doc.createdAt?.toDate().toISOString() ?? new Date().toISOString();

    return {
      id,
      role: doc.role,
      content: doc.content,
      ...(doc.sources ? { sources: doc.sources } : {}),
      ...(doc.costUsd !== undefined ? { costUsd: doc.costUsd } : {}),
      ...(doc.isUnanswerable !== undefined ? { isUnanswerable: doc.isUnanswerable } : {}),
      createdAt
    };
  }
}

// Export singleton instance
export const chatHistoryService = new ChatHistoryService();
