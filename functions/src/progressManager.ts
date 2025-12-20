import { FieldValue } from 'firebase-admin/firestore';
import { db } from './index';

// Processing step enum (keep in sync with frontend types.ts)
export enum ProcessingStep {
  PENDING = 'pending',
  UPLOADING = 'uploading',
  TRANSCRIBING = 'transcribing',
  ANALYZING = 'analyzing',
  ALIGNING = 'aligning',
  FINALIZING = 'finalizing',
  COMPLETE = 'complete',
  FAILED = 'failed'
}

// Progress percentages per step
const STEP_PERCENTAGES: Record<ProcessingStep, number> = {
  [ProcessingStep.PENDING]: 0,
  [ProcessingStep.UPLOADING]: 15,
  [ProcessingStep.TRANSCRIBING]: 40,
  [ProcessingStep.ANALYZING]: 60,
  [ProcessingStep.ALIGNING]: 85,
  [ProcessingStep.FINALIZING]: 95,
  [ProcessingStep.COMPLETE]: 100,
  [ProcessingStep.FAILED]: 0
};

export interface ProcessingProgress {
  currentStep: ProcessingStep;
  percentComplete: number;
  stepStartedAt?: FirebaseFirestore.Timestamp;
  estimatedRemainingMs?: number;
  errorMessage?: string;
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
 */
export class ProgressManager {
  private conversationId: string;
  private timeline: ProcessingTimeline[] = [];
  private currentStepStartTime: number = Date.now();

  constructor(conversationId: string) {
    this.conversationId = conversationId;
  }

  /**
   * Transition to a new processing step
   * Updates Firestore with current progress and timeline
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

    // Build progress object
    const progress: ProcessingProgress = {
      currentStep: step,
      percentComplete: STEP_PERCENTAGES[step],
      stepStartedAt: FieldValue.serverTimestamp() as any
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

      console.log(`[ProgressManager] Step: ${step} (${STEP_PERCENTAGES[step]}%)`, {
        conversationId: this.conversationId,
        step,
        percentComplete: STEP_PERCENTAGES[step]
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
