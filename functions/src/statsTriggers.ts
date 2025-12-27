/**
 * Firestore Triggers for Stats Tracking
 *
 * Automatically tracks user activity when conversations are created/deleted.
 * Uses Firestore triggers to ensure we never miss an event.
 *
 * These triggers complement the explicit recordUserEvent() calls made during
 * processing - they ensure conversation lifecycle events are always captured.
 */

import { onDocumentCreated, onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { recordUserEvent } from './userEvents';
import { log } from './logger';

// =============================================================================
// Conversation Lifecycle Triggers
// =============================================================================

/**
 * Trigger: Conversation document created
 *
 * Fires when a new conversation document is created in Firestore.
 * Records a 'conversation_created' event for the user.
 */
export const onConversationCreated = onDocumentCreated(
  {
    document: 'conversations/{conversationId}',
    region: 'us-central1'
  },
  async (event) => {
    const conversationId = event.params.conversationId;
    const data = event.data?.data();

    if (!data) {
      log.warn('Conversation created event missing data', { conversationId });
      return;
    }

    const userId = data.userId;
    if (!userId) {
      log.warn('Conversation missing userId', { conversationId });
      return;
    }

    log.info('Conversation created trigger fired', {
      conversationId,
      userId,
      title: data.title
    });

    await recordUserEvent({
      eventType: 'conversation_created',
      userId,
      conversationId,
      metadata: {
        title: data.title,
        status: data.status
      }
    });
  }
);

/**
 * Trigger: Conversation document deleted
 *
 * Fires when a conversation document is deleted from Firestore.
 * Records a 'conversation_deleted' event for the user.
 */
export const onConversationDeleted = onDocumentDeleted(
  {
    document: 'conversations/{conversationId}',
    region: 'us-central1'
  },
  async (event) => {
    const conversationId = event.params.conversationId;
    const data = event.data?.data();

    // Even if data is missing, we can still record the deletion
    const userId = data?.userId;

    if (!userId) {
      log.warn('Deleted conversation missing userId', {
        conversationId,
        hadData: !!data
      });
      return;
    }

    log.info('Conversation deleted trigger fired', {
      conversationId,
      userId,
      title: data?.title
    });

    await recordUserEvent({
      eventType: 'conversation_deleted',
      userId,
      conversationId,
      metadata: {
        title: data?.title,
        hadAudioUrl: !!data?.audioUrl
      }
    });
  }
);
