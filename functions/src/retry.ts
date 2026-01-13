/**
 * Retry Transcription Callable Function
 *
 * Allows users to retry failed or aborted transcription jobs.
 * Implements smart retry logic:
 * - For non-chunked jobs: Full restart from scratch
 * - For chunked jobs: Resume only incomplete chunks
 *
 * Features:
 * - Max 3 retry attempts per job
 * - Validates audio file still exists
 * - Clears previous error state
 * - Tracks retry metadata for observability
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { db, bucket } from './index';
import { ChunkingMetadata, ChunkStatus } from './types';

interface RetryTranscriptionRequest {
  conversationId: string;
}

interface RetryTranscriptionResponse {
  success: boolean;
  message: string;
  resumeMode: 'full_restart' | 'resume_chunks';
  chunksToResume?: number[];
}

const MAX_RETRIES = 3;

/**
 * Retry a failed or aborted transcription job.
 *
 * Security:
 * - Requires authentication
 * - Verifies user owns the conversation
 * - Enforces max retry limit
 * - Validates audio file exists
 */
export const retryTranscription = onCall<RetryTranscriptionRequest>(
  {
    region: 'us-central1',
    memory: '512MiB', // Only needs to enqueue tasks in production
    timeoutSeconds: 60 // 1 minute - just enqueueing tasks
  },
  async (request): Promise<RetryTranscriptionResponse> => {
    // Require authentication
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in to retry transcription');
    }

    const { conversationId } = request.data;
    const userId = request.auth.uid;

    if (!conversationId) {
      throw new HttpsError('invalid-argument', 'conversationId is required');
    }

    // Load conversation document
    const conversationRef = db.collection('conversations').doc(conversationId);
    const conversationSnap = await conversationRef.get();

    if (!conversationSnap.exists) {
      throw new HttpsError('not-found', 'Conversation not found');
    }

    const conversationData = conversationSnap.data();

    // Verify ownership
    if (conversationData?.userId !== userId) {
      throw new HttpsError('permission-denied', 'You do not have access to this conversation');
    }

    // Verify status is failed or aborted
    const status = conversationData?.status;
    if (status !== 'failed' && status !== 'aborted') {
      throw new HttpsError('failed-precondition', `Cannot retry job with status: ${status}`);
    }

    // Check retry count
    const retryCount = conversationData?.retryCount || 0;
    if (retryCount >= MAX_RETRIES) {
      throw new HttpsError('resource-exhausted', `Maximum retry limit (${MAX_RETRIES}) reached`);
    }

    // Verify audio file exists
    const audioStoragePath = conversationData?.audioStoragePath;
    if (!audioStoragePath) {
      throw new HttpsError('not-found', 'No audio file associated with this conversation');
    }

    const audioFile = bucket.file(audioStoragePath);
    const [exists] = await audioFile.exists();
    if (!exists) {
      throw new HttpsError('not-found', 'Audio file no longer exists in storage');
    }

    console.log('[Retry] Starting retry for conversation:', {
      conversationId,
      userId,
      currentRetryCount: retryCount,
      previousStatus: status
    });

    // Determine retry strategy: full restart or resume chunks
    const chunkingMetadata = conversationData?.chunkingMetadata as ChunkingMetadata | undefined;
    const isChunked = chunkingMetadata?.chunkingEnabled === true;
    const hasPartialProgress = isChunked &&
      chunkingMetadata.completedChunks > 0 &&
      chunkingMetadata.completedChunks < chunkingMetadata.totalChunks;

    let resumeMode: 'full_restart' | 'resume_chunks';
    let chunksToResume: number[] | undefined;

    if (hasPartialProgress && chunkingMetadata) {
      // Resume only incomplete chunks
      resumeMode = 'resume_chunks';

      // Find chunks that are not complete
      const incompleteChunks = chunkingMetadata.chunkStatuses
        .filter((chunk: ChunkStatus) => chunk.status !== 'complete')
        .map((chunk: ChunkStatus) => chunk.chunkIndex);

      chunksToResume = incompleteChunks;

      console.log('[Retry] Resuming incomplete chunks:', {
        conversationId,
        totalChunks: chunkingMetadata.totalChunks,
        completedChunks: chunkingMetadata.completedChunks,
        chunksToResume: incompleteChunks
      });

      // Reset incomplete chunk statuses to pending
      const updatedStatuses = chunkingMetadata.chunkStatuses.map((chunk: ChunkStatus) => {
        if (incompleteChunks.includes(chunk.chunkIndex)) {
          return {
            chunkIndex: chunk.chunkIndex,
            status: 'pending' as const,
            startedAt: undefined,
            completedAt: undefined,
            error: undefined,
            retryCount: (chunk.retryCount || 0) + 1
          };
        }
        return chunk;
      });

      // Update conversation: reset to chunking status, clear errors and stale progress
      // Increment taskGeneration to invalidate any stale Cloud Tasks from previous attempts
      // Clear processingProgress and processingTimeline to avoid showing stale data from failed attempt
      await conversationRef.update({
        status: 'chunking',
        processingError: FieldValue.delete(),
        processingProgress: FieldValue.delete(),
        processingTimeline: FieldValue.delete(),
        abortRequested: FieldValue.delete(),
        retryCount: FieldValue.increment(1),
        taskGeneration: FieldValue.increment(1), // Invalidate stale tasks
        lastFailedAt: conversationData.updatedAt,
        lastRetryAt: new Date().toISOString(),
        'chunkingMetadata.chunkStatuses': updatedStatuses,
        updatedAt: FieldValue.serverTimestamp()
      });

      // Check for emulator mode
      const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true';

      if (isEmulator) {
        // Cloud Tasks can't reach localhost in emulator mode
        // Just log and let the status update stand - user can re-upload in emulator
        console.warn('[Retry] 🧪 Emulator mode - Cloud Tasks cannot reach localhost.');
        console.warn('[Retry] Retry requires cloud deployment. Status reset to chunking.');
        throw new HttpsError(
          'failed-precondition',
          'Retry is not supported in emulator mode. Please deploy to cloud or re-upload the file.'
        );
      }

      // Production: enqueue tasks for incomplete chunks
      // New taskGeneration = old + 1 (we just incremented it in Firestore)
      const newTaskGeneration = (conversationData.taskGeneration || 0) + 1;
      await enqueueChunkTasks(
        conversationId,
        userId,
        chunkingMetadata,
        incompleteChunks,
        conversationData.processingMode || 'parallel',
        newTaskGeneration
      );

    } else {
      // Full restart from scratch
      resumeMode = 'full_restart';

      console.log('[Retry] Full restart from scratch:', {
        conversationId,
        isChunked,
        hasPartialProgress
      });

      // Clear chunk metadata if it exists (restart fresh)
      // Increment taskGeneration to invalidate any stale Cloud Tasks from previous attempts
      const updateData: any = {
        status: 'processing',
        processingError: FieldValue.delete(),
        abortRequested: FieldValue.delete(),
        retryCount: FieldValue.increment(1),
        taskGeneration: FieldValue.increment(1), // Invalidate stale tasks
        lastFailedAt: conversationData.updatedAt,
        lastRetryAt: new Date().toISOString(),
        // Clear processing progress
        processingProgress: FieldValue.delete(),
        processingTimeline: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp()
      };

      // Clear chunking metadata if present
      if (isChunked) {
        updateData.chunkingMetadata = FieldValue.delete();
        updateData.chunkMetadata = FieldValue.delete();
      }

      await conversationRef.update(updateData);

      // Check for emulator mode
      const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true';

      if (isEmulator) {
        // Cloud Tasks can't reach localhost in emulator mode
        console.warn('[Retry] 🧪 Emulator mode - Cloud Tasks cannot reach localhost.');
        console.warn('[Retry] Retry requires cloud deployment. Status reset to processing.');
        throw new HttpsError(
          'failed-precondition',
          'Retry is not supported in emulator mode. Please deploy to cloud or re-upload the file.'
        );
      }

      // Production: enqueue full restart via Cloud Tasks
      // New taskGeneration = old + 1 (we just incremented it in Firestore)
      const newTaskGeneration = (conversationData.taskGeneration || 0) + 1;
      await enqueueFullRestartTask(conversationId, userId, audioStoragePath, newTaskGeneration);
    }

    console.log('[Retry] ✅ Retry initiated successfully:', {
      conversationId,
      resumeMode,
      newRetryCount: retryCount + 1
    });

    return {
      success: true,
      message: resumeMode === 'resume_chunks'
        ? `Resuming ${chunksToResume!.length} incomplete chunks`
        : 'Restarting full transcription',
      resumeMode,
      chunksToResume
    };
  }
);

/**
 * Enqueue Cloud Tasks for incomplete chunks in resume mode.
 */
async function enqueueChunkTasks(
  conversationId: string,
  userId: string,
  chunkingMetadata: ChunkingMetadata,
  chunkIndices: number[],
  processingMode: 'parallel' | 'sequential',
  taskGeneration: number
): Promise<void> {
  const { CloudTasksClient } = await import('@google-cloud/tasks');
  const tasksClient = new CloudTasksClient();

  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  if (!project) {
    throw new Error('GCP project ID not found in environment');
  }

  const location = 'us-central1';
  const queue = 'transcription-queue';
  const parent = tasksClient.queuePath(project, location, queue);

  const functionName = 'processTranscription';
  const processTranscriptionUrl = `https://${location}-${project}.cloudfunctions.net/${functionName}`;

  const DISPATCH_DEADLINE_SECONDS = 1800; // 30 minutes (Cloud Tasks max)

  // Load chunk artifacts to get storage paths
  const chunksSnap = await db.collection('conversations')
    .doc(conversationId)
    .collection('chunks')
    .get();

  const chunkStoragePaths = new Map<number, string>();
  chunksSnap.docs.forEach(doc => {
    const data = doc.data();
    if (data.chunkIndex !== undefined && data.storagePath) {
      chunkStoragePaths.set(data.chunkIndex, data.storagePath);
    }
  });

  // Create tasks for each incomplete chunk
  const taskPromises = chunkIndices.map(async (chunkIndex, arrayIndex) => {
    const chunkStoragePath = chunkStoragePaths.get(chunkIndex);
    if (!chunkStoragePath) {
      throw new Error(`Missing storage path for chunk ${chunkIndex}`);
    }

    // Find chunk bounds from chunkStatuses (or derive from metadata)
    // For simplicity, we'll derive approximate bounds from index
    const chunkDurationMs = chunkingMetadata.originalDurationMs / chunkingMetadata.totalChunks;
    const overlapMs = 15000; // 15 seconds overlap (typical)

    const payload = {
      conversationId,
      userId,
      filePath: chunkStoragePath,
      chunkIndex,
      totalChunks: chunkingMetadata.totalChunks,
      chunkMetadata: {
        chunkIndex,
        totalChunks: chunkingMetadata.totalChunks,
        chunkStoragePath,
        originalStoragePath: chunkingMetadata.originalStoragePath,
        startMs: chunkIndex * chunkDurationMs,
        endMs: (chunkIndex + 1) * chunkDurationMs,
        overlapBeforeMs: chunkIndex > 0 ? overlapMs : 0,
        overlapAfterMs: chunkIndex < chunkingMetadata.totalChunks - 1 ? overlapMs : 0,
        durationMs: chunkDurationMs
      },
      processingMode,
      taskGeneration // Allows stale task detection
    };

    const task = {
      httpRequest: {
        httpMethod: 'POST' as const,
        url: processTranscriptionUrl,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(payload)).toString('base64'),
        oidcToken: { serviceAccountEmail: `${project}@appspot.gserviceaccount.com` }
      },
      scheduleTime: { seconds: Math.floor(Date.now() / 1000) + 5 + (arrayIndex * 2) },
      dispatchDeadline: { seconds: DISPATCH_DEADLINE_SECONDS }
    };

    const [createdTask] = await tasksClient.createTask({ parent, task });

    console.log('[Retry] Chunk task enqueued:', {
      conversationId,
      chunkIndex,
      taskName: createdTask.name
    });

    return createdTask;
  });

  await Promise.all(taskPromises);

  console.log('[Retry] ✅ All chunk tasks enqueued for resume:', {
    conversationId,
    taskCount: chunkIndices.length
  });
}

/**
 * Enqueue a full restart task by simulating the transcribeAudio trigger.
 * Creates a task to processTranscription with the original audio file.
 */
async function enqueueFullRestartTask(
  conversationId: string,
  userId: string,
  audioStoragePath: string,
  taskGeneration: number
): Promise<void> {
  const { CloudTasksClient } = await import('@google-cloud/tasks');
  const tasksClient = new CloudTasksClient();

  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  if (!project) {
    throw new Error('GCP project ID not found in environment');
  }

  const location = 'us-central1';
  const queue = 'transcription-queue';
  const parent = tasksClient.queuePath(project, location, queue);

  const functionName = 'processTranscription';
  const processTranscriptionUrl = `https://${location}-${project}.cloudfunctions.net/${functionName}`;

  const payload = {
    conversationId,
    userId,
    filePath: audioStoragePath,
    taskGeneration, // Allows stale task detection
    // No chunk metadata = full file processing
    chunkIndex: undefined,
    totalChunks: undefined
  };

  const task = {
    httpRequest: {
      httpMethod: 'POST' as const,
      url: processTranscriptionUrl,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(payload)).toString('base64'),
      oidcToken: { serviceAccountEmail: `${project}@appspot.gserviceaccount.com` }
    },
    scheduleTime: { seconds: Math.floor(Date.now() / 1000) + 5 },
    dispatchDeadline: { seconds: 1800 } // 30 minutes (Cloud Tasks max)
  };

  const [createdTask] = await tasksClient.createTask({ parent, task });

  console.log('[Retry] Full restart task enqueued:', {
    conversationId,
    taskName: createdTask.name
  });
}
