/**
 * Chunk Merge Module
 *
 * Stitches together chunk artifacts from conversations/{id}/chunks/* into
 * a single coherent conversation document. Handles:
 * - Segment deduplication in overlap regions
 * - Speaker ID canonicalization across chunks
 * - Term/topic/person merging with deterministic IDs
 * - Idempotency (safe to run multiple times)
 *
 * Triggered by Cloud Tasks after all chunks complete processing.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { FieldValue, WriteBatch } from 'firebase-admin/firestore';
import { db } from './index';
import {
  ChunkArtifact,
  Segment,
  Speaker,
  Term,
  TermOccurrence,
  Topic,
  Person,
  SpeakerSignature,
  ReconciliationDetails,
  ReconciliationMetadata,
  FallbackMetadata
} from './types';
import { getPreferredChunkForTimestamp, chunkToOriginalTimestamp } from './chunkBounds';
import { ChunkMetadata } from './chunking';
import { reconcileSpeakers, ReconciliationLowConfidenceError } from './speakerReconciliation';
import {
  reconcileSpeakersWithEmbeddings,
  hasValidEmbeddings,
  EmbeddingReconciliationConfig
} from './speakerReconciliationEmbeddings';
import { ReconciliationConfig } from './config/reconciliation';
import {
  logReconciliationStarted,
  logReconciliationCompleted,
  logFallbackTriggered,
  logReconciliationFailed
} from './logging/reconciliation';
import { BUILD_VERSION, BUILD_NUMBER } from './version';
import { checkAbort, AbortRequestedError } from './transcribe';

// =============================================================================
// Fallback Handling Helpers
// =============================================================================

/**
 * Archive parallel chunk artifacts to a timestamped subcollection.
 * Used before sequential reprocessing to preserve parallel attempt for debugging.
 *
 * Archive location: conversations/{id}/chunks.archived-{timestamp}/{chunkIndex}
 *
 * @param conversationId - Conversation to archive chunks for
 * @param chunksSnap - Snapshot of current chunks subcollection
 * @returns Archive ID (timestamp-based identifier)
 */
async function archiveChunks(
  conversationId: string,
  chunksSnap: FirebaseFirestore.QuerySnapshot
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveId = `chunks.archived-${timestamp}`;

  console.log('[ChunkMerge] Archiving parallel chunks:', {
    conversationId,
    archiveId,
    chunkCount: chunksSnap.docs.length
  });

  const conversationRef = db.collection('conversations').doc(conversationId);
  const batch: WriteBatch = db.batch();

  // Copy each chunk to the archive subcollection
  for (const doc of chunksSnap.docs) {
    const archiveRef = conversationRef
      .collection(archiveId)
      .doc(doc.id);
    batch.set(archiveRef, {
      ...doc.data(),
      archivedAt: new Date().toISOString(),
      archiveReason: 'low_speaker_confidence'
    });
  }

  // Delete original chunks (will be replaced by sequential processing)
  for (const doc of chunksSnap.docs) {
    batch.delete(doc.ref);
  }

  await batch.commit();

  console.log('[ChunkMerge] ✅ Chunks archived successfully:', {
    conversationId,
    archiveId
  });

  return archiveId;
}

/**
 * Enqueue sequential reprocessing after parallel fallback.
 * Resets chunking metadata and triggers fresh chunk tasks with sequential mode.
 *
 * @param conversationId - Conversation to reprocess
 * @param originalStoragePath - Path to original audio file
 * @param fallbackMetadata - Metadata about the failed parallel attempt
 */
async function enqueueSequentialReprocessing(
  conversationId: string,
  originalStoragePath: string,
  fallbackMetadata: FallbackMetadata
): Promise<void> {
  console.log('[ChunkMerge] Enqueueing sequential reprocessing:', {
    conversationId,
    originalStoragePath,
    fallbackReason: fallbackMetadata.reason
  });

  const { CloudTasksClient } = await import('@google-cloud/tasks');
  const tasksClient = new CloudTasksClient();

  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  if (!project) {
    throw new Error('GCP project ID not found in environment');
  }

  const location = 'us-central1';
  const queue = 'transcription-queue';
  const parent = tasksClient.queuePath(project, location, queue);

  // Get conversation to retrieve userId
  const conversationSnap = await db.collection('conversations').doc(conversationId).get();
  if (!conversationSnap.exists) {
    throw new Error(`Conversation ${conversationId} not found for reprocessing`);
  }
  const conversationData = conversationSnap.data()!;

  // Create reprocessing task payload
  // This will trigger the chunking flow again, but with sequential mode
  const functionName = 'processReprocessing';
  const reprocessUrl = `https://${location}-${project}.cloudfunctions.net/${functionName}`;

  const payload = {
    conversationId,
    userId: conversationData.userId,
    filePath: originalStoragePath,
    processingMode: 'sequential',
    isReprocessing: true,
    fallbackMetadata
  };

  const task = {
    httpRequest: {
      httpMethod: 'POST' as const,
      url: reprocessUrl,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(payload)).toString('base64'),
      oidcToken: { serviceAccountEmail: `${project}@appspot.gserviceaccount.com` }
    },
    scheduleTime: { seconds: Math.floor(Date.now() / 1000) + 5 }, // 5 second delay
    dispatchDeadline: { seconds: 1800 } // 30 min (Cloud Tasks max)
  };

  console.log('[ChunkMerge] Creating sequential reprocessing task:', {
    conversationId,
    queue: `${location}/${queue}`,
    targetUrl: reprocessUrl
  });

  const [createdTask] = await tasksClient.createTask({ parent, task });

  console.log('[ChunkMerge] ✅ Sequential reprocessing task enqueued:', {
    conversationId,
    taskName: createdTask.name
  });
}

/**
 * Handle low-confidence reconciliation by triggering fallback to sequential.
 *
 * Steps:
 * 1. Archive parallel chunk artifacts
 * 2. Record fallback metadata on conversation
 * 3. Update status to 'reprocessing'
 * 4. Enqueue sequential reprocessing task
 *
 * @param conversationId - Conversation to handle fallback for
 * @param confidence - The low confidence score that triggered fallback
 * @param chunksSnap - Snapshot of current chunks for archiving
 * @param originalStoragePath - Path to original audio for reprocessing
 * @param parallelDurationMs - How long the parallel attempt took
 * @param reconciliationDurationMs - How long the reconciliation computation took
 */
async function handleLowConfidenceFallback(
  conversationId: string,
  confidence: number,
  chunksSnap: FirebaseFirestore.QuerySnapshot,
  originalStoragePath: string,
  parallelDurationMs: number,
  reconciliationDurationMs: number
): Promise<void> {
  console.log('[ChunkMerge] 🔄 Initiating fallback to sequential processing:', {
    conversationId,
    parallelConfidence: confidence,
    threshold: ReconciliationConfig.CONFIDENCE_THRESHOLD
  });

  // Step 1: Archive parallel chunks
  const archiveId = await archiveChunks(conversationId, chunksSnap);

  // Step 2: Build fallback metadata
  const fallbackMetadata: FallbackMetadata = {
    triggeredAt: new Date().toISOString(),
    parallelConfidence: confidence,
    archiveId,
    reason: 'low_speaker_confidence',
    parallelDurationMs,
    configuredThreshold: ReconciliationConfig.CONFIDENCE_THRESHOLD
  };

  // Step 3: Update conversation with fallback metadata and reprocessing status
  await db.collection('conversations').doc(conversationId).update({
    status: 'reprocessing',
    fallbackMetadata,
    // Reset chunking metadata for fresh sequential processing
    'chunkingMetadata.mergedAt': FieldValue.delete(),
    'chunkingMetadata.mergeStartedAt': FieldValue.delete(),
    'chunkingMetadata.mergeTaskEnqueued': false,
    'chunkingMetadata.completedChunks': 0,
    'chunkingMetadata.chunkStatuses': [],
    'chunkingMetadata.chunkContexts': [],
    processingMode: 'sequential',
    updatedAt: FieldValue.serverTimestamp()
  });

  // Log the fallback event for observability
  logFallbackTriggered(
    conversationId,
    confidence,
    ReconciliationConfig.CONFIDENCE_THRESHOLD,
    archiveId,
    'parallel',
    reconciliationDurationMs
  );

  // Step 4: Enqueue sequential reprocessing
  await enqueueSequentialReprocessing(conversationId, originalStoragePath, fallbackMetadata);

  console.log('[ChunkMerge] ✅ Fallback initiated successfully:', {
    conversationId,
    archiveId,
    newMode: 'sequential'
  });
}

// =============================================================================
// Main Merge Logic
// =============================================================================

/**
 * Merge all chunk artifacts for a conversation into the final document.
 *
 * Steps:
 * 1. Check idempotency (skip if already merged or fallback triggered)
 * 2. Load all chunk artifacts
 * 3. Run speaker reconciliation (parallel mode)
 * 4. If low confidence: trigger fallback to sequential and return
 * 5. Deduplicate segments using overlap boundaries
 * 6. Merge speakers, terms, topics, people
 * 7. Write final conversation document
 * 8. Update status to 'complete'
 *
 * @throws Error if chunks are missing or invalid
 */
export async function mergeChunks(conversationId: string): Promise<void> {
  console.log('[ChunkMerge] Starting merge process:', { conversationId });

  // Step 1: Check idempotency - if already merged, skip
  const conversationRef = db.collection('conversations').doc(conversationId);
  const conversationSnap = await conversationRef.get();

  if (!conversationSnap.exists) {
    throw new Error(`Conversation ${conversationId} not found`);
  }

  const conversationData = conversationSnap.data()!;
  const chunkingMeta = conversationData.chunkingMetadata;

  if (!chunkingMeta) {
    throw new Error(`No chunking metadata for conversation ${conversationId}`);
  }

  // Idempotency check - if mergedAt is set, we're done
  if (chunkingMeta.mergedAt) {
    console.log('[ChunkMerge] Already merged, skipping:', {
      conversationId,
      mergedAt: chunkingMeta.mergedAt
    });
    return;
  }

  // Idempotency check - if fallback already triggered, don't retry merge
  if (conversationData.fallbackMetadata?.triggeredAt) {
    console.log('[ChunkMerge] Fallback already triggered, skipping merge:', {
      conversationId,
      fallbackTriggeredAt: conversationData.fallbackMetadata.triggeredAt
    });
    return;
  }

  // Track merge start time for duration calculation
  const mergeStartTime = Date.now();

  // Mark merge as started
  await conversationRef.update({
    'chunkingMetadata.mergeStartedAt': new Date().toISOString(),
    status: 'merging',
    updatedAt: FieldValue.serverTimestamp()
  });

  // Step 2: Load all chunk artifacts
  console.log('[ChunkMerge] Loading chunk artifacts...');
  const chunksSnap = await conversationRef
    .collection('chunks')
    .orderBy('chunkIndex')
    .get();

  if (chunksSnap.empty) {
    throw new Error(`No chunk artifacts found for conversation ${conversationId}`);
  }

  const chunkArtifacts: ChunkArtifact[] = chunksSnap.docs.map(doc => doc.data() as ChunkArtifact);

  // Validate we have all chunks
  const expectedChunks = chunkingMeta.totalChunks;
  if (chunkArtifacts.length !== expectedChunks) {
    throw new Error(
      `Missing chunks: expected ${expectedChunks}, found ${chunkArtifacts.length}`
    );
  }

  console.log('[ChunkMerge] Loaded chunk artifacts:', {
    conversationId,
    chunkCount: chunkArtifacts.length,
    totalSegments: chunkArtifacts.reduce((sum, c) => sum + c.segments.length, 0)
  });

  // Check for abort after loading chunk artifacts
  await checkAbort(conversationId);

  // Build chunk metadata array for deduplication helpers
  const chunkMetadataArray: ChunkMetadata[] = chunkArtifacts.map(artifact => ({
    chunkIndex: artifact.chunkIndex,
    totalChunks: artifact.totalChunks,
    startMs: artifact.chunkBounds.startMs,
    endMs: artifact.chunkBounds.endMs,
    overlapBeforeMs: artifact.chunkBounds.overlapBeforeMs,
    overlapAfterMs: artifact.chunkBounds.overlapAfterMs,
    chunkStoragePath: artifact.storagePath,
    originalStoragePath: chunkingMeta.originalStoragePath,
    durationMs: artifact.chunkBounds.endMs - artifact.chunkBounds.startMs +
                artifact.chunkBounds.overlapBeforeMs + artifact.chunkBounds.overlapAfterMs
  }));

  // Step 3: Run speaker reconciliation (parallel mode only)
  let reconciliationConfidence: number | undefined;
  let reconciliationDetails: ReconciliationDetails | undefined;
  const speakerIdRemapping = new Map<string, string>(); // originalId → canonicalId

  const processingMode = conversationData.processingMode || 'parallel';

  // Track reconciliation metadata for observability
  let reconciliationMetadata: ReconciliationMetadata | undefined;
  const reconciliationStartTime = Date.now();

  if (processingMode === 'parallel') {
    // Log reconciliation start for observability
    logReconciliationStarted(conversationId, chunkArtifacts.length, 'parallel');

    console.log('[ChunkMerge] Running speaker reconciliation (parallel mode)...');

    // Try embedding-based reconciliation first (if embeddings are available)
    let reconciliationMethod: 'embeddings' | 'content' = 'content';
    let reconciliationResult: any;

    if (hasValidEmbeddings(chunkArtifacts)) {
      console.log('[ChunkMerge] Using embedding-based speaker reconciliation');
      reconciliationMethod = 'embeddings';

      try {
        reconciliationResult = reconcileSpeakersWithEmbeddings(chunkArtifacts);
        const reconciliationDurationMs = Date.now() - reconciliationStartTime;

        console.log('[ChunkMerge] Embedding reconciliation complete:', {
          overallConfidence: reconciliationResult.overallConfidence,
          totalClusters: reconciliationResult.clusterDetails.length,
          durationMs: reconciliationDurationMs
        });

        // Check confidence threshold
        if (reconciliationResult.overallConfidence < EmbeddingReconciliationConfig.CONFIDENCE_THRESHOLD) {
          throw new ReconciliationLowConfidenceError(
            `Embedding reconciliation confidence ${reconciliationResult.overallConfidence.toFixed(3)} below threshold ${EmbeddingReconciliationConfig.CONFIDENCE_THRESHOLD}`,
            reconciliationResult.overallConfidence,
            reconciliationResult.clusterDetails
          );
        }
      } catch (error) {
        // If embedding reconciliation fails, fall back to content-based
        if (error instanceof ReconciliationLowConfidenceError) {
          throw error; // Re-throw to trigger sequential fallback
        }
        console.warn('[ChunkMerge] Embedding reconciliation failed, falling back to content-based:', error);
        reconciliationMethod = 'content';
        reconciliationResult = null;
      }
    }

    // Fall back to content-based reconciliation if needed
    if (!reconciliationResult || reconciliationMethod === 'content') {
      console.log('[ChunkMerge] Using content-based speaker reconciliation (fallback or no embeddings)');

      // Collect all speaker signatures from chunks
      const allSignatures: SpeakerSignature[] = [];
      for (const artifact of chunkArtifacts) {
        if (artifact.chunkSpeakerSignatures) {
          allSignatures.push(...artifact.chunkSpeakerSignatures);
        }
      }

      console.log('[ChunkMerge] Collected speaker signatures:', {
        totalSignatures: allSignatures.length,
        chunks: new Set(allSignatures.map(s => s.chunkIndex)).size
      });

      reconciliationResult = reconcileSpeakers(allSignatures);
    }

    try {
      const reconciliationDurationMs = Date.now() - reconciliationStartTime;

      // Store reconciliation metadata
      reconciliationConfidence = reconciliationResult.overallConfidence;

      // Calculate original speaker count based on method
      const originalSpeakerCount = reconciliationMethod === 'embeddings'
        ? reconciliationResult.clusterDetails.reduce((sum: number, c: any) => sum + c.originalIds.length, 0)
        : reconciliationResult.clusterDetails.reduce((sum: number, c: any) => sum + c.originalIds.length, 0);

      reconciliationDetails = {
        clusterCount: reconciliationResult.clusterDetails.length,
        originalSpeakerCount,
        clusters: reconciliationResult.clusterDetails.map((c: any) => ({
          canonicalId: c.canonicalId,
          originalIds: c.originalIds,
          confidence: c.confidence,
          displayName: c.displayName,
          matchEvidence: c.matchEvidence
        }))
      };

      // Build extended reconciliation metadata for observability
      reconciliationMetadata = {
        signalsUsed: reconciliationMethod === 'embeddings'
          ? ['embeddings']  // Voice embeddings only
          : ['name', 'topic', 'term'],  // Content-based signals
        fallbackTriggered: false,
        speakerMatchConfidences: reconciliationResult.clusterDetails.map((c: any) => ({
          canonicalId: c.canonicalId,
          confidence: c.confidence
        })),
        reconciliationDurationMs
      };

      // Log which reconciliation method was used
      console.log('[ChunkMerge] Reconciliation method:', {
        method: reconciliationMethod,
        signalsUsed: reconciliationMetadata.signalsUsed
      });

      // Check confidence threshold - throw exception if below threshold
      // The catch block handles fallback to sequential processing
      if (reconciliationConfidence !== undefined && reconciliationConfidence < ReconciliationConfig.CONFIDENCE_THRESHOLD) {
        throw new ReconciliationLowConfidenceError(
          `Speaker reconciliation confidence ${reconciliationConfidence.toFixed(3)} below threshold ${ReconciliationConfig.CONFIDENCE_THRESHOLD}`,
          reconciliationConfidence,
          reconciliationResult.clusterDetails
        );
      }

      // Build remapping table
      for (const [originalId, canonicalId] of reconciliationResult.speakerIdMap) {
        speakerIdRemapping.set(originalId, canonicalId);
      }

      // Log successful reconciliation (with type guard)
      if (reconciliationConfidence !== undefined && reconciliationDetails && reconciliationMetadata) {
        logReconciliationCompleted(
          conversationId,
          reconciliationConfidence,
          reconciliationDetails.clusterCount,
          reconciliationMetadata.signalsUsed,
          reconciliationDurationMs,
          'parallel'
        );
      }

      console.log('[ChunkMerge] Speaker reconciliation complete:', {
        overallConfidence: reconciliationConfidence,
        totalClusters: reconciliationDetails.clusterCount,
        totalOriginalSpeakers: reconciliationDetails.originalSpeakerCount,
        durationMs: reconciliationDurationMs
      });

    } catch (error) {
      // Handle low-confidence reconciliation by triggering fallback to sequential
      if (error instanceof ReconciliationLowConfidenceError) {
        console.warn('[ChunkMerge] ⚠️ Speaker reconciliation confidence below threshold:', {
          confidence: error.overallConfidence,
          threshold: ReconciliationConfig.CONFIDENCE_THRESHOLD,
          clusterCount: error.clusterDetails.length
        });

        // Calculate how long the parallel attempt took
        const parallelDurationMs = Date.now() - mergeStartTime;
        const reconciliationDurationMs = Date.now() - reconciliationStartTime;

        // Build reconciliation metadata for observability
        const fallbackReconciliationMetadata: ReconciliationMetadata = {
          signalsUsed: ['name', 'topic', 'term'],
          fallbackTriggered: true,
          speakerMatchConfidences: error.clusterDetails.map(c => ({
            canonicalId: c.canonicalId,
            confidence: c.confidence
          })),
          reconciliationDurationMs
        };

        // Persist reconciliation metadata on fallback for observability
        await db.collection('conversations').doc(conversationId).update({
          reconciliationMetadata: fallbackReconciliationMetadata,
          reconciliationConfidence: error.overallConfidence,
          reconciliationDetails: {
            clusterCount: error.clusterDetails.length,
            originalSpeakerCount: error.clusterDetails.reduce(
              (sum, c) => sum + c.originalIds.length, 0
            ),
            clusters: error.clusterDetails.map(c => ({
              canonicalId: c.canonicalId,
              originalIds: c.originalIds,
              confidence: c.confidence,
              displayName: c.displayName,
              matchEvidence: c.matchEvidence
            }))
          }
        });

        // Handle fallback - archive chunks, update status, enqueue sequential
        await handleLowConfidenceFallback(
          conversationId,
          error.overallConfidence,
          chunksSnap,
          chunkingMeta.originalStoragePath,
          parallelDurationMs,
          reconciliationDurationMs
        );

        // Return successfully - fallback has been initiated, merge is not needed
        return;
      }

      // Log other reconciliation errors
      logReconciliationFailed(
        conversationId,
        error instanceof Error ? error.message : 'Unknown error',
        'parallel'
      );

      // Re-throw non-low-confidence errors
      throw error;
    }
  } else {
    console.log('[ChunkMerge] Skipping speaker reconciliation (sequential mode)');
  }

  // Check for abort after speaker reconciliation
  await checkAbort(conversationId);

  // Step 4: Deduplicate segments using preferred chunk logic
  //
  // IMPORTANT: Segment timestamps from Gemini are chunk-local (start at 0 for each chunk).
  // We must convert them to the original audio timeline before checking which chunk "owns"
  // them for deduplication. Without this conversion, later chunks would have low timestamps
  // that make them appear to belong to earlier chunks, causing them to be dropped.
  console.log('[ChunkMerge] Deduplicating segments...');
  const mergedSegments: Segment[] = [];
  const seenSegmentIds = new Set<string>();

  for (const artifact of chunkArtifacts) {
    // Get the chunk metadata for timestamp conversion
    const chunkMeta = chunkMetadataArray[artifact.chunkIndex];

    // Diagnostic: Log first few segments for each chunk to debug timestamp drift
    if (artifact.segments.length > 0) {
      const firstSeg = artifact.segments[0];
      const lastSeg = artifact.segments[artifact.segments.length - 1];
      const firstOriginal = chunkToOriginalTimestamp(firstSeg.startMs, chunkMeta);
      const lastOriginal = chunkToOriginalTimestamp(lastSeg.endMs, chunkMeta);

      console.log('[ChunkMerge] DIAGNOSTIC - Chunk timestamp conversion:', {
        chunkIndex: artifact.chunkIndex,
        chunkBounds: {
          startMs: chunkMeta.startMs,
          endMs: chunkMeta.endMs,
          overlapBeforeMs: chunkMeta.overlapBeforeMs,
          overlapAfterMs: chunkMeta.overlapAfterMs,
          chunkAudioStartMs: chunkMeta.startMs - chunkMeta.overlapBeforeMs
        },
        firstSegment: {
          chunkLocal: { startMs: firstSeg.startMs, endMs: firstSeg.endMs },
          converted: { startMs: firstOriginal },
          text: firstSeg.text.substring(0, 50) + '...'
        },
        lastSegment: {
          chunkLocal: { startMs: lastSeg.startMs, endMs: lastSeg.endMs },
          converted: { endMs: lastOriginal }
        },
        segmentCount: artifact.segments.length
      });
    }

    for (const segment of artifact.segments) {
      // Convert chunk-local timestamp to original audio timeline
      const originalStartMs = chunkToOriginalTimestamp(segment.startMs, chunkMeta);
      const originalEndMs = chunkToOriginalTimestamp(segment.endMs, chunkMeta);

      // Check if this segment's original timestamp belongs to this chunk
      const preferredChunk = getPreferredChunkForTimestamp(originalStartMs, chunkMetadataArray);

      if (preferredChunk === artifact.chunkIndex) {
        // This chunk "owns" this segment - include it with normalized timestamps
        if (!seenSegmentIds.has(segment.segmentId)) {
          // Remap speaker ID if reconciliation was performed
          let speakerId = segment.speakerId;
          if (processingMode === 'parallel' && speakerIdRemapping.size > 0) {
            const originalId = `${segment.speakerId}_chunk${artifact.chunkIndex}`;
            const canonicalId = speakerIdRemapping.get(originalId);
            if (canonicalId) {
              speakerId = canonicalId;
            }
          }

          mergedSegments.push({
            ...segment,
            speakerId,
            startMs: originalStartMs,
            endMs: originalEndMs
          });
          seenSegmentIds.add(segment.segmentId);
        }
      }
      // Otherwise, skip (will be included from the preferred chunk)
    }
  }

  // Sort segments by timestamp to ensure chronological order
  // (index is chunk-local and can't be used for cross-chunk ordering)
  mergedSegments.sort((a, b) => a.startMs - b.startMs);

  // Reindex segments to be sequential (since we may have dropped duplicates)
  mergedSegments.forEach((seg, idx) => {
    seg.index = idx;
  });

  console.log('[ChunkMerge] Segment deduplication complete:', {
    totalBeforeDedup: chunkArtifacts.reduce((sum, c) => sum + c.segments.length, 0),
    totalAfterDedup: mergedSegments.length,
    duplicatesRemoved: chunkArtifacts.reduce((sum, c) => sum + c.segments.length, 0) - mergedSegments.length
  });

  // Diagnostic: Log sample merged segments to verify timestamps
  // Look for segments around common test points: 1:55, 28:25, 30:58
  const sampleTimesMs = [115000, 1705000, 1858000]; // Test timestamps from user
  console.log('[ChunkMerge] DIAGNOSTIC - Sample merged segments:');
  for (const targetMs of sampleTimesMs) {
    const nearestSeg = mergedSegments.find(seg =>
      seg.startMs <= targetMs && seg.endMs > targetMs
    ) || mergedSegments.find(seg =>
      Math.abs(seg.startMs - targetMs) < 10000
    );
    if (nearestSeg) {
      console.log(`  Near ${Math.floor(targetMs / 60000)}:${Math.floor((targetMs % 60000) / 1000).toString().padStart(2, '0')}:`, {
        startMs: nearestSeg.startMs,
        endMs: nearestSeg.endMs,
        text: nearestSeg.text.substring(0, 60) + '...'
      });
    }
  }

  // Step 5: Merge speakers
  console.log('[ChunkMerge] Merging speakers...');
  const mergedSpeakers: Record<string, Speaker> = {};

  if (processingMode === 'parallel' && reconciliationDetails) {
    // Use reconciliation results to build canonical speaker map
    for (const cluster of reconciliationDetails.clusters) {
      mergedSpeakers[cluster.canonicalId] = {
        speakerId: cluster.canonicalId,
        displayName: cluster.displayName,
        colorIndex: Object.keys(mergedSpeakers).length % 10 // Assign color index
      };
    }
  } else {
    // Sequential mode: simple union (speaker IDs should be consistent)
    for (const artifact of chunkArtifacts) {
      for (const [speakerId, speaker] of Object.entries(artifact.speakers)) {
        if (!mergedSpeakers[speakerId]) {
          mergedSpeakers[speakerId] = speaker;
        }
        // If speaker already exists, prefer the one with a display name
        else if (speaker.displayName && !mergedSpeakers[speakerId].displayName) {
          mergedSpeakers[speakerId] = speaker;
        }
      }
    }
  }

  // Step 6: Merge terms (deduplicate by termId)
  console.log('[ChunkMerge] Merging terms...');
  const mergedTerms: Record<string, Term> = {};
  const mergedTermOccurrences: TermOccurrence[] = [];
  const seenOccurrenceIds = new Set<string>();

  for (const artifact of chunkArtifacts) {
    // Merge terms
    for (const [termId, term] of Object.entries(artifact.terms)) {
      if (!mergedTerms[termId]) {
        mergedTerms[termId] = term;
      }
    }

    // Merge term occurrences (only for segments we kept)
    for (const occurrence of artifact.termOccurrences) {
      // Only include if the segment was kept after deduplication
      if (seenSegmentIds.has(occurrence.segmentId) && !seenOccurrenceIds.has(occurrence.occurrenceId)) {
        mergedTermOccurrences.push(occurrence);
        seenOccurrenceIds.add(occurrence.occurrenceId);
      }
    }
  }

  // Step 7: Merge topics (deduplicate by topicId, adjust indices)
  console.log('[ChunkMerge] Merging topics...');
  const mergedTopics: Topic[] = [];
  const seenTopicIds = new Set<string>();

  for (const artifact of chunkArtifacts) {
    for (const topic of artifact.topics) {
      if (!seenTopicIds.has(topic.topicId)) {
        mergedTopics.push(topic);
        seenTopicIds.add(topic.topicId);
      }
    }
  }

  // Sort topics by start index
  mergedTopics.sort((a, b) => a.startIndex - b.startIndex);

  // Step 8: Merge people (deduplicate by personId)
  console.log('[ChunkMerge] Merging people...');
  const mergedPeople: Person[] = [];
  const seenPersonIds = new Set<string>();

  for (const artifact of chunkArtifacts) {
    for (const person of artifact.people) {
      if (!seenPersonIds.has(person.personId)) {
        mergedPeople.push(person);
        seenPersonIds.add(person.personId);
      }
    }
  }

  // Step 9: Calculate total duration from last segment
  const lastSegment = mergedSegments[mergedSegments.length - 1];
  const durationMs = lastSegment ? lastSegment.endMs : chunkingMeta.originalDurationMs;

  // Check for abort before final document write
  await checkAbort(conversationId);

  // Step 10: Write final merged data to conversation document
  console.log('[ChunkMerge] Writing final merged data...');
  const updateData: any = {
    segments: mergedSegments,
    speakers: mergedSpeakers,
    terms: mergedTerms,
    termOccurrences: mergedTermOccurrences,
    topics: mergedTopics,
    people: mergedPeople,
    durationMs,
    status: 'complete',
    'chunkingMetadata.mergedAt': new Date().toISOString(),
    alignmentStatus: 'aligned', // Chunks use WhisperX alignment
    processedByVersion: BUILD_VERSION, // Track which function version processed this
    ...(BUILD_NUMBER !== null && { processedByBuildNumber: BUILD_NUMBER }), // Build tag number if present
    updatedAt: FieldValue.serverTimestamp()
  };

  // Add reconciliation metadata if parallel mode
  if (processingMode === 'parallel' && reconciliationConfidence !== undefined) {
    updateData.reconciliationConfidence = reconciliationConfidence;
    updateData.reconciliationDetails = reconciliationDetails;
    // Add extended observability metadata
    if (reconciliationMetadata) {
      updateData.reconciliationMetadata = reconciliationMetadata;
    }
  }

  await conversationRef.update(updateData);

  console.log('[ChunkMerge] ✅ Merge complete:', {
    conversationId,
    finalCounts: {
      segments: mergedSegments.length,
      speakers: Object.keys(mergedSpeakers).length,
      terms: Object.keys(mergedTerms).length,
      termOccurrences: mergedTermOccurrences.length,
      topics: mergedTopics.length,
      people: mergedPeople.length
    },
    durationMs
  });
}

/**
 * Cloud Tasks HTTP handler for processing merge jobs.
 *
 * Security: Only accepts requests from Cloud Tasks (x-cloudtasks-taskname header).
 * Returns 200 on success (Cloud Tasks won't retry).
 * Returns 500 on failure (Cloud Tasks will retry with backoff).
 */
export const processMerge = onRequest(
  {
    memory: '512MiB',
    timeoutSeconds: 600, // 10 minutes (merge can be slow for large files)
    region: 'us-central1',
    invoker: 'private' // Only Cloud Tasks can call this
  },
  async (req, res) => {
    // Validate Cloud Tasks header (security check)
    const taskName = req.headers['x-cloudtasks-taskname'];
    if (!taskName && process.env.K_SERVICE) { // K_SERVICE is set in Cloud Run
      console.error('[ProcessMerge] Forbidden: Direct invocation not allowed');
      res.status(403).send('Forbidden: Direct invocation not allowed');
      return;
    }

    console.log('[ProcessMerge] Task started:', {
      taskName,
      timestamp: new Date().toISOString()
    });

    // Parse request payload
    let conversationId: string;
    try {
      const payload = req.body as { conversationId: string };

      if (!payload.conversationId) {
        throw new Error('Missing required field: conversationId');
      }

      conversationId = payload.conversationId;

      console.log('[ProcessMerge] Processing merge:', { conversationId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Invalid request payload';
      console.error('[ProcessMerge] Invalid payload:', errorMessage);
      res.status(400).send(`Bad Request: ${errorMessage}`);
      return;
    }

    try {
      // Execute merge
      await mergeChunks(conversationId);

      console.log('[ProcessMerge] ✅ Task completed successfully:', { conversationId });
      res.status(200).send('OK');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Handle abort requests differently from failures
      if (error instanceof AbortRequestedError) {
        console.log('[ProcessMerge] Abort requested during merge:', { conversationId });

        // Mark as aborted instead of failed
        try {
          await db.collection('conversations').doc(conversationId).update({
            status: 'aborted',
            processingError: 'Merge cancelled by user',
            updatedAt: FieldValue.serverTimestamp()
          });
        } catch (updateError) {
          console.error('[ProcessMerge] Failed to update Firestore status:', updateError);
        }

        // Return success to prevent Cloud Tasks retry
        res.status(200).send('Aborted');
        return;
      }

      console.error('[ProcessMerge] ❌ Task failed:', {
        conversationId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined
      });

      // Update Firestore to mark merge failed
      try {
        await db.collection('conversations').doc(conversationId).update({
          status: 'failed',
          processingError: `Merge failed: ${errorMessage}`,
          updatedAt: FieldValue.serverTimestamp()
        });
      } catch (updateError) {
        console.error('[ProcessMerge] Failed to update Firestore status:', updateError);
      }

      // Return 500 so Cloud Tasks will retry
      res.status(500).send(`Internal Server Error: ${errorMessage}`);
    }
  }
);

// =============================================================================
// Reprocessing Handler
// =============================================================================

/**
 * Payload for the reprocessing task.
 */
interface ReprocessingPayload {
  conversationId: string;
  userId: string;
  filePath: string;
  processingMode: 'sequential';
  isReprocessing: boolean;
  fallbackMetadata: FallbackMetadata;
}

/**
 * Cloud Tasks HTTP handler for sequential reprocessing after parallel fallback.
 *
 * This function is triggered when parallel processing's speaker reconciliation
 * confidence is too low. It re-runs the chunking and transcription pipeline
 * in sequential mode for better speaker consistency.
 *
 * Flow:
 * 1. Validate request
 * 2. Re-trigger chunking with sequential mode
 * 3. Let the normal chunk processing flow handle the rest
 * 4. Merge will complete with sequential speaker IDs (no reconciliation needed)
 */
export const processReprocessing = onRequest(
  {
    memory: '512MiB',
    timeoutSeconds: 600, // 10 minutes (mostly enqueuing, not processing)
    region: 'us-central1',
    invoker: 'private' // Only Cloud Tasks can call this
  },
  async (req, res) => {
    // Validate Cloud Tasks header
    const taskName = req.headers['x-cloudtasks-taskname'];
    if (!taskName && process.env.K_SERVICE) {
      console.error('[ProcessReprocessing] Forbidden: Direct invocation not allowed');
      res.status(403).send('Forbidden: Direct invocation not allowed');
      return;
    }

    console.log('[ProcessReprocessing] Task started:', {
      taskName,
      timestamp: new Date().toISOString()
    });

    // Parse request payload
    let payload: ReprocessingPayload;
    try {
      payload = req.body as ReprocessingPayload;

      if (!payload.conversationId || !payload.userId || !payload.filePath) {
        throw new Error('Missing required fields: conversationId, userId, or filePath');
      }

      console.log('[ProcessReprocessing] Reprocessing request:', {
        conversationId: payload.conversationId,
        userId: payload.userId,
        filePath: payload.filePath,
        processingMode: payload.processingMode
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Invalid request payload';
      console.error('[ProcessReprocessing] Invalid payload:', errorMessage);
      res.status(400).send(`Bad Request: ${errorMessage}`);
      return;
    }

    const { conversationId, userId, filePath, fallbackMetadata } = payload;

    try {
      // Import chunking module dynamically
      const { chunkAudioFile, CHUNK_CONFIG } = await import('./chunking');
      const { getStorage } = await import('firebase-admin/storage');

      // Download the original audio file
      console.log('[ProcessReprocessing] Downloading original audio:', { filePath });
      const bucket = getStorage().bucket();
      const tempFilePath = `/tmp/${conversationId}_reprocess.mp3`;
      await bucket.file(filePath).download({ destination: tempFilePath });

      // Get file duration and perform chunking
      const { spawn } = await import('child_process');
      const ffprobeInstaller = await import('@ffprobe-installer/ffprobe');

      // Get audio duration using ffprobe
      const getDuration = (): Promise<number> => {
        return new Promise((resolve, reject) => {
          const ffprobe = spawn(ffprobeInstaller.default.path, [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            tempFilePath
          ]);

          let output = '';
          ffprobe.stdout.on('data', (data) => { output += data.toString(); });
          ffprobe.on('close', (code) => {
            if (code !== 0) {
              reject(new Error(`ffprobe exited with code ${code}`));
              return;
            }
            try {
              const metadata = JSON.parse(output);
              resolve(parseFloat(metadata.format.duration) * 1000); // Convert to ms
            } catch (e) {
              reject(new Error('Failed to parse audio duration'));
            }
          });
        });
      };

      const durationMs = await getDuration();
      console.log('[ProcessReprocessing] Audio duration:', { durationMs, filePath });

      // Check if chunking is needed
      const needsChunking = durationMs > CHUNK_CONFIG.CHUNKING_THRESHOLD_SECONDS * 1000;

      if (needsChunking) {
        // Chunk the file with sequential mode
        console.log('[ProcessReprocessing] Chunking file for sequential reprocessing...');
        const { result: chunkingResult, localChunkPaths } = await chunkAudioFile(
          tempFilePath,
          filePath
        );

        // Upload chunks to Storage
        const { getStorage } = await import('firebase-admin/storage');
        const storageBucket = getStorage().bucket();

        for (let i = 0; i < localChunkPaths.length; i++) {
          const localPath = localChunkPaths[i];
          const chunkStoragePath = `audio/${userId}/${conversationId}/chunks/chunk_${i}.mp3`;
          await storageBucket.upload(localPath, {
            destination: chunkStoragePath,
            metadata: { contentType: 'audio/mpeg' }
          });
          // Update the chunk metadata with the storage path
          chunkingResult.chunks[i].chunkStoragePath = chunkStoragePath;
        }

        // Update conversation with new chunking metadata
        await db.collection('conversations').doc(conversationId).update({
          'chunkingMetadata.chunkingEnabled': true,
          'chunkingMetadata.totalChunks': chunkingResult.chunks.length,
          'chunkingMetadata.chunkedAt': new Date().toISOString(),
          processingMode: 'sequential',
          updatedAt: FieldValue.serverTimestamp()
        });

        // Enqueue chunk processing tasks in sequential mode
        const { CloudTasksClient } = await import('@google-cloud/tasks');
        const tasksClient = new CloudTasksClient();

        const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
        const location = 'us-central1';
        const queue = 'transcription-queue';
        const parent = tasksClient.queuePath(project!, location, queue);
        const processTranscriptionUrl = `https://${location}-${project}.cloudfunctions.net/processTranscription`;

        // Enqueue all chunks with sequential mode
        for (const chunk of chunkingResult.chunks) {
          const chunkPayload = {
            conversationId,
            userId,
            filePath: chunk.chunkStoragePath,
            processingMode: 'sequential',
            chunkIndex: chunk.chunkIndex,
            totalChunks: chunk.totalChunks,
            chunkMetadata: chunk,
            chunkStartMs: chunk.startMs,
            chunkEndMs: chunk.endMs,
            overlapBeforeMs: chunk.overlapBeforeMs,
            overlapAfterMs: chunk.overlapAfterMs
          };

          const task = {
            httpRequest: {
              httpMethod: 'POST' as const,
              url: processTranscriptionUrl,
              headers: { 'Content-Type': 'application/json' },
              body: Buffer.from(JSON.stringify(chunkPayload)).toString('base64'),
              oidcToken: { serviceAccountEmail: `${project}@appspot.gserviceaccount.com` }
            },
            scheduleTime: { seconds: Math.floor(Date.now() / 1000) + 5 + (chunk.chunkIndex * 2) },
            dispatchDeadline: { seconds: 1800 } // 30 min (Cloud Tasks max)
          };

          await tasksClient.createTask({ parent, task });
          console.log('[ProcessReprocessing] Enqueued chunk task:', {
            chunkIndex: chunk.chunkIndex,
            totalChunks: chunk.totalChunks
          });
        }

        // Clean up local chunk files
        for (const localPath of localChunkPaths) {
          try {
            const fsModule = await import('fs');
            fsModule.unlinkSync(localPath);
          } catch {
            // Ignore cleanup errors
          }
        }

        console.log('[ProcessReprocessing] ✅ Sequential reprocessing initiated:', {
          conversationId,
          totalChunks: chunkingResult.chunks.length,
          parallelConfidence: fallbackMetadata.parallelConfidence
        });

      } else {
        // File is small enough to process without chunking
        // Enqueue single transcription task
        console.log('[ProcessReprocessing] File small enough for single task');

        const { CloudTasksClient } = await import('@google-cloud/tasks');
        const tasksClient = new CloudTasksClient();

        const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
        const location = 'us-central1';
        const queue = 'transcription-queue';
        const parent = tasksClient.queuePath(project!, location, queue);
        const processTranscriptionUrl = `https://${location}-${project}.cloudfunctions.net/processTranscription`;

        const taskPayload = {
          conversationId,
          userId,
          filePath,
          processingMode: 'sequential'
        };

        const task = {
          httpRequest: {
            httpMethod: 'POST' as const,
            url: processTranscriptionUrl,
            headers: { 'Content-Type': 'application/json' },
            body: Buffer.from(JSON.stringify(taskPayload)).toString('base64'),
            oidcToken: { serviceAccountEmail: `${project}@appspot.gserviceaccount.com` }
          },
          scheduleTime: { seconds: Math.floor(Date.now() / 1000) + 5 },
          dispatchDeadline: { seconds: 1800 } // 30 min (Cloud Tasks max)
        };

        await tasksClient.createTask({ parent, task });
      }

      // Clean up temp file
      try {
        const fs = await import('fs');
        fs.unlinkSync(tempFilePath);
      } catch {
        // Ignore cleanup errors
      }

      res.status(200).send('OK');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      console.error('[ProcessReprocessing] ❌ Reprocessing failed:', {
        conversationId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined
      });

      // Update Firestore to mark reprocessing failed
      try {
        await db.collection('conversations').doc(conversationId).update({
          status: 'failed',
          processingError: `Reprocessing failed: ${errorMessage}`,
          updatedAt: FieldValue.serverTimestamp()
        });
      } catch (updateError) {
        console.error('[ProcessReprocessing] Failed to update Firestore status:', updateError);
      }

      res.status(500).send(`Internal Server Error: ${errorMessage}`);
    }
  }
);
