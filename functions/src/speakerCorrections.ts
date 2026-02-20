/**
 * Speaker Corrections Cloud Functions
 *
 * Handles manual speaker corrections: merge, reassign, and rename.
 * Users can fix incorrectly diarized speakers from the UI.
 *
 * Features:
 * - Requires authentication and ownership verification
 * - Writes correction records to speakerCorrections subcollection
 * - Client applies corrections at read time (apply-on-read pattern)
 * - Undo preserves audit trail (sets undoneAt instead of deleting)
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

interface RenameSpeakerRequest {
  conversationId: string;
  speakerId: string;       // Speaker to rename
  newDisplayName: string;  // New name (validated: non-empty, <50 chars)
}

interface RenameSpeakerResponse {
  success: boolean;
  correctionId: string;
}

interface UndoCorrectionRequest {
  conversationId: string;
  correctionId: string;    // Correction to undo
}

interface UndoCorrectionResponse {
  success: boolean;
}

/** Minimal shape of a correction doc — only fields the replay helper cares about */
interface ActiveCorrection {
  type: 'merge' | 'reassign' | 'rename';
  // merge
  sourceSpeakerId?: string;
  targetSpeakerId?: string;
  // reassign
  segmentIds?: string[];
  toSpeakerId?: string;
  // rename
  speakerId?: string;
  newDisplayName?: string;
}

/**
 * Replay active corrections to derive the effective speaker map and
 * segment-to-speaker mapping. Mirrors the client-side apply-on-read
 * logic in useSpeakerCorrections.ts (the useMemo at ~line 172).
 *
 * We need this because raw Firestore data doesn't reflect prior
 * corrections — a segment reassigned A→B still shows speakerId=A
 * in the raw doc. Without replay, the backend rejects valid moves
 * like B→A ("already belongs to target speaker").
 */
async function computeEffectiveState(
  conversationId: string,
  rawSpeakers: Record<string, any>,
  rawSegments: Array<{ segmentId: string; speakerId: string; [key: string]: any }>
): Promise<{
  effectiveSpeakers: Record<string, any>;
  effectiveSegmentSpeaker: Map<string, string>;
}> {
  // Fetch all corrections, ordered chronologically
  const correctionsSnap = await db
    .collection('conversations')
    .doc(conversationId)
    .collection('speakerCorrections')
    .orderBy('createdAt', 'asc')
    .get();

  // Filter to active only (not undone)
  const active: ActiveCorrection[] = [];
  for (const doc of correctionsSnap.docs) {
    const data = doc.data();
    if (data.undoneAt) continue;
    active.push({
      type: data.type,
      sourceSpeakerId: data.sourceSpeakerId,
      targetSpeakerId: data.targetSpeakerId,
      segmentIds: data.segmentIds,
      toSpeakerId: data.toSpeakerId,
      speakerId: data.speakerId,
      newDisplayName: data.newDisplayName,
    });
  }

  // Deep-copy speakers so we don't mutate the raw data
  const speakers: Record<string, any> = {};
  for (const [id, speaker] of Object.entries(rawSpeakers)) {
    speakers[id] = { ...speaker };
  }

  // Build mutable segment-to-speaker map
  const segSpeaker = new Map<string, string>();
  for (const seg of rawSegments) {
    segSpeaker.set(seg.segmentId, seg.speakerId);
  }

  // Replay corrections in order — same logic as client hook
  for (const c of active) {
    if (c.type === 'merge') {
      if (!c.sourceSpeakerId || !c.targetSpeakerId) continue;
      if (!speakers[c.sourceSpeakerId] || !speakers[c.targetSpeakerId]) continue;

      delete speakers[c.sourceSpeakerId];
      for (const [segId, spkId] of segSpeaker) {
        if (spkId === c.sourceSpeakerId) {
          segSpeaker.set(segId, c.targetSpeakerId);
        }
      }
    } else if (c.type === 'reassign') {
      if (!c.segmentIds || !c.toSpeakerId) continue;
      for (const segId of c.segmentIds) {
        if (segSpeaker.has(segId)) {
          segSpeaker.set(segId, c.toSpeakerId);
        }
      }
    } else if (c.type === 'rename') {
      if (!c.speakerId || !c.newDisplayName) continue;
      if (!speakers[c.speakerId]) continue;
      speakers[c.speakerId] = {
        ...speakers[c.speakerId],
        displayName: c.newDisplayName,
      };
    }
  }

  // Prune speakers with zero segments (matches client behavior)
  const speakersWithSegments = new Set(segSpeaker.values());
  for (const speakerId of Object.keys(speakers)) {
    if (!speakersWithSegments.has(speakerId)) {
      delete speakers[speakerId];
    }
  }

  return { effectiveSpeakers: speakers, effectiveSegmentSpeaker: segSpeaker };
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

      // Validate against effective state (raw data doesn't reflect prior corrections)
      const { effectiveSpeakers } = await computeEffectiveState(
        conversationId,
        conversation.speakers || {},
        conversation.segments || []
      );
      if (!effectiveSpeakers[sourceSpeakerId]) {
        throw new HttpsError('invalid-argument', `Source speaker '${sourceSpeakerId}' not found`);
      }
      if (!effectiveSpeakers[targetSpeakerId]) {
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

      // Validate against effective state (raw data doesn't reflect prior corrections)
      const { effectiveSpeakers, effectiveSegmentSpeaker } = await computeEffectiveState(
        conversationId,
        conversation.speakers || {},
        conversation.segments || []
      );

      // Validate target speaker exists in effective state
      if (!effectiveSpeakers[toSpeakerId]) {
        throw new HttpsError('invalid-argument', `Target speaker '${toSpeakerId}' not found`);
      }

      // Validate segments exist and all effectively belong to the same speaker
      let fromSpeakerId: string | null = null;

      for (const segmentId of segmentIds) {
        const effectiveOwner = effectiveSegmentSpeaker.get(segmentId);
        if (!effectiveOwner) {
          throw new HttpsError('invalid-argument', `Segment '${segmentId}' not found`);
        }

        if (fromSpeakerId === null) {
          fromSpeakerId = effectiveOwner;
        } else if (effectiveOwner !== fromSpeakerId) {
          throw new HttpsError(
            'invalid-argument',
            'All segments must belong to the same speaker'
          );
        }
      }

      if (!fromSpeakerId) {
        throw new HttpsError('invalid-argument', 'Could not determine source speaker');
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

/**
 * Rename a speaker by writing a correction record.
 *
 * Security:
 * - Requires authentication
 * - Verifies user owns the conversation
 * - Validates speaker exists
 * - Validates name: non-empty, <50 characters
 *
 * The correction is stored in the speakerCorrections subcollection
 * and applied at read time by the client.
 */
export const renameSpeaker = onCall<RenameSpeakerRequest>(
  {
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 30,
    cors: true
  },
  async (request): Promise<RenameSpeakerResponse> => {
    // Require authentication
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in to rename speaker');
    }

    const { conversationId, speakerId, newDisplayName } = request.data;
    const userId = request.auth.uid;

    // Validate input
    if (!conversationId) {
      throw new HttpsError('invalid-argument', 'conversationId is required');
    }
    if (!speakerId) {
      throw new HttpsError('invalid-argument', 'speakerId is required');
    }

    // Validate name: non-empty and <50 characters
    const trimmedName = newDisplayName?.trim();
    if (!trimmedName) {
      throw new HttpsError('invalid-argument', 'newDisplayName cannot be empty');
    }
    if (trimmedName.length >= 50) {
      throw new HttpsError('invalid-argument', 'newDisplayName must be less than 50 characters');
    }

    log.info('Speaker rename request received', {
      conversationId,
      userId,
      speakerId,
      newDisplayName: trimmedName
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

      // Validate speaker exists
      const speakers = conversation.speakers || {};
      if (!speakers[speakerId]) {
        throw new HttpsError('invalid-argument', `Speaker '${speakerId}' not found`);
      }

      const previousDisplayName = speakers[speakerId].displayName;

      // Write correction record to subcollection
      const correctionRef = db
        .collection('conversations')
        .doc(conversationId)
        .collection('speakerCorrections')
        .doc(); // Auto-generate ID

      const correctionData = {
        type: 'rename',
        speakerId,
        newDisplayName: trimmedName,
        previousDisplayName,
        userId,
        createdAt: new Date() // Firestore will convert to Timestamp
      };

      await correctionRef.set(correctionData);

      log.info('Speaker rename correction saved', {
        conversationId,
        userId,
        correctionId: correctionRef.id,
        speakerId,
        previousDisplayName,
        newDisplayName: trimmedName
      });

      return {
        success: true,
        correctionId: correctionRef.id
      };

    } catch (error) {
      log.error('Speaker rename request failed', {
        conversationId,
        userId,
        speakerId,
        newDisplayName: trimmedName,
        error: error instanceof Error ? error.message : String(error)
      });

      // Re-throw HttpsErrors as-is
      if (error instanceof HttpsError) {
        throw error;
      }

      // Wrap other errors
      throw new HttpsError(
        'internal',
        'Failed to rename speaker: ' + (error instanceof Error ? error.message : String(error))
      );
    }
  }
);

/**
 * Undo a correction by setting its undoneAt timestamp.
 * This preserves the audit trail - we don't delete corrections.
 *
 * Security:
 * - Requires authentication
 * - Verifies user owns the conversation
 * - Validates correction exists and is not already undone
 *
 * After undo, the correction still exists but apply-on-read
 * logic filters it out based on undoneAt being set.
 */
export const undoCorrection = onCall<UndoCorrectionRequest>(
  {
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 30,
    cors: true
  },
  async (request): Promise<UndoCorrectionResponse> => {
    // Require authentication
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in to undo correction');
    }

    const { conversationId, correctionId } = request.data;
    const userId = request.auth.uid;

    // Validate input
    if (!conversationId) {
      throw new HttpsError('invalid-argument', 'conversationId is required');
    }
    if (!correctionId) {
      throw new HttpsError('invalid-argument', 'correctionId is required');
    }

    log.info('Undo correction request received', {
      conversationId,
      userId,
      correctionId
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

      // Fetch the correction and validate
      const correctionRef = db
        .collection('conversations')
        .doc(conversationId)
        .collection('speakerCorrections')
        .doc(correctionId);

      const correctionDoc = await correctionRef.get();

      if (!correctionDoc.exists) {
        throw new HttpsError('not-found', 'Correction not found');
      }

      const correction = correctionDoc.data();
      if (!correction) {
        throw new HttpsError('not-found', 'Correction data not found');
      }

      // Check if already undone
      if (correction.undoneAt) {
        throw new HttpsError('failed-precondition', 'Correction has already been undone');
      }

      // Set undoneAt to preserve audit trail (don't delete)
      await correctionRef.update({
        undoneAt: new Date()
      });

      log.info('Correction undone (audit preserved)', {
        conversationId,
        userId,
        correctionId,
        correctionType: correction.type
      });

      return {
        success: true
      };

    } catch (error) {
      log.error('Undo correction request failed', {
        conversationId,
        userId,
        correctionId,
        error: error instanceof Error ? error.message : String(error)
      });

      // Re-throw HttpsErrors as-is
      if (error instanceof HttpsError) {
        throw error;
      }

      // Wrap other errors
      throw new HttpsError(
        'internal',
        'Failed to undo correction: ' + (error instanceof Error ? error.message : String(error))
      );
    }
  }
);
