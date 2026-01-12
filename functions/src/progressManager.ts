import { FieldValue } from 'firebase-admin/firestore';
import { db } from './index';

// Processing step enum (keep in sync with frontend types.ts)
export enum ProcessingStep {
  PENDING = 'pending',
  UPLOADING = 'uploading',
  CHUNKING = 'chunking',
  PRE_ANALYZING = 'pre_analyzing',
  TRANSCRIBING = 'transcribing',
  ANALYZING = 'analyzing',
  REASSIGNING = 'reassigning',
  ALIGNING = 'aligning',
  FINALIZING = 'finalizing',
  COMPLETE = 'complete',
  FAILED = 'failed'
}

// Progress percentages per step
const STEP_PERCENTAGES: Record<ProcessingStep, number> = {
  [ProcessingStep.PENDING]: 0,
  [ProcessingStep.UPLOADING]: 10,
  [ProcessingStep.CHUNKING]: 15,
  [ProcessingStep.PRE_ANALYZING]: 25,
  [ProcessingStep.TRANSCRIBING]: 40,
  [ProcessingStep.ANALYZING]: 60,
  [ProcessingStep.REASSIGNING]: 75,
  [ProcessingStep.ALIGNING]: 85,
  [ProcessingStep.FINALIZING]: 95,
  [ProcessingStep.COMPLETE]: 100,
  [ProcessingStep.FAILED]: 0
};

// Step metadata interface
export interface StepMeta {
  label: string;
  description?: string;
  category: 'pending' | 'active' | 'success' | 'error';
}

// Self-describing metadata for each processing step
const STEP_META: Record<ProcessingStep, StepMeta> = {
  [ProcessingStep.PENDING]: {
    label: 'Pending',
    description: 'Waiting to start processing',
    category: 'pending'
  },
  [ProcessingStep.UPLOADING]: {
    label: 'Uploading',
    description: 'Uploading audio file to storage',
    category: 'active'
  },
  [ProcessingStep.CHUNKING]: {
    label: 'Splitting Audio',
    description: 'Splitting large audio into smaller chunks for processing',
    category: 'active'
  },
  [ProcessingStep.PRE_ANALYZING]: {
    label: 'Pre-analyzing',
    description: 'Identifying speakers and analyzing audio structure',
    category: 'active'
  },
  [ProcessingStep.TRANSCRIBING]: {
    label: 'Transcribing',
    description: 'Converting speech to text with speaker diarization',
    category: 'active'
  },
  [ProcessingStep.ANALYZING]: {
    label: 'Analyzing',
    description: 'Extracting topics, terms, and detecting people mentioned',
    category: 'active'
  },
  [ProcessingStep.REASSIGNING]: {
    label: 'Reassigning Speakers',
    description: 'Correcting speaker identification based on content analysis',
    category: 'active'
  },
  [ProcessingStep.ALIGNING]: {
    label: 'Aligning',
    description: 'Synchronizing timestamps with precise word-level timing',
    category: 'active'
  },
  [ProcessingStep.FINALIZING]: {
    label: 'Finalizing',
    description: 'Saving results and cleaning up',
    category: 'active'
  },
  [ProcessingStep.COMPLETE]: {
    label: 'Complete',
    description: 'Processing finished successfully',
    category: 'success'
  },
  [ProcessingStep.FAILED]: {
    label: 'Failed',
    description: 'Processing encountered an error',
    category: 'error'
  }
};

export interface ProcessingProgress {
  currentStep: ProcessingStep;
  percentComplete: number;
  stepStartedAt?: FirebaseFirestore.Timestamp;
  estimatedRemainingMs?: number;
  errorMessage?: string;
  stepMeta?: StepMeta;
}

export interface ProcessingTimeline {
  stepName: ProcessingStep;
  startedAt: string; // ISO timestamp (can't use FieldValue.serverTimestamp() in arrays)
  completedAt?: string; // ISO timestamp
  durationMs?: number;
}

/**
 * ProgressManager - Encapsulates Firestore progress updates for transcription
 *
 * Manages the processingProgress and processingTimeline fields in Firestore,
 * providing real-time feedback to the frontend about processing status.
 *
 * For chunked processing, computes aggregate progress across all chunks.
 */
export class ProgressManager {
  private conversationId: string;
  private timeline: ProcessingTimeline[] = [];
  private currentStepStartTime: number = Date.now();
  private chunkIndex?: number;
  private totalChunks?: number;
  private lastReportedProgress: number = 0; // For monotonic clamping

  constructor(conversationId: string, chunkIndex?: number, totalChunks?: number) {
    this.conversationId = conversationId;
    this.chunkIndex = chunkIndex;
    this.totalChunks = totalChunks;
  }

  /**
   * Transition to a new processing step
   * Updates Firestore with current progress and timeline
   *
   * For chunked processing, computes aggregate progress based on completed chunks.
   */
  async setStep(step: ProcessingStep, errorMessage?: string): Promise<void> {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    // Complete previous step in timeline if exists
    if (this.timeline.length > 0) {
      const prevStep = this.timeline[this.timeline.length - 1];
      prevStep.completedAt = nowIso;
      prevStep.durationMs = now - this.currentStepStartTime;
    }

    // Add new step to timeline (use ISO strings - FieldValue.serverTimestamp() not allowed in arrays)
    const timelineEntry: ProcessingTimeline = {
      stepName: step,
      startedAt: nowIso
    };
    this.timeline.push(timelineEntry);
    this.currentStepStartTime = now;

    // Build progress object with self-describing metadata
    const baseMeta = STEP_META[step];
    const stepMeta: StepMeta = errorMessage
      ? { ...baseMeta, category: 'error' } // Override category to 'error' when error present
      : baseMeta;

    // Calculate aggregate progress for chunked processing
    let percentComplete = STEP_PERCENTAGES[step];

    if (this.chunkIndex !== undefined && this.totalChunks !== undefined && this.totalChunks > 1) {
      // For chunked processing, use completedChunks from Firestore for accurate aggregate progress.
      // This handles out-of-order chunk completion correctly (parallel processing).
      //
      // Monotonic clamping: progress should never decrease.
      // In parallel processing, each chunk runs in a separate Cloud Function instance
      // (no shared memory), so we must also check the existing Firestore value—not
      // just lastReportedProgress, which is per-instance.
      let existingProgress = 0;

      try {
        const conversationSnap = await db.collection('conversations').doc(this.conversationId).get();
        const data = conversationSnap.data();
        const completedChunks = data?.chunkingMetadata?.completedChunks ?? this.chunkIndex;
        existingProgress = data?.processingProgress?.percentComplete ?? 0;

        // Base progress: completed chunks as percentage of total
        const baseProgress = (completedChunks / this.totalChunks) * 100;
        // Current chunk's step progress as a fraction of one chunk's worth
        const chunkProgress = (STEP_PERCENTAGES[step] / 100) * (100 / this.totalChunks);
        percentComplete = Math.min(99, Math.floor(baseProgress + chunkProgress)); // Cap at 99% until merge

        console.log(`[ProgressManager] Chunk ${this.chunkIndex + 1}/${this.totalChunks} at step ${step}:`, {
          completedChunks,
          baseProgress: baseProgress.toFixed(1),
          chunkProgress: chunkProgress.toFixed(1),
          aggregateProgress: percentComplete,
          existingProgress
        });
      } catch (error) {
        // If we can't read from Firestore, fall back to chunkIndex-based calculation.
        // existingProgress stays 0—we can't clamp against unknown Firestore state.
        const baseProgress = (this.chunkIndex / this.totalChunks) * 100;
        const chunkProgress = (STEP_PERCENTAGES[step] / 100) * (100 / this.totalChunks);
        percentComplete = Math.min(99, Math.floor(baseProgress + chunkProgress));

        console.warn(`[ProgressManager] Failed to read completedChunks, using fallback:`, {
          error: error instanceof Error ? error.message : String(error),
          fallbackProgress: percentComplete
        });
      }

      // Apply monotonic clamping using the higher of Firestore and local memory
      const progressFloor = Math.max(existingProgress, this.lastReportedProgress);
      if (percentComplete < progressFloor) {
        console.log(`[ProgressManager] Clamping progress to prevent regression:`, {
          calculated: percentComplete,
          existingFirestore: existingProgress,
          lastReportedLocal: this.lastReportedProgress,
          usingClamped: progressFloor
        });
        percentComplete = progressFloor;
      }
      this.lastReportedProgress = Math.max(this.lastReportedProgress, percentComplete);
    }

    const progress: ProcessingProgress = {
      currentStep: step,
      percentComplete,
      stepStartedAt: FieldValue.serverTimestamp() as any,
      stepMeta
    };

    if (errorMessage) {
      progress.errorMessage = errorMessage;
    }

    // Update Firestore - wrapped in try/catch so progress failures don't break transcription
    try {
      await db.collection('conversations').doc(this.conversationId).update({
        processingProgress: progress,
        processingTimeline: this.timeline,
        updatedAt: FieldValue.serverTimestamp()
      });

      console.log(`[ProgressManager] Step: ${step} (${percentComplete}%)`, {
        conversationId: this.conversationId,
        step,
        percentComplete,
        isChunked: this.chunkIndex !== undefined,
        chunkIndex: this.chunkIndex,
        totalChunks: this.totalChunks
      });
    } catch (error) {
      // Log but don't throw - progress updates are nice-to-have, not critical
      console.error(`[ProgressManager] Failed to update progress (non-fatal):`, {
        conversationId: this.conversationId,
        step,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Mark processing as failed
   */
  async setFailed(errorMessage: string): Promise<void> {
    await this.setStep(ProcessingStep.FAILED, errorMessage);
  }

  /**
   * Mark processing as complete
   */
  async setComplete(): Promise<void> {
    await this.setStep(ProcessingStep.COMPLETE);
  }
}
