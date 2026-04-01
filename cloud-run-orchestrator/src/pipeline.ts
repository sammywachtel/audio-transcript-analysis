/**
 * Cloud Run Pipeline Orchestrator
 *
 * Close adaptation of functions/src/newPipeline.ts for the Cloud Run
 * environment. Same pipeline stages, same Firestore progress contract,
 * same quality gates — just running with a 900s budget instead of 540s.
 *
 * Key differences from the Cloud Function version:
 *   - db comes from our own Firebase Admin init (./server), not ./index
 *   - Uses console.log instead of firebase-functions logger
 *   - Progress manager is inlined (avoids ./index import chain)
 *   - Structured errors (StructuredError) instead of freeform strings
 *   - No firebase-functions secrets — env vars injected by Cloud Run
 *
 * The heavy lifting modules (gemini3Pipeline, alignment) are imported
 * from the functions source via tsconfig path mapping (@functions/*).
 * At deploy time, a build step copies or bundles these modules.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getStorage } from 'firebase-admin/storage';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './server';
import { StructuredError, OrchestratorErrorCode, PipelineStage } from './contracts';

// Functions source modules — resolved via tsconfig paths (@functions/*)
import {
  processWithGemini3Flash,
  assembleFirestoreData,
  GeminiPipelineResult,
  AlignedSegment,
} from '@functions/gemini3Pipeline';
import { getWhisperXWords } from '@functions/alignment';
import { assignSpeakersToWords } from '@functions/speakerAssignment';
import { getAudioDuration } from '@functions/audioUtils';

// =============================================================================
// Constants
// =============================================================================

// 10-minute chunks — WhisperX's sweet spot, validated in the PoC
const CHUNK_SEC = 600;

// 15-minute pipeline ceiling. Cloud Run allows up to 900s, but we want
// headroom for cleanup and Firestore writes before the platform kills us.
const PIPELINE_TIMEOUT_MS = 15 * 60 * 1000;

// 2-minute ceiling per WhisperX chunk
const CHUNK_ALIGNMENT_TIMEOUT_MS = 2 * 60 * 1000;

const execFileAsync = promisify(execFile);

// =============================================================================
// Pipeline Result
// =============================================================================

export interface PipelineResult {
  segments: number;
  speakers: number;
  durationMs: number;
}

// =============================================================================
// Error Helpers
// =============================================================================

/**
 * Pipeline-level fatal error with structured metadata.
 * Carries both a human message and a machine-readable StructuredError
 * so the server can return it in the response body.
 */
class PipelineFatalError extends Error {
  public readonly structured: StructuredError;

  constructor(
    message: string,
    code: OrchestratorErrorCode,
    stage: PipelineStage,
    retryable: boolean = false,
  ) {
    super(message);
    this.name = 'PipelineFatalError';
    this.structured = { code, stage, message, retryable };
  }
}

// =============================================================================
// Inline Progress Manager
// =============================================================================
// Adapted from functions/src/progressManager.ts but uses our own db reference
// instead of importing from ./index. Same Firestore field names so the
// frontend sees identical progress updates.

enum ProcessingStep {
  GEMINI_ANALYSIS = 'gemini_analysis',
  WHISPERX_ALIGNMENT = 'whisperx_alignment',
  ASSEMBLY = 'assembly',
  SAVING = 'saving',
  COMPLETE = 'complete',
  FAILED = 'failed',
}

const STEP_PERCENTAGES: Record<ProcessingStep, number> = {
  [ProcessingStep.GEMINI_ANALYSIS]: 20,
  [ProcessingStep.WHISPERX_ALIGNMENT]: 60,
  [ProcessingStep.ASSEMBLY]: 85,
  [ProcessingStep.SAVING]: 95,
  [ProcessingStep.COMPLETE]: 100,
  [ProcessingStep.FAILED]: 0,
};

const STEP_LABELS: Record<ProcessingStep, string> = {
  [ProcessingStep.GEMINI_ANALYSIS]: 'Analyzing with Gemini',
  [ProcessingStep.WHISPERX_ALIGNMENT]: 'Aligning Timestamps',
  [ProcessingStep.ASSEMBLY]: 'Assembling Results',
  [ProcessingStep.SAVING]: 'Saving',
  [ProcessingStep.COMPLETE]: 'Complete',
  [ProcessingStep.FAILED]: 'Failed',
};

interface ProgressTimeline {
  stepName: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

class ProgressManager {
  private timeline: ProgressTimeline[] = [];
  private stepStart = Date.now();

  constructor(private conversationId: string) {}

  async setStep(step: ProcessingStep, errorMessage?: string): Promise<void> {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    // Close previous step
    if (this.timeline.length > 0) {
      const prev = this.timeline[this.timeline.length - 1];
      prev.completedAt = nowIso;
      prev.durationMs = now - this.stepStart;
    }

    this.timeline.push({ stepName: step, startedAt: nowIso });
    this.stepStart = now;

    const category = step === ProcessingStep.COMPLETE ? 'success'
      : step === ProcessingStep.FAILED ? 'error'
      : 'active';

    try {
      await db.collection('conversations').doc(this.conversationId).update({
        processingProgress: {
          currentStep: step,
          percentComplete: STEP_PERCENTAGES[step],
          stepStartedAt: FieldValue.serverTimestamp(),
          stepMeta: {
            label: STEP_LABELS[step],
            category: errorMessage ? 'error' : category,
          },
          ...(errorMessage && { errorMessage }),
        },
        processingTimeline: this.timeline,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      // Progress updates are best-effort — don't kill the pipeline
      console.warn('[Progress] Failed to update (non-fatal):', err);
    }
  }

  async setFailed(errorMessage: string): Promise<void> {
    await this.setStep(ProcessingStep.FAILED, errorMessage);
  }
}

// =============================================================================
// Helpers
// =============================================================================

async function getFfmpegPath(): Promise<string> {
  const ffmpegInstaller = await import('@ffmpeg-installer/ffmpeg');
  return ffmpegInstaller.default.path;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout: ${label} exceeded ${timeoutMs / 1000}s limit`));
    }, timeoutMs);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Check if abort has been requested for this conversation.
 * Throws PipelineFatalError if abort flag is set.
 */
async function checkAbort(conversationId: string): Promise<void> {
  const doc = await db.collection('conversations').doc(conversationId).get();
  if (doc.exists && doc.data()?.abortRequested === true) {
    console.log('[Pipeline] Abort requested, stopping:', { conversationId });
    throw new PipelineFatalError(
      `Processing aborted by user for ${conversationId}`,
      'ABORTED',
      'download',
      false,
    );
  }
}

async function downloadMp3(
  storagePath: string,
  conversationId: string,
): Promise<string> {
  console.log(`[Pipeline] Downloading MP3: ${storagePath}`, { conversationId });

  // Cloud Run doesn't auto-discover the default bucket like Cloud Functions does.
  // FIREBASE_STORAGE_BUCKET must be set as an env var on the Cloud Run service.
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucketName) {
    throw new PipelineFatalError(
      'FIREBASE_STORAGE_BUCKET not set — cannot download audio',
      'STORAGE_ERROR',
      'download',
      false,
    );
  }
  const bucket = getStorage().bucket(bucketName);
  const file = bucket.file(storagePath);
  const [exists] = await file.exists();

  if (!exists) {
    throw new PipelineFatalError(
      `Audio file not found: ${storagePath}`,
      'STORAGE_ERROR',
      'download',
      false,
    );
  }

  const ext = path.extname(storagePath) || '.mp3';
  const tmpPath = path.join(os.tmpdir(), `orchestrator-${Date.now()}${ext}`);

  // node-fetch v2 (used by @google-cloud/storage via gaxios) has no socket
  // timeout and hangs indefinitely on large downloads from Cloud Run.
  // curl bypasses Node's HTTP stack entirely. See: nodejs-storage#687
  const { GoogleAuth } = await import('google-auth-library');
  const gAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const accessToken = await gAuth.getAccessToken();
  const encodedPath = encodeURIComponent(storagePath);
  const downloadUrl = `https://storage.googleapis.com/storage/v1/b/${bucketName}/o/${encodedPath}?alt=media`;

  const { execFileSync } = await import('child_process');
  execFileSync('curl', [
    '-sS', '--fail',
    '--http1.1',  // HTTP/2 streams reset prematurely on GCS large downloads
    '-o', tmpPath,
    '-H', `Authorization: Bearer ${accessToken}`,
    downloadUrl,
  ], { timeout: 120_000 });

  const stats = fs.statSync(tmpPath);
  console.log(`[Pipeline] Downloaded ${(stats.size / 1024 / 1024).toFixed(1)}MB`);
  return tmpPath;
}

async function splitIntoChunks(
  mp3Path: string,
  audioDurationMs: number,
  _conversationId: string,
): Promise<Array<{ chunkPath: string; chunkStartMs: number; chunkEndMs: number }>> {
  const durationSec = audioDurationMs / 1000;
  const numChunks = Math.ceil(durationSec / CHUNK_SEC);

  console.log(`[Pipeline] Splitting into ${numChunks} chunk(s)`);

  if (numChunks <= 1) {
    return [{ chunkPath: mp3Path, chunkStartMs: 0, chunkEndMs: audioDurationMs }];
  }

  const ffmpegPath = await getFfmpegPath();
  const chunks: Array<{ chunkPath: string; chunkStartMs: number; chunkEndMs: number }> = [];

  for (let i = 0; i < numChunks; i++) {
    const chunkStartSec = i * CHUNK_SEC;
    const chunkEndSec = Math.min((i + 1) * CHUNK_SEC, durationSec);
    const chunkPath = path.join(os.tmpdir(), `orchestrator-chunk-${i}-${Date.now()}.mp3`);

    // Re-encode instead of stream copy. -c copy preserves VBR encoding
    // and can't seek to exact positions (nearest packet boundary only).
    // Re-encoding guarantees the chunk starts at exactly chunkStartSec,
    // and produces CBR output that WhisperX timestamps align to.
    // Matches the old chunked pipeline's proven ffmpeg args.
    await execFileAsync(ffmpegPath, [
      '-y', '-i', mp3Path,
      '-ss', String(chunkStartSec),
      '-t', String(chunkEndSec - chunkStartSec),
      '-acodec', 'libmp3lame',
      '-ar', '16000',    // 16kHz — optimal for speech/WhisperX
      '-ac', '1',         // mono — fine for speech, halves size
      '-ab', '64k',       // CBR 64kbps — browser seek is accurate
      chunkPath,
    ], { timeout: 300_000 });

    chunks.push({ chunkPath, chunkStartMs: chunkStartSec * 1000, chunkEndMs: chunkEndSec * 1000 });
  }

  return chunks;
}

// =============================================================================
// Main Pipeline
// =============================================================================

/**
 * Run the full Gemini hybrid pipeline.
 *
 * Faithful port of functions/src/newPipeline.ts::processWithNewPipeline
 * with structured errors and a more generous timeout budget.
 */
export async function runPipeline(
  conversationId: string,
  audioStoragePath: string,
  userId: string,
): Promise<PipelineResult> {
  const progress = new ProgressManager(conversationId);
  const pipelineStart = Date.now();

  console.log('[Pipeline] Starting Gemini hybrid pipeline', {
    conversationId,
    audioStoragePath,
    userId,
  });

  let mp3Path: string | null = null;
  const chunkPaths: string[] = [];

  const checkTimeout = (label: string) => {
    const elapsed = Date.now() - pipelineStart;
    if (elapsed > PIPELINE_TIMEOUT_MS) {
      throw new PipelineFatalError(
        `Pipeline timeout at "${label}" — ${(elapsed / 1000).toFixed(0)}s elapsed`,
        'GEMINI_TIMEOUT',
        'gemini_analysis',
        true,
      );
    }
  };

  try {
    // =======================================================================
    // Step 1: Gemini 3 Flash — diarization + content analysis
    // =======================================================================
    console.log(`[Pipeline] Step 1a: writing progress to Firestore...`);
    const t0 = Date.now();
    await progress.setStep(ProcessingStep.GEMINI_ANALYSIS);
    console.log(`[Pipeline] Step 1b: progress written (${Date.now() - t0}ms), checking abort...`);
    const t1 = Date.now();
    await checkAbort(conversationId);
    console.log(`[Pipeline] Step 1c: abort check done (${Date.now() - t1}ms), calling Gemini...`);

    const geminiResult: GeminiPipelineResult = await processWithGemini3Flash(
      audioStoragePath,
      { conversationId },
    );

    console.log(`[Pipeline] Gemini complete: ${geminiResult.speakers.length} speakers, ${geminiResult.segments.length} segments`);

    if (geminiResult.speakers.length === 0) {
      throw new PipelineFatalError(
        'Gemini returned zero speakers',
        'GEMINI_PARSE_FAILED',
        'gemini_analysis',
        true,
      );
    }

    if (geminiResult.segments.length === 0) {
      throw new PipelineFatalError(
        'Gemini returned zero segments',
        'GEMINI_PARSE_FAILED',
        'gemini_analysis',
        true,
      );
    }

    checkTimeout('after Gemini analysis');

    // =======================================================================
    // Step 2: Download MP3 for WhisperX chunking + create playback file
    // =======================================================================
    mp3Path = await downloadMp3(audioStoragePath, conversationId);
    const durationSec = await getAudioDuration(mp3Path);
    const audioDurationMs = Math.round(durationSec * 1000);

    console.log(`[Pipeline] Audio: ${(audioDurationMs / 1000 / 60).toFixed(1)} min`);

    // Re-encode the full audio to CBR MP3 for browser playback.
    // VBR MP3 files have wildly inaccurate seek-by-byte-offset in browsers,
    // causing click-to-play to land 5-10s away from the target. CBR with
    // a proper Xing header fixes this. ~2-3s encoding time is worth it.
    const ffmpegPath = await getFfmpegPath();
    const playbackPath = path.join(os.tmpdir(), `playback-${conversationId}-${Date.now()}.mp3`);
    await execFileAsync(ffmpegPath, [
      '-y', '-i', mp3Path,
      '-acodec', 'libmp3lame',
      '-ab', '128k',     // CBR 128kbps — good quality for playback
      '-ar', '44100',    // Keep original sample rate for playback quality
      '-ac', '2',        // Keep stereo for playback
      playbackPath,
    ], { timeout: 300_000 });

    // Upload playback file alongside the original
    const playbackStoragePath = audioStoragePath.replace(/\.[^.]+$/, '_playback.mp3');
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET!;
    const bucket = getStorage().bucket(bucketName);
    await bucket.upload(playbackPath, {
      destination: playbackStoragePath,
      metadata: { contentType: 'audio/mpeg' },
    });
    // Clean up temp file immediately
    try { fs.unlinkSync(playbackPath); } catch { /* best-effort */ }
    console.log(`[Pipeline] Playback CBR MP3 uploaded: ${playbackStoragePath}`);

    // =======================================================================
    // Step 3: WhisperX alignment — chunk by chunk
    // =======================================================================
    await progress.setStep(ProcessingStep.WHISPERX_ALIGNMENT);
    await checkAbort(conversationId);

    const whisperServiceUrl = process.env.WHISPER_SERVICE_URL;
    if (!whisperServiceUrl) {
      throw new PipelineFatalError(
        'WHISPER_SERVICE_URL not set',
        'WHISPERX_UNAVAILABLE',
        'whisperx_timestamps',
        false,
      );
    }

    const chunks = await splitIntoChunks(mp3Path, audioDurationMs, conversationId);
    for (const chunk of chunks) {
      if (chunk.chunkPath !== mp3Path) {
        chunkPaths.push(chunk.chunkPath);
      }
    }

    // Scale Gemini timestamps to real audio time.
    // Use Math.max across all endMs — last segment isn't always the longest.
    const geminiLastMs = Math.max(...geminiResult.segments.map(s => s.endMs));
    const scale = audioDurationMs / geminiLastMs;

    const allAlignedSegments: AlignedSegment[] = [];

    for (const { chunkPath, chunkStartMs, chunkEndMs } of chunks) {
      const chunkLabel = `chunk ${chunkStartMs / 1000}s–${chunkEndMs / 1000}s`;

      checkTimeout(`before ${chunkLabel}`);
      await checkAbort(conversationId);

      // Any-overlap assignment: include Gemini segments that overlap this chunk at all
      // (not just midpoint-in-chunk). Avoids dropping cross-boundary segments.
      const chunkGeminiSegs = geminiResult.segments.filter(s => {
        const scaledStart = s.startMs * scale;
        const scaledEnd = s.endMs * scale;
        return scaledStart < chunkEndMs && scaledEnd > chunkStartMs;
      });

      if (chunkGeminiSegs.length === 0) {
        console.log(`[Pipeline] No segments for ${chunkLabel}, skipping`);
        continue;
      }

      // Scale Gemini segments to chunk-local time for speaker assignment
      const localGeminiSegs = chunkGeminiSegs.map(s => ({
        speaker: s.speaker,
        startMs: Math.max(0, Math.round(s.startMs * scale - chunkStartMs)),
        endMs: Math.round(s.endMs * scale - chunkStartMs),
      }));

      const chunkBuffer = fs.readFileSync(chunkPath);
      const chunkBase64 = chunkBuffer.toString('base64');

      // Hard fail if WhisperX is unreachable or returns nothing — no fallback.
      // Drifted Gemini timestamps in the output would silently corrupt sync.
      const rawWords = await withTimeout(
        getWhisperXWords(chunkBase64, whisperServiceUrl),
        CHUNK_ALIGNMENT_TIMEOUT_MS,
        `whisperx ${chunkLabel}`,
      );

      if (!rawWords || rawWords.length === 0) {
        throw new PipelineFatalError(
          `WhisperX returned no words for ${chunkLabel} — cannot assign speakers`,
          'WHISPERX_UNAVAILABLE',
          'whisperx_timestamps',
          false,
        );
      }

      // WhisperX words are already chunk-local (each chunk is a separate audio
      // file starting at 0s), so no offset needed here.
      const chunkSegments = assignSpeakersToWords(rawWords, localGeminiSegs);

      console.log(`[Pipeline] ${chunkLabel}: ${chunkSegments.length} segments from ${rawWords.length} words`);

      // Offset chunk-local timestamps back to global audio time
      for (const seg of chunkSegments) {
        allAlignedSegments.push({
          speakerId: seg.speakerId,
          text: seg.text,
          startMs: seg.startMs + chunkStartMs,
          endMs: seg.endMs + chunkStartMs,
        });
      }
    }

    // =======================================================================
    // Step 3.5: Quality gates
    // =======================================================================
    checkTimeout('after alignment');

    if (allAlignedSegments.length < geminiResult.segments.length * 0.5) {
      throw new PipelineFatalError(
        `Aligned segments (${allAlignedSegments.length}) dropped below 50% of Gemini segments (${geminiResult.segments.length})`,
        'QUALITY_GATE_FAILED',
        'quality_gates',
        true,
      );
    }

    // =======================================================================
    // Step 4: Assembly
    // =======================================================================
    await progress.setStep(ProcessingStep.ASSEMBLY);

    const assembled = assembleFirestoreData(geminiResult, allAlignedSegments, audioDurationMs);

    // =======================================================================
    // Step 5: Persist to Firestore
    // =======================================================================
    await progress.setStep(ProcessingStep.SAVING);

    await db.collection('conversations').doc(conversationId).update({
      status: 'complete',
      segments: assembled.segments,
      speakers: assembled.speakers,
      terms: assembled.terms,
      termOccurrences: assembled.termOccurrences,
      topics: assembled.topics,
      people: assembled.people,
      durationMs: assembled.durationMs,
      // Tells the client that timestamps are WhisperX-accurate and
      // drift correction should NOT be applied on top of them.
      alignmentStatus: 'aligned',
      // CBR playback file for accurate browser seeking
      playbackAudioPath: playbackStoragePath,
      processingPipeline: 'gemini_hybrid',
      pipelineVersion: 'gemini_hybrid',
      updatedAt: FieldValue.serverTimestamp(),
    });

    await progress.setStep(ProcessingStep.COMPLETE);

    console.log(`[Pipeline] Complete: ${Object.keys(assembled.speakers).length} speakers, ${assembled.segments.length} segments`);

    return {
      segments: assembled.segments.length,
      speakers: Object.keys(assembled.speakers).length,
      durationMs: assembled.durationMs,
    };

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Pipeline] Failed: ${errMsg}`);

    // Write structured failure to Firestore so the frontend shows the right error
    const structuredError: StructuredError = (err instanceof PipelineFatalError)
      ? err.structured
      : { code: 'UNKNOWN', stage: 'download', message: errMsg, retryable: false };

    // Handle abort specially — it's not a failure, it's a user action
    if (structuredError.code === 'ABORTED') {
      await db.collection('conversations').doc(conversationId).update({
        status: 'aborted',
        processingError: structuredError,
        updatedAt: FieldValue.serverTimestamp(),
      }).catch(writeErr => console.error('[Pipeline] Failed to write abort status:', writeErr));
    } else {
      await db.collection('conversations').doc(conversationId).update({
        status: 'failed',
        processingError: structuredError,
        updatedAt: FieldValue.serverTimestamp(),
      }).catch(writeErr => console.error('[Pipeline] Failed to write error status:', writeErr));
    }

    await progress.setFailed(errMsg).catch(() => {});
    throw err;

  } finally {
    for (const chunkPath of chunkPaths) {
      try { if (fs.existsSync(chunkPath)) fs.unlinkSync(chunkPath); } catch { /* cleanup is best-effort */ }
    }
    if (mp3Path) {
      try { if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path); } catch { /* cleanup is best-effort */ }
    }
  }
}
