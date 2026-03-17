#!/usr/bin/env tsx
/**
 * Phase 1 + 3: Gemini Full-Audio Diarization & Analysis
 *
 * Sends a complete audio file to Gemini 2.5 Flash and asks it to:
 *   1. Identify and label all speakers (with names when mentioned)
 *   2. Produce a speaker-attributed timeline with timestamps
 *   3. Extract terms, topics, and persons (Phase 3 piggyback)
 *
 * The 22MB MP3 exceeds the 20MB inline limit, so we go through
 * the Files API. This is a PoC script — not production code.
 *
 * Usage:
 *   npx tsx scripts/poc-gemini-diarize.ts [conversationId] [iteration]
 *
 * Output:
 *   .agent_process/work/poc_gemini_hybrid/<iteration>/results/gemini_diarization_raw.json
 *   .agent_process/work/poc_gemini_hybrid/<iteration>/results/gemini_analysis_raw.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { GoogleGenAI, createPartFromUri } from '@google/genai';
import admin from 'firebase-admin';
import 'dotenv/config';
import { resolvePocResultsDir } from './poc-results-dir.js';

// Node 24's undici has a default headersTimeout that's too short for
// Gemini API calls that process 45 minutes of audio. Bump it globally.
import { setGlobalDispatcher, Agent } from 'undici';
setGlobalDispatcher(new Agent({
  headersTimeout: 600_000,    // 10 minutes
  bodyTimeout: 600_000,       // 10 minutes
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCOPE = 'poc_gemini_hybrid';
const { iteration: ITERATION, resultsDir: RESULTS_DIR } = resolvePocResultsDir(
  PROJECT_ROOT,
  SCOPE,
  process.argv[3]
);

// ============================================================================
// Types — what we ask Gemini for
// ============================================================================

/** A single speaker turn from Gemini's diarization output */
export interface GeminiSpeakerSegment {
  speaker: string;        // Gemini's label, e.g. "JJ" or "Speaker 3"
  startMs: number;
  endMs: number;
  text?: string;          // Optional — omitted in timeline-only mode to save tokens
}

/** Speaker identification metadata */
export interface GeminiSpeakerInfo {
  label: string;          // The label used in segments (e.g. "JJ", "Speaker 3")
  name: string;
  role?: string;
}

/** Term extracted by Gemini */
export interface GeminiTerm {
  key: string;
  display: string;
  definition: string;
  aliases: string[];
}

/** Topic extracted by Gemini */
export interface GeminiTopic {
  title: string;
  startApproxMs: number;
  endApproxMs: number;
  type: 'main' | 'tangent';
}

/** Person mentioned (not a speaker) */
export interface GeminiPerson {
  name: string;
  affiliation?: string;
}

/** The full structured response we want from Gemini */
export interface GeminiDiarizationResult {
  speakers: GeminiSpeakerInfo[] | Record<string, GeminiSpeakerInfo>;
  segments: GeminiSpeakerSegment[];
  terms: GeminiTerm[];
  topics: GeminiTopic[];
  persons: GeminiPerson[];
}

/** Artifact saved to disk for downstream phases */
export interface DiarizationArtifact {
  conversationId: string;
  model: string;
  timestamp: string;
  durationMs: number;         // wall-clock time for the API call
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  result: GeminiDiarizationResult;
  rawText?: string;           // fallback if JSON parsing fails
}

// ============================================================================
// Firebase init
// ============================================================================

function initFirebase(): admin.app.App {
  const saKeyPath = path.join(PROJECT_ROOT, 'firebase-sa-key.json');
  if (!fs.existsSync(saKeyPath)) {
    throw new Error(`Service account key not found at ${saKeyPath}. Cannot proceed.`);
  }

  // Already initialized? Return existing app
  if (admin.apps.length > 0) {
    return admin.apps[0]!;
  }

  return admin.initializeApp({
    credential: admin.credential.cert(saKeyPath),
    storageBucket: 'audio-transcript-analyzer-01.firebasestorage.app',
  });
}

// ============================================================================
// Audio download — get the file from Firebase Storage
// ============================================================================

async function downloadAudioToTemp(
  storagePath: string,
  _app: admin.app.App
): Promise<string> {
  console.log(`[Download] Fetching audio from Storage: ${storagePath}`);
  const bucket = admin.storage().bucket();
  const file = bucket.file(storagePath);

  const [exists] = await file.exists();
  if (!exists) {
    throw new Error(`Audio file not found in Storage: ${storagePath}`);
  }

  // Download to a temp file — we'll clean it up later
  const tmpDir = os.tmpdir();
  const ext = path.extname(storagePath) || '.mp3';
  const tmpPath = path.join(tmpDir, `poc-audio-${Date.now()}${ext}`);

  await file.download({ destination: tmpPath });
  const stats = fs.statSync(tmpPath);
  console.log(`[Download] Saved ${(stats.size / 1024 / 1024).toFixed(1)}MB to ${tmpPath}`);

  return tmpPath;
}

// ============================================================================
// Gemini prompt — the heart of the experiment
// ============================================================================

// We ask for everything in one call because Gemini charges per input token
// and re-sending the entire audio for a follow-up would double the cost.
//
// When DIARIZE_ONLY=1, skip analysis to maximize output tokens for segments.
// The 64K output ceiling is the enemy — every term/topic/person burns tokens
// that could be speaker timeline entries.
const DIARIZE_ONLY = process.env.DIARIZE_ONLY === '1';

const DIARIZATION_PROMPT = DIARIZE_ONLY
  ? `You are an expert audio transcription analyst. Listen to this entire audio recording.

## Task 1: Speaker Identification
Identify every distinct speaker by their VOICE. Each unique voice = one speaker.
- Use their actual name if mentioned in the conversation, otherwise "Speaker N"
- Note their role if discernible
- Be conservative — don't create separate speakers for the same voice

## Task 2: Speaker Timeline
Produce a timeline of speaker turns covering the ENTIRE recording.

RULES:
- Each entry = one speaker's continuous turn (until someone else speaks)
- Merge consecutive speech by the same speaker into one entry
- For a 45-minute conversation, expect 100-400 entries
- Cover the full recording — do not stop early

Fields per entry:
- "speaker": must match a label from the speakers list
- "startMs": start time in milliseconds
- "endMs": end time in milliseconds`
  : `You are an expert audio transcription analyst. Listen to this entire audio recording and produce a detailed analysis.

## Task 1: Speaker Identification
Identify every distinct speaker in the recording. For each speaker:
- Assign a consistent label (use their actual name if mentioned in the conversation, otherwise "Speaker N")
- Note their apparent role if discernible (e.g., "host", "guest", "interviewer")

Be conservative with speaker count — do NOT create separate speakers for the same person. If you're unsure whether two voices are the same person, lean toward treating them as the same speaker.

## Task 2: Content Analysis
Extract the following from the conversation:

### Terms
Domain-specific or noteworthy terms/concepts discussed. For each:
- "key": lowercase identifier (e.g., "machine_learning")
- "display": how it should be displayed (e.g., "Machine Learning")
- "definition": brief definition in context of this conversation
- "aliases": alternative names/abbreviations used

### Topics
Major topics/segments of the conversation. For each:
- "title": descriptive title
- "startApproxMs": approximate start time in ms
- "endApproxMs": approximate end time in ms
- "type": "main" for primary topics, "tangent" for digressions

### Persons
People mentioned in the conversation who are NOT speakers. For each:
- "name": full name as mentioned
- "affiliation": organization/role if mentioned

## Task 3: Speaker Timeline
Produce a COARSE timeline of speaker turns. This is for diarization only — we already have a separate word-level transcript, so we just need to know WHO is speaking at each point in time.

CRITICAL RULES:
- Each entry = one speaker's CONTINUOUS turn (everything from when they start speaking until someone else takes over)
- Do NOT produce individual sentences — merge all speech by the same speaker in one continuous block
- Do NOT include the "text" field — only speaker, startMs, endMs
- For a 45-minute conversation, expect 100-400 entries total. If you have more than 500, you are being too granular.

Each entry should have ONLY these 3 fields:
- "speaker": the speaker label (must match Task 1 labels exactly)
- "startMs": start time in milliseconds
- "endMs": end time in milliseconds

## Output Rules
The output schema is enforced automatically. Follow these rules for the content:

- The "speaker" field in each segment MUST exactly match a "label" from the "speakers" array
- Timestamps are in milliseconds from the start of the audio
- Cover the ENTIRE 45-minute recording from start to finish — do not stop early
- Each segment = one speaker TURN (when the speaker changes, start a new segment)
- DO NOT break a single speaker's continuous speech into multiple segments
- For a 45-minute recording, expect roughly 100-400 segment entries total`;

// ============================================================================
// Core logic — send audio to Gemini, parse the result
// ============================================================================

async function runGeminiDiarization(
  audioPath: string,
  conversationId: string
): Promise<DiarizationArtifact> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not found in environment. Check your .env file.');
  }

  // 10 minute timeout — processing 45 min of audio with a big prompt
  // needs way more than undici's default headers timeout
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: 600_000 },
  });
  // Default to stable Flash — the original Dec 2025 pipeline used gemini-2.5-flash
  // (stable, not preview) and had working diarization. Override via GEMINI_MODEL env.
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  // Step 1: Upload audio via Files API (too big for inline)
  console.log('[Gemini] Uploading audio to Files API...');
  const uploadStart = Date.now();
  const uploadedFile = await ai.files.upload({
    file: audioPath,
    config: {
      mimeType: 'audio/mpeg',
      displayName: `poc-diarization-${conversationId}`,
    },
  });
  console.log(`[Gemini] Upload complete in ${((Date.now() - uploadStart) / 1000).toFixed(1)}s`);
  console.log(`[Gemini] File URI: ${uploadedFile.uri}`);

  if (!uploadedFile.uri || !uploadedFile.mimeType) {
    throw new Error('File upload succeeded but missing URI or mimeType in response');
  }

  // Step 2: Wait for file to be ready (processing can take a moment)
  let fileState = uploadedFile.state;
  let waitAttempts = 0;
  while (fileState === 'PROCESSING') {
    waitAttempts++;
    if (waitAttempts > 60) {
      throw new Error('File processing timed out after 60 attempts');
    }
    console.log(`[Gemini] File still processing... (attempt ${waitAttempts})`);
    await new Promise(r => setTimeout(r, 2000));

    // Re-check file state
    const fileInfo = await ai.files.get({ name: uploadedFile.name! });
    fileState = fileInfo.state;
  }

  if (fileState === 'FAILED') {
    throw new Error('File processing failed on Gemini side');
  }

  // Step 3: Call generateContent with the uploaded file
  console.log(`[Gemini] File state: ${fileState}`);
  console.log(`[Gemini] File URI: ${uploadedFile.uri}, mimeType: ${uploadedFile.mimeType}`);
  console.log('[Gemini] Sending diarization request...');
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
            { text: DIARIZATION_PROMPT },
          ],
        },
      ],
      config: {
        temperature: 0.1,
        maxOutputTokens: 65536,
        // Flash can run with thinkingBudget: 0, Pro requires >= 1024.
        // Killing thinking for Flash frees all 65K tokens for actual output.
        thinkingConfig: model.includes('pro')
          ? { thinkingBudget: 1024 }
          : { thinkingBudget: 0 },
        responseMimeType: 'application/json',
        responseSchema: DIARIZE_ONLY
          ? {
              // Lean schema — speakers + segments only, maximize token budget for timeline
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
                    },
                    required: ['speaker', 'startMs', 'endMs'],
                    propertyOrdering: ['speaker', 'startMs', 'endMs'],
                  },
                },
              },
              required: ['speakers', 'segments'],
              propertyOrdering: ['speakers', 'segments'],
            }
          : {
              type: 'object',
              properties: {
                speakers: {
                  type: 'array',
                  description: 'List of all distinct speakers identified in the audio',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'Speaker label used in segments' },
                      name: { type: 'string', description: 'Full name if known' },
                      role: { type: 'string', description: 'Role in the conversation' },
                    },
                    required: ['label', 'name'],
                    propertyOrdering: ['label', 'name', 'role'],
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
              },
              required: ['speakers', 'terms', 'topics', 'persons', 'segments'],
              propertyOrdering: ['speakers', 'terms', 'topics', 'persons', 'segments'],
            },
      },
    });
  } catch (err: unknown) {
    // Surface the real error from fetch failures
    const e = err as Error & { cause?: Error };
    if (e.cause) {
      console.error('[Gemini] Underlying cause:', e.cause.message || e.cause);
    }
    throw err;
  }

  const apiDuration = Date.now() - apiStart;
  console.log(`[Gemini] Response received in ${(apiDuration / 1000).toFixed(1)}s`);

  // Step 4: Parse the response
  const rawText = response.text ?? '';
  const usage = response.usageMetadata;

  console.log(`[Gemini] Token usage: prompt=${usage?.promptTokenCount ?? '?'}, completion=${usage?.candidatesTokenCount ?? '?'}, total=${usage?.totalTokenCount ?? '?'}`);

  // Try to parse JSON — Gemini sometimes wraps it in markdown fences
  let parsed: GeminiDiarizationResult;
  try {
    parsed = parseGeminiJson(rawText);
  } catch (_err) {
    console.error('[Gemini] Failed to parse JSON response. Saving raw text for debugging.');
    // Save the raw response so we can debug the prompt
    const artifact: DiarizationArtifact = {
      conversationId,
      model,
      timestamp: new Date().toISOString(),
      durationMs: apiDuration,
      tokenUsage: {
        promptTokens: usage?.promptTokenCount ?? 0,
        completionTokens: usage?.candidatesTokenCount ?? 0,
        totalTokens: usage?.totalTokenCount ?? 0,
      },
      result: { speakers: [], segments: [], terms: [], topics: [], persons: [] },
      rawText,
    };
    return artifact;
  }

  // Validate the basics
  const speakerCount = Array.isArray(parsed.speakers)
    ? parsed.speakers.length
    : Object.keys(parsed.speakers || {}).length;
  const segmentCount = (parsed.segments || []).length;
  console.log(`[Gemini] Parsed: ${speakerCount} speakers, ${segmentCount} segments`);
  console.log(`[Gemini] Terms: ${(parsed.terms || []).length}, Topics: ${(parsed.topics || []).length}, Persons: ${(parsed.persons || []).length}`);

  // Clean up uploaded file — don't leave our audio sitting in Google's servers
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
    tokenUsage: {
      promptTokens: usage?.promptTokenCount ?? 0,
      completionTokens: usage?.candidatesTokenCount ?? 0,
      totalTokens: usage?.totalTokenCount ?? 0,
    },
    result: parsed,
  };
}

/**
 * Parse JSON from Gemini response, handling common quirks.
 * Gemini loves wrapping JSON in ```json ... ``` blocks, and sometimes
 * the output gets truncated when it hits the token ceiling mid-segment.
 * We handle both cases because we'd rather have 80% of the data than 0%.
 */
function parseGeminiJson(text: string): GeminiDiarizationResult {
  // Strip markdown code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '');
    cleaned = cleaned.replace(/\n?```\s*$/, '');
  }

  // Happy path: it's valid JSON
  try {
    return JSON.parse(cleaned);
  } catch (_firstErr) {
    // Not valid JSON — likely truncated at the token limit
  }

  // Truncation repair: find the last complete object in the segments array,
  // then close all open brackets/braces. This loses the tail-end segments
  // but preserves everything Gemini managed to finish.
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
      // Repair didn't work either
    }
  }

  // Last resort: find the last } and truncate
  const lastBrace = cleaned.lastIndexOf('}');
  if (lastBrace !== -1) {
    cleaned = cleaned.substring(0, lastBrace + 1);
  }
  return JSON.parse(cleaned);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const conversationId = process.argv[2] || 'c_1773188486911';

  console.log('='.repeat(70));
  console.log(`PoC: Gemini Diarization — conversation ${conversationId}`);
  console.log(`[Context] Scope: ${SCOPE}, Iteration: ${ITERATION}`);
  console.log('='.repeat(70));

  // Init Firebase
  const app = initFirebase();
  const db = admin.firestore();

  // Fetch conversation doc to get audioStoragePath
  const convoDoc = await db.collection('conversations').doc(conversationId).get();
  if (!convoDoc.exists) {
    throw new Error(`Conversation ${conversationId} not found in Firestore`);
  }

  const convoData = convoDoc.data()!;
  const audioStoragePath = convoData.audioStoragePath;
  if (!audioStoragePath) {
    throw new Error(`Conversation ${conversationId} has no audioStoragePath`);
  }

  console.log(`[Main] Audio path: ${audioStoragePath}`);
  console.log(`[Main] Duration: ${(convoData.durationMs / 1000 / 60).toFixed(1)} minutes`);
  console.log(`[Main] Current segments: ${(convoData.segments || []).length}`);
  console.log(`[Main] Current speakers: ${Object.keys(convoData.speakers || {}).length}`);

  // Download audio
  const audioPath = await downloadAudioToTemp(audioStoragePath, app);

  try {
    // Run Gemini diarization + analysis
    const artifact = await runGeminiDiarization(audioPath, conversationId);

    // Save artifacts
    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    // Save the diarization artifact (segments + speakers)
    const diarizationPath = path.join(RESULTS_DIR, 'gemini_diarization_raw.json');
    fs.writeFileSync(diarizationPath, JSON.stringify(artifact, null, 2));
    console.log(`[Main] Saved diarization artifact: ${diarizationPath}`);

    // Save the analysis artifact (terms + topics + persons) separately for Phase 3
    const analysisArtifact = {
      conversationId,
      model: artifact.model,
      timestamp: artifact.timestamp,
      terms: artifact.result.terms,
      topics: artifact.result.topics,
      persons: artifact.result.persons,
    };
    const analysisPath = path.join(RESULTS_DIR, 'gemini_analysis_raw.json');
    fs.writeFileSync(analysisPath, JSON.stringify(analysisArtifact, null, 2));
    console.log(`[Main] Saved analysis artifact: ${analysisPath}`);

    // Quick summary
    console.log('\n' + '='.repeat(70));
    console.log('SUMMARY');
    console.log('='.repeat(70));
    const spkCount = Array.isArray(artifact.result.speakers)
      ? artifact.result.speakers.length
      : Object.keys(artifact.result.speakers).length;
    console.log(`Speakers found: ${spkCount}`);
    console.log(`Segments produced: ${(artifact.result.segments || []).length}`);
    console.log(`API call duration: ${(artifact.durationMs / 1000).toFixed(1)}s`);
    console.log(`Tokens: ${artifact.tokenUsage.totalTokens} total (${artifact.tokenUsage.promptTokens} prompt + ${artifact.tokenUsage.completionTokens} completion)`);

    if (artifact.rawText) {
      console.log('\nWARNING: JSON parsing failed — raw text saved for debugging');
      console.log('First 500 chars:', artifact.rawText.substring(0, 500));
    }
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(audioPath);
      console.log('[Cleanup] Removed temp audio file');
    } catch (_e) {
      // shrug
    }
  }
}

main().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
