/**
 * Shared Audio Utilities
 *
 * Houses helpers that both the hybrid pipeline and the legacy chunking
 * module need. Extracted so newPipeline.ts no longer imports from
 * chunking.ts — which is scheduled for deletion in scope -02.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Dynamic import wrapper: resolves at runtime in Cloud Functions, not at build time.
// Same pattern used in chunking.ts and newPipeline.ts — ffmpeg path doesn't exist
// on the build machine, so we can't resolve it statically.
async function getFfmpegPath(): Promise<string> {
  const ffmpegInstaller = await import('@ffmpeg-installer/ffmpeg');
  return ffmpegInstaller.default.path;
}

/**
 * Get the total duration of an audio file in seconds.
 *
 * Tries ffprobe first (fast, reliable). Falls back to parsing ffmpeg's
 * stderr Duration line if ffprobe is unavailable or broken — because
 * sometimes the universe just doesn't want things to be easy.
 *
 * @param audioFilePath - Path to audio file on local filesystem
 * @returns Duration in seconds
 */
export async function getAudioDuration(audioFilePath: string): Promise<number> {
  const ffmpegPath = await getFfmpegPath();
  const ffprobePath = ffmpegPath.replace(/ffmpeg$/, 'ffprobe');

  try {
    // execFile (not exec) — no shell injection risk, arguments are passed as array
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
    // Fallback: coerce ffmpeg into printing file info to stderr
    console.warn('[audioUtils] ffprobe failed, falling back to ffmpeg duration extraction');

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
