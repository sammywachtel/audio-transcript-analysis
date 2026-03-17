#!/usr/bin/env tsx
/**
 * Phase 1: Chirp-3 BatchRecognize Benchmark
 *
 * Sends a complete audio file to Google Cloud Speech-to-Text v2 (Chirp-3)
 * and evaluates diarization + timestamp quality against our ground truth
 * conversation c_1773188486911 (45-min, 6-speaker meeting).
 *
 * Unlike Gemini, Chirp-3 processes audio natively — no token ceilings,
 * no multimodal gymnastics. Just speech recognition doing what it does best.
 *
 * Usage:
 *   npx tsx scripts/poc-chirp3-benchmark.ts [conversationId] [iteration]
 *
 * Output:
 *   .agent_process/work/poc_gemini_hybrid/<iteration>/results/chirp3_benchmark.json
 *   .agent_process/work/poc_gemini_hybrid/<iteration>/results/phase1_chirp3.md
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';
import 'dotenv/config';
import { resolvePocResultsDir } from './poc-results-dir.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCOPE = 'poc_gemini_hybrid';
const { iteration: ITERATION, resultsDir: RESULTS_DIR } = resolvePocResultsDir(
  PROJECT_ROOT,
  SCOPE,
  process.argv[3],
);

// GCP project config — same project as Firebase
const GCP_PROJECT = 'audio-transcript-analyzer-01';
const GCS_BUCKET = 'audio-transcript-analyzer-01.firebasestorage.app';

// ============================================================================
// Types
// ============================================================================

/** An utterance-level result from Chirp-3 (no word-level timestamps) */
interface Chirp3Utterance {
  text: string;
  startMs: number;
  endMs: number;
  speakerLabel: string;
  confidence: number;
  wordCount: number;
}

/** Consecutive same-speaker utterances merged into a segment */
interface Chirp3Segment {
  speaker: string;
  startMs: number;
  endMs: number;
  wordCount: number;
  text: string;
}

interface Chirp3BenchmarkResult {
  conversationId: string;
  model: string;
  timestamp: string;
  durationMs: number;
  gcsUri: string;
  speakers: {
    count: number;
    distribution: Record<string, { wordCount: number; segments: number; durationMs: number }>;
  };
  segments: Chirp3Segment[];
  utterances: Chirp3Utterance[];
  totalUtterances: number;
  totalSegments: number;
  totalWords: number;
  audioDurationMs: number;
  coveragePercent: number;
  groundTruth: {
    expectedSpeakers: number;
    existingSegments: number;
    existingSpeakers: number;
  };
}

// ============================================================================
// Firebase init — same pattern as poc-gemini-diarize.ts
// ============================================================================

function initFirebase(): admin.app.App {
  const saKeyPath = path.join(PROJECT_ROOT, 'firebase-sa-key.json');
  if (!fs.existsSync(saKeyPath)) {
    throw new Error(`Service account key not found at ${saKeyPath}. Cannot proceed.`);
  }

  if (admin.apps.length > 0) {
    return admin.apps[0]!;
  }

  return admin.initializeApp({
    credential: admin.credential.cert(saKeyPath),
    storageBucket: GCS_BUCKET,
  });
}

// ============================================================================
// Audio chunking — download, split, upload to GCS
// ============================================================================

// Chirp-3 with word timestamps caps at 20 min per file. We split into
// 15-min chunks so we don't bump into the limit.
const CHUNK_DURATION_SEC = 900;

async function downloadAudioToTemp(storagePath: string): Promise<string> {
  console.log(`[Download] Fetching audio from Storage: ${storagePath}`);
  const bucket = admin.storage().bucket();
  const file = bucket.file(storagePath);

  const [exists] = await file.exists();
  if (!exists) {
    throw new Error(`Audio file not found in Storage: ${storagePath}`);
  }

  const tmpDir = os.tmpdir();
  const ext = path.extname(storagePath) || '.mp3';
  const tmpPath = path.join(tmpDir, `poc-chirp3-${Date.now()}${ext}`);

  await file.download({ destination: tmpPath });
  const stats = fs.statSync(tmpPath);
  console.log(`[Download] Saved ${(stats.size / 1024 / 1024).toFixed(1)}MB to ${tmpPath}`);

  return tmpPath;
}

/** Get audio duration in seconds via ffprobe */
function getAudioDuration(filePath: string): number {
  const output = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
    { encoding: 'utf-8' },
  ).trim();
  return parseFloat(output);
}

/** Split audio into <=15-min chunks, returns array of {path, offsetSec} */
function splitAudio(inputPath: string, durationSec: number): Array<{ path: string; offsetSec: number }> {
  const chunks: Array<{ path: string; offsetSec: number }> = [];
  const tmpDir = os.tmpdir();
  const ext = path.extname(inputPath);
  const numChunks = Math.ceil(durationSec / CHUNK_DURATION_SEC);

  if (numChunks <= 1) {
    return [{ path: inputPath, offsetSec: 0 }];
  }

  console.log(`[Split] Splitting ${(durationSec / 60).toFixed(1)}min audio into ${numChunks} chunks of ${CHUNK_DURATION_SEC / 60}min`);

  for (let i = 0; i < numChunks; i++) {
    const startSec = i * CHUNK_DURATION_SEC;
    const chunkPath = path.join(tmpDir, `poc-chirp3-chunk-${i}${ext}`);

    execFileSync(
      'ffmpeg',
      ['-y', '-i', inputPath, '-ss', String(startSec), '-t', String(CHUNK_DURATION_SEC), '-c', 'copy', chunkPath],
      { stdio: 'pipe' },
    );

    const stats = fs.statSync(chunkPath);
    console.log(`[Split] Chunk ${i}: offset=${startSec}s, size=${(stats.size / 1024 / 1024).toFixed(1)}MB`);
    chunks.push({ path: chunkPath, offsetSec: startSec });
  }

  return chunks;
}

/** Upload a local file to a temp GCS location, returns gs:// URI */
async function uploadToGcsTemp(localPath: string, label: string): Promise<string> {
  const bucket = admin.storage().bucket();
  const gcsPath = `tmp/chirp3-benchmark/${label}-${Date.now()}${path.extname(localPath)}`;
  await bucket.upload(localPath, { destination: gcsPath });
  const uri = `gs://${GCS_BUCKET}/${gcsPath}`;
  console.log(`[Upload] ${label} → ${uri}`);
  return uri;
}

/** Clean up temp GCS files */
async function cleanupGcsTemp(uris: string[]): Promise<void> {
  const bucket = admin.storage().bucket();
  for (const uri of uris) {
    const gcsPath = uri.replace(`gs://${GCS_BUCKET}/`, '');
    try {
      await bucket.file(gcsPath).delete();
    } catch (_e) {
      // Best effort cleanup
    }
  }
  console.log(`[Cleanup] Removed ${uris.length} temp GCS files`);
}

/** Convert protobuf Duration {seconds, nanos} to milliseconds */
function durationToMs(d?: { seconds?: string | number; nanos?: number }): number {
  if (!d) return 0;
  const sec = Number(d.seconds ?? 0);
  const nanos = Number(d.nanos ?? 0);
  return Math.round(sec * 1000 + nanos / 1_000_000);
}

// ============================================================================
// Chirp-3 BatchRecognize — the main event
// ============================================================================

async function runChirp3BatchRecognize(gcsUri: string): Promise<{
  utterances: Chirp3Utterance[];
  durationMs: number;
  rawResponse: unknown;
}> {
  // Dynamic import — @google-cloud/speech resolves native grpc binaries,
  // so we import at runtime to avoid build-time resolution headaches
  const { v2 } = await import('@google-cloud/speech');

  // Chirp-3 is only available in specific locations. GA regions are
  // the multi-regions "us" and "eu" — NOT individual regions like
  // us-central1. The endpoint format for multi-regions is just
  // "speech.googleapis.com" (no region prefix), but the recognizer
  // path still needs locations/{region}. Override via CHIRP3_REGION.
  const region = process.env.CHIRP3_REGION || 'us';
  const saKeyPath = path.join(PROJECT_ROOT, 'firebase-sa-key.json');

  // All locations — multi-region ("us", "eu") and named regions alike —
  // use the {location}-speech.googleapis.com endpoint pattern.
  // The default speech.googleapis.com expects "global" in the resource
  // path, but Chirp-3 doesn't exist at global. So we always prefix.
  const apiEndpoint = `${region}-speech.googleapis.com`;

  const client = new v2.SpeechClient({
    keyFilename: saKeyPath,
    apiEndpoint,
  });

  console.log(`[Chirp-3] Starting BatchRecognize...`);
  console.log(`[Chirp-3] Location: ${region} (endpoint: ${apiEndpoint})`);
  console.log(`[Chirp-3] GCS URI: ${gcsUri}`);
  console.log(`[Chirp-3] Model: chirp_3, Language: en-US`);
  console.log(`[Chirp-3] NOTE: Word-level timestamps enabled for diarization — 20 min file limit applies`);

  const apiStart = Date.now();

  const [operation] = await client.batchRecognize({
    recognizer: `projects/${GCP_PROJECT}/locations/${region}/recognizers/_`,
    config: {
      model: 'chirp_3',
      languageCodes: ['en-US'],
      // v2 API requires an explicit decoding_config oneof — auto-detect
      // handles MP3, WAV, FLAC, etc. without us specifying sample rate
      autoDecodingConfig: {},
      features: {
        // Diarization speaker labels only appear on word objects, so we
        // need word-level offsets enabled. This caps BatchRecognize at 20
        // min — but 20 min of diarized audio is enough to benchmark quality.
        // Chirp-3 docs say to use an empty SpeakerDiarizationConfig.
        enableWordTimeOffsets: true,
        diarizationConfig: {},
      },
    },
    files: [{ uri: gcsUri }],
    recognitionOutputConfig: {
      inlineResponseConfig: {},
    },
  });

  console.log(`[Chirp-3] Operation submitted, waiting for completion...`);
  console.log(`[Chirp-3] (This may take several minutes for a 45-min file)`);

  // Poll for completion — operation.promise() handles the LRO polling
  const [response] = await operation.promise();
  const apiDuration = Date.now() - apiStart;
  console.log(`[Chirp-3] Completed in ${(apiDuration / 1000).toFixed(1)}s`);

  // Extract utterances from the response.
  // With word-level offsets enabled, each result has alternatives[0].words
  // with speakerLabel per word. We group words into utterances by looking
  // at each result's transcript text and using the majority speaker label
  // from its words.
  const utterances: Chirp3Utterance[] = [];
  const inlineResults = (response as Record<string, unknown>).results as
    | Record<string, {
        transcript?: { results?: unknown[] };
        inlineResult?: { transcript?: { results?: unknown[] } };
        error?: { code?: number; message?: string };
      }>
    | undefined;

  if (inlineResults) {
    for (const [uri, fileResult] of Object.entries(inlineResults)) {
      console.log(`[Chirp-3] Processing results for: ${uri}`);

      if (fileResult?.error?.message) {
        console.error(`[Chirp-3] API error for ${uri}: ${fileResult.error.message}`);
        continue;
      }

      const transcript =
        fileResult?.inlineResult?.transcript ??
        fileResult?.transcript;
      if (!transcript?.results) {
        console.warn(`[Chirp-3] No transcript results for ${uri}`);
        console.warn(`[Chirp-3] Available keys: ${JSON.stringify(Object.keys(fileResult || {}))}`);
        const firstKey = Object.keys(fileResult || {})[0];
        if (firstKey) {
          console.warn(`[Chirp-3] Sample value: ${JSON.stringify((fileResult as Record<string, unknown>)[firstKey]).substring(0, 500)}`);
        }
        continue;
      }

      for (const result of transcript.results as Array<{
        resultEndOffset?: { seconds?: string | number; nanos?: number };
        alternatives?: Array<{
          transcript?: string;
          confidence?: number;
          words?: Array<{
            word?: string;
            startOffset?: { seconds?: string | number; nanos?: number };
            endOffset?: { seconds?: string | number; nanos?: number };
            speakerLabel?: string;
            confidence?: number;
          }>;
        }>;
      }>) {
        const alt = result.alternatives?.[0];
        if (!alt?.transcript) continue;

        const words = alt.words ?? [];
        if (words.length === 0) {
          // No word-level data — fall back to one utterance per result
          utterances.push({
            text: alt.transcript.trim(),
            startMs: 0,
            endMs: durationToMs(result.resultEndOffset),
            speakerLabel: 'unknown',
            confidence: alt.confidence ?? 0,
            wordCount: alt.transcript.trim().split(/\s+/).filter(Boolean).length,
          });
          continue;
        }

        // Build utterances by splitting at speaker transitions within the
        // word array. Each run of consecutive same-speaker words becomes
        // one utterance — this is where the diarization magic happens.
        let currentSpeaker = words[0].speakerLabel ?? 'unknown';
        let uttWords: string[] = [words[0].word ?? ''];
        let uttStart = durationToMs(words[0].startOffset);
        let uttEnd = durationToMs(words[0].endOffset);

        for (let wi = 1; wi < words.length; wi++) {
          const w = words[wi];
          const label = w.speakerLabel ?? 'unknown';

          if (label === currentSpeaker) {
            uttWords.push(w.word ?? '');
            uttEnd = durationToMs(w.endOffset);
          } else {
            // Speaker changed — emit current utterance
            utterances.push({
              text: uttWords.join(' '),
              startMs: uttStart,
              endMs: uttEnd,
              speakerLabel: currentSpeaker,
              confidence: alt.confidence ?? 0,
              wordCount: uttWords.length,
            });
            currentSpeaker = label;
            uttWords = [w.word ?? ''];
            uttStart = durationToMs(w.startOffset);
            uttEnd = durationToMs(w.endOffset);
          }
        }

        // Emit final utterance
        utterances.push({
          text: uttWords.join(' '),
          startMs: uttStart,
          endMs: uttEnd,
          speakerLabel: currentSpeaker,
          confidence: alt.confidence ?? 0,
          wordCount: uttWords.length,
        });
      }
    }
  }

  console.log(`[Chirp-3] Extracted ${utterances.length} utterances`);

  return { utterances, durationMs: apiDuration, rawResponse: response };
}

// ============================================================================
// Analysis — group words into segments, compute stats
// ============================================================================

/** Merge consecutive same-speaker utterances into coarser segments */
function buildSegments(utterances: Chirp3Utterance[]): Chirp3Segment[] {
  if (utterances.length === 0) return [];

  const segments: Chirp3Segment[] = [];
  let currentSpeaker = utterances[0].speakerLabel;
  let segStart = utterances[0].startMs;
  let segEnd = utterances[0].endMs;
  let segTexts: string[] = [utterances[0].text];
  let segWordCount = utterances[0].wordCount;

  for (let i = 1; i < utterances.length; i++) {
    const u = utterances[i];
    if (u.speakerLabel === currentSpeaker) {
      segEnd = u.endMs;
      segTexts.push(u.text);
      segWordCount += u.wordCount;
    } else {
      segments.push({
        speaker: currentSpeaker,
        startMs: segStart,
        endMs: segEnd,
        wordCount: segWordCount,
        text: segTexts.join(' '),
      });
      currentSpeaker = u.speakerLabel;
      segStart = u.startMs;
      segEnd = u.endMs;
      segTexts = [u.text];
      segWordCount = u.wordCount;
    }
  }

  segments.push({
    speaker: currentSpeaker,
    startMs: segStart,
    endMs: segEnd,
    wordCount: segWordCount,
    text: segTexts.join(' '),
  });

  return segments;
}

function computeSpeakerDistribution(
  segments: Chirp3Segment[],
): Record<string, { wordCount: number; segments: number; durationMs: number }> {
  const dist: Record<string, { wordCount: number; segments: number; durationMs: number }> = {};

  for (const seg of segments) {
    if (!dist[seg.speaker]) {
      dist[seg.speaker] = { wordCount: 0, segments: 0, durationMs: 0 };
    }
    dist[seg.speaker].wordCount += seg.wordCount;
    dist[seg.speaker].segments++;
    dist[seg.speaker].durationMs += seg.endMs - seg.startMs;
  }

  return dist;
}

// ============================================================================
// Report generation — markdown summary
// ============================================================================

function generateReport(result: Chirp3BenchmarkResult): string {
  const lines: string[] = [];
  lines.push('# Chirp-3 BatchRecognize Benchmark Results');
  lines.push('');
  lines.push(`**Date:** ${result.timestamp}`);
  lines.push(`**Conversation:** ${result.conversationId}`);
  lines.push(`**Model:** ${result.model}`);
  lines.push(`**API Duration:** ${(result.durationMs / 1000).toFixed(1)}s`);
  lines.push(`**GCS URI:** ${result.gcsUri}`);
  lines.push('');

  lines.push('## Speaker Analysis');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Speakers found | ${result.speakers.count} |`);
  lines.push(`| Expected speakers | ${result.groundTruth.expectedSpeakers} |`);
  lines.push(`| Total utterances | ${result.totalUtterances} |`);
  lines.push(`| Total segments (merged) | ${result.totalSegments} |`);
  lines.push(`| Total words | ${result.totalWords} |`);
  lines.push(`| Audio coverage | ${result.coveragePercent.toFixed(1)}% |`);
  lines.push('');

  lines.push('### Speaker Distribution');
  lines.push('');
  lines.push('| Speaker | Words | Segments | Duration |');
  lines.push('|---------|-------|----------|----------|');
  const sorted = Object.entries(result.speakers.distribution).sort(
    (a, b) => b[1].wordCount - a[1].wordCount,
  );
  for (const [speaker, stats] of sorted) {
    const durMin = (stats.durationMs / 1000 / 60).toFixed(1);
    lines.push(`| ${speaker} | ${stats.wordCount} | ${stats.segments} | ${durMin}m |`);
  }
  lines.push('');

  lines.push('## Ground Truth Comparison');
  lines.push('');
  lines.push(`| Metric | Chirp-3 | Existing |`);
  lines.push(`|--------|---------|----------|`);
  lines.push(
    `| Speakers | ${result.speakers.count} | ${result.groundTruth.existingSpeakers} (expected: ${result.groundTruth.expectedSpeakers}) |`,
  );
  lines.push(`| Segments | ${result.totalSegments} | ${result.groundTruth.existingSegments} |`);
  lines.push('');

  // Timestamp quality — first and last segment
  if (result.segments.length > 0) {
    const first = result.segments[0];
    const last = result.segments[result.segments.length - 1];
    lines.push('## Timestamp Quality');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(
      `| First segment | "${first.text.substring(0, 40)}..." at ${(first.startMs / 1000).toFixed(1)}s |`,
    );
    lines.push(
      `| Last segment | "...${last.text.substring(last.text.length - 40)}" at ${(last.endMs / 1000).toFixed(1)}s |`,
    );
    lines.push(
      `| Audio duration | ${(result.audioDurationMs / 1000 / 60).toFixed(1)} min |`,
    );
    lines.push(
      `| Transcript span | ${((last.endMs - first.startMs) / 1000 / 60).toFixed(1)} min |`,
    );
    lines.push('');
  }

  // Sample segments — first 10 and last 5
  lines.push('## Sample Segments (first 10)');
  lines.push('');
  lines.push('| # | Speaker | Start | End | Words | Preview |');
  lines.push('|---|---------|-------|-----|-------|---------|');
  const sampleHead = result.segments.slice(0, 10);
  for (let i = 0; i < sampleHead.length; i++) {
    const seg = sampleHead[i];
    const preview = seg.text.length > 50 ? seg.text.substring(0, 50) + '...' : seg.text;
    lines.push(
      `| ${i + 1} | ${seg.speaker} | ${(seg.startMs / 1000).toFixed(1)}s | ${(seg.endMs / 1000).toFixed(1)}s | ${seg.wordCount} | ${preview} |`,
    );
  }
  lines.push('');

  if (result.segments.length > 10) {
    lines.push('## Sample Segments (last 5)');
    lines.push('');
    lines.push('| # | Speaker | Start | End | Words | Preview |');
    lines.push('|---|---------|-------|-----|-------|---------|');
    const sampleTail = result.segments.slice(-5);
    const offset = result.segments.length - 5;
    for (let i = 0; i < sampleTail.length; i++) {
      const seg = sampleTail[i];
      const preview = seg.text.length > 50 ? seg.text.substring(0, 50) + '...' : seg.text;
      lines.push(
        `| ${offset + i + 1} | ${seg.speaker} | ${(seg.startMs / 1000).toFixed(1)}s | ${(seg.endMs / 1000).toFixed(1)}s | ${seg.wordCount} | ${preview} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const conversationId = process.argv[2] || 'c_1773188486911';

  console.log('='.repeat(70));
  console.log(`PoC: Chirp-3 BatchRecognize Benchmark — ${conversationId}`);
  console.log(`[Context] Scope: ${SCOPE}, Iteration: ${ITERATION}`);
  console.log('='.repeat(70));

  // Init Firebase
  initFirebase();
  const db = admin.firestore();

  // Fetch conversation for ground truth comparison
  const convoDoc = await db.collection('conversations').doc(conversationId).get();
  if (!convoDoc.exists) {
    throw new Error(`Conversation ${conversationId} not found in Firestore`);
  }

  const convoData = convoDoc.data()!;
  const audioStoragePath = convoData.audioStoragePath as string;
  if (!audioStoragePath) {
    throw new Error(`Conversation ${conversationId} has no audioStoragePath`);
  }

  const existingSegments = (convoData.segments || []).length;
  const existingSpeakers = Object.keys(convoData.speakers || {}).length;
  const audioDurationMs = convoData.durationMs || 0;

  console.log(`[Main] Audio path: ${audioStoragePath}`);
  console.log(`[Main] Duration: ${(audioDurationMs / 1000 / 60).toFixed(1)} minutes`);
  console.log(`[Main] Existing segments: ${existingSegments}`);
  console.log(`[Main] Existing speakers: ${existingSpeakers}`);

  // Download audio, split into chunks, process each
  const audioPath = await downloadAudioToTemp(audioStoragePath);
  const actualDurationSec = getAudioDuration(audioPath);
  console.log(`[Main] Actual audio duration: ${(actualDurationSec / 60).toFixed(1)} min`);

  const chunks = splitAudio(audioPath, actualDurationSec);
  const tempGcsUris: string[] = [];
  const allUtterances: Chirp3Utterance[] = [];
  let totalApiDurationMs = 0;
  let lastRawResponse: unknown = null;

  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`\n[Main] Processing chunk ${i + 1}/${chunks.length} (offset: ${chunk.offsetSec}s)...`);

      // Upload chunk to GCS (Chirp-3 needs a gs:// URI)
      const gcsUri = await uploadToGcsTemp(chunk.path, `chunk-${i}`);
      tempGcsUris.push(gcsUri);

      const { utterances: chunkUtterances, durationMs: chunkDuration, rawResponse } =
        await runChirp3BatchRecognize(gcsUri);
      totalApiDurationMs += chunkDuration;
      lastRawResponse = rawResponse;

      // Offset timestamps to account for chunk position in the full audio
      const offsetMs = chunk.offsetSec * 1000;
      for (const u of chunkUtterances) {
        u.startMs += offsetMs;
        u.endMs += offsetMs;
      }

      console.log(`[Main] Chunk ${i + 1}: ${chunkUtterances.length} utterances`);
      allUtterances.push(...chunkUtterances);
    }
  } finally {
    // Clean up temp files — local chunks and GCS uploads
    for (const chunk of chunks) {
      try { fs.unlinkSync(chunk.path); } catch (_e) { /* */ }
    }
    try { fs.unlinkSync(audioPath); } catch (_e) { /* */ }
    if (tempGcsUris.length > 0) {
      await cleanupGcsTemp(tempGcsUris);
    }
  }

  const gcsUri = `gs://${GCS_BUCKET}/${audioStoragePath}`;

  if (allUtterances.length === 0) {
    console.error('[Main] No utterances returned from any chunk');
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const rawPath = path.join(RESULTS_DIR, 'chirp3_raw_response.json');
    fs.writeFileSync(rawPath, JSON.stringify(lastRawResponse, null, 2));
    console.log(`[Main] Last raw response saved to: ${rawPath}`);
    return;
  }

  const utterances = allUtterances;
  const durationMs = totalApiDurationMs;

  // Merge consecutive same-speaker utterances into coarser segments
  const segments = buildSegments(utterances);
  const speakerDistribution = computeSpeakerDistribution(segments);
  const uniqueSpeakers = Object.keys(speakerDistribution);
  const totalWords = utterances.reduce((sum, u) => sum + u.wordCount, 0);

  // Coverage: what fraction of the audio does the transcript span?
  const lastEnd = utterances[utterances.length - 1].endMs;
  const coveragePercent = audioDurationMs > 0 ? (lastEnd / audioDurationMs) * 100 : 0;

  const result: Chirp3BenchmarkResult = {
    conversationId,
    model: 'chirp_3',
    timestamp: new Date().toISOString(),
    durationMs,
    gcsUri,
    speakers: {
      count: uniqueSpeakers.length,
      distribution: speakerDistribution,
    },
    segments,
    utterances,
    totalUtterances: utterances.length,
    totalSegments: segments.length,
    totalWords,
    audioDurationMs,
    coveragePercent,
    groundTruth: {
      expectedSpeakers: 6,
      existingSegments,
      existingSpeakers,
    },
  };

  // Save results
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const jsonPath = path.join(RESULTS_DIR, 'chirp3_benchmark.json');
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  console.log(`[Main] Saved benchmark JSON: ${jsonPath}`);

  const reportPath = path.join(RESULTS_DIR, 'phase1_chirp3.md');
  const report = generateReport(result);
  fs.writeFileSync(reportPath, report);
  console.log(`[Main] Saved benchmark report: ${reportPath}`);

  // Print summary to console
  console.log('\n' + '='.repeat(70));
  console.log('CHIRP-3 BENCHMARK SUMMARY');
  console.log('='.repeat(70));
  console.log(`Speakers found:    ${uniqueSpeakers.length} (expected: 6)`);
  console.log(`Utterances:        ${utterances.length}`);
  console.log(`Segments (merged): ${segments.length}`);
  console.log(`Total words:       ${totalWords}`);
  console.log(`API duration:      ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`Audio coverage:    ${coveragePercent.toFixed(1)}%`);
  console.log('');
  console.log('Speaker distribution:');
  const sortedDist = Object.entries(speakerDistribution).sort((a, b) => b[1].wordCount - a[1].wordCount);
  for (const [speaker, stats] of sortedDist) {
    const pct = ((stats.wordCount / totalWords) * 100).toFixed(1);
    console.log(
      `  ${speaker.padEnd(12)} ${String(stats.wordCount).padStart(6)} words (${pct}%), ${stats.segments} segments, ${(stats.durationMs / 1000 / 60).toFixed(1)}m`,
    );
  }
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
