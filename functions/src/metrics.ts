/**
 * Processing metrics collection
 *
 * Records timing and outcome data for each transcription job.
 * Stored in _metrics collection for analysis and monitoring.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { db } from './index';
import { log } from './logger';

/**
 * Processing stage timings (in milliseconds)
 */
export interface ProcessingMetrics {
  conversationId: string;
  userId: string;
  status: 'success' | 'failed';
  errorMessage?: string;
  alignmentStatus?: 'aligned' | 'fallback';

  // Stage timings (ms)
  timingMs: {
    download: number;
    whisperx: number;
    buildSegments: number;
    gemini: number;
    speakerCorrection: number;
    transform: number;
    firestore: number;
    total: number;
  };

  // Result counts
  segmentCount: number;
  speakerCount: number;
  termCount: number;
  topicCount: number;
  personCount: number;
  speakerCorrectionsApplied: number;

  // Audio metadata
  audioSizeMB: number;
  durationMs: number;

  // Timestamp
  timestamp: FieldValue;
}

/**
 * Record processing metrics to Firestore
 * Stored in _metrics collection for analysis
 */
export async function recordMetrics(metrics: Omit<ProcessingMetrics, 'timestamp'>): Promise<void> {
  try {
    const metricsWithTimestamp: ProcessingMetrics = {
      ...metrics,
      timestamp: FieldValue.serverTimestamp()
    };

    await db.collection('_metrics').add(metricsWithTimestamp);

    log.info('Metrics recorded', {
      conversationId: metrics.conversationId,
      stage: 'metrics',
      status: metrics.status,
      totalMs: metrics.timingMs.total
    });
  } catch (error) {
    // Don't fail the transcription if metrics recording fails
    // Just log the error
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.warn('Failed to record metrics', {
      conversationId: metrics.conversationId,
      stage: 'metrics',
      error: errorMessage
    });
  }
}
