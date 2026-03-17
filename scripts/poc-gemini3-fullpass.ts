#!/usr/bin/env tsx
/**
 * Phase 2b: Gemini 3 Flash — Full Single-Pass (Analysis + Diarization)
 *
 * The big question: can one Gemini 3 Flash call produce BOTH content
 * analysis AND a coarse speaker diarization timeline without hitting
 * the 65K output token ceiling?
 *
 * Phase 2 used 965 tokens for content analysis alone. A coarse timeline
 * of ~300 speaker turns at ~25 tokens each adds ~7,500 tokens. If this
 * works, we get a single-API architecture: one call, full pipeline.
 *
 * The key trick: we ask for speaker TURNS only (speaker + startMs + endMs),
 * NOT per-sentence transcript text. Text reproduction is what killed the
 * original Gemini 2.5 Flash diarization attempts.
 *
 * Usage:
 *   npx tsx scripts/poc-gemini3-fullpass.ts [conversationId] [iteration]
 *
 * Output:
 *   .agent_process/work/poc_gemini_hybrid/<iteration>/results/gemini3_fullpass.json
 *   .agent_process/work/poc_gemini_hybrid/<iteration>/results/phase2b_gemini3.md
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
setGlobalDispatcher(new Agent({
  headersTimeout: 600_000,
  bodyTimeout: 600_000,
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCOPE = 'poc_gemini_hybrid';
const { iteration: ITERATION, resultsDir: RESULTS_DIR } = resolvePocResultsDir(
  PROJECT_ROOT,
  SCOPE,
  process.argv[3],
);

// ============================================================================
// Types
// ============================================================================

interface SpeakerIdentification {
  label: string;
  name: string;
  role?: string;
  description?: string;
}

interface DiarizationSegment {
  speaker: string;   // Must match a speaker label
  startMs: number;
  endMs: number;
}

interface AnalysisTerm {
  key: string;
  display: string;
  definition: string;
  aliases: string[];
}

interface AnalysisTopic {
  title: string;
  startApproxMs: number;
  endApproxMs: number;
  type: 'main' | 'tangent';
}

interface AnalysisPerson {
  name: string;
  affiliation?: string;
}

interface FullPassResult {
  speakers: SpeakerIdentification[];
  speakerCount: number;
  segments: DiarizationSegment[];
  terms: AnalysisTerm[];
  topics: AnalysisTopic[];
  persons: AnalysisPerson[];
}

interface FullPassBenchmarkResult {
  conversationId: string;
  model: string;
  timestamp: string;
  durationMs: number;
  uploadDurationMs: number;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  result: FullPassResult;
  rawText?: string;
  groundTruth: {
    speakerNames: string[];
    expectedSpeakers: number;
    existingSegments: number;
    existingSpeakers: number;
  };
}

// ============================================================================
// Firebase init
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
    storageBucket: 'audio-transcript-analyzer-01.firebasestorage.app',
  });
}

// ============================================================================
// Audio download + optional WAV conversion
// ============================================================================

// WAV=1 converts the MP3 to WAV before sending to Gemini.
// Hypothesis: MP3's variable bitrate frames may cause timestamp drift.
const CONVERT_TO_WAV = process.env.WAV === '1';

/** Convert MP3 to 16-bit PCM WAV — returns path to new WAV file */
function convertToWav(inputPath: string): string {
  const wavPath = inputPath.replace(/\.[^.]+$/, '.wav');
  console.log(`[Convert] MP3 → WAV (16-bit PCM, mono, 16kHz)...`);
  execFileSync('ffmpeg', [
    '-y', '-i', inputPath,
    '-ar', '16000',    // 16kHz sample rate — plenty for speech
    '-ac', '1',        // mono
    '-sample_fmt', 's16', // 16-bit signed int
    wavPath,
  ], { stdio: 'pipe' });
  const stats = fs.statSync(wavPath);
  console.log(`[Convert] WAV file: ${(stats.size / 1024 / 1024).toFixed(1)}MB`);
  return wavPath;
}

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
  const tmpPath = path.join(tmpDir, `poc-gemini3fp-${Date.now()}${ext}`);

  await file.download({ destination: tmpPath });
  const stats = fs.statSync(tmpPath);
  console.log(`[Download] Saved ${(stats.size / 1024 / 1024).toFixed(1)}MB to ${tmpPath}`);

  return tmpPath;
}

// ============================================================================
// The prompt — analysis + coarse diarization in one pass
// ============================================================================

const FULLPASS_PROMPT = `You are an expert audio transcription analyst. Listen to this entire recording carefully.

## Your Tasks

### 1. Speaker Identification
Identify every distinct speaker in this recording. For each speaker:
- Assign a label ("Speaker 1", "Speaker 2", etc.)
- Identify their actual name if mentioned in conversation
- Note their role (e.g., "presenter", "client lead", "questioner")
- Describe how you identified them

Be conservative — do NOT create separate speakers for the same person.

Also provide "speakerCount" — the total number of distinct speakers you identified.

### 2. Speaker Timeline (Diarization)
Produce a COARSE timeline of speaker turns covering the ENTIRE recording.

CRITICAL RULES:
- Each entry = one speaker's CONTINUOUS turn (from when they start until someone else speaks)
- Do NOT include any transcript text — ONLY speaker label, startMs, endMs
- Merge consecutive speech by the same speaker into one entry
- The "speaker" field MUST exactly match a label from the speakers list (e.g., "Speaker 1")
- For a 45-minute conversation, expect 100-400 entries
- Cover the FULL recording from start to finish — do not stop early
- Timestamps are in milliseconds from the start of the audio

### 3. Terms
Extract domain-specific or noteworthy terms/concepts discussed. For each:
- "key": lowercase identifier (e.g., "machine_learning")
- "display": how it should be displayed
- "definition": brief definition in context of this conversation
- "aliases": alternative names/abbreviations used

### 4. Topics
Identify major topics/segments of the conversation. For each:
- "title": descriptive title
- "startApproxMs": approximate start time in milliseconds
- "endApproxMs": approximate end time in milliseconds
- "type": "main" for primary topics, "tangent" for digressions

### 5. Persons
People mentioned in the conversation who are NOT speakers. For each:
- "name": full name as mentioned
- "affiliation": organization/role if mentioned

## Important
- Cover the ENTIRE recording — do not stop early
- The segments array is the most important output — ensure complete coverage
- NO transcript text in segments — only speaker, startMs, endMs`;

// ============================================================================
// Gemini 3 Flash — full single-pass
// ============================================================================

async function runGemini3FullPass(
  audioPath: string,
  conversationId: string,
): Promise<FullPassBenchmarkResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not found in environment. Check your .env file.');
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: 600_000 },
  });

  const model = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';

  // Upload audio
  console.log('[Gemini] Uploading audio to Files API...');
  const uploadStart = Date.now();
  const uploadedFile = await ai.files.upload({
    file: audioPath,
    config: {
      mimeType: CONVERT_TO_WAV ? 'audio/wav' : 'audio/mpeg',
      displayName: `poc-fullpass-${conversationId}`,
    },
  });
  const uploadDuration = Date.now() - uploadStart;
  console.log(`[Gemini] Upload complete in ${(uploadDuration / 1000).toFixed(1)}s`);

  if (!uploadedFile.uri || !uploadedFile.mimeType) {
    throw new Error('File upload succeeded but missing URI or mimeType in response');
  }

  // Wait for processing
  let fileState = uploadedFile.state;
  let waitAttempts = 0;
  while (fileState === 'PROCESSING') {
    waitAttempts++;
    if (waitAttempts > 60) {
      throw new Error('File processing timed out after 60 attempts');
    }
    console.log(`[Gemini] File still processing... (attempt ${waitAttempts})`);
    await new Promise(r => setTimeout(r, 2000));
    const fileInfo = await ai.files.get({ name: uploadedFile.name! });
    fileState = fileInfo.state;
  }

  if (fileState === 'FAILED') {
    throw new Error('File processing failed on Gemini side');
  }

  console.log(`[Gemini] Model: ${model}`);
  console.log('[Gemini] Sending FULL PASS request (analysis + diarization timeline)...');
  const apiStart = Date.now();

  let response;
  try {
    response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            createPartFromUri(uploadedFile.uri, uploadedFile.mimeType!),
            { text: FULLPASS_PROMPT },
          ],
        },
      ],
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
                  description: { type: 'string' },
                },
                required: ['label', 'name'],
                propertyOrdering: ['label', 'name', 'role', 'description'],
              },
            },
            speakerCount: { type: 'number' },
            segments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  speaker: { type: 'string' },
                  startMs: { type: 'number' },
                  endMs: { type: 'number' },
                },
                required: ['speaker', 'startMs', 'endMs'],
                propertyOrdering: ['speaker', 'startMs', 'endMs'],
              },
            },
            terms: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  display: { type: 'string' },
                  definition: { type: 'string' },
                  aliases: { type: 'array', items: { type: 'string' } },
                },
                required: ['key', 'display', 'definition'],
                propertyOrdering: ['key', 'display', 'definition', 'aliases'],
              },
            },
            topics: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  startApproxMs: { type: 'number' },
                  endApproxMs: { type: 'number' },
                  type: { type: 'string', enum: ['main', 'tangent'] },
                },
                required: ['title', 'startApproxMs', 'endApproxMs', 'type'],
                propertyOrdering: ['title', 'startApproxMs', 'endApproxMs', 'type'],
              },
            },
            persons: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  affiliation: { type: 'string' },
                },
                required: ['name'],
                propertyOrdering: ['name', 'affiliation'],
              },
            },
          },
          required: ['speakers', 'speakerCount', 'segments', 'terms', 'topics', 'persons'],
          propertyOrdering: ['speakers', 'speakerCount', 'segments', 'terms', 'topics', 'persons'],
        },
      },
    });
  } catch (err: unknown) {
    const e = err as Error & { cause?: Error };
    if (e.cause) {
      console.error('[Gemini] Underlying cause:', e.cause.message || e.cause);
    }
    throw err;
  }

  const apiDuration = Date.now() - apiStart;
  console.log(`[Gemini] Response received in ${(apiDuration / 1000).toFixed(1)}s`);

  const rawText = response.text ?? '';
  const usage = response.usageMetadata;

  console.log(`[Gemini] Token usage: prompt=${usage?.promptTokenCount ?? '?'}, completion=${usage?.candidatesTokenCount ?? '?'}, total=${usage?.totalTokenCount ?? '?'}`);

  // Parse — reuse the truncation repair from poc-gemini-diarize.ts
  let parsed: FullPassResult;
  try {
    parsed = parseGeminiJson(rawText);
  } catch (_err) {
    console.error('[Gemini] Failed to parse JSON response. Saving raw text.');
    return {
      conversationId,
      model,
      timestamp: new Date().toISOString(),
      durationMs: apiDuration,
      uploadDurationMs: uploadDuration,
      tokenUsage: {
        promptTokens: usage?.promptTokenCount ?? 0,
        completionTokens: usage?.candidatesTokenCount ?? 0,
        totalTokens: usage?.totalTokenCount ?? 0,
      },
      result: { speakers: [], speakerCount: 0, segments: [], terms: [], topics: [], persons: [] },
      rawText,
      groundTruth: {
        speakerNames: ['JJ Jonathan', 'Adam', 'Sanjay', 'Chris Savage', 'Dhaval', 'Sammy'],
        expectedSpeakers: 6,
        existingSegments: 0,
        existingSpeakers: 0,
      },
    };
  }

  console.log(`[Gemini] Parsed: ${parsed.speakers.length} speakers, ${(parsed.segments || []).length} segments`);
  console.log(`[Gemini] Terms: ${(parsed.terms || []).length}, Topics: ${(parsed.topics || []).length}, Persons: ${(parsed.persons || []).length}`);

  // Clean up uploaded file
  try {
    await ai.files.delete({ name: uploadedFile.name! });
    console.log('[Gemini] Cleaned up uploaded file');
  } catch (_err) {
    console.warn('[Gemini] Failed to clean up uploaded file (non-fatal)');
  }

  return {
    conversationId,
    model,
    timestamp: new Date().toISOString(),
    durationMs: apiDuration,
    uploadDurationMs: uploadDuration,
    tokenUsage: {
      promptTokens: usage?.promptTokenCount ?? 0,
      completionTokens: usage?.candidatesTokenCount ?? 0,
      totalTokens: usage?.totalTokenCount ?? 0,
    },
    result: parsed,
    groundTruth: {
      speakerNames: ['JJ Jonathan', 'Adam', 'Sanjay', 'Chris Savage', 'Dhaval', 'Sammy'],
      expectedSpeakers: 6,
      existingSegments: 0,
      existingSpeakers: 0,
    },
  };
}

/**
 * Parse JSON from Gemini response — handles markdown fences and truncation.
 * Borrowed from poc-gemini-diarize.ts because Gemini occasionally hits the
 * output ceiling mid-JSON and we'd rather have 80% of the data than 0%.
 */
function parseGeminiJson(text: string): FullPassResult {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '');
    cleaned = cleaned.replace(/\n?```\s*$/, '');
  }

  try {
    return JSON.parse(cleaned);
  } catch (_firstErr) {
    // Not valid JSON — likely truncated
  }

  console.warn('[Gemini] JSON truncated — attempting repair...');
  const lastComplete = cleaned.lastIndexOf('},');
  if (lastComplete > 0) {
    let repaired = cleaned.substring(0, lastComplete + 1);
    const openBrackets = (repaired.match(/\[/g) || []).length - (repaired.match(/\]/g) || []).length;
    const openBraces = (repaired.match(/\{/g) || []).length - (repaired.match(/\}/g) || []).length;
    repaired += ']'.repeat(Math.max(0, openBrackets)) + '}'.repeat(Math.max(0, openBraces));

    try {
      const result = JSON.parse(repaired);
      const segs = (result.segments || []).length;
      console.warn(`[Gemini] Repair succeeded — recovered ${segs} segments (some tail data lost)`);
      return result;
    } catch (_repairErr) {
      // Repair didn't work
    }
  }

  const lastBrace = cleaned.lastIndexOf('}');
  if (lastBrace !== -1) {
    cleaned = cleaned.substring(0, lastBrace + 1);
  }
  return JSON.parse(cleaned);
}

// ============================================================================
// Report generation
// ============================================================================

function generateReport(result: FullPassBenchmarkResult): string {
  const lines: string[] = [];
  lines.push('# Gemini 3 Flash Full Single-Pass Benchmark (Phase 2b)');
  lines.push('');
  lines.push(`**Date:** ${result.timestamp}`);
  lines.push(`**Conversation:** ${result.conversationId}`);
  lines.push(`**Model:** ${result.model}`);
  lines.push(`**API Duration:** ${(result.durationMs / 1000).toFixed(1)}s`);
  lines.push(`**Upload Duration:** ${(result.uploadDurationMs / 1000).toFixed(1)}s`);
  lines.push(`**Tokens:** ${result.tokenUsage.totalTokens} total (${result.tokenUsage.promptTokens} prompt + ${result.tokenUsage.completionTokens} completion)`);
  lines.push('');

  // Output budget — the key metric for this test
  const pct = ((result.tokenUsage.completionTokens / 65536) * 100).toFixed(1);
  lines.push('## Output Token Budget (THE key metric)');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Completion tokens used | **${result.tokenUsage.completionTokens}** |`);
  lines.push(`| Output ceiling | 65,536 |`);
  lines.push(`| Budget used | **${pct}%** |`);
  lines.push(`| Truncation risk | ${Number(pct) > 80 ? '**HIGH**' : Number(pct) > 50 ? '**MEDIUM**' : '**LOW**'} |`);
  lines.push(`| Phase 2 (analysis only) | 965 tokens (1.5%) |`);
  lines.push('');

  // Speaker identification
  lines.push('## Speaker Identification');
  lines.push('');
  lines.push(`Gemini identified **${result.result.speakerCount}** speakers (expected: ${result.groundTruth.expectedSpeakers}).`);
  lines.push('');
  lines.push('| Label | Name | Role | How Identified |');
  lines.push('|-------|------|------|----------------|');
  for (const s of result.result.speakers) {
    const desc = s.description ? s.description.substring(0, 60) + (s.description.length > 60 ? '...' : '') : '—';
    lines.push(`| ${s.label} | ${s.name} | ${s.role ?? '—'} | ${desc} |`);
  }
  lines.push('');

  // Ground truth name matching
  const gtNames = result.groundTruth.speakerNames;
  const identifiedNames = result.result.speakers.map(s => s.name.toLowerCase());
  const matched = gtNames.filter(gt =>
    identifiedNames.some(id => id.includes(gt.split(' ')[0].toLowerCase())),
  );
  lines.push('### Ground Truth Name Match');
  lines.push('');
  lines.push(`| Ground Truth | Identified? |`);
  lines.push(`|-------------|-------------|`);
  for (const gt of gtNames) {
    const found = identifiedNames.some(id => id.includes(gt.split(' ')[0].toLowerCase()));
    lines.push(`| ${gt} | ${found ? 'Yes' : 'No'} |`);
  }
  lines.push(`| **Match rate** | **${matched.length}/${gtNames.length}** |`);
  lines.push('');

  // Diarization segments
  const segs = result.result.segments || [];
  lines.push('## Diarization Timeline');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total segments | ${segs.length} |`);
  lines.push(`| Ground truth segments | ${result.groundTruth.existingSegments} |`);

  if (segs.length > 0) {
    const lastSeg = segs[segs.length - 1];
    const coverageMs = lastSeg.endMs;
    lines.push(`| Timeline coverage | ${(coverageMs / 1000 / 60).toFixed(1)} min |`);
    lines.push(`| First segment | ${segs[0].speaker} at ${(segs[0].startMs / 1000).toFixed(1)}s |`);
    lines.push(`| Last segment | ${lastSeg.speaker} ends at ${(lastSeg.endMs / 1000).toFixed(1)}s |`);

    // Speaker distribution from segments
    const dist: Record<string, { count: number; durationMs: number }> = {};
    for (const seg of segs) {
      if (!dist[seg.speaker]) dist[seg.speaker] = { count: 0, durationMs: 0 };
      dist[seg.speaker].count++;
      dist[seg.speaker].durationMs += seg.endMs - seg.startMs;
    }
    lines.push('');
    lines.push('### Speaker Distribution (from segments)');
    lines.push('');
    lines.push('| Speaker | Segments | Duration | % of Total |');
    lines.push('|---------|----------|----------|-----------|');
    const totalDur = Object.values(dist).reduce((s, d) => s + d.durationMs, 0);
    const sorted = Object.entries(dist).sort((a, b) => b[1].durationMs - a[1].durationMs);
    for (const [speaker, stats] of sorted) {
      const pctDur = ((stats.durationMs / totalDur) * 100).toFixed(1);
      lines.push(`| ${speaker} | ${stats.count} | ${(stats.durationMs / 1000 / 60).toFixed(1)}m | ${pctDur}% |`);
    }
  }
  lines.push('');

  // Sample segments
  if (segs.length > 0) {
    lines.push('### Sample Segments (first 15)');
    lines.push('');
    lines.push('| # | Speaker | Start | End | Duration |');
    lines.push('|---|---------|-------|-----|----------|');
    for (let i = 0; i < Math.min(15, segs.length); i++) {
      const seg = segs[i];
      const dur = ((seg.endMs - seg.startMs) / 1000).toFixed(1);
      lines.push(`| ${i + 1} | ${seg.speaker} | ${(seg.startMs / 1000).toFixed(1)}s | ${(seg.endMs / 1000).toFixed(1)}s | ${dur}s |`);
    }
    lines.push('');

    if (segs.length > 15) {
      lines.push('### Sample Segments (last 10)');
      lines.push('');
      lines.push('| # | Speaker | Start | End | Duration |');
      lines.push('|---|---------|-------|-----|----------|');
      const tail = segs.slice(-10);
      const offset = segs.length - 10;
      for (let i = 0; i < tail.length; i++) {
        const seg = tail[i];
        const dur = ((seg.endMs - seg.startMs) / 1000).toFixed(1);
        lines.push(`| ${offset + i + 1} | ${seg.speaker} | ${(seg.startMs / 1000).toFixed(1)}s | ${(seg.endMs / 1000).toFixed(1)}s | ${dur}s |`);
      }
      lines.push('');
    }
  }

  // Content analysis summary
  lines.push('## Content Analysis');
  lines.push('');
  lines.push(`- **Terms:** ${(result.result.terms || []).length}`);
  lines.push(`- **Topics:** ${(result.result.topics || []).length}`);
  lines.push(`- **Persons:** ${(result.result.persons || []).length}`);
  lines.push('');

  if (result.rawText) {
    lines.push('## WARNING: JSON Parse Failed');
    lines.push('');
    lines.push('Raw response (first 500 chars):');
    lines.push('```');
    lines.push(result.rawText.substring(0, 500));
    lines.push('```');
  }

  return lines.join('\n');
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const conversationId = process.argv[2] || 'c_1773188486911';

  console.log('='.repeat(70));
  console.log(`PoC: Gemini 3 Flash FULL PASS (analysis + diarization) — ${conversationId}`);
  console.log(`[Context] Scope: ${SCOPE}, Iteration: ${ITERATION}`);
  console.log('='.repeat(70));

  initFirebase();
  const db = admin.firestore();

  const convoDoc = await db.collection('conversations').doc(conversationId).get();
  if (!convoDoc.exists) {
    throw new Error(`Conversation ${conversationId} not found in Firestore`);
  }

  const convoData = convoDoc.data()!;
  const audioStoragePath = convoData.audioStoragePath;
  if (!audioStoragePath) {
    throw new Error(`Conversation ${conversationId} has no audioStoragePath`);
  }

  const existingSegments = (convoData.segments || []).length;
  const existingSpeakers = Object.keys(convoData.speakers || {}).length;

  console.log(`[Main] Audio path: ${audioStoragePath}`);
  console.log(`[Main] Duration: ${(convoData.durationMs / 1000 / 60).toFixed(1)} minutes`);
  console.log(`[Main] Existing: ${existingSegments} segments, ${existingSpeakers} speakers`);

  const mp3Path = await downloadAudioToTemp(audioStoragePath);
  let audioPath = mp3Path;

  if (CONVERT_TO_WAV) {
    audioPath = convertToWav(mp3Path);
    console.log(`[Main] Using WAV format for Gemini`);
  }

  try {
    const result = await runGemini3FullPass(audioPath, conversationId);
    result.groundTruth.existingSegments = existingSegments;
    result.groundTruth.existingSpeakers = existingSpeakers;

    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    const suffix = CONVERT_TO_WAV ? '_wav' : '';
    const jsonPath = path.join(RESULTS_DIR, `gemini3_fullpass${suffix}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
    console.log(`[Main] Saved JSON: ${jsonPath}`);

    const reportPath = path.join(RESULTS_DIR, `phase2b_gemini3${suffix}.md`);
    fs.writeFileSync(reportPath, generateReport(result));
    console.log(`[Main] Saved report: ${reportPath}`);

    // Console summary
    const segs = result.result.segments || [];
    const pctBudget = ((result.tokenUsage.completionTokens / 65536) * 100).toFixed(1);

    console.log('\n' + '='.repeat(70));
    console.log('GEMINI 3 FLASH FULL PASS SUMMARY');
    console.log('='.repeat(70));
    console.log(`Output tokens:     ${result.tokenUsage.completionTokens} / 65,536 (${pctBudget}%)`);
    console.log(`Speakers:          ${result.result.speakerCount} (expected: 6)`);
    console.log(`Segments:          ${segs.length} (existing: ${existingSegments})`);
    console.log('');

    for (const s of result.result.speakers) {
      console.log(`  ${s.label.padEnd(12)} → ${s.name} (${s.role ?? '?'})`);
    }

    if (segs.length > 0) {
      const lastSeg = segs[segs.length - 1];
      console.log('');
      console.log(`Timeline:          ${(segs[0].startMs / 1000).toFixed(0)}s → ${(lastSeg.endMs / 1000).toFixed(0)}s`);

      // Quick speaker distribution
      const dist: Record<string, number> = {};
      for (const seg of segs) {
        dist[seg.speaker] = (dist[seg.speaker] || 0) + 1;
      }
      console.log('');
      console.log('Segment distribution:');
      for (const [spk, count] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${spk.padEnd(14)} ${String(count).padStart(4)} segments`);
      }
    }

    console.log('');
    console.log(`Terms: ${(result.result.terms || []).length}, Topics: ${(result.result.topics || []).length}, Persons: ${(result.result.persons || []).length}`);
    console.log(`API duration: ${(result.durationMs / 1000).toFixed(1)}s`);

    if (result.rawText) {
      console.log('\nWARNING: JSON parsing failed — raw text saved');
    }
  } finally {
    try { fs.unlinkSync(mp3Path); } catch (_e) { /* */ }
    if (CONVERT_TO_WAV && audioPath !== mp3Path) {
      try { fs.unlinkSync(audioPath); } catch (_e) { /* */ }
    }
    console.log('[Cleanup] Done');
  }
}

main().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
