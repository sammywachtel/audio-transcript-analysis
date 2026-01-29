/**
 * useSpeakerCorrections Hook
 *
 * Manages speaker correction state for a conversation:
 * - Real-time subscription to speakerCorrections subcollection
 * - Apply-on-read logic: compute corrected speakers and segments
 * - Merge speakers via Cloud Function
 * - Undo last merge
 *
 * Pattern: Original conversation data stays immutable.
 * All corrections are applied at read time.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  Timestamp
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '@/config/firebase-config';
import type { Speaker, Segment, SpeakerCorrection } from '@/config/types';

interface UseSpeakerCorrectionsOptions {
  conversationId: string;
  originalSpeakers: Record<string, Speaker>;
  originalSegments: Segment[];
}

interface UseSpeakerCorrectionsReturn {
  /** Corrected speaker list with merges applied */
  correctedSpeakers: Record<string, Speaker>;
  /** Segments with corrected speaker IDs */
  correctedSegments: Segment[];
  /** Whether undo is available */
  canUndo: boolean;
  /** Merge two speakers (calls Cloud Function) */
  mergeSpeakers: (sourceSpeakerId: string, targetSpeakerId: string) => Promise<void>;
  /** Reassign specific segments to a different speaker (calls Cloud Function) */
  reassignSegments: (segmentIds: string[], toSpeakerId: string) => Promise<void>;
  /** Undo the most recent merge */
  undoLastMerge: () => Promise<void>;
  /** Loading state for merge operations */
  isLoading: boolean;
  /** Error message if merge fails */
  error: string | null;
  /** Clear error state */
  clearError: () => void;
}

/**
 * Firestore document type for speaker corrections
 */
interface SpeakerCorrectionDoc extends Omit<SpeakerCorrection, 'createdAt'> {
  createdAt: Timestamp;
}

/**
 * Hook to manage speaker corrections with apply-on-read logic.
 *
 * Subscribes to speakerCorrections subcollection and recomputes
 * corrected speakers/segments whenever corrections change.
 */
export function useSpeakerCorrections({
  conversationId,
  originalSpeakers,
  originalSegments
}: UseSpeakerCorrectionsOptions): UseSpeakerCorrectionsReturn {
  const [corrections, setCorrections] = useState<SpeakerCorrection[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Subscribe to speakerCorrections subcollection
  useEffect(() => {
    if (!conversationId) return;

    const correctionsRef = collection(db, 'conversations', conversationId, 'speakerCorrections');
    const q = query(correctionsRef, orderBy('createdAt', 'asc'));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const loadedCorrections: SpeakerCorrection[] = snapshot.docs.map(doc => {
          const data = doc.data() as SpeakerCorrectionDoc;
          return {
            correctionId: doc.id,
            type: data.type,
            // Merge correction fields
            sourceSpeakerId: data.sourceSpeakerId,
            targetSpeakerId: data.targetSpeakerId,
            // Reassign correction fields
            segmentIds: data.segmentIds,
            fromSpeakerId: data.fromSpeakerId,
            toSpeakerId: data.toSpeakerId,
            createdAt: data.createdAt.toDate().toISOString(),
            userId: data.userId
          };
        });

        setCorrections(loadedCorrections);
      },
      (err) => {
        console.error('[useSpeakerCorrections] Subscription error:', err);
        setError('Failed to load speaker corrections');
      }
    );

    return () => unsubscribe();
  }, [conversationId]);

  /**
   * Apply corrections to derive corrected speakers and segments.
   * This is the core apply-on-read logic - we never mutate the original data.
   */
  const { correctedSpeakers, correctedSegments } = useMemo(() => {
    // Start with originals
    let speakers = { ...originalSpeakers };
    let segments = [...originalSegments];

    // Apply each correction in chronological order
    for (const correction of corrections) {
      if (correction.type === 'merge') {
        const { sourceSpeakerId, targetSpeakerId } = correction;

        if (!sourceSpeakerId || !targetSpeakerId) continue;

        // Remove source speaker from list
        delete speakers[sourceSpeakerId];

        // Remap all segments from source to target
        segments = segments.map(seg =>
          seg.speakerId === sourceSpeakerId
            ? { ...seg, speakerId: targetSpeakerId }
            : seg
        );
      } else if (correction.type === 'reassign') {
        const { segmentIds, toSpeakerId } = correction;

        if (!segmentIds || !toSpeakerId) continue;

        // Reassign only the specified segments to the new speaker
        const segmentIdSet = new Set(segmentIds);
        segments = segments.map(seg =>
          segmentIdSet.has(seg.segmentId)
            ? { ...seg, speakerId: toSpeakerId }
            : seg
        );
      }
    }

    // Prune speakers with zero remaining segments
    const speakersWithSegments = new Set(segments.map(seg => seg.speakerId));
    for (const speakerId in speakers) {
      if (!speakersWithSegments.has(speakerId)) {
        delete speakers[speakerId];
      }
    }

    return { correctedSpeakers: speakers, correctedSegments: segments };
  }, [originalSpeakers, originalSegments, corrections]);

  /**
   * Check if undo is available (have corrections to undo)
   */
  const canUndo = corrections.length > 0;

  /**
   * Merge two speakers by calling Cloud Function.
   * The function writes to Firestore, and our listener picks it up automatically.
   */
  const mergeSpeakers = useCallback(async (sourceSpeakerId: string, targetSpeakerId: string) => {
    if (isLoading) return;

    setIsLoading(true);
    setError(null);

    try {
      const mergeSpeakersFunction = httpsCallable(functions, 'mergeSpeakers');
      await mergeSpeakersFunction({
        conversationId,
        sourceSpeakerId,
        targetSpeakerId
      });

      // Success - the onSnapshot listener will update our state automatically
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to merge speakers';
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [conversationId, isLoading]);

  /**
   * Undo the most recent merge by deleting its correction record.
   * Firestore listener will automatically update our state.
   */
  const undoLastMerge = useCallback(async () => {
    if (!canUndo || isLoading) return;

    setIsLoading(true);
    setError(null);

    try {
      const lastCorrection = corrections[corrections.length - 1];

      // Dynamically import to avoid build-time resolution issues
      const { doc, deleteDoc } = await import('firebase/firestore');
      const correctionRef = doc(
        db,
        'conversations',
        conversationId,
        'speakerCorrections',
        lastCorrection.correctionId
      );

      await deleteDoc(correctionRef);

      // Success - the onSnapshot listener will update our state automatically
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to undo merge';
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [conversationId, corrections, canUndo, isLoading]);

  /**
   * Reassign specific segments to a different speaker by calling Cloud Function.
   * The function writes to Firestore, and our listener picks it up automatically.
   */
  const reassignSegments = useCallback(async (segmentIds: string[], toSpeakerId: string) => {
    if (isLoading) return;

    setIsLoading(true);
    setError(null);

    try {
      const reassignSegmentsFunction = httpsCallable(functions, 'reassignSegments');
      await reassignSegmentsFunction({
        conversationId,
        segmentIds,
        toSpeakerId
      });

      // Success - the onSnapshot listener will update our state automatically
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to reassign segments';
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [conversationId, isLoading]);

  /**
   * Clear error state
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    correctedSpeakers,
    correctedSegments,
    canUndo,
    mergeSpeakers,
    reassignSegments,
    undoLastMerge,
    isLoading,
    error,
    clearError
  };
}
