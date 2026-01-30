/**
 * useSpeakerCorrections Hook
 *
 * Manages speaker correction state for a conversation:
 * - Real-time subscription to speakerCorrections subcollection
 * - Apply-on-read logic: compute corrected speakers and segments
 * - Merge, reassign, and rename speakers via Cloud Functions
 * - Undo support with audit trail preservation (sets undoneAt, doesn't delete)
 *
 * Pattern: Original conversation data stays immutable.
 * All corrections are applied at read time.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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

/** Toast notification data for undo actions */
export interface CorrectionToast {
  correctionId: string;
  message: string;
  type: 'merge' | 'reassign' | 'rename';
}

interface UseSpeakerCorrectionsReturn {
  /** Corrected speaker list with all corrections applied */
  correctedSpeakers: Record<string, Speaker>;
  /** Segments with corrected speaker IDs */
  correctedSegments: Segment[];
  /** Whether undo is available (has active corrections) */
  canUndo: boolean;
  /** Number of corrections in the undo stack */
  undoStackSize: number;
  /** Merge two speakers (calls Cloud Function) */
  mergeSpeakers: (sourceSpeakerId: string, targetSpeakerId: string) => Promise<void>;
  /** Reassign specific segments to a different speaker (calls Cloud Function) */
  reassignSegments: (segmentIds: string[], toSpeakerId: string) => Promise<void>;
  /** Rename a speaker (calls Cloud Function) */
  renameSpeaker: (speakerId: string, newDisplayName: string) => Promise<void>;
  /** Undo the most recent active correction (uses Cloud Function to preserve audit) */
  undoLastCorrection: () => Promise<void>;
  /** Loading state for correction operations */
  isLoading: boolean;
  /** Error message if operation fails */
  error: string | null;
  /** Clear error state */
  clearError: () => void;
  /** Latest toast notification (for UI display), cleared after read */
  pendingToast: CorrectionToast | null;
  /** Clear the pending toast */
  clearPendingToast: () => void;
  /** Recent merge visual feedback (cleared after 1.5s) */
  recentMerge: { sourceSpeakerId: string; targetSpeakerId: string } | null;
  /** Recent reassign segment IDs (cleared after 1.5s) */
  recentReassignSegmentIds: string[];
}

/**
 * Firestore document type for speaker corrections
 */
interface SpeakerCorrectionDoc extends Omit<SpeakerCorrection, 'createdAt' | 'undoneAt'> {
  createdAt: Timestamp;
  undoneAt?: Timestamp;
}

// Maximum corrections tracked in undo stack
const MAX_UNDO_STACK_SIZE = 20;

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
  const [allCorrections, setAllCorrections] = useState<SpeakerCorrection[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingToast, setPendingToast] = useState<CorrectionToast | null>(null);

  // Visual feedback state for corrections (cleared after 1.5s)
  const [recentMerge, setRecentMerge] = useState<{ sourceSpeakerId: string; targetSpeakerId: string } | null>(null);
  const [recentReassignSegmentIds, setRecentReassignSegmentIds] = useState<string[]>([]);

  // Track undo stack for last N corrections (in-memory, not persisted)
  const undoStackRef = useRef<string[]>([]);

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
            // Rename correction fields
            speakerId: data.speakerId,
            newDisplayName: data.newDisplayName,
            previousDisplayName: data.previousDisplayName,
            // Common fields
            createdAt: data.createdAt.toDate().toISOString(),
            userId: data.userId,
            // Undo support
            undoneAt: data.undoneAt?.toDate().toISOString()
          };
        });

        setAllCorrections(loadedCorrections);
      },
      (err) => {
        console.error('[useSpeakerCorrections] Subscription error:', err);
        setError('Failed to load speaker corrections');
      }
    );

    return () => unsubscribe();
  }, [conversationId]);

  /**
   * Active corrections = corrections that haven't been undone.
   * These are what we apply in the apply-on-read logic.
   */
  const activeCorrections = useMemo(() => {
    return allCorrections.filter(c => !c.undoneAt);
  }, [allCorrections]);

  /**
   * Filter undo stack to remove correction IDs that are no longer active.
   * This ensures the stack only contains valid IDs to undo.
   */
  useEffect(() => {
    const activeIds = new Set(activeCorrections.map(c => c.correctionId));
    undoStackRef.current = undoStackRef.current.filter(id => activeIds.has(id));
  }, [activeCorrections]);

  /**
   * Apply corrections to derive corrected speakers and segments.
   * This is the core apply-on-read logic - we never mutate the original data.
   */
  const { correctedSpeakers, correctedSegments } = useMemo(() => {
    // Start with deep copies of originals
    let speakers: Record<string, Speaker> = {};
    for (const [id, speaker] of Object.entries(originalSpeakers)) {
      speakers[id] = { ...speaker };
    }
    let segments = originalSegments.map(seg => ({ ...seg }));

    // Apply each active correction in chronological order
    for (const correction of activeCorrections) {
      if (correction.type === 'merge') {
        const { sourceSpeakerId, targetSpeakerId } = correction;

        if (!sourceSpeakerId || !targetSpeakerId) continue;
        if (!speakers[sourceSpeakerId] || !speakers[targetSpeakerId]) continue;

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
      } else if (correction.type === 'rename') {
        const { speakerId, newDisplayName } = correction;

        if (!speakerId || !newDisplayName) continue;
        if (!speakers[speakerId]) continue;

        // Update the speaker's display name (preserve colorIndex)
        speakers[speakerId] = {
          ...speakers[speakerId],
          displayName: newDisplayName
        };
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
  }, [originalSpeakers, originalSegments, activeCorrections]);

  /**
   * Check if undo is available (have corrections in the in-memory undo stack)
   */
  const canUndo = undoStackRef.current.length > 0;
  const undoStackSize = undoStackRef.current.length;

  /**
   * Add a correction to the undo stack (after successful creation)
   */
  const pushToUndoStack = useCallback((correctionId: string) => {
    undoStackRef.current = [
      correctionId,
      ...undoStackRef.current.slice(0, MAX_UNDO_STACK_SIZE - 1)
    ];
  }, []);

  /**
   * Generate a human-readable message for a correction
   */
  const getCorrectionMessage = useCallback((
    type: 'merge' | 'reassign' | 'rename',
    details: { sourceName?: string; targetName?: string; segmentCount?: number; speakerName?: string; newName?: string }
  ): string => {
    switch (type) {
      case 'merge':
        return `Merged "${details.sourceName}" into "${details.targetName}"`;
      case 'reassign':
        return `Reassigned ${details.segmentCount} segment${details.segmentCount === 1 ? '' : 's'}`;
      case 'rename':
        return `Renamed speaker to "${details.newName}"`;
      default:
        return 'Speaker correction applied';
    }
  }, []);

  /**
   * Merge two speakers by calling Cloud Function.
   * The function writes to Firestore, and our listener picks it up automatically.
   */
  const mergeSpeakers = useCallback(async (sourceSpeakerId: string, targetSpeakerId: string) => {
    if (isLoading) return;

    setIsLoading(true);
    setError(null);

    const sourceName = correctedSpeakers[sourceSpeakerId]?.displayName || 'Speaker';
    const targetName = correctedSpeakers[targetSpeakerId]?.displayName || 'Speaker';

    try {
      const mergeSpeakersFunction = httpsCallable<
        { conversationId: string; sourceSpeakerId: string; targetSpeakerId: string },
        { success: boolean; correctionId: string }
      >(functions, 'mergeSpeakers');

      const result = await mergeSpeakersFunction({
        conversationId,
        sourceSpeakerId,
        targetSpeakerId
      });

      // Add to undo stack and create toast
      pushToUndoStack(result.data.correctionId);
      setPendingToast({
        correctionId: result.data.correctionId,
        message: getCorrectionMessage('merge', { sourceName, targetName }),
        type: 'merge'
      });

      // Set visual feedback for merge (cleared after 1.5s)
      setRecentMerge({ sourceSpeakerId, targetSpeakerId });
      setTimeout(() => setRecentMerge(null), 1500);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to merge speakers';
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [conversationId, isLoading, correctedSpeakers, pushToUndoStack, getCorrectionMessage]);

  /**
   * Reassign specific segments to a different speaker by calling Cloud Function.
   */
  const reassignSegments = useCallback(async (segmentIds: string[], toSpeakerId: string) => {
    if (isLoading) return;

    setIsLoading(true);
    setError(null);

    const targetName = correctedSpeakers[toSpeakerId]?.displayName || 'Speaker';

    try {
      const reassignSegmentsFunction = httpsCallable<
        { conversationId: string; segmentIds: string[]; toSpeakerId: string },
        { success: boolean; correctionId: string }
      >(functions, 'reassignSegments');

      const result = await reassignSegmentsFunction({
        conversationId,
        segmentIds,
        toSpeakerId
      });

      // Add to undo stack and create toast
      pushToUndoStack(result.data.correctionId);
      setPendingToast({
        correctionId: result.data.correctionId,
        message: getCorrectionMessage('reassign', { segmentCount: segmentIds.length, targetName }),
        type: 'reassign'
      });

      // Set visual feedback for reassign (cleared after 1.5s)
      setRecentReassignSegmentIds(segmentIds);
      setTimeout(() => setRecentReassignSegmentIds([]), 1500);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to reassign segments';
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [conversationId, isLoading, correctedSpeakers, pushToUndoStack, getCorrectionMessage]);

  /**
   * Rename a speaker by calling Cloud Function.
   */
  const renameSpeaker = useCallback(async (speakerId: string, newDisplayName: string) => {
    if (isLoading) return;

    setIsLoading(true);
    setError(null);

    try {
      const renameSpeakerFunction = httpsCallable<
        { conversationId: string; speakerId: string; newDisplayName: string },
        { success: boolean; correctionId: string }
      >(functions, 'renameSpeaker');

      const result = await renameSpeakerFunction({
        conversationId,
        speakerId,
        newDisplayName
      });

      // Add to undo stack and create toast
      pushToUndoStack(result.data.correctionId);
      setPendingToast({
        correctionId: result.data.correctionId,
        message: getCorrectionMessage('rename', { newName: newDisplayName }),
        type: 'rename'
      });

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to rename speaker';
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [conversationId, isLoading, pushToUndoStack, getCorrectionMessage]);

  /**
   * Undo the most recent correction from the in-memory undo stack by calling Cloud Function.
   * This sets undoneAt instead of deleting, preserving audit trail.
   */
  const undoLastCorrection = useCallback(async () => {
    if (undoStackRef.current.length === 0 || isLoading) return;

    setIsLoading(true);
    setError(null);

    try {
      // Get the most recent correction ID from the in-memory undo stack
      const correctionIdToUndo = undoStackRef.current[0];

      const undoCorrectionFunction = httpsCallable<
        { conversationId: string; correctionId: string },
        { success: boolean }
      >(functions, 'undoCorrection');

      await undoCorrectionFunction({
        conversationId,
        correctionId: correctionIdToUndo
      });

      // Remove from undo stack
      undoStackRef.current = undoStackRef.current.filter(
        id => id !== correctionIdToUndo
      );

      // Success - the onSnapshot listener will update our state automatically

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to undo correction';
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

  /**
   * Clear pending toast
   */
  const clearPendingToast = useCallback(() => {
    setPendingToast(null);
  }, []);

  return {
    correctedSpeakers,
    correctedSegments,
    canUndo,
    undoStackSize,
    mergeSpeakers,
    reassignSegments,
    renameSpeaker,
    undoLastCorrection,
    isLoading,
    error,
    clearError,
    pendingToast,
    clearPendingToast,
    recentMerge,
    recentReassignSegmentIds
  };
}
