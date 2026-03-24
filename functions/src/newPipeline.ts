/**
 * Gemini Hybrid Pipeline Orchestrator
 *
 * The production transcription pipeline. Composes Gemini 3 Flash
 * (diarization + content analysis) with WhisperX (precise word-level
 * timestamps) via HARDY alignment.
 *
 * Pipeline:
 *   1. Gemini 3 Flash (WAV) → speakers, segments (drifted ts), terms, topics, persons
 *   2. Download MP3 separately — processWithGemini3Flash cleaned up its own copy
 *   3. Split MP3 into 10-min chunks
 *   4. Per chunk: scale Gemini timestamps → HARDY alignment → offset back to global time
 *   5. Quality gates — reject bad output before it reaches Firestore
 *   6. assembleFirestoreData() → final Firestore-ready payload
 *   7. Write to Firestore, clean up temp files
 *
 * Failure modes (in escalating severity):
 *   - Chunk alignment fallback: use scaled Gemini timestamps, continue
 *   - Quality warning (needs_review): persist data but flag for human review
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
import { alignTimestamps } from './alignment';
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

// 2-minute ceiling per HARDY alignment chunk. WhisperX + HARDY on a 10-min
// chunk rarely exceeds 60s, so 120s gives generous headroom without letting
// a wedged call block the whole pipeline.
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

    // Stream copy is fine here — WhisperX doesn't care about VBR seeking artifacts
    // and we want speed over perfect timestamps (HARDY corrects those anyway)
    await execFileAsync(ffmpegPath, [
      '-y', '-i', mp3Path,
      '-ss', String(chunkStartSec),
      '-t', String(chunkEndSec - chunkStartSec),
      '-c', 'copy',
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
    // Gemini-time to real-audio-time for chunk assignment and local-ts calculation.
    const geminiLastMs = geminiResult.segments[geminiResult.segments.length - 1].endMs;
    const scale = audioDurationMs / geminiLastMs;

    log.info(`Timestamp scale factor: ${scale.toFixed(3)} (Gemini last: ${geminiLastMs}ms, real: ${audioDurationMs}ms)`, ctx);

    const allAlignedSegments: AlignedSegment[] = [];

    // Per-chunk quality tracking for post-loop quality gates
    let fallbackChunkCount = 0;
    let lowConfidenceChunkCount = 0;
    let totalChunksProcessed = 0;

    for (const { chunkPath, chunkStartMs, chunkEndMs } of chunks) {
      const chunkLabel = `chunk ${chunkStartMs / 1000}s–${chunkEndMs / 1000}s`;

      checkPipelineTimeout(`before ${chunkLabel}`);

      // Filter Gemini segments whose SCALED midpoint falls within this chunk's time range.
      // Midpoint assignment avoids edge-case double-counting at chunk boundaries.
      const chunkGeminiSegs = geminiResult.segments.filter(s => {
        const scaledMid = ((s.startMs + s.endMs) / 2) * scale;
        return scaledMid >= chunkStartMs && scaledMid < chunkEndMs;
      });

      if (chunkGeminiSegs.length === 0) {
        log.info(`No Gemini segments for ${chunkLabel}, skipping`, ctx);
        continue;
      }

      log.info(`${chunkLabel}: ${chunkGeminiSegs.length} Gemini segments → HARDY alignment`, ctx);

      // Convert to chunk-local timestamps (subtract chunkStartMs after scaling)
      const localSegs = chunkGeminiSegs.map(s => ({
        speakerId: s.speaker,
        text: s.text,
        startMs: Math.max(0, Math.round(s.startMs * scale - chunkStartMs)),
        endMs: Math.round(s.endMs * scale - chunkStartMs),
      }));

      const chunkBuffer = fs.readFileSync(chunkPath);

      try {
        // Wrap each chunk alignment with a 2-minute timeout so a wedged
        // WhisperX call doesn't blow the entire pipeline budget.
        const result = await withTimeout(
          alignTimestamps(chunkBuffer, localSegs, whisperServiceUrl),
          CHUNK_ALIGNMENT_TIMEOUT_MS,
          `alignment ${chunkLabel}`,
        );

        if (result.alignmentStatus === 'aligned') {
          // Offset aligned timestamps back to global audio time
          for (const seg of result.segments) {
            allAlignedSegments.push({
              speakerId: seg.speakerId,
              text: seg.text,
              startMs: seg.startMs + chunkStartMs,
              endMs: seg.endMs + chunkStartMs,
            });
          }
          log.info(`${chunkLabel}: aligned ${result.segments.length} segments`, ctx);

          // Track low-confidence chunks for the post-loop quality gate
          if (result.avgConfidence !== undefined && result.avgConfidence < 0.5) {
            lowConfidenceChunkCount++;
            log.warn(
              `${chunkLabel}: low HARDY confidence ${result.avgConfidence.toFixed(3)}`,
              ctx,
            );
          }
        } else {
          // HARDY fell back — use scaled Gemini timestamps as best-effort
          fallbackChunkCount++;
          log.warn(`${chunkLabel}: alignment fallback — ${result.alignmentError}`, ctx);
          for (const seg of chunkGeminiSegs) {
            allAlignedSegments.push({
              speakerId: seg.speaker,
              text: seg.text,
              startMs: Math.round(seg.startMs * scale),
              endMs: Math.round(seg.endMs * scale),
            });
          }
        }
      } catch (alignErr) {
        // Alignment threw entirely — still use scaled timestamps so we don't lose content.
        // Better to have drifted timestamps than missing segments.
        fallbackChunkCount++;
        const errMsg = alignErr instanceof Error ? alignErr.message : String(alignErr);
        log.warn(`${chunkLabel}: alignment threw, using scaled fallback — ${errMsg}`, ctx);
        for (const seg of chunkGeminiSegs) {
          allAlignedSegments.push({
            speakerId: seg.speaker,
            text: seg.text,
            startMs: Math.round(seg.startMs * scale),
            endMs: Math.round(seg.endMs * scale),
          });
        }
      }

      totalChunksProcessed++;
    }

    log.info(
      `Alignment complete: ${allAlignedSegments.length} total segments ` +
      `(${fallbackChunkCount} fallback chunks, ${lowConfidenceChunkCount} low-confidence chunks)`,
      ctx,
    );

    // =========================================================================
    // Step 3.5: Quality gates — catch bad output before it reaches Firestore
    // =========================================================================

    checkPipelineTimeout('after alignment');

    // Gate: aligned segment count dropped too far below Gemini's output.
    // This catches scenarios where HARDY ate segments silently or chunks
    // produced no output. 50% is generous — anything below means we lost
    // too much content to be useful.
    if (allAlignedSegments.length < geminiResult.segments.length * 0.5) {
      throw new HybridPipelineFatalError(
        `Aligned segments (${allAlignedSegments.length}) dropped below 50% of ` +
        `Gemini segments (${geminiResult.segments.length}) — output too degraded`,
        'low_segment_count',
      );
    }

    // Gate: warn if low-confidence HARDY output on >50% of chunks.
    // We still persist data (it's usable, just noisy) but flag it for review.
    const needsReview = totalChunksProcessed > 0 &&
      lowConfidenceChunkCount > totalChunksProcessed * 0.5;

    if (needsReview) {
      log.warn(
        `Quality gate: ${lowConfidenceChunkCount}/${totalChunksProcessed} chunks ` +
        `had low HARDY confidence — marking needs_review`,
        ctx,
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

    const status = needsReview ? 'needs_review' : 'complete';

    await db.collection('conversations').doc(conversationId).update({
      status,
      segments: assembled.segments,
      speakers: assembled.speakers,
      terms: assembled.terms,
      termOccurrences: assembled.termOccurrences,
      topics: assembled.topics,
      people: assembled.people,
      durationMs: assembled.durationMs,
      processingPipeline: 'gemini_hybrid',
      pipelineVersion: 'gemini_hybrid',
      // Metadata for downstream consumers to distinguish outcome quality
      ...(needsReview && {
        processingError: `Low HARDY confidence on ${lowConfidenceChunkCount}/${totalChunksProcessed} chunks`,
      }),
      ...(fallbackChunkCount > 0 && {
        alignmentStatus: 'fallback',
      }),
      updatedAt: FieldValue.serverTimestamp(),
    });

    log.info(`Firestore write complete (status: ${status})`, ctx);

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
