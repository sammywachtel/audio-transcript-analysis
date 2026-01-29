/**
 * Speaker Corrections Cloud Function
 *
 * Handles manual speaker merge operations.
 * Users can merge incorrectly diarized speakers from the UI.
 *
 * Features:
 * - Requires authentication and ownership verification
 * - Writes correction records to speakerCorrections subcollection
 * - Client applies corrections at read time (apply-on-read pattern)
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { db } from './index';
import { log } from './logger';

interface MergeSpeakersRequest {
  conversationId: string;
  sourceSpeakerId: string;  // Speaker being merged away
  targetSpeakerId: string;  // Speaker to merge into
}

interface MergeSpeakersResponse {
  success: boolean;
  correctionId: string;
}

interface ReassignSegmentsRequest {
  conversationId: string;
  segmentIds: string[];    // Segments to reassign
  toSpeakerId: string;     // Target speaker
}

interface ReassignSegmentsResponse {
  success: boolean;
  correctionId: string;
}

/**
 * Merge two speakers by writing a correction record.
 *
 * Security:
 * - Requires authentication
 * - Verifies user owns the conversation
 * - Validates speaker IDs exist
 *
 * The correction is stored in the speakerCorrections subcollection
 * and applied at read time by the client.
 */
export const mergeSpeakers = onCall<MergeSpeakersRequest>(
  {
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 30,
    cors: true
  },
  async (request): Promise<MergeSpeakersResponse> => {
    // Require authentication
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in to merge speakers');
    }

    const { conversationId, sourceSpeakerId, targetSpeakerId } = request.data;
    const userId = request.auth.uid;

    // Validate input
    if (!conversationId) {
      throw new HttpsError('invalid-argument', 'conversationId is required');
    }
    if (!sourceSpeakerId || !targetSpeakerId) {
      throw new HttpsError('invalid-argument', 'sourceSpeakerId and targetSpeakerId are required');
    }
    if (sourceSpeakerId === targetSpeakerId) {
      throw new HttpsError('invalid-argument', 'Cannot merge a speaker into itself');
    }

    log.info('Speaker merge request received', {
      conversationId,
      userId,
      sourceSpeakerId,
      targetSpeakerId
    });

    try {
      // Fetch conversation and verify ownership
      const conversationDoc = await db.collection('conversations').doc(conversationId).get();

      if (!conversationDoc.exists) {
        throw new HttpsError('not-found', 'Conversation not found');
      }

      const conversation = conversationDoc.data();
      if (!conversation) {
        throw new HttpsError('not-found', 'Conversation data not found');
      }

      if (conversation.userId !== userId) {
        throw new HttpsError('permission-denied', 'You do not have access to this conversation');
      }

      // Validate that both speakers exist in the conversation
      const speakers = conversation.speakers || {};
      if (!speakers[sourceSpeakerId]) {
        throw new HttpsError('invalid-argument', `Source speaker '${sourceSpeakerId}' not found`);
      }
      if (!speakers[targetSpeakerId]) {
        throw new HttpsError('invalid-argument', `Target speaker '${targetSpeakerId}' not found`);
      }

      // Write correction record to subcollection
      const correctionRef = db
        .collection('conversations')
        .doc(conversationId)
        .collection('speakerCorrections')
        .doc(); // Auto-generate ID

      const correctionData = {
        type: 'merge',
        sourceSpeakerId,
        targetSpeakerId,
        userId,
        createdAt: new Date() // Firestore will convert to Timestamp
      };

      await correctionRef.set(correctionData);

      log.info('Speaker merge correction saved', {
        conversationId,
        userId,
        correctionId: correctionRef.id,
        sourceSpeakerId,
        targetSpeakerId
      });

      return {
        success: true,
        correctionId: correctionRef.id
      };

    } catch (error) {
      log.error('Speaker merge request failed', {
        conversationId,
        userId,
        sourceSpeakerId,
        targetSpeakerId,
        error: error instanceof Error ? error.message : String(error)
      });

      // Re-throw HttpsErrors as-is
      if (error instanceof HttpsError) {
        throw error;
      }

      // Wrap other errors
      throw new HttpsError(
        'internal',
        'Failed to merge speakers: ' + (error instanceof Error ? error.message : String(error))
      );
    }
  }
);

/**
 * Reassign specific segments to a different speaker.
 *
 * Security:
 * - Requires authentication
 * - Verifies user owns the conversation
 * - Validates segments exist and belong to the same speaker
 * - Validates target speaker exists
 *
 * The correction is stored in the speakerCorrections subcollection
 * and applied at read time by the client.
 */
export const reassignSegments = onCall<ReassignSegmentsRequest>(
  {
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 30,
    cors: true
  },
  async (request): Promise<ReassignSegmentsResponse> => {
    // Require authentication
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in to reassign segments');
    }

    const { conversationId, segmentIds, toSpeakerId } = request.data;
    const userId = request.auth.uid;

    // Validate input
    if (!conversationId) {
      throw new HttpsError('invalid-argument', 'conversationId is required');
    }
    if (!segmentIds || !Array.isArray(segmentIds) || segmentIds.length === 0) {
      throw new HttpsError('invalid-argument', 'segmentIds must be a non-empty array');
    }
    if (!toSpeakerId) {
      throw new HttpsError('invalid-argument', 'toSpeakerId is required');
    }

    log.info('Segment reassignment request received', {
      conversationId,
      userId,
      segmentCount: segmentIds.length,
      toSpeakerId
    });

    try {
      // Fetch conversation and verify ownership
      const conversationDoc = await db.collection('conversations').doc(conversationId).get();

      if (!conversationDoc.exists) {
        throw new HttpsError('not-found', 'Conversation not found');
      }

      const conversation = conversationDoc.data();
      if (!conversation) {
        throw new HttpsError('not-found', 'Conversation data not found');
      }

      if (conversation.userId !== userId) {
        throw new HttpsError('permission-denied', 'You do not have access to this conversation');
      }

      // Validate segments exist and all belong to the same speaker
      const segments = conversation.segments || [];

      interface SegmentData {
        segmentId: string;
        speakerId: string;
        [key: string]: any;
      }

      const segmentMap = new Map<string, SegmentData>(
        segments.map((s: any) => [s.segmentId, s as SegmentData])
      );

      let fromSpeakerId: string | null = null;

      for (const segmentId of segmentIds) {
        const segment = segmentMap.get(segmentId);
        if (!segment) {
          throw new HttpsError('invalid-argument', `Segment '${segmentId}' not found`);
        }

        // All segments must belong to the same speaker
        if (fromSpeakerId === null) {
          fromSpeakerId = segment.speakerId;
        } else if (segment.speakerId !== fromSpeakerId) {
          throw new HttpsError(
            'invalid-argument',
            'All segments must belong to the same speaker'
          );
        }
      }

      if (!fromSpeakerId) {
        throw new HttpsError('invalid-argument', 'Could not determine source speaker');
      }

      // Validate target speaker exists
      const speakers = conversation.speakers || {};
      if (!speakers[toSpeakerId]) {
        throw new HttpsError('invalid-argument', `Target speaker '${toSpeakerId}' not found`);
      }

      // Don't allow reassigning to the same speaker
      if (fromSpeakerId === toSpeakerId) {
        throw new HttpsError('invalid-argument', 'Segments already belong to the target speaker');
      }

      // Write correction record to subcollection
      const correctionRef = db
        .collection('conversations')
        .doc(conversationId)
        .collection('speakerCorrections')
        .doc(); // Auto-generate ID

      const correctionData = {
        type: 'reassign',
        segmentIds,
        fromSpeakerId,
        toSpeakerId,
        userId,
        createdAt: new Date() // Firestore will convert to Timestamp
      };

      await correctionRef.set(correctionData);

      log.info('Segment reassignment correction saved', {
        conversationId,
        userId,
        correctionId: correctionRef.id,
        segmentCount: segmentIds.length,
        fromSpeakerId,
        toSpeakerId
      });

      return {
        success: true,
        correctionId: correctionRef.id
      };

    } catch (error) {
      log.error('Segment reassignment request failed', {
        conversationId,
        userId,
        segmentCount: segmentIds.length,
        toSpeakerId,
        error: error instanceof Error ? error.message : String(error)
      });

      // Re-throw HttpsErrors as-is
      if (error instanceof HttpsError) {
        throw error;
      }

      // Wrap other errors
      throw new HttpsError(
        'internal',
        'Failed to reassign segments: ' + (error instanceof Error ? error.message : String(error))
      );
    }
  }
);
