#!/usr/bin/env tsx
/**
 * Phase 3: Real HARDY Alignment Test
 *
 * Uses the ACTUAL deployed HARDY + WhisperX pipeline:
 *   1. Gemini 3 Flash (WAV) → speaker-labeled segments with transcript text
 *   2. alignTimestamps() → calls live WhisperX Cloud Run service for word
 *      timestamps, then runs full HARDY alignment algorithm
 *   3. Evaluate: compare aligned timestamps + speaker accuracy vs ground truth
 *
 * Usage:
 *   WHISPER_URL=https://... WAV=1 npx tsx scripts/poc-align-speakers.ts [conversationId] [iteration]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { GoogleGenAI, createPartFromUri } from '@google/genai';
import admin from 'firebase-admin';
import 'dotenv/config';
import { resolvePocResultsDir } from './poc-results-dir.js';

import { setGlobalDispatcher, Agent } from 'undici';
setGlobalDispatcher(new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCOPE = 'poc_gemini_hybrid';
const { iteration: ITERATION, resultsDir: RESULTS_DIR } = resolvePocResultsDir(
  PROJECT_ROOT, SCOPE, process.argv[3],
);
const CONVERT_TO_WAV = process.env.WAV === '1';
const WHISPER_URL = process.env.WHISPER_URL || 'https://whisperx-service-467135162440.us-east4.run.app';

// Set GOOGLE_APPLICATION_CREDENTIALS for the auth library used by alignment.ts
process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(PROJECT_ROOT, 'firebase-sa-key.json');

// ============================================================================
// Firebase
// ============================================================================

function initFirebase(): admin.app.App {
  const saKeyPath = path.join(PROJECT_ROOT, 'firebase-sa-key.json');
  if (!fs.existsSync(saKeyPath)) throw new Error(`SA key not found at ${saKeyPath}`);
  if (admin.apps.length > 0) return admin.apps[0]!;
  return admin.initializeApp({
    credential: admin.credential.cert(saKeyPath),
    storageBucket: 'audio-transcript-analyzer-01.firebasestorage.app',
  });
}

function convertToWav(inputPath: string): string {
  const wavPath = inputPath.replace(/\.[^.]+$/, '.wav');
  execFileSync('ffmpeg', ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', wavPath], { stdio: 'pipe' });
  console.log(`[Convert] WAV: ${(fs.statSync(wavPath).size / 1024 / 1024).toFixed(1)}MB`);
  return wavPath;
}

// ============================================================================
// Gemini 3 Flash — diarization with transcript text
// ============================================================================

const DIARIZE_PROMPT = `You are an expert audio transcription analyst. Listen to this entire recording carefully.

## Tasks

### 1. Speaker Identification
Identify every distinct speaker. For each:
- Assign a label ("Speaker 1", "Speaker 2", etc.)
- Identify their actual name if mentioned
- Note their role

Be conservative — do NOT create separate speakers for the same person.

### 2. Speaker Timeline with Transcript
Produce a timeline of speaker turns covering the ENTIRE recording.

RULES:
- Each entry = one speaker's CONTINUOUS turn (until someone else speaks)
- Include the transcript TEXT for each turn — what they actually said, verbatim
- The "speaker" field MUST match a label from the speakers list
- Timestamps in milliseconds from start of audio
- Cover the FULL recording from start to finish — do not stop early
- Merge consecutive speech by the same speaker into one entry
- For a 45-minute conversation, expect 100-400 entries`;

async function runGeminiDiarization(audioPath: string, conversationId: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not found');

  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 600_000 } });
  const model = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';

  console.log('[Gemini] Uploading audio...');
  const uploadStart = Date.now();
  const uploadedFile = await ai.files.upload({
    file: audioPath,
    config: {
      mimeType: CONVERT_TO_WAV ? 'audio/wav' : 'audio/mpeg',
      displayName: `poc-align-${conversationId}`,
    },
  });
  console.log(`[Gemini] Upload: ${((Date.now() - uploadStart) / 1000).toFixed(1)}s`);

  let fileState = uploadedFile.state;
  while (fileState === 'PROCESSING') {
    await new Promise(r => setTimeout(r, 2000));
    const info = await ai.files.get({ name: uploadedFile.name! });
    fileState = info.state;
  }

  console.log(`[Gemini] Model: ${model}, requesting diarization + text...`);
  const apiStart = Date.now();

  const response = await ai.models.generateContent({
    model,
    contents: [{
      role: 'user',
      parts: [
        createPartFromUri(uploadedFile.uri!, uploadedFile.mimeType!),
        { text: DIARIZE_PROMPT },
      ],
    }],
    config: {
      temperature: 0.1,
      maxOutputTokens: 65536,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          speakers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                name: { type: 'string' },
                role: { type: 'string' },
              },
              required: ['label', 'name'],
              propertyOrdering: ['label', 'name', 'role'],
            },
          },
          segments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                speaker: { type: 'string' },
                startMs: { type: 'number' },
                endMs: { type: 'number' },
                text: { type: 'string' },
              },
              required: ['speaker', 'startMs', 'endMs', 'text'],
              propertyOrdering: ['speaker', 'startMs', 'endMs', 'text'],
            },
          },
        },
        required: ['speakers', 'segments'],
        propertyOrdering: ['speakers', 'segments'],
      },
    },
  });

  const apiDuration = Date.now() - apiStart;
  const usage = response.usageMetadata;
  console.log(`[Gemini] Done in ${(apiDuration / 1000).toFixed(1)}s`);
  console.log(`[Gemini] Tokens: prompt=${usage?.promptTokenCount}, completion=${usage?.candidatesTokenCount}`);

  // Parse with truncation repair
  let cleaned = (response.text ?? '').trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_) {
    console.warn('[Gemini] JSON truncated, attempting repair...');
    const lastComplete = cleaned.lastIndexOf('},');
    if (lastComplete > 0) {
      let repaired = cleaned.substring(0, lastComplete + 1);
      const openB = (repaired.match(/\[/g) || []).length - (repaired.match(/\]/g) || []).length;
      const openC = (repaired.match(/\{/g) || []).length - (repaired.match(/\}/g) || []).length;
      repaired += ']'.repeat(Math.max(0, openB)) + '}'.repeat(Math.max(0, openC));
      parsed = JSON.parse(repaired);
      console.warn(`[Gemini] Repair OK — ${parsed.segments?.length ?? 0} segments`);
    } else {
      throw new Error('JSON parse failed');
    }
  }

  try { await ai.files.delete({ name: uploadedFile.name! }); } catch (_) { /* */ }

  return {
    speakers: parsed.speakers as Array<{ label: string; name: string; role?: string }>,
    segments: parsed.segments as Array<{ speaker: string; text: string; startMs: number; endMs: number }>,
    tokenUsage: { prompt: usage?.promptTokenCount ?? 0, completion: usage?.candidatesTokenCount ?? 0 },
    durationMs: apiDuration,
  };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const conversationId = process.argv[2] || 'c_1773188486911';

  console.log('='.repeat(70));
  console.log(`Phase 3: REAL HARDY Alignment — Gemini + WhisperX service`);
  console.log(`[Context] Scope: ${SCOPE}, Iteration: ${ITERATION}`);
  console.log(`[Config] WhisperX: ${WHISPER_URL}`);
  console.log(`[Config] WAV: ${CONVERT_TO_WAV}`);
  console.log('='.repeat(70));

  initFirebase();
  const db = admin.firestore();

  const convoDoc = await db.collection('conversations').doc(conversationId).get();
  if (!convoDoc.exists) throw new Error(`Conversation ${conversationId} not found`);
  const convoData = convoDoc.data()!;
  const audioStoragePath = convoData.audioStoragePath as string;
  const audioDurationMs = convoData.durationMs || 0;

  // Ground truth
  const gtSegments = (convoData.segments || []) as Array<{
    speakerId: string; text: string; startMs: number; endMs: number;
  }>;
  const gtSpeakers = convoData.speakers || {};
  console.log(`[Main] Ground truth: ${gtSegments.length} segments, ${Object.keys(gtSpeakers).length} speakers`);

  // Download audio (MP3 for WhisperX — it handles its own decoding)
  const bucket = admin.storage().bucket();
  const mp3Path = path.join(os.tmpdir(), `poc-align-${Date.now()}.mp3`);
  await bucket.file(audioStoragePath).download({ destination: mp3Path });
  console.log(`[Download] ${(fs.statSync(mp3Path).size / 1024 / 1024).toFixed(1)}MB`);

  // For Gemini: optionally convert to WAV
  let geminiAudioPath = mp3Path;
  if (CONVERT_TO_WAV) {
    geminiAudioPath = convertToWav(mp3Path);
  }

  // Step 1: Get Gemini diarization with text
  let gemini;
  try {
    gemini = await runGeminiDiarization(geminiAudioPath, conversationId);
  } finally {
    if (geminiAudioPath !== mp3Path) {
      try { fs.unlinkSync(geminiAudioPath); } catch (_) { /* */ }
    }
  }

  console.log(`\n[Main] Gemini: ${gemini.speakers.length} speakers, ${gemini.segments.length} segments`);
  for (const s of gemini.speakers) {
    console.log(`  ${s.label} → ${s.name} (${s.role ?? '?'})`);
  }

  // Step 2: Chunk audio + call alignTimestamps() per chunk
  // The WhisperX Cloud Run service has a request body size limit (~32MB),
  // so we split the 41MB MP3 into ~10-min chunks — same as production pipeline.
  console.log(`\n[Main] Loading alignment module...`);

  const alignmentMod = await import(path.join(PROJECT_ROOT, 'functions', 'lib', 'alignment.js'));
  const alignTimestamps = alignmentMod.alignTimestamps as (
    audioBuffer: Buffer,
    segments: Array<{ speakerId: string; text: string; startMs: number; endMs: number }>,
    serviceUrl: string,
  ) => Promise<{ segments: Array<{ speakerId: string; text: string; startMs: number; endMs: number }>; alignmentStatus: string; alignmentError?: string }>;

  // Split audio into 10-min chunks
  const CHUNK_SEC = 600; // 10 minutes
  const actualDurationSec = audioDurationMs / 1000;
  const numChunks = Math.ceil(actualDurationSec / CHUNK_SEC);
  console.log(`[Main] Splitting ${(actualDurationSec / 60).toFixed(1)}min audio into ${numChunks} chunks of ${CHUNK_SEC / 60}min`);

  const allAligned: Array<{ speakerId: string; text: string; startMs: number; endMs: number }> = [];
  let alignmentStatus = 'aligned';
  let alignmentError: string | undefined;
  const alignStart = Date.now();

  // Convert Gemini segments to input format
  const inputSegments = gemini.segments.map(s => ({
    speakerId: s.speaker,
    text: s.text,
    startMs: s.startMs,
    endMs: s.endMs,
  }));

  for (let c = 0; c < numChunks; c++) {
    const chunkStartSec = c * CHUNK_SEC;
    const chunkEndSec = Math.min((c + 1) * CHUNK_SEC, actualDurationSec);
    const chunkStartMs = chunkStartSec * 1000;
    const chunkEndMs = chunkEndSec * 1000;

    // Extract chunk audio with ffmpeg
    const chunkPath = path.join(os.tmpdir(), `poc-align-chunk-${c}-${Date.now()}.mp3`);
    execFileSync('ffmpeg', [
      '-y', '-i', mp3Path,
      '-ss', String(chunkStartSec),
      '-t', String(CHUNK_SEC),
      '-c', 'copy', chunkPath,
    ], { stdio: 'pipe' });
    const chunkSize = fs.statSync(chunkPath).size;
    console.log(`\n[Main] Chunk ${c + 1}/${numChunks}: ${chunkStartSec}s-${chunkEndSec}s (${(chunkSize / 1024 / 1024).toFixed(1)}MB)`);

    // Find Gemini segments that overlap this chunk
    // Use Gemini's (drifted) timestamps to select — HARDY will fix them
    const geminiScale = actualDurationSec * 1000 / (gemini.segments[gemini.segments.length - 1]?.endMs || 1);
    const scaledChunkStart = chunkStartMs / geminiScale;
    const scaledChunkEnd = chunkEndMs / geminiScale;

    const chunkSegments = inputSegments.filter(s => {
      const mid = (s.startMs + s.endMs) / 2;
      return mid >= scaledChunkStart && mid < scaledChunkEnd;
    });

    if (chunkSegments.length === 0) {
      console.log(`[Main] No Gemini segments for this chunk, skipping`);
      try { fs.unlinkSync(chunkPath); } catch (_) { /* */ }
      continue;
    }

    // Offset Gemini segments to chunk-local timestamps (scale + shift)
    const localSegments = chunkSegments.map(s => ({
      ...s,
      startMs: Math.max(0, Math.round(s.startMs * geminiScale - chunkStartMs)),
      endMs: Math.round(s.endMs * geminiScale - chunkStartMs),
    }));

    console.log(`[Main] ${chunkSegments.length} Gemini segments → HARDY alignment`);

    const chunkBuffer = fs.readFileSync(chunkPath);
    try {
      const result = await alignTimestamps(chunkBuffer, localSegments, WHISPER_URL);

      if (result.alignmentStatus === 'aligned') {
        // Offset aligned timestamps back to global time
        for (const seg of result.segments) {
          allAligned.push({
            ...seg,
            startMs: seg.startMs + chunkStartMs,
            endMs: seg.endMs + chunkStartMs,
          });
        }
        console.log(`[Main] Chunk ${c + 1}: ${result.segments.length} segments aligned`);
      } else {
        console.warn(`[Main] Chunk ${c + 1}: fallback — ${result.alignmentError}`);
        alignmentStatus = 'partial';
        alignmentError = result.alignmentError;
        // Still add segments with global-offset Gemini timestamps
        for (const seg of chunkSegments) {
          allAligned.push({
            ...seg,
            startMs: Math.round(seg.startMs * geminiScale),
            endMs: Math.round(seg.endMs * geminiScale),
          });
        }
      }
    } finally {
      try { fs.unlinkSync(chunkPath); } catch (_) { /* */ }
    }
  }

  const alignDuration = Date.now() - alignStart;
  console.log(`\n[Main] Total alignment: ${(alignDuration / 1000).toFixed(1)}s, ${allAligned.length} segments`);

  // Clean up audio
  try { fs.unlinkSync(mp3Path); } catch (_) { /* */ }

  const aligned = allAligned;
  const alignResult = { alignmentStatus, alignmentError };
  console.log(`[Main] Aligned segments: ${aligned.length}`);

  // Step 3: Evaluate — compare aligned timestamps AND speakers to ground truth
  const speakerNameMap = new Map<string, string>();
  for (const s of gemini.speakers) speakerNameMap.set(s.label, s.name);

  // Build ground truth name map: speakerId → display name
  const gtNameMap = new Map<string, string>();
  for (const [id, spk] of Object.entries(gtSpeakers)) {
    gtNameMap.set(id, (spk as { name: string }).name);
  }

  // Debug: show the actual name mappings so we can verify matching works
  console.log('\n[Eval] Ground truth speaker names:');
  for (const [id, name] of gtNameMap) {
    console.log(`  ${id} → ${name}`);
  }
  console.log('[Eval] Gemini speaker names:');
  for (const [label, name] of speakerNameMap) {
    console.log(`  ${label} → ${name}`);
  }

  // Evaluate each aligned segment against ground truth
  let speakerCorrect = 0;
  let speakerTotal = 0;
  let speakerMismatches: Array<{ aligned: string; gt: string; timeMs: number }> = [];

  // Timestamp accuracy: compare aligned segment startMs to nearest GT segment start
  const gtTimestampErrors: number[] = [];

  for (const seg of aligned) {
    const midMs = (seg.startMs + seg.endMs) / 2;

    // Find ground truth segment at this time
    const gtSeg = gtSegments.find(g => midMs >= g.startMs && midMs <= g.endMs);
    if (!gtSeg) continue;

    speakerTotal++;

    // Compare speaker names (Gemini name vs GT name)
    const geminiName = (speakerNameMap.get(seg.speakerId) || seg.speakerId).toLowerCase();
    const gtName = (gtNameMap.get(gtSeg.speakerId) || '').toLowerCase();

    // Fuzzy first-name match — handle "sam" vs "sammy", "jj" vs "jj jonathan", etc.
    const gFirst = geminiName.split(' ')[0];
    const gtFirst = gtName.split(' ')[0];

    let match = false;
    if (gFirst && gtFirst && gFirst.length > 1 && gtFirst.length > 1) {
      match = gFirst.includes(gtFirst) || gtFirst.includes(gFirst);
    }
    // Also try "sammy" ↔ "sam" (prefix match)
    if (!match && gFirst && gtFirst) {
      match = gFirst.startsWith(gtFirst) || gtFirst.startsWith(gFirst);
    }

    if (match) {
      speakerCorrect++;
    } else {
      speakerMismatches.push({ aligned: geminiName, gt: gtName, timeMs: midMs });
    }

    // Timestamp accuracy: how close is aligned start to the nearest GT boundary?
    let minGtError = Infinity;
    for (const g of gtSegments) {
      const err = Math.abs(seg.startMs - g.startMs);
      if (err < minGtError) minGtError = err;
    }
    gtTimestampErrors.push(minGtError);
  }

  const avgTsError = gtTimestampErrors.length > 0
    ? gtTimestampErrors.reduce((a, b) => a + b, 0) / gtTimestampErrors.length : 0;
  const medTsError = gtTimestampErrors.length > 0
    ? [...gtTimestampErrors].sort((a, b) => a - b)[Math.floor(gtTimestampErrors.length / 2)] : 0;
  const maxTsError = gtTimestampErrors.length > 0 ? Math.max(...gtTimestampErrors) : 0;

  // Also compute HARDY correction magnitude (how much HARDY moved from Gemini)
  const hardyCorrections: number[] = [];
  for (let i = 0; i < Math.min(aligned.length, gemini.segments.length); i++) {
    hardyCorrections.push(Math.abs(aligned[i].startMs - gemini.segments[i].startMs));
  }
  const avgCorrection = hardyCorrections.length > 0
    ? hardyCorrections.reduce((a, b) => a + b, 0) / hardyCorrections.length : 0;

  // Save results
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const resultPath = path.join(RESULTS_DIR, 'phase3_hardy_real.json');
  fs.writeFileSync(resultPath, JSON.stringify({
    conversationId,
    timestamp: new Date().toISOString(),
    gemini: {
      speakers: gemini.speakers,
      segmentCount: gemini.segments.length,
      tokenUsage: gemini.tokenUsage,
      durationMs: gemini.durationMs,
    },
    alignment: {
      status: alignResult.alignmentStatus,
      error: alignResult.alignmentError,
      segmentCount: aligned.length,
      durationMs: alignDuration,
    },
    evaluation: {
      speakerAccuracy: `${speakerCorrect}/${speakerTotal} (${speakerTotal > 0 ? ((speakerCorrect / speakerTotal) * 100).toFixed(1) : 'N/A'}%)`,
      speakerMismatches: speakerMismatches.slice(0, 20),
      timestampVsGroundTruth: {
        avgErrorMs: Math.round(avgTsError),
        medianErrorMs: Math.round(medTsError),
        maxErrorMs: Math.round(maxTsError),
      },
      hardyCorrectionFromGemini: {
        avgMs: Math.round(avgCorrection),
      },
    },
    sampleAligned: aligned.slice(0, 20).map((a, i) => {
      const midMs = (a.startMs + a.endMs) / 2;
      const gtSeg = gtSegments.find(g => midMs >= g.startMs && midMs <= g.endMs);
      return {
        speaker: speakerNameMap.get(a.speakerId) || a.speakerId,
        gtSpeaker: gtSeg ? (gtNameMap.get(gtSeg.speakerId) || gtSeg.speakerId) : '?',
        alignedStart: a.startMs,
        alignedEnd: a.endMs,
        gtSegStart: gtSeg?.startMs,
        geminiStart: gemini.segments[i]?.startMs,
        text: a.text.substring(0, 60),
      };
    }),
    groundTruth: {
      segmentCount: gtSegments.length,
      speakerCount: Object.keys(gtSpeakers).length,
    },
  }, null, 2));

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('PHASE 3: REAL HARDY ALIGNMENT RESULTS');
  console.log('='.repeat(70));
  console.log(`Gemini speakers:       ${gemini.speakers.length}`);
  console.log(`Gemini segments:       ${gemini.segments.length}`);
  console.log(`Gemini tokens:         ${gemini.tokenUsage.completion} / 65536 (${((gemini.tokenUsage.completion / 65536) * 100).toFixed(1)}%)`);
  console.log('');
  console.log(`Alignment status:      ${alignResult.alignmentStatus}`);
  console.log(`Alignment duration:    ${(alignDuration / 1000).toFixed(1)}s`);
  console.log(`Aligned segments:      ${aligned.length}`);
  console.log('');
  console.log('--- Timestamp Quality (aligned vs ground truth) ---');
  console.log(`Avg error:             ${(avgTsError / 1000).toFixed(1)}s`);
  console.log(`Median error:          ${(medTsError / 1000).toFixed(1)}s`);
  console.log(`Max error:             ${(maxTsError / 1000).toFixed(1)}s`);
  console.log(`HARDY avg correction:  ${(avgCorrection / 1000).toFixed(1)}s (from Gemini → aligned)`);
  console.log('');
  console.log('--- Speaker Accuracy ---');
  console.log(`Correct:               ${speakerCorrect}/${speakerTotal} (${speakerTotal > 0 ? ((speakerCorrect / speakerTotal) * 100).toFixed(1) : 'N/A'}%)`);
  if (speakerMismatches.length > 0) {
    console.log(`Sample mismatches:`);
    for (const m of speakerMismatches.slice(0, 5)) {
      console.log(`  at ${(m.timeMs / 1000).toFixed(0)}s: Gemini="${m.aligned}" vs GT="${m.gt}"`);
    }
  }
  console.log('');

  console.log('Sample (first 10):');
  console.log(`${'Gemini'.padEnd(10)} ${'GT'.padEnd(12)} ${'Aligned'.padEnd(14)} ${'GT Start'.padEnd(10)} ${'Match'.padEnd(6)} Text`);
  for (let i = 0; i < Math.min(10, aligned.length); i++) {
    const a = aligned[i];
    const midMs = (a.startMs + a.endMs) / 2;
    const gtSeg = gtSegments.find(g => midMs >= g.startMs && midMs <= g.endMs);
    const name = (speakerNameMap.get(a.speakerId) || a.speakerId).substring(0, 8);
    const gtName = gtSeg ? (gtNameMap.get(gtSeg.speakerId) || '?').substring(0, 10) : '?';
    const aRange = `${(a.startMs / 1000).toFixed(0)}s-${(a.endMs / 1000).toFixed(0)}s`;
    const gtStart = gtSeg ? `${(gtSeg.startMs / 1000).toFixed(0)}s` : '?';
    const gName = (speakerNameMap.get(a.speakerId) || '').toLowerCase().split(' ')[0];
    const gtN = gtSeg ? (gtNameMap.get(gtSeg.speakerId) || '').toLowerCase().split(' ')[0] : '';
    const match = gName && gtN && (gName.startsWith(gtN) || gtN.startsWith(gName)) ? '✓' : '✗';
    console.log(`${name.padEnd(10)} ${gtName.padEnd(12)} ${aRange.padEnd(14)} ${gtStart.padEnd(10)} ${match.padEnd(6)} ${a.text.substring(0, 35)}...`);
  }

  console.log(`\nResults saved to: ${resultPath}`);
}

main().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
