/**
 * Process Transcription HTTP Function
 *
 * Long-running HTTP function invoked by Cloud Tasks to process audio transcription.
 * Receives a queued job from the storage trigger and performs the full transcription pipeline:
 * 1. Downloads audio from Storage
 * 2. Calls Gemini for pre-analysis (speaker hints)
 * 3. Calls WhisperX for transcription + alignment
 * 4. Calls Gemini for content analysis (topics, terms, people)
 * 5. Saves results to Firestore
 *
 * For chunked audio files (>30 min), this function:
 * 1. Loads the ChunkContext from the previous chunk (or initial for chunk 0)
 * 2. Marks the chunk as "processing" in chunkStatuses
 * 3. Processes the chunk with context-aware diarization
 * 4. Emits a new ChunkContext for the next chunk
 * 5. Marks the chunk as "complete" or "failed" for resume logic
 *
 * This function has a 60-minute timeout (vs 9-minute limit for storage triggers)
 * to handle large audio files (46MB+) that can take 10-15+ minutes to process.
 *
 * Cloud Tasks provides automatic retry with exponential backoff on 500 errors.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './index';
import { executeTranscriptionPipeline } from './transcribe';
import {
  loadChunkContext,
  markChunkProcessing,
  markChunkComplete,
  markChunkFailed,
  buildNextContext,
  sanitizeForFirestore,
  createInitialChunkContext
} from './chunkContext';
import { ChunkContext, ProcessingMode, SpeakerSignature } from './types';
import { ChunkMetadata } from './chunking';
import { BUILD_VERSION, BUILD_NUMBER } from './version';

/**
 * Enqueue a merge task to Cloud Tasks.
 * Called after all chunks complete to trigger final merge.
 */
async function enqueueMergeTask(conversationId: string): Promise<void> {
  console.log('[ProcessTranscription] Enqueueing merge task:', { conversationId });

  const { CloudTasksClient } = await import('@google-cloud/tasks');
  const tasksClient = new CloudTasksClient();

  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  if (!project) {
    throw new Error('GCP project ID not found in environment');
  }

  const location = 'us-central1';
  const queue = 'transcription-queue';
  const parent = tasksClient.queuePath(project, location, queue);

  const functionName = 'processMerge';
  const processMergeUrl = `https://${location}-${project}.cloudfunctions.net/${functionName}`;

  const payload = { conversationId };

  const task = {
    httpRequest: {
      httpMethod: 'POST' as const,
      url: processMergeUrl,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(payload)).toString('base64'),
      oidcToken: { serviceAccountEmail: `${project}@appspot.gserviceaccount.com` }
    },
    scheduleTime: { seconds: Math.floor(Date.now() / 1000) + 5 }, // 5 second delay
    dispatchDeadline: { seconds: 600 } // 10 minutes (enough for merge)
  };

  console.log('[ProcessTranscription] Creating merge task:', {
    conversationId,
    queue: `${location}/${queue}`,
    targetUrl: processMergeUrl
  });

  const [createdTask] = await tasksClient.createTask({ parent, task });

  console.log('[ProcessTranscription] ✅ Merge task enqueued:', {
    conversationId,
    taskName: createdTask.name
  });
}

// Define secrets (same as transcribeAudio - needed for heavy processing)
const replicateApiToken = defineSecret('REPLICATE_API_TOKEN');
const huggingfaceAccessToken = defineSecret('HUGGINGFACE_ACCESS_TOKEN');

/**
 * Cloud Tasks payload for transcription job.
 * Extended for chunk tasks to include chunk-specific metadata.
 */
interface TranscriptionTaskPayload {
  conversationId: string;
  userId: string;
  filePath: string;
  /**
   * Processing mode for chunked uploads.
   * - 'parallel': Chunks run independently (fast, speaker reconciliation at merge)
   * - 'sequential': Chunks wait for predecessor context (legacy, consistent speaker IDs)
   * Defaults to 'parallel' if not specified.
   */
  processingMode?: ProcessingMode;
  /**
   * Task generation - incremented on each retry.
   * Used to detect stale tasks from previous retry attempts.
   */
  taskGeneration?: number;
  // Chunk-specific fields (present for chunked audio processing)
  chunkIndex?: number;
  totalChunks?: number;
  chunkMetadata?: ChunkMetadata;
  chunkStartMs?: number;
  chunkEndMs?: number;
  overlapBeforeMs?: number;
  overlapAfterMs?: number;
}

/**
 * Check if this is a chunk task (vs a whole-file task).
 */
function isChunkTask(payload: TranscriptionTaskPayload): boolean {
  return payload.chunkIndex !== undefined && payload.totalChunks !== undefined;
}

/**
 * HTTP function invoked by Cloud Tasks to process audio transcription.
 *
 * Security: Only accepts requests from Cloud Tasks (x-cloudtasks-taskname header).
 * Returns 200 on success (Cloud Tasks won't retry).
 * Returns 500 on failure (Cloud Tasks will retry with backoff).
 */
export const processTranscription = onRequest(
  {
    memory: '2GiB', // Increased from 1GiB - large audio files need more memory
    timeoutSeconds: 3600, // 60 minutes (enough for large files)
    region: 'us-central1',
    invoker: 'private', // Only Cloud Tasks can call this
    secrets: [replicateApiToken, huggingfaceAccessToken]
  },
  async (req, res) => {
    // Validate Cloud Tasks header (security check - prevents direct invocation)
    const taskName = req.headers['x-cloudtasks-taskname'];
    if (!taskName && process.env.K_SERVICE) { // K_SERVICE is set in Cloud Run
      console.error('[ProcessTranscription] Forbidden: Direct invocation not allowed');
      res.status(403).send('Forbidden: Direct invocation not allowed');
      return;
    }

    console.log('[ProcessTranscription] Task started:', {
      taskName,
      timestamp: new Date().toISOString()
    });

    // Parse request payload
    let payload: TranscriptionTaskPayload;
    try {
      payload = req.body as TranscriptionTaskPayload;

      if (!payload.conversationId || !payload.userId || !payload.filePath) {
        throw new Error('Missing required fields: conversationId, userId, or filePath');
      }

      console.log('[ProcessTranscription] Processing task:', {
        conversationId: payload.conversationId,
        userId: payload.userId,
        filePath: payload.filePath
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Invalid request payload';
      console.error('[ProcessTranscription] Invalid payload:', errorMessage);
      res.status(400).send(`Bad Request: ${errorMessage}`);
      return;
    }

    const { conversationId, userId, filePath } = payload;
    const isChunk = isChunkTask(payload);
    const chunkIndex = payload.chunkIndex ?? -1;
    // Default to parallel mode for new uploads (faster for users)
    const processingMode: ProcessingMode = payload.processingMode ?? 'parallel';

    // Check for stale task (task from a previous generation before retry)
    // This prevents old retrying Cloud Tasks from interfering with new retry attempts
    // Default to 0 for tasks created before taskGeneration feature - they're always stale after a retry
    const payloadGeneration = payload.taskGeneration ?? 0;
    const conversationSnap = await db.collection('conversations').doc(conversationId).get();
    if (conversationSnap.exists) {
      const currentGeneration = conversationSnap.data()?.taskGeneration ?? 1;
      if (payloadGeneration < currentGeneration) {
        console.log('[ProcessTranscription] ⏭️ Stale task detected, skipping:', {
          conversationId,
          chunkIndex: isChunk ? chunkIndex : 'N/A',
          payloadGeneration,
          currentGeneration,
          message: 'Task from older generation - a retry has started newer tasks'
        });
        // Return 200 to prevent Cloud Tasks from retrying this stale task
        res.status(200).send('Stale task skipped');
        return;
      }
    }

    // Chunk context for propagation (only used for chunk tasks)
    let chunkContext: ChunkContext | null = null;

    try {
      // For chunk tasks, load context and mark as processing
      if (isChunk) {
        console.log('[ProcessTranscription] Chunk task detected:', {
          conversationId,
          chunkIndex,
          totalChunks: payload.totalChunks,
          chunkStartMs: payload.chunkStartMs,
          chunkEndMs: payload.chunkEndMs,
          processingMode
        });

        // Context loading differs by processing mode:
        // - Sequential: Wait for predecessor, load its emitted context
        // - Parallel: Use fresh initial context (no waiting)
        if (processingMode === 'sequential') {
          // SEQUENTIAL MODE: Load context from previous chunk (blocks until predecessor completes)
          try {
            chunkContext = await loadChunkContext(conversationId, chunkIndex);
            console.log('[ProcessTranscription] [Sequential] Loaded chunk context:', {
              conversationId,
              chunkIndex,
              previousChunk: chunkContext.emittedByChunkIndex,
              speakerCount: chunkContext.speakerMap.length,
              cumulativeSegments: chunkContext.cumulativeSegmentCount
            });
          } catch (contextError) {
            // If we can't load context, this chunk can't proceed yet
            const errorMsg = contextError instanceof Error ? contextError.message : String(contextError);

            // Distinguish between "waiting" (retriable) vs "predecessor failed" (permanent)
            // Both "still processing" and "still pending" are retriable states
            const isRetriable = errorMsg.includes('still processing') || errorMsg.includes('still pending');

            if (isRetriable) {
              // Previous chunk hasn't completed yet - this is retriable, NOT a failure
              // Don't mark as failed, just return 500 to let Cloud Tasks retry
              console.log('[ProcessTranscription] [Sequential] Chunk waiting on predecessor:', {
                conversationId,
                chunkIndex,
                reason: errorMsg
              });
              res.status(500).send(`Chunk ${chunkIndex} waiting on predecessor - will retry`);
              return;
            }

            // Previous chunk actually failed - this is a permanent failure
            console.error('[ProcessTranscription] [Sequential] Failed to load chunk context:', errorMsg);
            await markChunkFailed(conversationId, chunkIndex, `Context load failed: ${errorMsg}`);

            // Return 500 to trigger retry (in case it's a transient issue)
            res.status(500).send(`Chunk context not ready: ${errorMsg}`);
            return;
          }
        } else {
          // PARALLEL MODE: Use fresh initial context - no waiting for predecessors!
          // Each chunk processes independently, speaker reconciliation happens at merge
          chunkContext = createInitialChunkContext();
          console.log('[ProcessTranscription] [Parallel] Using initial context (no predecessor wait):', {
            conversationId,
            chunkIndex
          });
        }

        // Mark this chunk as processing
        await markChunkProcessing(conversationId, chunkIndex);
      }

      // Update Firestore to mark processing started (for whole-file tasks or first chunk)
      if (!isChunk || chunkIndex === 0) {
        await db.collection('conversations').doc(conversationId).update({
          status: 'processing',
          processingStartedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });
      }

      console.log('[ProcessTranscription] Starting transcription pipeline...', { version: BUILD_VERSION });

      // Execute the full transcription pipeline (shared with transcribeAudio)
      // Pass chunk context and metadata for chunk-aware processing
      const pipelineResult = await executeTranscriptionPipeline({
        conversationId,
        userId,
        filePath,
        replicateApiToken: replicateApiToken.value(),
        huggingfaceAccessToken: huggingfaceAccessToken.value(),
        chunkContext: chunkContext ?? undefined,
        chunkMetadata: isChunk ? {
          chunkIndex,
          totalChunks: payload.totalChunks!,
          startMs: payload.chunkStartMs!,
          endMs: payload.chunkEndMs!,
          overlapBeforeMs: payload.overlapBeforeMs!,
          overlapAfterMs: payload.overlapAfterMs!
        } : undefined
      });

      // For chunk tasks, emit the next context and mark as complete
      if (isChunk && chunkContext) {
        // Build the next context from real pipeline results
        const nextContext = buildNextContext(
          chunkContext,
          chunkIndex,
          {
            speakerMappings: pipelineResult.speakerMappings,
            chunkSummary: pipelineResult.summary,
            newTermIds: pipelineResult.termIds,
            newTopicIds: pipelineResult.topicIds,
            newPersonIds: pipelineResult.personIds,
            segmentsProcessed: pipelineResult.segmentCount,
            lastTimestampMs: pipelineResult.lastTimestampMs
          }
        );

        // Sanitize the context - Firestore doesn't allow undefined values
        // (e.g., voiceSignature in speaker mappings is optional and may be undefined)
        const sanitizedContext = sanitizeForFirestore(nextContext);

        // Build chunk artifact update
        // For parallel mode, include speaker signatures for merge reconciliation
        const chunkArtifactUpdate: { emittedContext: ChunkContext; chunkSpeakerSignatures?: SpeakerSignature[]; processedByVersion: string; processedByBuildNumber?: number } = {
          emittedContext: sanitizedContext,
          processedByVersion: BUILD_VERSION, // Track which function version processed this chunk
          ...(BUILD_NUMBER !== null && { processedByBuildNumber: BUILD_NUMBER }) // Build tag number if present
        };

        // Store speaker signatures for merge-time reconciliation (useful in both modes)
        // These help the merge function correlate speakers across independently-processed chunks
        if (pipelineResult.chunkSpeakerSignatures) {
          chunkArtifactUpdate.chunkSpeakerSignatures = pipelineResult.chunkSpeakerSignatures;
          console.log('[ProcessTranscription] Storing speaker signatures:', {
            conversationId,
            chunkIndex,
            signatureCount: pipelineResult.chunkSpeakerSignatures.length,
            processingMode
          });
        }

        // Update the chunk artifact with the actual emitted context (and speaker signatures for parallel)
        await db
          .collection('conversations')
          .doc(conversationId)
          .collection('chunks')
          .doc(String(chunkIndex))
          .update(chunkArtifactUpdate);

        // Mark chunk complete and check if merge should be triggered
        const result = await markChunkComplete(conversationId, chunkIndex, sanitizedContext);

        console.log('[ProcessTranscription] ✅ Chunk completed successfully:', {
          conversationId,
          chunkIndex,
          pipelineResults: {
            segmentsProcessed: pipelineResult.segmentCount,
            speakerMappings: pipelineResult.speakerMappings.length,
            terms: pipelineResult.termIds.length,
            topics: pipelineResult.topicIds.length,
            persons: pipelineResult.personIds.length
          },
          emittedContext: {
            emittedByChunkIndex: nextContext.emittedByChunkIndex,
            cumulativeSegments: nextContext.cumulativeSegmentCount,
            cumulativeTerms: nextContext.knownTermIds.length,
            cumulativeTopics: nextContext.knownTopicIds.length
          },
          allComplete: result.allComplete,
          shouldEnqueueMerge: result.shouldEnqueueMerge
        });

        // If all chunks complete, enqueue merge task and update status
        if (result.shouldEnqueueMerge) {
          console.log('[ProcessTranscription] 🔀 All chunks complete - enqueueing merge task');

          // Enqueue merge task
          await enqueueMergeTask(conversationId);

          // Update conversation status to 'merging'
          await db.collection('conversations').doc(conversationId).update({
            status: 'merging',
            updatedAt: FieldValue.serverTimestamp()
          });
        }
      } else {
        console.log('[ProcessTranscription] ✅ Task completed successfully:', { conversationId });
      }

      // Return 200 so Cloud Tasks doesn't retry
      res.status(200).send('OK');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      console.error('[ProcessTranscription] ❌ Task failed:', {
        conversationId,
        chunkIndex: isChunk ? chunkIndex : undefined,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined
      });

      // For chunk tasks, mark the chunk as failed for resume logic
      if (isChunk) {
        try {
          await markChunkFailed(conversationId, chunkIndex, errorMessage);
        } catch (markError) {
          console.error('[ProcessTranscription] Failed to mark chunk as failed:', markError);
        }
      }

      // Update Firestore to mark processing failed
      // (executeTranscriptionPipeline may have already done this, but being safe)
      try {
        await db.collection('conversations').doc(conversationId).update({
          status: 'failed',
          processingError: errorMessage,
          updatedAt: FieldValue.serverTimestamp()
        });
      } catch (updateError) {
        console.error('[ProcessTranscription] Failed to update Firestore status:', updateError);
      }

      // Return 500 so Cloud Tasks will retry
      res.status(500).send(`Internal Server Error: ${errorMessage}`);
    }
  }
);
