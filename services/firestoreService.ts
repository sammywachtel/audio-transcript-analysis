import {
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  Timestamp,
  serverTimestamp,
  Unsubscribe,
  QuerySnapshot,
  DocumentData
} from 'firebase/firestore';
import { db } from '../firebase-config';
import { Conversation } from '../types';

/**
 * Firestore document type for conversations
 * Matches the Firestore schema but uses Timestamps instead of ISO strings
 */
interface ConversationDoc extends Omit<Conversation, 'createdAt' | 'updatedAt' | 'audioUrl'> {
  createdAt: Timestamp;
  updatedAt: Timestamp;
  audioStoragePath?: string; // Path in Firebase Storage (replaces audioUrl)
}

/**
 * FirestoreService - Handles all Firestore operations for conversations
 *
 * Key differences from IndexedDB:
 * 1. Data is synced to cloud automatically
 * 2. Real-time listeners for instant updates across devices
 * 3. Security rules enforce user isolation server-side
 * 4. Audio stored separately in Firebase Storage (referenced by path)
 *
 * The audioUrl field is NOT stored in Firestore - it's generated client-side
 * from the audioStoragePath when loading conversations.
 */
export class FirestoreService {
  private readonly conversationsCollection = 'conversations';

  /**
   * Save a conversation to Firestore
   * Creates or updates the document (upsert pattern)
   */
  async save(conversation: Conversation, audioStoragePath?: string): Promise<void> {
    const docRef = doc(db, this.conversationsCollection, conversation.conversationId);

    // Convert to Firestore document format
    // Note: Firestore rejects undefined values, so we conditionally include audioStoragePath
    const firestoreDoc: ConversationDoc = {
      ...conversation,
      createdAt: Timestamp.fromDate(new Date(conversation.createdAt)),
      updatedAt: Timestamp.fromDate(new Date(conversation.updatedAt || new Date().toISOString())),
      ...(audioStoragePath ? { audioStoragePath } : {})
    };

    // Remove audioUrl - it's ephemeral and regenerated on load
    delete (firestoreDoc as any).audioUrl;

    console.log('[Firestore] Saving conversation:', {
      id: conversation.conversationId,
      userId: conversation.userId,
      hasAudioPath: !!audioStoragePath
    });

    await setDoc(docRef, firestoreDoc);
  }

  /**
   * Load a single conversation by ID
   * Returns null if not found or user doesn't have access
   */
  async loadById(conversationId: string): Promise<Conversation | null> {
    const docRef = doc(db, this.conversationsCollection, conversationId);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      return null;
    }

    return this.docToConversation(docSnap.id, docSnap.data() as ConversationDoc);
  }

  /**
   * Load all conversations for a specific user
   * Sorted by createdAt descending (newest first)
   */
  async loadAllForUser(userId: string): Promise<Conversation[]> {
    const q = query(
      collection(db, this.conversationsCollection),
      where('userId', '==', userId),
      orderBy('createdAt', 'desc')
    );

    const querySnapshot = await getDocs(q);
    console.log('[Firestore] Loaded conversations for user:', {
      userId,
      count: querySnapshot.docs.length
    });

    return querySnapshot.docs.map(doc =>
      this.docToConversation(doc.id, doc.data() as ConversationDoc)
    );
  }

  /**
   * Subscribe to real-time updates for a user's conversations
   * Returns an unsubscribe function to stop listening
   *
   * This is the magic of Firestore - changes sync instantly across devices.
   * When another device uploads a conversation, this listener fires.
   */
  subscribeToUserConversations(
    userId: string,
    onUpdate: (conversations: Conversation[]) => void,
    onError?: (error: Error) => void
  ): Unsubscribe {
    const q = query(
      collection(db, this.conversationsCollection),
      where('userId', '==', userId),
      orderBy('createdAt', 'desc')
    );

    console.log('[Firestore] Setting up real-time listener for user:', userId);

    return onSnapshot(
      q,
      (snapshot: QuerySnapshot<DocumentData>) => {
        const conversations = snapshot.docs.map(doc =>
          this.docToConversation(doc.id, doc.data() as ConversationDoc)
        );

        console.log('[Firestore] Real-time update received:', {
          userId,
          count: conversations.length,
          changes: snapshot.docChanges().map(c => ({ type: c.type, id: c.doc.id }))
        });

        onUpdate(conversations);
      },
      (error) => {
        console.error('[Firestore] Real-time listener error:', error);
        onError?.(error);
      }
    );
  }

  /**
   * Delete a conversation by ID
   * Note: This does NOT delete the audio file from Storage
   * The storageService should be called separately for that
   */
  async delete(conversationId: string): Promise<void> {
    const docRef = doc(db, this.conversationsCollection, conversationId);
    console.log('[Firestore] Deleting conversation:', conversationId);
    await deleteDoc(docRef);
  }

  /**
   * Update specific fields of a conversation
   * More efficient than save() when only changing a few fields
   */
  async updateFields(
    conversationId: string,
    updates: Partial<Conversation>
  ): Promise<void> {
    const docRef = doc(db, this.conversationsCollection, conversationId);

    // Convert dates if present
    const firestoreUpdates: any = { ...updates };
    if (updates.updatedAt) {
      firestoreUpdates.updatedAt = Timestamp.fromDate(new Date(updates.updatedAt));
    }
    if (updates.createdAt) {
      firestoreUpdates.createdAt = Timestamp.fromDate(new Date(updates.createdAt));
    }

    // Always update the updatedAt timestamp
    firestoreUpdates.updatedAt = serverTimestamp();

    // Remove audioUrl if present - it's client-side only
    delete firestoreUpdates.audioUrl;

    await setDoc(docRef, firestoreUpdates, { merge: true });
  }

  /**
   * Convert a Firestore document to our Conversation type
   * Handles Timestamp -> ISO string conversion
   */
  private docToConversation(id: string, doc: ConversationDoc): Conversation {
    return {
      ...doc,
      conversationId: id,
      createdAt: doc.createdAt.toDate().toISOString(),
      updatedAt: doc.updatedAt.toDate().toISOString(),
      // audioUrl will be populated by the caller using storageService
      audioUrl: undefined,
      // Ensure arrays exist (migration safety)
      people: doc.people || [],
      segments: doc.segments || [],
      termOccurrences: doc.termOccurrences || [],
      topics: doc.topics || []
    };
  }

  /**
   * Check if any conversations exist without a userId (orphans from pre-auth era)
   * Used for migration detection
   */
  async hasOrphanConversations(): Promise<boolean> {
    // Note: Firestore doesn't support querying for missing fields well
    // This would require a Cloud Function or batch check
    // For now, we'll handle this in the migration utility
    return false;
  }
}

// Export singleton instance
export const firestoreService = new FirestoreService();
