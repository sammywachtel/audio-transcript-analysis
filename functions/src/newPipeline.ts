/**
 * Gemini Hybrid Pipeline Orchestrator
 *
 * The production transcription pipeline. Composes Gemini 3 Flash
 * (diarization + content analysis) with WhisperX word-level timestamps
 * + speaker assignment — no HARDY alignment.
 *
 * Pipeline:
 *   1. Gemini 3 Flash (WAV) → speakers, segments (drifted ts), terms, topics, persons
 *   2. Download MP3 separately — processWithGemini3Flash cleaned up its own copy
 *   3. Split MP3 into 10-min chunks
 *   4. Per chunk: call WhisperX for Word[] → assignSpeakersToWords → offset to global time
 *   5. Quality gates — reject bad output before it reaches Firestore
 *   6. assembleFirestoreData() → final Firestore-ready payload
 *   7. Write to Firestore, clean up temp files
 *
 * Failure modes:
 *   - WhisperX returns empty/unusable words: hard fail (no fallback, write 'failed')
 *   - Fatal (HybridPipelineFatalError): write 'failed' to Firestore, abort
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getStorage } from 'firebase-admin/storage';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './index';
import { log } from './logger';
import {
  processWithGemini3Flash,
  assembleFirestoreData,
  GeminiPipelineResult,
  AlignedSegment,
} from './gemini3Pipeline';
import { getWhisperXWords } from './alignment';
import { assignSpeakersToWords } from './speakerAssignment';
import { getAudioDuration } from './audioUtils';
import { ProgressManager, ProcessingStep } from './progressManager';

// 10-minute chunks — matches WhisperX's sweet spot and the PoC's validated approach
const CHUNK_SEC = 600;

const execFileAsync = promisify(execFile);

// =============================================================================
// Error Types
// =============================================================================

/**
 * Thrown when the hybrid pipeline hits a fatal failure — zero speakers,
 * zero segments, or pipeline-level timeout. Carries a machine-readable
 * `reason` field for structured logging.
 *
 * NOT thrown for chunk-level fallbacks or quality warnings — those degrade
 * gracefully within the hybrid pipeline itself.
 */
export class HybridPipelineFatalError extends Error {
  constructor(message: string, public readonly reason: string) {
    super(message);
    this.name = 'HybridPipelineFatalError';
  }
}

// =============================================================================
// Timeout Configuration
// =============================================================================

// 10-minute hard ceiling for the entire hybrid run. Must sit below the Cloud
// Function platform timeout so we get a chance to clean up before the rug
// gets pulled.
const PIPELINE_TIMEOUT_MS = 10 * 60 * 1000;

// 2-minute ceiling per WhisperX chunk. A 10-min chunk rarely takes more than
// 60s on the GPU service, so 120s gives headroom without letting a wedged
// call block the whole pipeline.
const CHUNK_ALIGNMENT_TIMEOUT_MS = 2 * 60 * 1000;

// =============================================================================
// Helpers
// =============================================================================

// Dynamic import wrapper: resolves at runtime in Cloud Functions, not at build time.
// Learned this the hard way — ffmpeg path doesn't exist on the build machine.
async function getFfmpegPath(): Promise<string> {
  const ffmpegInstaller = await import('@ffmpeg-installer/ffmpeg');
  return ffmpegInstaller.default.path;
}

/**
 * Race a promise against a timeout. The timer is cleaned up on both
 * success and failure so it doesn't keep the process alive.
 */
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

// =============================================================================
// Helper: Download MP3 from Storage
// =============================================================================

async function downloadMp3ForAlignment(
  storagePath: string,
  conversationId: string,
): Promise<string> {
  const ctx = { conversationId, stage: 'newPipeline-download' };
  log.info(`Downloading MP3 for WhisperX alignment: ${storagePath}`, ctx);

  const bucket = getStorage().bucket();
  const file = bucket.file(storagePath);

  const [exists] = await file.exists();
  if (!exists) {
    throw new Error(`Audio file not found in Storage: ${storagePath}`);
  }

  const tmpDir = os.tmpdir();
  const ext = path.extname(storagePath) || '.mp3';
  const tmpPath = path.join(tmpDir, `newpipeline-mp3-${Date.now()}${ext}`);

  await file.download({ destination: tmpPath });

  const stats = fs.statSync(tmpPath);
  log.info(`Downloaded ${(stats.size / 1024 / 1024).toFixed(1)}MB for alignment`, ctx);

  return tmpPath;
}

// =============================================================================
// Helper: Split MP3 into fixed-length chunks via ffmpeg
// =============================================================================

async function splitIntoChunks(
  mp3Path: string,
  audioDurationMs: number,
  conversationId: string,
): Promise<Array<{ chunkPath: string; chunkStartMs: number; chunkEndMs: number }>> {
  const ctx = { conversationId, stage: 'newPipeline-split' };
  const durationSec = audioDurationMs / 1000;
  const numChunks = Math.ceil(durationSec / CHUNK_SEC);

  log.info(`Splitting into ${numChunks} chunk(s) (${CHUNK_SEC}s each)`, ctx);

  // Single chunk — no splitting needed, just return the source file reference
  if (numChunks <= 1) {
    return [{
      chunkPath: mp3Path,
      chunkStartMs: 0,
      chunkEndMs: audioDurationMs,
    }];
  }

  const ffmpegPath = await getFfmpegPath();
  const chunks: Array<{ chunkPath: string; chunkStartMs: number; chunkEndMs: number }> = [];

  for (let i = 0; i < numChunks; i++) {
    const chunkStartSec = i * CHUNK_SEC;
    const chunkEndSec = Math.min((i + 1) * CHUNK_SEC, durationSec);
    const chunkPath = path.join(os.tmpdir(), `newpipeline-chunk-${i}-${Date.now()}.mp3`);

    // Re-encode instead of stream copy — -c copy can't seek to exact
    // positions on VBR MP3, causing timestamp drift in downstream output.
    // CBR 16kHz mono matches the old pipeline's proven ffmpeg args.
    await execFileAsync(ffmpegPath, [
      '-y', '-i', mp3Path,
      '-ss', String(chunkStartSec),
      '-t', String(chunkEndSec - chunkStartSec),
      '-acodec', 'libmp3lame',
      '-ar', '16000',
      '-ac', '1',
      '-ab', '64k',
      chunkPath,
    ], { timeout: 300_000 });

    chunks.push({
      chunkPath,
      chunkStartMs: chunkStartSec * 1000,
      chunkEndMs: chunkEndSec * 1000,
    });

    log.info(`Chunk ${i + 1}/${numChunks}: ${(fs.statSync(chunkPath).size / 1024 / 1024).toFixed(1)}MB`, ctx);
  }

  return chunks;
}

// =============================================================================
// Main Orchestrator
// =============================================================================

/**
 * Process audio with the Gemini hybrid pipeline.
 *
 * This is the sole production transcription path — called directly from
 * transcribeAudio for every upload. Fatal errors write 'failed' to
 * Firestore and propagate to the caller.
 *
 * @param conversationId - Firestore conversation document ID
 * @param audioStoragePath - Firebase Storage path to the uploaded audio file
 * @param userId - Owner's Firebase UID (for logging context)
 */
export async function processWithNewPipeline(
  conversationId: string,
  audioStoragePath: string,
  userId: string,
): Promise<void> {
  const ctx = { conversationId, stage: 'newPipeline' };
  const progress = new ProgressManager(conversationId);
  const pipelineStart = Date.now();

  log.info(`Starting Gemini hybrid pipeline`, { ...ctx, audioStoragePath, userId });

  // Temp file paths tracked here so finally{} can clean up regardless of which step blew up
  let mp3Path: string | null = null;
  const chunkPaths: string[] = [];

  // Checks elapsed time against the pipeline ceiling. Called at orchestration
  // boundaries so we bail before starting expensive work that would get killed
  // mid-flight by the Cloud Function timeout anyway.
  const checkPipelineTimeout = (label: string) => {
    const elapsed = Date.now() - pipelineStart;
    if (elapsed > PIPELINE_TIMEOUT_MS) {
      throw new HybridPipelineFatalError(
        `Pipeline timeout at "${label}" — ${(elapsed / 1000).toFixed(0)}s elapsed (limit: ${PIPELINE_TIMEOUT_MS / 1000}s)`,
        'pipeline_timeout',
      );
    }
  };

  try {
    // =========================================================================
    // Step 1: Gemini 3 Flash — diarization + content analysis
    // =========================================================================
    await progress.setStep(ProcessingStep.GEMINI_ANALYSIS);

    log.info('Running Gemini 3 Flash analysis (WAV upload)...', ctx);
    const geminiResult: GeminiPipelineResult = await processWithGemini3Flash(
      audioStoragePath,
      { conversationId },
    );

    log.info(
      `Gemini complete: ${geminiResult.speakers.length} speakers, ${geminiResult.segments.length} segments`,
      ctx,
    );

    // --- Quality gate: zero speakers ---
    if (geminiResult.speakers.length === 0) {
      throw new HybridPipelineFatalError(
        'Gemini returned zero speakers — cannot produce useful transcript',
        'zero_speakers',
      );
    }

    // --- Quality gate: zero segments ---
    if (geminiResult.segments.length === 0) {
      throw new HybridPipelineFatalError(
        'Gemini returned zero segments — nothing to align',
        'zero_segments',
      );
    }

    checkPipelineTimeout('after Gemini analysis');

    // =========================================================================
    // Step 2: Download MP3 for WhisperX chunking
    // (processWithGemini3Flash already cleaned up its own WAV + MP3 copies)
    // =========================================================================
    mp3Path = await downloadMp3ForAlignment(audioStoragePath, conversationId);

    // getAudioDuration takes a file path and returns seconds
    const durationSec = await getAudioDuration(mp3Path);
    const audioDurationMs = Math.round(durationSec * 1000);

    log.info(`Audio duration: ${(audioDurationMs / 1000 / 60).toFixed(1)} min`, ctx);

    // =========================================================================
    // Step 3: WhisperX alignment — chunk-by-chunk
    // =========================================================================
    await progress.setStep(ProcessingStep.WHISPERX_ALIGNMENT);

    // WhisperX service URL comes from Firebase Secrets at runtime
    const whisperServiceUrl = process.env.WHISPER_SERVICE_URL;
    if (!whisperServiceUrl) {
      throw new Error('WHISPER_SERVICE_URL not set in environment');
    }

    const chunks = await splitIntoChunks(mp3Path, audioDurationMs, conversationId);

    // Track which chunk paths need cleanup (exclude mp3Path itself — cleaned separately)
    for (const chunk of chunks) {
      if (chunk.chunkPath !== mp3Path) {
        chunkPaths.push(chunk.chunkPath);
      }
    }

    // Gemini's timestamps are drifted (typically ~1.6x slow). Scale factor maps
    // Gemini-time to real-audio-time for chunk overlap filtering.
    // Use Math.max across all endMs — last segment isn't always the longest.
    const geminiLastMs = Math.max(...geminiResult.segments.map(s => s.endMs));
    const scale = audioDurationMs / geminiLastMs;

    log.info(`Timestamp scale factor: ${scale.toFixed(3)} (Gemini last: ${geminiLastMs}ms, real: ${audioDurationMs}ms)`, ctx);

    const allAlignedSegments: AlignedSegment[] = [];

    for (const { chunkPath, chunkStartMs, chunkEndMs } of chunks) {
      const chunkLabel = `chunk ${chunkStartMs / 1000}s–${chunkEndMs / 1000}s`;

      checkPipelineTimeout(`before ${chunkLabel}`);

      // Any-overlap assignment: include Gemini segments that overlap this chunk at all
      // (not just midpoint-in-chunk). Avoids dropping cross-boundary segments.
      const chunkGeminiSegs = geminiResult.segments.filter(s => {
        const scaledStart = s.startMs * scale;
        const scaledEnd = s.endMs * scale;
        return scaledStart < chunkEndMs && scaledEnd > chunkStartMs;
      });

      if (chunkGeminiSegs.length === 0) {
        log.info(`No Gemini segments for ${chunkLabel}, skipping`, ctx);
        continue;
      }

      log.info(`${chunkLabel}: ${chunkGeminiSegs.length} Gemini segments → WhisperX word timestamps`, ctx);

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
        throw new HybridPipelineFatalError(
          `WhisperX returned no words for ${chunkLabel} — cannot assign speakers`,
          'whisperx_empty',
        );
      }

      // WhisperX words are already chunk-local (each chunk is a separate audio
      // file starting at 0s), so no offset needed here.
      const chunkSegments = assignSpeakersToWords(rawWords, localGeminiSegs);

      log.info(`${chunkLabel}: ${chunkSegments.length} segments from ${rawWords.length} words`, ctx);

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

    log.info(`Alignment complete: ${allAlignedSegments.length} total segments`, ctx);

    // =========================================================================
    // Step 3.5: Quality gates — catch bad output before it reaches Firestore
    // =========================================================================

    checkPipelineTimeout('after alignment');

    // Gate: aligned segment count dropped too far below Gemini's output.
    // WhisperX returning words but assignSpeakersToWords producing nothing
    // would be suspicious — 50% threshold catches silent data loss.
    if (allAlignedSegments.length < geminiResult.segments.length * 0.5) {
      throw new HybridPipelineFatalError(
        `Aligned segments (${allAlignedSegments.length}) dropped below 50% of ` +
        `Gemini segments (${geminiResult.segments.length}) — output too degraded`,
        'low_segment_count',
      );
    }

    // =========================================================================
    // Step 4: Assembly — convert to Firestore schema
    // =========================================================================
    await progress.setStep(ProcessingStep.ASSEMBLY);

    const assembled = assembleFirestoreData(geminiResult, allAlignedSegments, audioDurationMs);

    log.info(
      `Assembled: ${Object.keys(assembled.speakers).length} speakers, ${assembled.segments.length} segments, ${assembled.topics.length} topics`,
      ctx,
    );

    // =========================================================================
    // Step 5: Persist to Firestore
    // =========================================================================
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
      processingPipeline: 'gemini_hybrid',
      pipelineVersion: 'gemini_hybrid',
      updatedAt: FieldValue.serverTimestamp(),
    });

    log.info(`Firestore write complete (status: complete)`, ctx);

    await progress.setStep(ProcessingStep.COMPLETE);
    log.info('Gemini hybrid pipeline done', ctx);

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`Pipeline failed: ${errMsg}`, ctx);

    // No legacy fallback — every failure writes 'failed' to Firestore so the
    // frontend can show an error state and the user can retry.
    await db.collection('conversations').doc(conversationId).update({
      status: 'failed',
      processingError: errMsg,
      updatedAt: FieldValue.serverTimestamp(),
    }).catch((writeErr) => {
      log.error(`Failed to write error status to Firestore: ${writeErr}`, ctx);
    });

    await progress.setFailed(errMsg).catch(() => {/* progress update failure is non-fatal */});
    throw err;

  } finally {
    // Clean up chunk files first (these are the small pieces)
    for (const chunkPath of chunkPaths) {
      try {
        if (fs.existsSync(chunkPath)) fs.unlinkSync(chunkPath);
      } catch (cleanupErr) {
        log.warn(`Failed to delete chunk file: ${chunkPath}`, ctx);
      }
    }

    // Clean up main MP3 download
    if (mp3Path) {
      try {
        if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
      } catch (cleanupErr) {
        log.warn(`Failed to delete MP3 temp file: ${mp3Path}`, ctx);
      }
    }
  }
}
