#!/usr/bin/env tsx
/**
 * Phase 4: Combined Pipeline PoC
 *
 * Full end-to-end pipeline: Gemini 3 Flash (WAV) for diarization + content
 * analysis, WhisperX for precise timestamps, HARDY alignment to bridge them.
 * Outputs Firestore-compatible format.
 *
 * Usage:
 *   npx tsx scripts/poc-combined-pipeline.ts <conversationId> [iteration]
 *
 * Output:
 *   .agent_process/work/poc_gemini_hybrid/<iteration>/results/<convId>_pipeline_result.json
 *   .agent_process/work/poc_gemini_hybrid/<iteration>/results/<convId>_pipeline_summary.md
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// execFileSync is the safe (no-shell) variant — immune to injection
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
const WHISPER_URL = process.env.WHISPER_URL || 'https://whisperx-service-467135162440.us-east4.run.app';
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

// ============================================================================
// Audio helpers
// ============================================================================

function convertToWav(inputPath: string): string {
  const wavPath = inputPath.replace(/\.[^.]+$/, '.wav');
  console.log(`[Audio] Converting to WAV (16kHz mono)...`);
  execFileSync('ffmpeg', [
    '-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', wavPath,
  ], { stdio: 'pipe' });
  console.log(`[Audio] WAV: ${(fs.statSync(wavPath).size / 1024 / 1024).toFixed(1)}MB`);
  return wavPath;
}

function splitAudioChunks(inputPath: string, durationSec: number, chunkSec = 600): string[] {
  const numChunks = Math.ceil(durationSec / chunkSec);
  if (numChunks <= 1) return [inputPath];

  const chunks: string[] = [];
  for (let i = 0; i < numChunks; i++) {
    const chunkPath = path.join(os.tmpdir(), `poc-pipeline-chunk-${i}-${Date.now()}.mp3`);
    execFileSync('ffmpeg', [
      '-y', '-i', inputPath, '-ss', String(i * chunkSec), '-t', String(chunkSec), '-c', 'copy', chunkPath,
    ], { stdio: 'pipe' });
    chunks.push(chunkPath);
    console.log(`[Audio] Chunk ${i + 1}/${numChunks}: ${(fs.statSync(chunkPath).size / 1024 / 1024).toFixed(1)}MB`);
  }
  return chunks;
}

// ============================================================================
// Step 1: Gemini 3 Flash — diarization + content analysis
// ============================================================================

// The no-text prompt matches poc-gemini3-fullpass.ts — the version that found 6/6 speakers.
// Gemini does diarization only (speaker + timestamps), WhisperX provides the actual text.
const NOTEXT_PROMPT = `You are an expert audio transcription analyst. Listen to this entire recording carefully.

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
- "key": lowercase identifier
- "display": display version (capitalization preserved)
- "definition": brief definition in context
- "aliases": alternative names/abbreviations

### 4. Topics
Identify major topics/segments. For each:
- "title": descriptive title
- "startApproxMs": approximate start time in milliseconds
- "endApproxMs": approximate end time in milliseconds
- "type": "main" for primary topics, "tangent" for digressions

### 5. Persons
People mentioned who are NOT speakers. For each:
- "name": full name as mentioned
- "affiliation": organization/role if mentioned

## Important
- Cover the ENTIRE recording — do not stop early
- The segments array is the most important output — ensure complete coverage
- NO transcript text in segments — only speaker, startMs, endMs`;

const TEXT_PROMPT = `You are an expert audio transcription analyst. Listen to this entire recording carefully.

## Tasks

### 1. Speaker Identification
Identify every distinct speaker. For each:
- Assign a label ("Speaker 1", "Speaker 2", etc.)
- Identify their actual name if mentioned in conversation
- Note their role (e.g., "presenter", "client lead", "questioner")

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
- For a 45-minute conversation, expect 100-400 entries

### 3. Terms
Extract domain-specific or noteworthy terms/concepts. For each:
- "key": lowercase identifier
- "display": display version (capitalization preserved)
- "definition": brief definition in context
- "aliases": alternative names/abbreviations

### 4. Topics
Identify major topics/segments. For each:
- "title": descriptive title
- "startApproxMs": approximate start time in milliseconds
- "endApproxMs": approximate end time in milliseconds
- "type": "main" for primary topics, "tangent" for digressions

### 5. Persons
People mentioned who are NOT speakers. For each:
- "name": full name as mentioned
- "affiliation": organization/role if mentioned`;

const USE_NOTEXT = process.env.NOTEXT === '1';
const GEMINI_PROMPT = USE_NOTEXT ? NOTEXT_PROMPT : TEXT_PROMPT;

async function runGemini(audioPath: string, conversationId: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not found');

  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 600_000 } });
  const model = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';

  console.log('[Gemini] Uploading WAV...');
  const uploadStart = Date.now();
  const uploadedFile = await ai.files.upload({
    file: audioPath,
    config: { mimeType: 'audio/wav', displayName: `pipeline-${conversationId}` },
  });
  console.log(`[Gemini] Upload: ${((Date.now() - uploadStart) / 1000).toFixed(1)}s`);

  let fileState = uploadedFile.state;
  while (fileState === 'PROCESSING') {
    await new Promise(r => setTimeout(r, 2000));
    fileState = (await ai.files.get({ name: uploadedFile.name! })).state;
  }

  console.log(`[Gemini] Calling ${model}... (mode: ${USE_NOTEXT ? 'NO-TEXT diarization only' : 'with transcript text'})`);
  const apiStart = Date.now();

  const response = await ai.models.generateContent({
    model,
    contents: [{
      role: 'user',
      parts: [
        createPartFromUri(uploadedFile.uri!, uploadedFile.mimeType!),
        { text: GEMINI_PROMPT },
      ],
    }],
    config: {
      temperature: parseFloat(process.env.GEMINI_TEMPERATURE || '0.1'),
      maxOutputTokens: 65536,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: 'application/json',
      responseSchema: USE_NOTEXT ? {
        type: 'object',
        properties: {
          speakers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' }, name: { type: 'string' },
                role: { type: 'string' }, description: { type: 'string' },
              },
              required: ['label', 'name'], propertyOrdering: ['label', 'name', 'role', 'description'],
            },
          },
          speakerCount: { type: 'number' },
          segments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                speaker: { type: 'string' }, startMs: { type: 'number' },
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
                key: { type: 'string' }, display: { type: 'string' },
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
                title: { type: 'string' }, startApproxMs: { type: 'number' },
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
              properties: { name: { type: 'string' }, affiliation: { type: 'string' } },
              required: ['name'], propertyOrdering: ['name', 'affiliation'],
            },
          },
        },
        required: ['speakers', 'speakerCount', 'segments', 'terms', 'topics', 'persons'],
        propertyOrdering: ['speakers', 'speakerCount', 'segments', 'terms', 'topics', 'persons'],
      } : {
        type: 'object',
        properties: {
          speakers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' },
              },
              required: ['label', 'name'], propertyOrdering: ['label', 'name', 'role'],
            },
          },
          segments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                speaker: { type: 'string' }, startMs: { type: 'number' },
                endMs: { type: 'number' }, text: { type: 'string' },
              },
              required: ['speaker', 'startMs', 'endMs', 'text'],
              propertyOrdering: ['speaker', 'startMs', 'endMs', 'text'],
            },
          },
          terms: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' }, display: { type: 'string' },
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
                title: { type: 'string' }, startApproxMs: { type: 'number' },
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
              properties: { name: { type: 'string' }, affiliation: { type: 'string' } },
              required: ['name'], propertyOrdering: ['name', 'affiliation'],
            },
          },
        },
        required: ['speakers', 'segments', 'terms', 'topics', 'persons'],
        propertyOrdering: ['speakers', 'segments', 'terms', 'topics', 'persons'],
      },
    },
  });

  const apiDuration = Date.now() - apiStart;
  const usage = response.usageMetadata;
  console.log(`[Gemini] Done in ${(apiDuration / 1000).toFixed(1)}s — tokens: ${usage?.candidatesTokenCount}/${65536} (${(((usage?.candidatesTokenCount ?? 0) / 65536) * 100).toFixed(1)}%)`);

  // Parse with truncation repair
  let cleaned = (response.text ?? '').trim();
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_) {
    console.warn('[Gemini] JSON truncated, repairing...');
    const last = cleaned.lastIndexOf('},');
    if (last > 0) {
      let r = cleaned.substring(0, last + 1);
      r += ']'.repeat(Math.max(0, (r.match(/\[/g) || []).length - (r.match(/\]/g) || []).length));
      r += '}'.repeat(Math.max(0, (r.match(/\{/g) || []).length - (r.match(/\}/g) || []).length));
      parsed = JSON.parse(r);
      console.warn(`[Gemini] Repaired — ${parsed.segments?.length ?? 0} segments`);
    } else {
      throw new Error('JSON parse failed');
    }
  }

  try { await ai.files.delete({ name: uploadedFile.name! }); } catch (_) { /* */ }

  return {
    speakers: parsed.speakers as Array<{ label: string; name: string; role?: string }>,
    segments: parsed.segments as Array<{ speaker: string; text: string; startMs: number; endMs: number }>,
    terms: parsed.terms as Array<{ key: string; display: string; definition: string; aliases?: string[] }>,
    topics: parsed.topics as Array<{ title: string; startApproxMs: number; endApproxMs: number; type: string }>,
    persons: parsed.persons as Array<{ name: string; affiliation?: string }>,
    tokenUsage: { prompt: usage?.promptTokenCount ?? 0, completion: usage?.candidatesTokenCount ?? 0 },
    durationMs: apiDuration,
  };
}

// ============================================================================
// Step 2: HARDY alignment per chunk
// ============================================================================

async function alignChunked(
  mp3Path: string,
  durationSec: number,
  geminiSegments: Array<{ speaker: string; text: string; startMs: number; endMs: number }>,
  alignTimestamps: (...args: unknown[]) => Promise<{ segments: Array<{ speakerId: string; text: string; startMs: number; endMs: number }>; alignmentStatus: string; alignmentError?: string }>,
): Promise<Array<{ speakerId: string; text: string; startMs: number; endMs: number }>> {
  const CHUNK_SEC = 600;
  const chunks = splitAudioChunks(mp3Path, durationSec, CHUNK_SEC);
  const numChunks = chunks.length;
  const audioDurationMs = durationSec * 1000;

  // Pre-scale Gemini timestamps to real time for chunk assignment
  const geminiLastMs = geminiSegments[geminiSegments.length - 1]?.endMs || 1;
  const scale = audioDurationMs / geminiLastMs;

  const allAligned: Array<{ speakerId: string; text: string; startMs: number; endMs: number }> = [];

  for (let c = 0; c < numChunks; c++) {
    const chunkStartMs = c * CHUNK_SEC * 1000;
    const chunkEndMs = Math.min((c + 1) * CHUNK_SEC * 1000, audioDurationMs);

    console.log(`\n[HARDY] Chunk ${c + 1}/${numChunks}: ${c * CHUNK_SEC}s-${Math.min((c + 1) * CHUNK_SEC, durationSec)}s`);

    // Find Gemini segments whose scaled midpoint falls in this chunk
    const chunkGeminiSegs = geminiSegments.filter(s => {
      const scaledMid = ((s.startMs + s.endMs) / 2) * scale;
      return scaledMid >= chunkStartMs && scaledMid < chunkEndMs;
    });

    if (chunkGeminiSegs.length === 0) {
      console.log(`[HARDY] No segments for this chunk, skipping`);
      if (chunks[c] !== mp3Path) try { fs.unlinkSync(chunks[c]); } catch (_) { /* */ }
      continue;
    }

    // Convert to chunk-local timestamps
    const localSegs = chunkGeminiSegs.map(s => ({
      speakerId: s.speaker,
      text: s.text,
      startMs: Math.max(0, Math.round(s.startMs * scale - chunkStartMs)),
      endMs: Math.round(s.endMs * scale - chunkStartMs),
    }));

    console.log(`[HARDY] ${localSegs.length} segments → alignment`);

    const chunkBuffer = fs.readFileSync(chunks[c]);
    try {
      const result = await alignTimestamps(chunkBuffer, localSegs, WHISPER_URL);

      if (result.alignmentStatus === 'aligned') {
        for (const seg of result.segments) {
          allAligned.push({
            speakerId: seg.speakerId,
            text: seg.text,
            startMs: seg.startMs + chunkStartMs,
            endMs: seg.endMs + chunkStartMs,
          });
        }
        console.log(`[HARDY] ✓ ${result.segments.length} segments aligned`);
      } else {
        console.warn(`[HARDY] Fallback: ${result.alignmentError}`);
        for (const seg of chunkGeminiSegs) {
          allAligned.push({
            speakerId: seg.speaker,
            text: seg.text,
            startMs: Math.round(seg.startMs * scale),
            endMs: Math.round(seg.endMs * scale),
          });
        }
      }
    } finally {
      if (chunks[c] !== mp3Path) try { fs.unlinkSync(chunks[c]); } catch (_) { /* */ }
    }
  }

  return allAligned;
}

// ============================================================================
// Step 3: Convert to Firestore format
// ============================================================================

function toFirestoreFormat(
  gemini: Awaited<ReturnType<typeof runGemini>>,
  aligned: Array<{ speakerId: string; text: string; startMs: number; endMs: number }>,
  durationMs: number,
) {
  // Build speaker map: "Speaker 1" → "speaker_0"
  const speakerIdMap = new Map<string, string>();
  const speakers: Record<string, { speakerId: string; displayName: string; colorIndex: number }> = {};

  gemini.speakers.forEach((s, i) => {
    const id = `speaker_${i}`;
    speakerIdMap.set(s.label, id);
    const displayName = s.role ? `${s.name} (${s.role})` : s.name;
    speakers[id] = { speakerId: id, displayName, colorIndex: i };
  });

  // Build segments
  const segments = aligned.map((seg, i) => ({
    segmentId: `seg_${i}`,
    index: i,
    speakerId: speakerIdMap.get(seg.speakerId) || seg.speakerId,
    startMs: seg.startMs,
    endMs: seg.endMs,
    text: seg.text,
  }));

  // Build terms
  const terms: Record<string, { termId: string; key: string; display: string; definition: string; aliases: string[] }> = {};
  gemini.terms.forEach((t, i) => {
    const id = `t_${i}`;
    terms[id] = { termId: id, key: t.key, display: t.display, definition: t.definition, aliases: t.aliases || [] };
  });

  // Build term occurrences via regex
  const termOccurrences: Array<{ occurrenceId: string; termId: string; segmentId: string; startChar: number; endChar: number }> = [];
  let occCount = 0;
  for (const seg of segments) {
    for (const [termId, term] of Object.entries(terms)) {
      const patterns = [term.display, ...term.aliases].filter(Boolean);
      for (const pattern of patterns) {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'gi');
        let match;
        while ((match = regex.exec(seg.text)) !== null) {
          termOccurrences.push({
            occurrenceId: `occ_${occCount++}`,
            termId,
            segmentId: seg.segmentId,
            startChar: match.index,
            endChar: match.index + match[0].length,
          });
        }
      }
    }
  }

  // Build topics — map Gemini's approximate timestamps to segment indices
  const topics = gemini.topics.map((t, i) => {
    // Scale Gemini topic timestamps the same way we scaled segment timestamps
    const geminiLastMs = gemini.segments[gemini.segments.length - 1]?.endMs || 1;
    const scale = durationMs / geminiLastMs;
    const scaledStart = t.startApproxMs * scale;
    const scaledEnd = t.endApproxMs * scale;

    let startIndex = 0;
    let endIndex = segments.length - 1;
    for (let s = 0; s < segments.length; s++) {
      if (segments[s].startMs >= scaledStart) { startIndex = s; break; }
    }
    for (let s = segments.length - 1; s >= 0; s--) {
      if (segments[s].startMs <= scaledEnd) { endIndex = s; break; }
    }
    return {
      topicId: `top_${i}`,
      title: t.title,
      startIndex,
      endIndex,
      type: t.type as 'main' | 'tangent',
    };
  });

  // Build people
  const people: Array<{ personId: string; name: string; affiliation?: string }> = [];
  gemini.speakers.forEach((s, i) => {
    const entry: { personId: string; name: string; affiliation?: string } = {
      personId: `p_${i}`, name: s.name,
    };
    if (s.role) entry.affiliation = `Speaker (${s.role})`;
    people.push(entry);
  });
  gemini.persons.forEach((p, i) => {
    const entry: { personId: string; name: string; affiliation?: string } = {
      personId: `p_${gemini.speakers.length + i}`, name: p.name,
    };
    if (p.affiliation) entry.affiliation = p.affiliation;
    people.push(entry);
  });

  return { speakers, segments, terms, termOccurrences, topics, people, durationMs };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const conversationId = process.argv[2];
  if (!conversationId) {
    console.error('Usage: npx tsx scripts/poc-combined-pipeline.ts <conversationId> [iteration]');
    process.exit(1);
  }

  console.log('='.repeat(70));
  console.log(`Combined Pipeline PoC — ${conversationId}`);
  console.log(`[Context] Scope: ${SCOPE}, Iteration: ${ITERATION}`);
  console.log('='.repeat(70));

  const pipelineStart = Date.now();
  initFirebase();
  const db = admin.firestore();

  const convoDoc = await db.collection('conversations').doc(conversationId).get();
  if (!convoDoc.exists) throw new Error(`Conversation ${conversationId} not found`);
  const convoData = convoDoc.data()!;
  const audioStoragePath = convoData.audioStoragePath as string;
  const audioDurationMs = convoData.durationMs || 0;
  const existingSegments = (convoData.segments || []).length;
  const existingSpeakers = Object.keys(convoData.speakers || {}).length;

  console.log(`[Main] Audio: ${audioStoragePath}`);
  console.log(`[Main] Duration: ${(audioDurationMs / 1000 / 60).toFixed(1)} min`);
  console.log(`[Main] Existing: ${existingSegments} segments, ${existingSpeakers} speakers`);

  // Download audio
  const bucket = admin.storage().bucket();
  const mp3Path = path.join(os.tmpdir(), `poc-pipeline-${Date.now()}.mp3`);
  await bucket.file(audioStoragePath).download({ destination: mp3Path });
  console.log(`[Download] ${(fs.statSync(mp3Path).size / 1024 / 1024).toFixed(1)}MB`);

  // Step 1: Convert to WAV and run Gemini
  const wavPath = convertToWav(mp3Path);

  console.log('\n' + '─'.repeat(70));
  console.log('STEP 1: Gemini 3 Flash (diarization + content analysis)');
  console.log('─'.repeat(70));

  let gemini;
  try {
    gemini = await runGemini(wavPath, conversationId);
  } finally {
    try { fs.unlinkSync(wavPath); } catch (_) { /* */ }
  }

  console.log(`[Gemini] ${gemini.speakers.length} speakers, ${gemini.segments.length} segments`);
  for (const s of gemini.speakers) {
    console.log(`  ${s.label} → ${s.name} (${s.role ?? '?'})`);
  }
  console.log(`[Gemini] Terms: ${gemini.terms.length}, Topics: ${gemini.topics.length}, Persons: ${gemini.persons.length}`);

  // Step 2: HARDY alignment with WhisperX
  console.log('\n' + '─'.repeat(70));
  console.log('STEP 2: HARDY alignment (WhisperX timestamps)');
  console.log('─'.repeat(70));

  const alignmentMod = await import(path.join(PROJECT_ROOT, 'functions', 'lib', 'alignment.js'));
  const aligned = await alignChunked(
    mp3Path,
    audioDurationMs / 1000,
    gemini.segments,
    alignmentMod.alignTimestamps,
  );

  try { fs.unlinkSync(mp3Path); } catch (_) { /* */ }

  console.log(`\n[HARDY] Total aligned: ${aligned.length} segments`);

  // Step 3: Convert to Firestore format
  console.log('\n' + '─'.repeat(70));
  console.log('STEP 3: Assemble Firestore-compatible output');
  console.log('─'.repeat(70));

  const firestoreData = toFirestoreFormat(gemini, aligned, audioDurationMs);

  console.log(`[Output] ${Object.keys(firestoreData.speakers).length} speakers`);
  console.log(`[Output] ${firestoreData.segments.length} segments`);
  console.log(`[Output] ${Object.keys(firestoreData.terms).length} terms`);
  console.log(`[Output] ${firestoreData.termOccurrences.length} term occurrences`);
  console.log(`[Output] ${firestoreData.topics.length} topics`);
  console.log(`[Output] ${firestoreData.people.length} people`);

  // Save results
  const pipelineDuration = Date.now() - pipelineStart;
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const resultPath = path.join(RESULTS_DIR, `${conversationId}_pipeline_result.json`);
  fs.writeFileSync(resultPath, JSON.stringify({
    conversationId,
    timestamp: new Date().toISOString(),
    pipelineDurationMs: pipelineDuration,
    gemini: {
      speakers: gemini.speakers,
      segmentCount: gemini.segments.length,
      tokenUsage: gemini.tokenUsage,
      durationMs: gemini.durationMs,
    },
    alignment: {
      inputSegments: gemini.segments.length,
      outputSegments: aligned.length,
    },
    output: firestoreData,
    comparison: {
      existingSegments,
      existingSpeakers,
      newSegments: firestoreData.segments.length,
      newSpeakers: Object.keys(firestoreData.speakers).length,
    },
  }, null, 2));
  console.log(`\n[Save] ${resultPath}`);

  // Generate summary
  const summaryPath = path.join(RESULTS_DIR, `${conversationId}_pipeline_summary.md`);
  const summary = [
    `# Combined Pipeline Results: ${conversationId}`,
    '',
    `**Date:** ${new Date().toISOString()}`,
    `**Pipeline duration:** ${(pipelineDuration / 1000).toFixed(1)}s`,
    `**Audio duration:** ${(audioDurationMs / 1000 / 60).toFixed(1)} min`,
    '',
    '## Speakers',
    '',
    '| # | Name | Role |',
    '|---|------|------|',
    ...gemini.speakers.map((s, i) => `| ${i + 1} | ${s.name} | ${s.role ?? '—'} |`),
    '',
    '## Pipeline Metrics',
    '',
    '| Metric | Current Pipeline | New Pipeline |',
    '|--------|-----------------|--------------|',
    `| Speakers | ${existingSpeakers} (pyannote) | ${Object.keys(firestoreData.speakers).length} (Gemini) |`,
    `| Segments | ${existingSegments} | ${firestoreData.segments.length} |`,
    `| Terms | — | ${Object.keys(firestoreData.terms).length} |`,
    `| Topics | — | ${firestoreData.topics.length} |`,
    `| Gemini tokens | — | ${gemini.tokenUsage.completion}/${65536} (${((gemini.tokenUsage.completion / 65536) * 100).toFixed(1)}%) |`,
    `| Pipeline time | — | ${(pipelineDuration / 1000).toFixed(1)}s |`,
    '',
    '## Sample Segments (first 10)',
    '',
    '| # | Speaker | Start | End | Text |',
    '|---|---------|-------|-----|------|',
    ...firestoreData.segments.slice(0, 10).map((s, i) =>
      `| ${i + 1} | ${firestoreData.speakers[s.speakerId]?.displayName ?? s.speakerId} | ${(s.startMs / 1000).toFixed(1)}s | ${(s.endMs / 1000).toFixed(1)}s | ${s.text.substring(0, 50)}... |`
    ),
    '',
  ].join('\n');
  fs.writeFileSync(summaryPath, summary);
  console.log(`[Save] ${summaryPath}`);

  // Final summary
  console.log('\n' + '='.repeat(70));
  console.log('COMBINED PIPELINE COMPLETE');
  console.log('='.repeat(70));
  console.log(`Conversation:    ${conversationId}`);
  console.log(`Duration:        ${(audioDurationMs / 1000 / 60).toFixed(1)} min`);
  console.log(`Pipeline time:   ${(pipelineDuration / 1000).toFixed(1)}s`);
  console.log(`Speakers:        ${Object.keys(firestoreData.speakers).length} (was: ${existingSpeakers})`);
  console.log(`Segments:        ${firestoreData.segments.length} (was: ${existingSegments})`);
  console.log(`Gemini tokens:   ${gemini.tokenUsage.completion}/${65536}`);
  console.log(`Terms:           ${Object.keys(firestoreData.terms).length}`);
  console.log(`Topics:          ${firestoreData.topics.length}`);
  console.log(`People:          ${firestoreData.people.length}`);
}

main().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
