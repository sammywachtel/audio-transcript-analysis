/**
 * Transcription Cloud Function — Thin Dispatcher
 *
 * Triggered when an audio file is uploaded to Firebase Storage.
 * Validates the upload event, writes initial processing state, and
 * dispatches an authenticated HTTP request to the Cloud Run orchestrator.
 * Returns within 60s/256MiB — the orchestrator owns the actual pipeline.
 *
 * Also exports segment boundary repair and speaker correction utilities
 * used by the pipeline and tested independently.
 */

import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { defineSecret } from 'firebase-functions/params';
import { FieldValue } from 'firebase-admin/firestore';
import { GoogleAuth } from 'google-auth-library';
import { db } from './index';
import { recordUserEvent } from './userEvents';
import { ProcessingMode, TranscribeRequest, StructuredError } from './types';

// Define secrets (set via: firebase functions:secrets:set <SECRET_NAME>)
// Gemini/Whisper secrets are still declared so the emulator path works.
// The Cloud Run orchestrator reads them from its own env vars.
const geminiApiKey = defineSecret('GEMINI_API_KEY');
const whisperServiceUrl = defineSecret('WHISPER_SERVICE_URL');

// Cloud Run orchestrator URL — set via firebase functions:config or env var.
// In production, this is the authenticated Cloud Run service URL.
const orchestratorUrl = defineSecret('ORCHESTRATOR_URL');

/**
 * Custom error for abort requests - allows clean exit from processing
 */
export class AbortRequestedError extends Error {
  constructor(conversationId: string) {
    super(`Processing aborted by user for conversation ${conversationId}`);
    this.name = 'AbortRequestedError';
  }
}

/**
 * Check if abort has been requested for this conversation.
 * Throws AbortRequestedError if abort flag is set.
 */
export async function checkAbort(conversationId: string): Promise<void> {
  const doc = await db.collection('conversations').doc(conversationId).get();
  if (doc.exists && doc.data()?.abortRequested === true) {
    console.log('[Transcribe] Abort requested, stopping processing:', { conversationId });
    throw new AbortRequestedError(conversationId);
  }
}

/**
 * Represents a speaker correction identified by Gemini analysis.
 * Used to fix mid-segment speaker changes that pyannote misses.
 */
interface SpeakerCorrection {
  segmentIndex: number;
  action: 'split' | 'reassign';
  reason: string;
  // For split action:
  splitAtChar?: number;       // DEPRECATED: old char-position anchor (kept for _applySpeakerCorrections compat)
  splitAfterSentence?: string; // NEW: sentence text anchor — find this text, split after it
  speakerBefore?: string;
  speakerAfter?: string;
  // For reassign action:
  newSpeaker?: string;
}

// Lazy-initialized Google Auth client for IAM-authenticated dispatch
let _authClient: GoogleAuth | null = null;
function getAuthClient(): GoogleAuth {
  if (!_authClient) {
    _authClient = new GoogleAuth();
  }
  return _authClient;
}

/**
 * Get an OIDC identity token for the Cloud Run orchestrator.
 * The Cloud Function's service account must have `roles/run.invoker`
 * on the target Cloud Run service.
 */
async function getIdTokenForOrchestrator(targetAudience: string): Promise<string> {
  const auth = getAuthClient();
  const client = await auth.getIdTokenClient(targetAudience);
  const headers = await client.getRequestHeaders();
  return headers.Authorization?.replace('Bearer ', '') || '';
}

/**
 * Dispatch to the Cloud Run orchestrator and wait for acceptance.
 *
 * The orchestrator validates the request and returns 202 Accepted
 * immediately — before the pipeline starts. This lets us confirm
 * the request was received without blocking on a 10-minute pipeline.
 * Results go straight to Firestore; we never see them here.
 */
async function dispatchToOrchestrator(
  orchestratorBaseUrl: string,
  payload: TranscribeRequest,
): Promise<void> {
  const url = `${orchestratorBaseUrl}/transcribe`;
  const idToken = await getIdTokenForOrchestrator(orchestratorBaseUrl);

  const DISPATCH_TIMEOUT_MS = 30_000; // 30s to get acceptance
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.status !== 202) {
      // Read the error body for diagnostics (it's small — validation errors only)
      const body = await response.text().catch(() => '(unreadable)');
      throw new Error(
        `Orchestrator returned ${response.status} (expected 202): ${body}`
      );
    }

    console.log('[Dispatcher] Orchestrator accepted request:', {
      conversationId: payload.conversationId,
      status: response.status,
    });
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/**
 * Triggered when an audio file is uploaded to storage.
 * Path pattern: audio/{userId}/{conversationId}.{extension}
 *
 * Production: thin dispatcher that validates and hands off to Cloud Run.
 * Emulator: runs the pipeline inline (Cloud Run isn't available locally).
 */
export const transcribeAudio = onObjectFinalized(
  {
    secrets: [geminiApiKey, whisperServiceUrl, orchestratorUrl],
    memory: '256MiB',
    timeoutSeconds: 60, // Thin dispatcher — 60s is plenty
    region: 'us-central1'
  },
  async (event) => {
    const filePath = event.data.name;
    const contentType = event.data.contentType;

    // DEBUG: Log raw event data for troubleshooting
    console.debug('[Transcribe] Storage event received:', {
      bucket: event.data.bucket,
      name: event.data.name,
      contentType: event.data.contentType,
      size: event.data.size,
      timeCreated: event.data.timeCreated,
      updated: event.data.updated,
      md5Hash: event.data.md5Hash,
      generation: event.data.generation,
      metageneration: event.data.metageneration
    });

    // Only process audio files in the audio/ directory
    if (!filePath.startsWith('audio/') || !contentType?.startsWith('audio/')) {
      console.debug('[Transcribe] Skipping non-audio file:', { filePath, contentType });
      return;
    }

    // Skip playback files created by the pipeline (CBR re-encode for browser seeking)
    if (filePath.includes('_playback')) {
      console.debug('[Transcribe] Skipping playback file:', filePath);
      return;
    }

    // Parse path: audio/{userId}/{conversationId}.{ext}
    const pathParts = filePath.split('/');
    if (pathParts.length !== 3) {
      console.error('[Transcribe] Invalid audio path structure:', filePath);
      return;
    }

    const userId = pathParts[1];
    const fileName = pathParts[2];
    const conversationId = fileName.split('.')[0];
    const fileExtension = fileName.split('.').pop();

    // Atomic dedup: use a Firestore transaction to claim this conversation.
    // Cloud Storage fires "at least once" — we routinely get 3 triggers for one upload.
    // A simple read-then-write has a race window where all 3 pass the check.
    // The transaction ensures exactly one trigger wins.
    const conversationRef = db.collection('conversations').doc(conversationId);
    // Returns the existing processingMode if we should proceed, or null if duplicate
    const existingProcessingMode = await db.runTransaction(async (txn) => {
      const doc = await txn.get(conversationRef);
      const data = doc.data();
      const existingStatus = data?.status;
      const alreadyQueued = data?.queuedAt !== undefined;
      const taskAlreadyEnqueued = data?.taskEnqueued === true;

      if (alreadyQueued || taskAlreadyEnqueued ||
          existingStatus === 'chunking' || existingStatus === 'merging' ||
          existingStatus === 'complete' || existingStatus === 'failed' ||
          existingStatus === 'aborted') {
        console.log('[Transcribe] Skipping duplicate trigger - already claimed:', {
          conversationId,
          existingStatus,
          alreadyQueued,
          taskAlreadyEnqueued,
        });
        return null;
      }

      // Claim it — set queuedAt so the other triggers see it and bail out
      txn.set(conversationRef, {
        queuedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      // Return stored mode for legacy upload compat
      return data?.processingMode ?? undefined;
    });

    if (existingProcessingMode === null) {
      return;
    }

    // Read processingMode from Storage custom metadata
    // If metadata is missing, check Firestore for an existing value (legacy uploads)
    // Only default to 'parallel' if neither source has a value
    const customMetadata = event.data.metadata as Record<string, string> | undefined;
    let processingMode: ProcessingMode = (customMetadata?.processingMode === 'sequential')
      ? 'sequential'
      : 'parallel';

    // Honor stored legacy mode when Storage metadata is absent
    if (!customMetadata?.processingMode) {
      if (existingProcessingMode === 'sequential') {
          processingMode = 'sequential';
          console.log('[Transcribe] Using stored sequential mode from Firestore (no Storage metadata)');
        }
    }

    console.log('[Transcribe] Audio file uploaded - enqueuing for processing:', {
      filePath,
      userId,
      conversationId,
      contentType,
      fileExtension,
      sizeBytes: event.data.size,
      sizeMB: (event.data.size / (1024 * 1024)).toFixed(2),
      processingMode
    });


    try {
      // Set initial status. Using merge to handle the race where the storage trigger
      // fires before the frontend creates the Firestore document.
      await db.collection('conversations').doc(conversationId).set({
        conversationId,
        userId,
        status: 'processing',
        processingMode,
        taskGeneration: 1,
        queuedAt: FieldValue.serverTimestamp(),
        processingStartedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true';

      if (isEmulator) {
        // Emulator: run pipeline inline — Cloud Run isn't available locally.
        console.log('[Dispatcher] Emulator detected — running pipeline directly');

        const { processWithNewPipeline } = await import('./newPipeline');
        await processWithNewPipeline(conversationId, filePath, userId);
        console.log('[Dispatcher] Pipeline complete:', { conversationId });
      } else {
        // Production: dispatch to Cloud Run orchestrator, fire-and-forget.
        // The orchestrator writes all progress/results to Firestore directly.
        const orchestratorBaseUrl = process.env.ORCHESTRATOR_URL;
        if (!orchestratorBaseUrl) {
          throw new Error('ORCHESTRATOR_URL secret not configured');
        }

        const payload: TranscribeRequest = {
          conversationId,
          audioStoragePath: filePath,
          userId,
        };

        await dispatchToOrchestrator(orchestratorBaseUrl, payload);

        console.log('[Dispatcher] Dispatched to Cloud Run orchestrator:', {
          conversationId,
          orchestratorBaseUrl: orchestratorBaseUrl.replace(/\/\/.*@/, '//***@'), // don't log tokens
        });
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Check if this was an abort request (emulator path only)
      if (error instanceof AbortRequestedError) {
        console.log('[Dispatcher] Processing was aborted by user:', { conversationId });
        await db.collection('conversations').doc(conversationId).update({
          status: 'aborted',
          processingError: 'Processing cancelled by user',
          updatedAt: FieldValue.serverTimestamp()
        });
        return;
      }

      console.error('[Dispatcher] Failed to dispatch transcription:', {
        conversationId,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        errorMessage,
      });

      // Dispatch failure → write structured error so the frontend
      // can show a meaningful message and the user can retry.
      const structuredError: StructuredError = {
        code: 'UNKNOWN',
        stage: 'download',
        message: `Dispatch failed: ${errorMessage}`,
        retryable: true,
      };

      await db.collection('conversations').doc(conversationId).update({
        status: 'failed',
        processingError: structuredError,
        updatedAt: FieldValue.serverTimestamp()
      });

      // Record failure event
      await recordUserEvent({
        eventType: 'processing_failed',
        userId,
        conversationId,
        metadata: {
          errorMessage: `Dispatch failed: ${errorMessage}`
        }
      });
    }
  }
);


// =============================================================================
// Segment Boundary Repair
// =============================================================================

/**
 * Fix segment boundary bleed-over from WhisperX diarization.
 *
 * WhisperX sometimes misattributes a speaker's final few words to the next
 * speaker's segment (or vice versa), because the diarization timestamp is
 * slightly off relative to the word timestamps. The result is that the end of
 * one speaker's sentence gets attached to the start of the next speaker's segment.
 *
 * Example: "all these other things. Anyways. But having tools..."
 *          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ should be in previous segment
 *
 * Heuristic: If a segment starts with a sentence fragment (text ending in
 * sentence-ending punctuation within first N chars), move it to prev segment.
 */
export function fixSegmentBoundaries(
  segments: Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }>
): Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }> {
  if (segments.length < 2) {
    return segments;
  }

  const MAX_FRAGMENT_CHARS = 80;       // Forward pass: max fragment length at segment START
  const MAX_COMMA_FRAGMENT_CHARS = 40; // Secondary pattern: comma/semicolon fragments are smaller
  const MIN_REMAINING_CHARS = 20;      // Don't move if it leaves a stub behind
  const MAX_REVERSE_FRAGMENT_CHARS = 80; // Reverse pass: max trailing fragment at segment END

  // Primary: sentence-ending punctuation followed by a capitalized continuation
  const fragmentPattern = /^(.+?[.!?])\s+([A-Z].*)/s;
  // Secondary: comma or semicolon fragment at start — "well, anyway. But" style trailing clauses
  const commaFragmentPattern = /^(.+?[,;])\s+([A-Z].*)/s;
  // Reverse: last sentence boundary followed by short trailing text
  const reverseFragmentPattern = /(.+[.!?])\s+(.{1,80})$/s;

  let forwardCandidates = 0;
  let forwardMoved = 0;
  let reverseCandidates = 0;
  let reverseMoved = 0;
  const result = [...segments];

  // ---- FORWARD PASS: move leading fragment of segment[i] to segment[i-1] ----
  for (let i = 1; i < result.length; i++) {
    const current = result[i];
    const previous = result[i - 1];

    if (current.speakerId === previous.speakerId) {
      continue;
    }

    const text = current.text.trim();

    // Try primary pattern first (sentence-ending punctuation)
    let fragment: string | null = null;
    let remainder: string | null = null;
    let maxFragLen = MAX_FRAGMENT_CHARS;

    const primaryMatch = text.match(fragmentPattern);
    if (primaryMatch) {
      fragment = primaryMatch[1];
      remainder = primaryMatch[2];
    } else {
      // Try secondary: comma/semicolon fragment (tighter length limit)
      const commaMatch = text.match(commaFragmentPattern);
      if (commaMatch) {
        fragment = commaMatch[1];
        remainder = commaMatch[2];
        maxFragLen = MAX_COMMA_FRAGMENT_CHARS;
      }
    }

    if (!fragment || !remainder) {
      continue;
    }

    forwardCandidates++;

    if (fragment.length > maxFragLen || remainder.length < MIN_REMAINING_CHARS) {
      continue;
    }

    // Fragment starting with common sentence starters is probably intentional speech,
    // not a dangling tail — but only reject it if it's long enough to stand alone.
    // Threshold lowered from 40 → 25: short starter fragments are still usually bleeds.
    const startsWithSentenceStarter = /^(I|You|We|They|He|She|It|The|A|An|This|That|So|But|And|Or|If|When|What|How|Why|Where|Who)\s/i.test(fragment);
    if (startsWithSentenceStarter && fragment.length > 25) {
      continue;
    }

    console.debug(`[FixBoundaries] Forward: moving fragment from seg ${i} to ${i-1}:`, {
      fragment: fragment.substring(0, 50) + (fragment.length > 50 ? '...' : ''),
      fromSpeaker: current.speakerId,
      toSpeaker: previous.speakerId
    });

    const totalChars = current.text.length;
    const fragmentRatio = fragment.length / totalChars;
    const durationMs = current.endMs - current.startMs;
    const fragmentDurationMs = Math.floor(durationMs * fragmentRatio);
    const newBoundaryMs = current.startMs + fragmentDurationMs;

    result[i - 1] = {
      ...previous,
      text: previous.text.trimEnd() + ' ' + fragment,
      endMs: newBoundaryMs
    };

    result[i] = {
      ...current,
      text: remainder,
      startMs: newBoundaryMs
    };

    forwardMoved++;
  }

  // ---- REVERSE PASS: move trailing fragment of segment[i] to segment[i+1] ----
  // Catches the mirror problem: speaker change detected early, so the start of the
  // next speaker's thought is still appended to the current speaker's segment.
  for (let i = 0; i < result.length - 1; i++) {
    const current = result[i];
    const next = result[i + 1];

    if (current.speakerId === next.speakerId) {
      continue;
    }

    const text = current.text.trim();

    // Look for a sentence boundary followed by a short trailing chunk
    const match = text.match(reverseFragmentPattern);
    if (!match) {
      continue;
    }

    const keep = match[1];     // Everything up to and including last sentence end
    const trailing = match[2]; // The orphaned tail that belongs to the next segment

    reverseCandidates++;

    if (trailing.length > MAX_REVERSE_FRAGMENT_CHARS || keep.length < MIN_REMAINING_CHARS) {
      continue;
    }

    // Reject if trailing starts with a sentence starter and is substantial —
    // that suggests it's intentional content, not a bleed.
    const trailingStartsWithStarter = /^(I|You|We|They|He|She|It|The|A|An|This|That|So|But|And|Or|If|When|What|How|Why|Where|Who)\s/i.test(trailing);
    if (trailingStartsWithStarter && trailing.length > 25) {
      continue;
    }

    console.debug(`[FixBoundaries] Reverse: moving trailing fragment from seg ${i} to ${i+1}:`, {
      trailing: trailing.substring(0, 50) + (trailing.length > 50 ? '...' : ''),
      fromSpeaker: current.speakerId,
      toSpeaker: next.speakerId
    });

    const totalChars = current.text.length;
    const keepRatio = keep.length / totalChars;
    const durationMs = current.endMs - current.startMs;
    const keepDurationMs = Math.floor(durationMs * keepRatio);
    const newBoundaryMs = current.startMs + keepDurationMs;

    result[i] = {
      ...current,
      text: keep,
      endMs: newBoundaryMs
    };

    result[i + 1] = {
      ...next,
      text: trailing + ' ' + next.text.trimStart(),
      startMs: newBoundaryMs
    };

    reverseMoved++;
  }

  console.log('[FixBoundaries] Boundary repair complete:', {
    forwardCandidates,
    forwardMoved,
    reverseCandidates,
    reverseMoved
  });

  // Re-index segments
  return result.map((seg, idx) => ({ ...seg, index: idx }));
}


// =============================================================================
// Speaker Reassignment
// =============================================================================

/**
 * Apply speaker corrections (reassignments and splits) to segments.
 *
 * Processing order:
 *   1. Apply all reassignments (simple speaker ID swaps, no timestamp changes)
 *   2. Apply up to MAX_SPLITS splits in DESCENDING index order (to keep earlier indices valid)
 *   3. Merge adjacent same-speaker segments created/revealed by the splits
 *   4. Re-index all segments
 *
 * Every split is guarded — invalid corrections are skipped with a log, never thrown.
 */
export function applySpeakerReassignments(
  segments: Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }>,
  corrections: SpeakerCorrection[],
  allSpeakers: string[]
): Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }> {
  if (corrections.length === 0) {
    return segments;
  }

  const MAX_SPLITS = 3;
  const MIN_SPLIT_HALF_CHARS = 20; // Both halves must be at least this long

  // ---- Phase 1: Reassignments ----
  const reassignments = corrections.filter(c => c.action === 'reassign' && c.newSpeaker);
  let result = [...segments];
  // Track which indices were modified so Phase 3 only merges around them
  const touchedIndices = new Set<number>();

  for (const correction of reassignments) {
    const { segmentIndex, newSpeaker } = correction;

    if (segmentIndex < 0 || segmentIndex >= result.length) {
      console.warn(`[Speaker Reassignment] Invalid segment index ${segmentIndex}, skipping reassign`);
      continue;
    }

    if (!allSpeakers.includes(newSpeaker!)) {
      console.warn(`[Speaker Reassignment] Unknown speaker "${newSpeaker}", skipping reassign`);
      continue;
    }

    const oldSpeaker = result[segmentIndex].speakerId;
    if (oldSpeaker !== newSpeaker) {
      console.debug(`[Speaker Reassignment] Seg ${segmentIndex}: ${oldSpeaker} -> ${newSpeaker}`);
      result[segmentIndex] = { ...result[segmentIndex], speakerId: newSpeaker! };
      touchedIndices.add(segmentIndex);
    }
  }

  // ---- Phase 2: Splits ----
  // Cap at MAX_SPLITS, process descending so earlier indices stay valid
  const splitCorrections = corrections
    .filter(c => c.action === 'split' && c.splitAfterSentence)
    .slice(0, MAX_SPLITS)
    .sort((a, b) => b.segmentIndex - a.segmentIndex);

  const droppedSplits = corrections.filter(c => c.action === 'split').length - splitCorrections.length;
  if (droppedSplits > 0) {
    console.warn(`[Speaker Reassignment] Dropped ${droppedSplits} split correction(s) exceeding MAX_SPLITS=${MAX_SPLITS}`);
  }

  for (const correction of splitCorrections) {
    const { segmentIndex, splitAfterSentence, speakerBefore, speakerAfter } = correction;

    // Guard: valid index
    if (segmentIndex < 0 || segmentIndex >= result.length) {
      console.warn(`[Speaker Reassignment] Invalid segment index ${segmentIndex}, skipping split`);
      continue;
    }

    // Guard: both speakers must be known
    if (!speakerBefore || !speakerAfter) {
      console.warn(`[Speaker Reassignment] Split at seg ${segmentIndex} missing speakerBefore/speakerAfter, skipping`);
      continue;
    }
    if (!allSpeakers.includes(speakerBefore)) {
      console.warn(`[Speaker Reassignment] Unknown speakerBefore "${speakerBefore}" for split at seg ${segmentIndex}, skipping`);
      continue;
    }
    if (!allSpeakers.includes(speakerAfter)) {
      console.warn(`[Speaker Reassignment] Unknown speakerAfter "${speakerAfter}" for split at seg ${segmentIndex}, skipping`);
      continue;
    }

    const segment = result[segmentIndex];
    const anchor = splitAfterSentence!.trim();

    // Guard: anchor text must exist in segment
    const anchorPos = segment.text.indexOf(anchor);
    if (anchorPos === -1) {
      console.warn(`[Speaker Reassignment] splitAfterSentence not found in seg ${segmentIndex}, skipping`, {
        anchor: anchor.substring(0, 60),
        segmentStart: segment.text.substring(0, 60)
      });
      continue;
    }

    // Guard: anchor must end at a sentence boundary
    const splitPos = anchorPos + anchor.length; // character index right after the anchor
    const anchorEndsWithPunct = /[.!?]$/.test(anchor.trimEnd());
    if (!anchorEndsWithPunct) {
      console.warn(`[Speaker Reassignment] Split anchor for seg ${segmentIndex} doesn't end with sentence punctuation, skipping`, {
        anchor: anchor.substring(0, 60)
      });
      continue;
    }

    const textBefore = segment.text.substring(0, splitPos).trim();
    const textAfter = segment.text.substring(splitPos).trim();

    // Guard: both halves must be substantial enough to stand alone
    if (textBefore.length < MIN_SPLIT_HALF_CHARS || textAfter.length < MIN_SPLIT_HALF_CHARS) {
      console.warn(`[Speaker Reassignment] Split halves too short for seg ${segmentIndex}, skipping`, {
        beforeLen: textBefore.length,
        afterLen: textAfter.length,
        minRequired: MIN_SPLIT_HALF_CHARS
      });
      continue;
    }

    // Interpolate timestamps by character ratio
    const totalChars = segment.text.length;
    const charRatio = textBefore.length / totalChars;
    const durationMs = segment.endMs - segment.startMs;
    const splitTimeMs = segment.startMs + Math.floor(durationMs * charRatio);

    console.debug(`[Speaker Reassignment] Splitting seg ${segmentIndex}:`, {
      speakerBefore,
      speakerAfter,
      splitTimeMs,
      beforeLen: textBefore.length,
      afterLen: textAfter.length,
      reason: correction.reason?.substring(0, 60)
    });

    const segBefore = {
      text: textBefore,
      startMs: segment.startMs,
      endMs: splitTimeMs,
      speakerId: speakerBefore,
      index: segment.index  // placeholder — reindexed at end
    };

    const segAfter = {
      text: textAfter,
      startMs: splitTimeMs,
      endMs: segment.endMs,
      speakerId: speakerAfter,
      index: segment.index  // placeholder
    };

    result.splice(segmentIndex, 1, segBefore, segAfter);
    // Both halves of the split are new — mark them for Phase 3
    touchedIndices.add(segmentIndex);
    touchedIndices.add(segmentIndex + 1);
    // Splits insert an element, so bump any previously-tracked indices above this point
    const shifted = new Set<number>();
    for (const idx of touchedIndices) {
      shifted.add(idx > segmentIndex + 1 ? idx + 1 : idx);
    }
    touchedIndices.clear();
    for (const idx of shifted) touchedIndices.add(idx);
  }

  // ---- Phase 3: Merge adjacent same-speaker segments (ONLY around modified indices) ----
  // Only merge neighbours when at least one was touched by Phase 1/2.
  // Unconditionally merging all same-speaker neighbours destroys WhisperX's
  // natural sentence boundaries and creates giant multi-sentence blocks.
  const merged: typeof result = [];
  for (let i = 0; i < result.length; i++) {
    const seg = result[i];
    const last = merged[merged.length - 1];
    if (
      last &&
      last.speakerId === seg.speakerId &&
      (touchedIndices.has(i) || touchedIndices.has(i - 1))
    ) {
      // Only merge if one of the pair was modified by reassignment/split
      merged[merged.length - 1] = {
        ...last,
        text: last.text.trimEnd() + ' ' + seg.text.trimStart(),
        endMs: seg.endMs
      };
    } else {
      merged.push({ ...seg });
    }
  }

  // ---- Phase 4: Re-index ----
  return merged.map((seg, idx) => ({ ...seg, index: idx }));
}

/**
 * DEPRECATED: Apply speaker corrections to segments.
 * Handles both 'split' and 'reassign' actions.
 * Use applySpeakerReassignments instead (no timestamp manipulation).
 */
export function _applySpeakerCorrections(
  segments: Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }>,
  corrections: SpeakerCorrection[],
  allSpeakers: string[]
): Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }> {
  if (corrections.length === 0) {
    console.debug('[Apply Corrections] No corrections to apply');
    return segments;
  }

  console.log('[Apply Corrections] Applying corrections...', {
    correctionCount: corrections.length,
    splitCount: corrections.filter(c => c.action === 'split').length,
    reassignCount: corrections.filter(c => c.action === 'reassign').length,
    availableSpeakers: allSpeakers
  });

  let modifiedSegments = [...segments];

  // Sort corrections by segment index DESCENDING to avoid index shifting
  const sortedCorrections = [...corrections].sort((a, b) => b.segmentIndex - a.segmentIndex);

  sortedCorrections.forEach(correction => {
    const segIndex = correction.segmentIndex;

    if (segIndex < 0 || segIndex >= modifiedSegments.length) {
      console.warn('[Apply Corrections] Invalid segment index, skipping:', {
        segmentIndex: segIndex,
        totalSegments: modifiedSegments.length
      });
      return;
    }

    const segment = modifiedSegments[segIndex];

    if (correction.action === 'reassign') {
      // Simple reassignment - just change the speaker
      if (!correction.newSpeaker) {
        console.warn('[Apply Corrections] Reassign action missing newSpeaker, skipping:', correction);
        return;
      }

      console.debug('[Apply Corrections] Reassigning segment:', {
        segmentIndex: segIndex,
        oldSpeaker: segment.speakerId,
        newSpeaker: correction.newSpeaker,
        reason: correction.reason
      });

      modifiedSegments[segIndex] = {
        ...segment,
        speakerId: correction.newSpeaker
      };

    } else if (correction.action === 'split') {
      // Split segment at character position
      // speakerBefore is optional - defaults to original segment's speaker
      // speakerAfter can be inferred for 2-speaker conversations
      if (!correction.splitAtChar) {
        console.warn('[Apply Corrections] Split action missing splitAtChar, skipping:', correction);
        return;
      }

      // Default speakerBefore to original speaker if not provided
      const speakerBefore = correction.speakerBefore || segment.speakerId;

      // Infer speakerAfter if not provided
      let speakerAfter = correction.speakerAfter;
      if (!speakerAfter) {
        // For 2-speaker conversations, the "other" speaker is obvious
        if (allSpeakers.length === 2) {
          speakerAfter = allSpeakers.find(s => s !== speakerBefore) || speakerBefore;
          console.debug('[Apply Corrections] Inferred speakerAfter for 2-speaker conversation:', {
            speakerBefore,
            speakerAfter,
            allSpeakers
          });
        } else {
          // Can't infer with >2 speakers - skip this correction
          console.warn('[Apply Corrections] Split action missing speakerAfter and cannot infer (>2 speakers), skipping:', correction);
          return;
        }
      }

      const splitPos = correction.splitAtChar;
      if (splitPos <= 0 || splitPos >= segment.text.length) {
        console.warn('[Apply Corrections] Invalid split position, skipping:', {
          splitAtChar: splitPos,
          textLength: segment.text.length
        });
        return;
      }

      const textBefore = segment.text.substring(0, splitPos).trim();
      const textAfter = segment.text.substring(splitPos).trim();

      // Interpolate timestamps based on character ratio (rough but reasonable)
      const charRatio = textBefore.length / segment.text.length;
      const durationMs = segment.endMs - segment.startMs;
      const splitTimeMs = segment.startMs + Math.floor(durationMs * charRatio);

      console.debug('[Apply Corrections] Splitting segment:', {
        segmentIndex: segIndex,
        splitAtChar: splitPos,
        charRatio: charRatio.toFixed(2),
        speakerBefore: speakerBefore,
        speakerAfter: speakerAfter,
        reason: correction.reason,
        beforeLength: textBefore.length,
        afterLength: textAfter.length
      });

      // Create two new segments
      const segmentBefore = {
        text: textBefore,
        startMs: segment.startMs,
        endMs: splitTimeMs,
        speakerId: speakerBefore,
        index: segment.index  // Will be re-indexed later
      };

      const segmentAfter = {
        text: textAfter,
        startMs: splitTimeMs,
        endMs: segment.endMs,
        speakerId: speakerAfter,
        index: segment.index  // Will be re-indexed later
      };

      // Replace the original segment with the two new ones
      modifiedSegments.splice(segIndex, 1, segmentBefore, segmentAfter);
    }
  });

  // Re-index all segments after corrections
  modifiedSegments = modifiedSegments.map((seg, idx) => ({
    ...seg,
    index: idx
  }));

  console.log('[Apply Corrections] Corrections applied:', {
    originalSegmentCount: segments.length,
    finalSegmentCount: modifiedSegments.length,
    segmentsAdded: modifiedSegments.length - segments.length
  });

  return modifiedSegments;
}
