/**
 * Audio Chunking Module
 *
 * Splits large audio files into overlapping chunks for processing within
 * Cloud Function time limits. Uses ffmpeg for silence detection to find
 * natural break points, avoiding mid-word splits.
 *
 * The chunking flow:
 * 1. Detect silence gaps in audio via ffmpeg silencedetect filter
 * 2. Build chunk boundaries targeting 10-15 min segments at silence points
 * 3. Extract chunks with 5-10s overlap for seamless downstream merging
 * 4. Upload chunks to Storage with metadata for later deduplication
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
const execFileAsync = promisify(execFile);

// Dynamic import helper to avoid build-time binary resolution
async function getFfmpegPath(): Promise<string> {
  const ffmpegInstaller = await import('@ffmpeg-installer/ffmpeg');
  return ffmpegInstaller.default.path;
}

// =============================================================================
// Types
// =============================================================================

/**
 * A silence interval detected in the audio.
 * Represents a pause between speech segments.
 */
export interface SilenceGap {
  /** Start of silence in seconds */
  startSeconds: number;
  /** End of silence in seconds */
  endSeconds: number;
  /** Duration of silence in seconds */
  durationSeconds: number;
}

/**
 * Metadata for a single audio chunk.
 * Contains everything needed for downstream processing and final merge.
 */
export interface ChunkMetadata {
  /** Zero-indexed chunk number */
  chunkIndex: number;
  /** Total number of chunks for this file */
  totalChunks: number;
  /** Start time in the original audio (milliseconds) */
  startMs: number;
  /** End time in the original audio (milliseconds) */
  endMs: number;
  /** Overlap with previous chunk (milliseconds), 0 for first chunk */
  overlapBeforeMs: number;
  /** Overlap with next chunk (milliseconds), 0 for last chunk */
  overlapAfterMs: number;
  /** Storage path for this chunk */
  chunkStoragePath: string;
  /** Storage path of the original file */
  originalStoragePath: string;
  /** Duration of this chunk in milliseconds */
  durationMs: number;
}

/**
 * Result of chunking an audio file.
 */
export interface ChunkingResult {
  /** Whether chunking was needed (false if file is short enough) */
  chunked: boolean;
  /** Chunk metadata array (empty if not chunked, original file is used directly) */
  chunks: ChunkMetadata[];
  /** Original audio duration in milliseconds */
  originalDurationMs: number;
  /** Original file storage path */
  originalStoragePath: string;
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Chunking parameters.
 * These balance Cloud Function timeouts with processing efficiency.
 */
export const CHUNK_CONFIG = {
  /** Target chunk duration (10 minutes) */
  TARGET_DURATION_SECONDS: 600,
  /** Maximum chunk duration (15 minutes) */
  MAX_DURATION_SECONDS: 900,
  /** Minimum chunk duration (2 minutes) - prevents tiny chunks */
  MIN_DURATION_SECONDS: 120,
  /** Overlap duration for seamless merging (5-10 seconds) */
  OVERLAP_SECONDS: 7,
  /** Silence detection noise threshold in dB */
  SILENCE_THRESHOLD_DB: -30,
  /** Minimum silence duration to consider as a break point (seconds) */
  SILENCE_MIN_DURATION: 0.5,
  /** Files under this duration don't need chunking (30 minutes) */
  CHUNKING_THRESHOLD_SECONDS: 1800,
  /** Files larger than this size need chunking regardless of duration (20MB) */
  CHUNKING_THRESHOLD_BYTES: 20 * 1024 * 1024,
};

// =============================================================================
// Silence Detection
// =============================================================================

/**
 * Detect silence gaps in an audio file using ffmpeg's silencedetect filter.
 *
 * Runs: ffmpeg -i <file> -af silencedetect=n=-30dB:d=0.5 -f null -
 * Parses stderr for silence_start/silence_end markers.
 *
 * @param audioFilePath - Path to audio file on local filesystem
 * @returns Array of silence gaps sorted by start time
 */
export async function detectSilenceGaps(audioFilePath: string): Promise<SilenceGap[]> {
  console.log('[Chunking] Detecting silence gaps...', { audioFilePath });

  const ffmpegPath = await getFfmpegPath();
  const filterArg = `silencedetect=n=${CHUNK_CONFIG.SILENCE_THRESHOLD_DB}dB:d=${CHUNK_CONFIG.SILENCE_MIN_DURATION}`;

  try {
    // ffmpeg writes silencedetect output to stderr
    // The -f null - discards actual output, we only want the filter logs
    const { stderr } = await execFileAsync(ffmpegPath, [
      '-i', audioFilePath,
      '-af', filterArg,
      '-f', 'null',
      '-'
    ], {
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for long files
    });

    const silenceGaps = parseSilenceDetectOutput(stderr);

    console.log('[Chunking] Silence detection complete:', {
      gapsFound: silenceGaps.length,
      firstGap: silenceGaps[0] ?? null,
      lastGap: silenceGaps[silenceGaps.length - 1] ?? null,
    });

    return silenceGaps;

  } catch (error) {
    // ffmpeg returns non-zero for some audio formats but still produces output
    // Check if we got useful stderr before throwing
    const execError = error as { stderr?: string };
    if (execError.stderr) {
      const silenceGaps = parseSilenceDetectOutput(execError.stderr);
      if (silenceGaps.length > 0) {
        console.log('[Chunking] Extracted silence gaps despite ffmpeg exit code:', {
          gapsFound: silenceGaps.length,
        });
        return silenceGaps;
      }
    }

    console.error('[Chunking] Silence detection failed:', error);
    throw new Error(`Silence detection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Parse ffmpeg silencedetect filter output.
 *
 * Example output lines:
 *   [silencedetect @ 0x...] silence_start: 10.234
 *   [silencedetect @ 0x...] silence_end: 10.789 | silence_duration: 0.555
 *
 * @param stderr - Raw ffmpeg stderr output
 * @returns Parsed silence gaps
 */
function parseSilenceDetectOutput(stderr: string): SilenceGap[] {
  const silenceGaps: SilenceGap[] = [];

  // Match silence_start and silence_end lines
  const startRegex = /silence_start:\s*([\d.]+)/g;
  const endRegex = /silence_end:\s*([\d.]+)/g;

  const starts: number[] = [];
  const ends: number[] = [];

  let match;
  while ((match = startRegex.exec(stderr)) !== null) {
    starts.push(parseFloat(match[1]));
  }
  while ((match = endRegex.exec(stderr)) !== null) {
    ends.push(parseFloat(match[1]));
  }

  // Pair up starts and ends
  // Each silence_start should be followed by a silence_end
  const pairCount = Math.min(starts.length, ends.length);
  for (let i = 0; i < pairCount; i++) {
    const startSeconds = starts[i];
    const endSeconds = ends[i];

    // Sanity check: end should be after start
    if (endSeconds > startSeconds) {
      silenceGaps.push({
        startSeconds,
        endSeconds,
        durationSeconds: endSeconds - startSeconds,
      });
    }
  }

  // Sort by start time (should already be sorted, but be safe)
  silenceGaps.sort((a, b) => a.startSeconds - b.startSeconds);

  return silenceGaps;
}

/**
 * Get the total duration of an audio file in seconds.
 *
 * @param audioFilePath - Path to audio file on local filesystem
 * @returns Duration in seconds
 */
export async function getAudioDuration(audioFilePath: string): Promise<number> {
  const ffmpegPath = await getFfmpegPath();
  const ffprobePath = ffmpegPath.replace(/ffmpeg$/, 'ffprobe');

  try {
    // Use ffprobe to get duration
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      audioFilePath
    ]);

    const duration = parseFloat(stdout.trim());
    if (isNaN(duration)) {
      throw new Error(`Invalid duration value: ${stdout}`);
    }

    return duration;

  } catch (error) {
    // Fallback: use ffmpeg to get duration from its output
    console.warn('[Chunking] ffprobe failed, falling back to ffmpeg duration extraction');

    try {
      await execFileAsync(ffmpegPath, ['-i', audioFilePath], { maxBuffer: 1024 * 1024 });
    } catch (ffmpegError) {
      // ffmpeg returns error when no output specified, but prints file info to stderr
      const execError = ffmpegError as { stderr?: string };
      if (execError.stderr) {
        const durationMatch = /Duration: (\d+):(\d+):(\d+\.?\d*)/.exec(execError.stderr);
        if (durationMatch) {
          const hours = parseInt(durationMatch[1], 10);
          const minutes = parseInt(durationMatch[2], 10);
          const seconds = parseFloat(durationMatch[3]);
          return hours * 3600 + minutes * 60 + seconds;
        }
      }
    }

    throw new Error(`Failed to get audio duration: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// =============================================================================
// Chunk Boundary Calculation
// =============================================================================

/**
 * A proposed chunk boundary before overlap calculation.
 */
interface RawChunkBoundary {
  startSeconds: number;
  endSeconds: number;
}

/**
 * Calculate chunk boundaries from silence gaps.
 *
 * Strategy:
 * 1. Walk through the audio, accumulating duration
 * 2. When we approach target duration (600s), look for the next silence gap
 * 3. Snap chunk boundary to the silence gap (prefer end of silence for clean cuts)
 * 4. Ensure minimum duration (120s) is respected
 * 5. Cap at maximum duration (900s) even if no silence found
 *
 * @param totalDurationSeconds - Total audio duration
 * @param silenceGaps - Detected silence gaps in the audio
 * @returns Array of chunk boundaries (without overlap applied yet)
 */
export function calculateChunkBoundaries(
  totalDurationSeconds: number,
  silenceGaps: SilenceGap[]
): RawChunkBoundary[] {
  // If audio is short enough, no chunking needed
  if (totalDurationSeconds <= CHUNK_CONFIG.CHUNKING_THRESHOLD_SECONDS) {
    return [{
      startSeconds: 0,
      endSeconds: totalDurationSeconds,
    }];
  }

  const boundaries: RawChunkBoundary[] = [];
  let currentStart = 0;

  while (currentStart < totalDurationSeconds) {
    const remainingDuration = totalDurationSeconds - currentStart;

    // If remaining audio is short enough, make it the final chunk
    if (remainingDuration <= CHUNK_CONFIG.MAX_DURATION_SECONDS) {
      boundaries.push({
        startSeconds: currentStart,
        endSeconds: totalDurationSeconds,
      });
      break;
    }

    // Find ideal end point: target duration, snapped to silence
    const targetEnd = currentStart + CHUNK_CONFIG.TARGET_DURATION_SECONDS;
    const maxEnd = currentStart + CHUNK_CONFIG.MAX_DURATION_SECONDS;

    // Find silence gaps in the window [targetEnd - 60s, maxEnd]
    // This gives us flexibility to find a good break point
    const searchWindowStart = Math.max(currentStart + CHUNK_CONFIG.MIN_DURATION_SECONDS, targetEnd - 60);
    const candidateGaps = silenceGaps.filter(
      gap => gap.endSeconds >= searchWindowStart && gap.startSeconds <= maxEnd
    );

    let chunkEnd: number;

    if (candidateGaps.length > 0) {
      // Find the gap closest to target duration
      const targetGap = candidateGaps.reduce((best, gap) => {
        const gapMidpoint = (gap.startSeconds + gap.endSeconds) / 2;
        const bestMidpoint = (best.startSeconds + best.endSeconds) / 2;
        return Math.abs(gapMidpoint - targetEnd) < Math.abs(bestMidpoint - targetEnd) ? gap : best;
      });

      // Cut at the END of silence (so next chunk starts cleanly)
      chunkEnd = targetGap.endSeconds;
      console.log('[Chunking] Snapping to silence gap:', {
        chunkIndex: boundaries.length,
        silenceStart: targetGap.startSeconds,
        silenceEnd: targetGap.endSeconds,
        chunkEnd,
      });
    } else {
      // No silence found in window - cut at target duration
      // This is suboptimal but necessary to stay under time limits
      chunkEnd = Math.min(targetEnd, totalDurationSeconds);
      console.warn('[Chunking] No silence gap found, cutting at target duration:', {
        chunkIndex: boundaries.length,
        chunkEnd,
      });
    }

    boundaries.push({
      startSeconds: currentStart,
      endSeconds: chunkEnd,
    });

    currentStart = chunkEnd;
  }

  console.log('[Chunking] Calculated chunk boundaries:', {
    totalDurationSeconds,
    chunkCount: boundaries.length,
    boundaries: boundaries.map((b, i) => ({
      index: i,
      start: b.startSeconds.toFixed(2),
      end: b.endSeconds.toFixed(2),
      duration: (b.endSeconds - b.startSeconds).toFixed(2),
    })),
  });

  return boundaries;
}

/**
 * Apply overlap to chunk boundaries.
 *
 * Each chunk (except the first) starts a few seconds before its "official" start,
 * capturing overlap audio from the previous chunk. This ensures no words are cut
 * at chunk boundaries - downstream merge logic will deduplicate the overlap.
 *
 * @param boundaries - Raw chunk boundaries
 * @param totalDurationSeconds - Total audio duration
 * @returns Chunk boundaries with overlap windows noted
 */
export function applyOverlap(
  boundaries: RawChunkBoundary[],
  totalDurationSeconds: number
): ChunkMetadata[] {
  const overlap = CHUNK_CONFIG.OVERLAP_SECONDS;

  return boundaries.map((boundary, index) => {
    const isFirst = index === 0;
    const isLast = index === boundaries.length - 1;

    // Calculate actual extraction start (with overlap into previous chunk)
    const actualStartSeconds = isFirst
      ? boundary.startSeconds
      : Math.max(0, boundary.startSeconds - overlap);

    // Calculate actual extraction end (with overlap into next chunk)
    const actualEndSeconds = isLast
      ? boundary.endSeconds
      : Math.min(totalDurationSeconds, boundary.endSeconds + overlap);

    return {
      chunkIndex: index,
      totalChunks: boundaries.length,
      // Logical timestamps (what this chunk "represents" in the original)
      startMs: Math.floor(boundary.startSeconds * 1000),
      endMs: Math.floor(boundary.endSeconds * 1000),
      // Overlap info (how much extra audio is captured)
      overlapBeforeMs: isFirst ? 0 : Math.floor(overlap * 1000),
      overlapAfterMs: isLast ? 0 : Math.floor(overlap * 1000),
      // These will be filled in during extraction
      chunkStoragePath: '',
      originalStoragePath: '',
      // Duration of the EXTRACTED chunk (including overlaps)
      durationMs: Math.floor((actualEndSeconds - actualStartSeconds) * 1000),
    };
  });
}

// =============================================================================
// Chunk Extraction
// =============================================================================

/**
 * Extract a single chunk from the audio file.
 *
 * Uses ffmpeg with -ss (seek) and -to (end time) for efficient extraction.
 * The -c copy flag avoids re-encoding when possible.
 *
 * @param audioFilePath - Source audio file path
 * @param outputPath - Where to write the extracted chunk
 * @param startSeconds - Start time in source (with overlap applied)
 * @param endSeconds - End time in source (with overlap applied)
 */
export async function extractChunk(
  audioFilePath: string,
  outputPath: string,
  startSeconds: number,
  endSeconds: number
): Promise<void> {
  const ffmpegPath = await getFfmpegPath();

  console.log('[Chunking] Extracting chunk:', {
    source: audioFilePath,
    output: outputPath,
    startSeconds,
    endSeconds,
    durationSeconds: endSeconds - startSeconds,
  });

  // ALWAYS re-encode to ensure clean timestamps starting at 0.
  // Stream copy (-c copy) preserves original container timestamps which can cause
  // playback position to differ from byte-offset position, especially for YouTube
  // downloads and VBR MP3 files. Re-encoding is slower but guarantees accurate timestamps.
  //
  // Technical background: MP3 container timestamps are based on frame positions,
  // not sample counts. VBR files can have timestamp drift where the container says
  // "frame at 10.5s" but byte-position-based playback puts it at 10.7s. Browsers
  // typically use byte-position seeking, while WhisperX may use container timestamps.
  console.log('[Chunking] Re-encoding chunk for accurate timestamps...');

  await execFileAsync(ffmpegPath, [
    '-y',
    '-i', audioFilePath,
    '-ss', startSeconds.toString(), // Seek AFTER input = precise seeking
    '-t', (endSeconds - startSeconds).toString(),
    '-acodec', 'libmp3lame',        // Re-encode to MP3
    '-ar', '16000',                  // 16kHz sample rate (optimal for speech/WhisperX)
    '-ac', '1',                      // Mono (reduces size, fine for speech)
    '-ab', '64k',                    // 64kbps (sufficient for speech)
    outputPath
  ], {
    timeout: 300000, // 5 minute timeout for re-encoding
  });

  // Verify output exists and has content
  const stats = fs.statSync(outputPath);
  if (stats.size === 0) {
    throw new Error('Extracted chunk is empty');
  }

  console.log('[Chunking] Chunk extracted successfully:', {
    outputPath,
    sizeBytes: stats.size,
    sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
  });
}

// =============================================================================
// Playback Re-encoding (Seeking Fix)
// =============================================================================

/**
 * Re-encode audio file for clean playback seeking.
 *
 * MP3 files (especially VBR or downloaded from YouTube) often have imprecise
 * seeking because browsers estimate byte position from time using average
 * bitrate. Re-encoding creates fresh timestamps that start at exactly 0 and
 * increment predictably, which fixes seeking accuracy.
 *
 * Trade-offs:
 * - Adds ~10-30 seconds to upload processing time
 * - Creates consistent seeking behavior across all audio sources
 * - Uses CBR encoding for predictable byte-to-time mapping
 *
 * @param inputPath - Path to the original audio file
 * @param outputPath - Path for the re-encoded output (can be same as input to overwrite)
 */
export async function reencodeForPlayback(
  inputPath: string,
  outputPath: string
): Promise<{ originalSizeBytes: number; outputSizeBytes: number; durationMs: number; reencodeTimeMs: number }> {
  const ffmpegPath = await getFfmpegPath();
  const startTime = Date.now();

  const originalStats = fs.statSync(inputPath);
  const originalSizeBytes = originalStats.size;

  console.log('[Chunking] Re-encoding audio for playback (seeking fix)...', {
    inputPath,
    outputPath,
    originalSizeBytes,
    originalSizeMB: (originalSizeBytes / (1024 * 1024)).toFixed(2)
  });

  // Use a temp file if outputPath === inputPath (can't overwrite while reading)
  const needsTempFile = inputPath === outputPath;
  const actualOutputPath = needsTempFile
    ? outputPath.replace(/(\.[^.]+)$/, '-reencoded$1')
    : outputPath;

  try {
    // Re-encode with settings optimized for speech playback:
    // - CBR (constant bitrate) for predictable seeking
    // - Preserve original sample rate if higher than 16kHz for quality
    // - Stereo if original is stereo (some users may have stereo recordings)
    await execFileAsync(ffmpegPath, [
      '-y',
      '-i', inputPath,
      '-acodec', 'libmp3lame',    // Re-encode to MP3
      '-ab', '128k',               // 128kbps CBR - good quality for speech, predictable seeking
      '-ar', '44100',              // Standard sample rate for broad compatibility
      actualOutputPath
    ], {
      timeout: 600000, // 10 minute timeout for long files
    });

    // If we used a temp file, replace the original
    if (needsTempFile) {
      fs.renameSync(actualOutputPath, outputPath);
    }

    const outputStats = fs.statSync(outputPath);
    const outputSizeBytes = outputStats.size;

    // Get duration for logging
    const durationSeconds = await getAudioDuration(outputPath);
    const durationMs = Math.floor(durationSeconds * 1000);

    const reencodeTimeMs = Date.now() - startTime;

    console.log('[Chunking] Re-encoding complete:', {
      outputPath,
      originalSizeBytes,
      outputSizeBytes,
      sizeChange: `${((outputSizeBytes - originalSizeBytes) / originalSizeBytes * 100).toFixed(1)}%`,
      audioDurationMs: durationMs,
      audioDurationFormatted: `${Math.floor(durationMs / 60000)}:${((durationMs % 60000) / 1000).toFixed(0).padStart(2, '0')}`,
      reencodeTimeMs,
      reencodeTimeSec: (reencodeTimeMs / 1000).toFixed(1),
      realtimeRatio: (durationMs / reencodeTimeMs).toFixed(1) + 'x' // e.g., "45x" means 45min audio encoded in 1min
    });

    return { originalSizeBytes, outputSizeBytes, durationMs, reencodeTimeMs };
  } catch (error) {
    // Clean up temp file on error
    if (needsTempFile && fs.existsSync(actualOutputPath)) {
      fs.unlinkSync(actualOutputPath);
    }
    throw error;
  }
}

// =============================================================================
// Main Chunking Workflow
// =============================================================================

/**
 * Chunk an audio file if it exceeds the size threshold.
 *
 * This is the main entry point for the chunking module. It:
 * 1. Checks if chunking is needed based on duration
 * 2. Detects silence gaps for natural break points
 * 3. Calculates chunk boundaries with overlap
 * 4. Extracts each chunk to local temp files
 *
 * The caller is responsible for uploading chunks to Storage and
 * cleaning up temp files.
 *
 * @param audioFilePath - Path to the audio file on local filesystem
 * @param originalStoragePath - Storage path of the original file
 * @returns Chunking result with metadata and local chunk file paths
 */
export async function chunkAudioFile(
  audioFilePath: string,
  originalStoragePath: string
): Promise<{
  result: ChunkingResult;
  localChunkPaths: string[];
}> {
  console.log('[Chunking] Starting chunking analysis:', {
    audioFilePath,
    originalStoragePath,
  });

  // Get audio duration
  const durationSeconds = await getAudioDuration(audioFilePath);
  const durationMs = Math.floor(durationSeconds * 1000);

  // Get file size
  const fileSizeBytes = fs.statSync(audioFilePath).size;
  const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);

  // Determine if chunking is needed based on duration OR file size
  const exceedsDurationThreshold = durationSeconds > CHUNK_CONFIG.CHUNKING_THRESHOLD_SECONDS;
  const exceedsSizeThreshold = fileSizeBytes > CHUNK_CONFIG.CHUNKING_THRESHOLD_BYTES;
  const needsChunking = exceedsDurationThreshold || exceedsSizeThreshold;

  console.log('[Chunking] Audio analysis:', {
    durationSeconds,
    durationMs,
    fileSizeBytes,
    fileSizeMB,
    duration_threshold: CHUNK_CONFIG.CHUNKING_THRESHOLD_SECONDS,
    size_threshold_mb: (CHUNK_CONFIG.CHUNKING_THRESHOLD_BYTES / (1024 * 1024)).toFixed(2),
    exceedsDurationThreshold,
    exceedsSizeThreshold,
    needsChunking,
  });

  // If audio is short enough AND small enough, no chunking needed
  if (!needsChunking) {
    console.log('[Chunking] File is short and small enough, no chunking needed');
    return {
      result: {
        chunked: false,
        chunks: [],
        originalDurationMs: durationMs,
        originalStoragePath,
      },
      localChunkPaths: [],
    };
  }

  console.log('[Chunking] File needs chunking:', {
    reason: exceedsDurationThreshold ? 'duration' : 'file size',
  });

  // Detect silence gaps
  const silenceGaps = await detectSilenceGaps(audioFilePath);

  // Calculate chunk boundaries
  const rawBoundaries = calculateChunkBoundaries(durationSeconds, silenceGaps);

  // Apply overlap
  const chunks = applyOverlap(rawBoundaries, durationSeconds);

  // Create temp directory for chunks
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-chunks-'));
  const localChunkPaths: string[] = [];

  // Determine output extension from source
  const sourceExt = path.extname(audioFilePath) || '.mp3';

  // Extract each chunk
  for (const chunk of chunks) {
    const overlap = CHUNK_CONFIG.OVERLAP_SECONDS;
    const isFirst = chunk.chunkIndex === 0;
    const isLast = chunk.chunkIndex === chunks.length - 1;

    // Calculate extraction boundaries (with overlap)
    const extractStart = isFirst
      ? chunk.startMs / 1000
      : (chunk.startMs / 1000) - overlap;
    const extractEnd = isLast
      ? chunk.endMs / 1000
      : (chunk.endMs / 1000) + overlap;

    const chunkFileName = `chunk-${chunk.chunkIndex.toString().padStart(3, '0')}${sourceExt}`;
    const localPath = path.join(tempDir, chunkFileName);

    await extractChunk(audioFilePath, localPath, extractStart, extractEnd);

    localChunkPaths.push(localPath);
  }

  // Update chunks with storage paths (caller will set these based on upload location)
  chunks.forEach((chunk, idx) => {
    chunk.originalStoragePath = originalStoragePath;
    // chunkStoragePath will be set by caller after upload
  });

  console.log('[Chunking] ✅ Chunking complete:', {
    originalDurationMs: durationMs,
    chunkCount: chunks.length,
    tempDir,
    chunks: chunks.map(c => ({
      index: c.chunkIndex,
      startMs: c.startMs,
      endMs: c.endMs,
      durationMs: c.durationMs,
      overlapBefore: c.overlapBeforeMs,
      overlapAfter: c.overlapAfterMs,
    })),
  });

  return {
    result: {
      chunked: true,
      chunks,
      originalDurationMs: durationMs,
      originalStoragePath,
    },
    localChunkPaths,
  };
}

/**
 * Clean up temporary chunk files.
 *
 * @param localChunkPaths - Paths to temp chunk files
 */
export function cleanupChunks(localChunkPaths: string[]): void {
  for (const filePath of localChunkPaths) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.warn('[Chunking] Failed to delete temp file:', filePath, error);
    }
  }

  // Try to remove the temp directory if empty
  if (localChunkPaths.length > 0) {
    const tempDir = path.dirname(localChunkPaths[0]);
    try {
      fs.rmdirSync(tempDir);
    } catch {
      // Directory not empty or doesn't exist - that's fine
    }
  }
}
