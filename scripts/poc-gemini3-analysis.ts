#!/usr/bin/env tsx
/**
 * Phase 2: Gemini 3 Flash Content Analysis Benchmark
 *
 * Sends the full 45-min audio to Gemini 3 Flash and asks for content
 * analysis ONLY (no diarization timeline). Tests whether:
 *   1. It handles full-length audio without truncation
 *   2. It identifies speaker names from conversational context
 *   3. Terms/topics/persons quality is comparable to current pipeline
 *
 * This is deliberately NOT a diarization test — that's Chirp-3's job
 * (or Gemini's, depending on Phase 1 results). We're testing Gemini's
 * content understanding and speaker identification on long audio.
 *
 * Usage:
 *   npx tsx scripts/poc-gemini3-analysis.ts [conversationId] [iteration]
 *
 * Output:
 *   .agent_process/work/poc_gemini_hybrid/<iteration>/results/gemini3_analysis.json
 *   .agent_process/work/poc_gemini_hybrid/<iteration>/results/phase2_gemini3.md
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
// Gemini API calls that process 45 minutes of audio.
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
  label: string;      // "Speaker 1", "Speaker 2", etc.
  name: string;       // Identified name or "Unknown"
  role?: string;      // Role in the conversation
  description?: string; // Brief description of speaking style or context clues
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

interface Gemini3AnalysisResult {
  speakers: SpeakerIdentification[];
  speakerCount: number;
  terms: AnalysisTerm[];
  topics: AnalysisTopic[];
  persons: AnalysisPerson[];
}

interface AnalysisBenchmarkResult {
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
  result: Gemini3AnalysisResult;
  rawText?: string;
  groundTruth: {
    speakerNames: string[];
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
// Audio download
// ============================================================================

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
  const tmpPath = path.join(tmpDir, `poc-gemini3-${Date.now()}${ext}`);

  await file.download({ destination: tmpPath });
  const stats = fs.statSync(tmpPath);
  console.log(`[Download] Saved ${(stats.size / 1024 / 1024).toFixed(1)}MB to ${tmpPath}`);

  return tmpPath;
}

// ============================================================================
// Gemini 3 Flash — content analysis (no diarization timeline)
// ============================================================================

const ANALYSIS_PROMPT = `You are an expert audio analyst. Listen to this entire recording carefully.

## Your Tasks

### 1. Speaker Identification
Identify every distinct speaker in this recording. For each speaker:
- Assign a label ("Speaker 1", "Speaker 2", etc.)
- Identify their actual name if mentioned in conversation
- Note their role (e.g., "presenter", "client lead", "questioner")
- Describe how you identified them (e.g., "introduced themselves as...", "addressed by name when...")

Be conservative — do NOT create separate speakers for the same person. If unsure whether two voices are the same person, lean toward treating them as one.

Also provide "speakerCount" — the total number of distinct speakers you identified.

### 2. Terms
Extract domain-specific or noteworthy terms/concepts discussed. For each:
- "key": lowercase identifier (e.g., "machine_learning")
- "display": how it should be displayed (e.g., "Machine Learning")
- "definition": brief definition in context of this conversation
- "aliases": alternative names/abbreviations used

### 3. Topics
Identify major topics/segments of the conversation. For each:
- "title": descriptive title
- "startApproxMs": approximate start time in milliseconds
- "endApproxMs": approximate end time in milliseconds
- "type": "main" for primary topics, "tangent" for digressions

### 4. Persons
People mentioned in the conversation who are NOT speakers. For each:
- "name": full name as mentioned
- "affiliation": organization/role if mentioned

## Important
- Cover the ENTIRE recording — do not stop analyzing early
- Focus on accuracy over quantity
- If you cannot identify a speaker's name, use "Unknown" but still describe their voice/role`;

async function runGemini3Analysis(
  audioPath: string,
  conversationId: string,
): Promise<AnalysisBenchmarkResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not found in environment. Check your .env file.');
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: 600_000 },
  });

  const model = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';

  // Upload audio via Files API (41MB is too big for inline)
  console.log('[Gemini] Uploading audio to Files API...');
  const uploadStart = Date.now();
  const uploadedFile = await ai.files.upload({
    file: audioPath,
    config: {
      mimeType: 'audio/mpeg',
      displayName: `poc-analysis-${conversationId}`,
    },
  });
  const uploadDuration = Date.now() - uploadStart;
  console.log(`[Gemini] Upload complete in ${(uploadDuration / 1000).toFixed(1)}s`);
  console.log(`[Gemini] File URI: ${uploadedFile.uri}`);

  if (!uploadedFile.uri || !uploadedFile.mimeType) {
    throw new Error('File upload succeeded but missing URI or mimeType in response');
  }

  // Wait for file processing
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

  // Call generateContent
  console.log(`[Gemini] Model: ${model}`);
  console.log('[Gemini] Sending analysis request (no diarization timeline — content only)...');
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
            { text: ANALYSIS_PROMPT },
          ],
        },
      ],
      config: {
        temperature: 0.1,
        maxOutputTokens: 65536,
        // Minimize thinking to maximize output budget for actual content
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
          required: ['speakers', 'speakerCount', 'terms', 'topics', 'persons'],
          propertyOrdering: ['speakers', 'speakerCount', 'terms', 'topics', 'persons'],
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

  // Parse JSON response
  let parsed: Gemini3AnalysisResult;
  try {
    let cleaned = rawText.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '');
      cleaned = cleaned.replace(/\n?```\s*$/, '');
    }
    parsed = JSON.parse(cleaned);
  } catch (_err) {
    console.error('[Gemini] Failed to parse JSON response. Saving raw text.');
    parsed = { speakers: [], speakerCount: 0, terms: [], topics: [], persons: [] };
    // Still return with rawText so we can debug
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
      rawText,
      groundTruth: {
        speakerNames: ['JJ Jonathan', 'Adam', 'Sanjay', 'Chris Savage', 'Dhaval', 'Sammy'],
        existingSpeakers: 0,
      },
    };
  }

  console.log(`[Gemini] Parsed: ${parsed.speakers.length} speakers, ${parsed.speakerCount} speakerCount`);
  console.log(`[Gemini] Terms: ${parsed.terms.length}, Topics: ${parsed.topics.length}, Persons: ${parsed.persons.length}`);

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
      existingSpeakers: 0,
    },
  };
}

// ============================================================================
// Report generation
// ============================================================================

function generateReport(result: AnalysisBenchmarkResult): string {
  const lines: string[] = [];
  lines.push('# Gemini 3 Flash Content Analysis Benchmark');
  lines.push('');
  lines.push(`**Date:** ${result.timestamp}`);
  lines.push(`**Conversation:** ${result.conversationId}`);
  lines.push(`**Model:** ${result.model}`);
  lines.push(`**API Duration:** ${(result.durationMs / 1000).toFixed(1)}s`);
  lines.push(`**Upload Duration:** ${(result.uploadDurationMs / 1000).toFixed(1)}s`);
  lines.push(`**Tokens:** ${result.tokenUsage.totalTokens} total (${result.tokenUsage.promptTokens} prompt + ${result.tokenUsage.completionTokens} completion)`);
  lines.push('');

  // Speaker identification
  lines.push('## Speaker Identification');
  lines.push('');
  lines.push(`Gemini identified **${result.result.speakerCount}** speakers (expected: 6).`);
  lines.push('');
  lines.push('| Label | Name | Role | How Identified |');
  lines.push('|-------|------|------|----------------|');
  for (const s of result.result.speakers) {
    const desc = s.description ? s.description.substring(0, 60) + (s.description.length > 60 ? '...' : '') : '—';
    lines.push(`| ${s.label} | ${s.name} | ${s.role ?? '—'} | ${desc} |`);
  }
  lines.push('');

  // Ground truth comparison
  const gtNames = result.groundTruth.speakerNames;
  const identifiedNames = result.result.speakers.map(s => s.name.toLowerCase());
  const matched = gtNames.filter(gt =>
    identifiedNames.some(id => id.includes(gt.toLowerCase()) || gt.toLowerCase().includes(id)),
  );

  lines.push('### Ground Truth Comparison');
  lines.push('');
  lines.push(`| Ground Truth Speaker | Identified? |`);
  lines.push(`|---------------------|-------------|`);
  for (const gt of gtNames) {
    const found = identifiedNames.some(id =>
      id.includes(gt.split(' ')[0].toLowerCase()),
    );
    lines.push(`| ${gt} | ${found ? 'Yes' : 'No'} |`);
  }
  lines.push(`| **Match rate** | **${matched.length}/${gtNames.length}** |`);
  lines.push('');

  // Terms
  lines.push('## Terms Extracted');
  lines.push('');
  lines.push(`Total: ${result.result.terms.length}`);
  lines.push('');
  if (result.result.terms.length > 0) {
    lines.push('| Term | Definition | Aliases |');
    lines.push('|------|-----------|---------|');
    for (const t of result.result.terms.slice(0, 20)) {
      const def = t.definition.length > 60 ? t.definition.substring(0, 60) + '...' : t.definition;
      lines.push(`| ${t.display} | ${def} | ${(t.aliases || []).join(', ') || '—'} |`);
    }
    if (result.result.terms.length > 20) {
      lines.push(`| ... | *${result.result.terms.length - 20} more terms* | |`);
    }
    lines.push('');
  }

  // Topics
  lines.push('## Topics Identified');
  lines.push('');
  lines.push(`Total: ${result.result.topics.length}`);
  lines.push('');
  if (result.result.topics.length > 0) {
    lines.push('| Topic | Type | Start | End |');
    lines.push('|-------|------|-------|-----|');
    for (const t of result.result.topics) {
      lines.push(`| ${t.title} | ${t.type} | ${(t.startApproxMs / 1000 / 60).toFixed(1)}m | ${(t.endApproxMs / 1000 / 60).toFixed(1)}m |`);
    }
    lines.push('');
  }

  // Persons
  lines.push('## Persons Mentioned (Non-Speakers)');
  lines.push('');
  lines.push(`Total: ${result.result.persons.length}`);
  lines.push('');
  if (result.result.persons.length > 0) {
    lines.push('| Name | Affiliation |');
    lines.push('|------|-------------|');
    for (const p of result.result.persons) {
      lines.push(`| ${p.name} | ${p.affiliation ?? '—'} |`);
    }
    lines.push('');
  }

  // Output budget assessment
  lines.push('## Output Token Budget Assessment');
  lines.push('');
  const pct = ((result.tokenUsage.completionTokens / 65536) * 100).toFixed(1);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Completion tokens used | ${result.tokenUsage.completionTokens} |`);
  lines.push(`| Output ceiling | 65,536 |`);
  lines.push(`| Budget used | ${pct}% |`);
  lines.push(`| Truncation risk | ${Number(pct) > 80 ? 'HIGH' : Number(pct) > 50 ? 'MEDIUM' : 'LOW'} |`);
  lines.push('');

  if (result.rawText) {
    lines.push('## WARNING: JSON Parse Failed');
    lines.push('');
    lines.push('Raw response saved — first 500 chars:');
    lines.push('```');
    lines.push(result.rawText.substring(0, 500));
    lines.push('```');
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
  console.log(`PoC: Gemini 3 Flash Content Analysis — ${conversationId}`);
  console.log(`[Context] Scope: ${SCOPE}, Iteration: ${ITERATION}`);
  console.log('='.repeat(70));

  // Init Firebase
  initFirebase();
  const db = admin.firestore();

  // Fetch conversation
  const convoDoc = await db.collection('conversations').doc(conversationId).get();
  if (!convoDoc.exists) {
    throw new Error(`Conversation ${conversationId} not found in Firestore`);
  }

  const convoData = convoDoc.data()!;
  const audioStoragePath = convoData.audioStoragePath;
  if (!audioStoragePath) {
    throw new Error(`Conversation ${conversationId} has no audioStoragePath`);
  }

  const existingSpeakers = Object.keys(convoData.speakers || {}).length;

  console.log(`[Main] Audio path: ${audioStoragePath}`);
  console.log(`[Main] Duration: ${(convoData.durationMs / 1000 / 60).toFixed(1)} minutes`);
  console.log(`[Main] Existing speakers: ${existingSpeakers}`);

  // Download audio
  const audioPath = await downloadAudioToTemp(audioStoragePath);

  try {
    const result = await runGemini3Analysis(audioPath, conversationId);
    result.groundTruth.existingSpeakers = existingSpeakers;

    // Save results
    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    const jsonPath = path.join(RESULTS_DIR, 'gemini3_analysis.json');
    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
    console.log(`[Main] Saved analysis JSON: ${jsonPath}`);

    const reportPath = path.join(RESULTS_DIR, 'phase2_gemini3.md');
    const report = generateReport(result);
    fs.writeFileSync(reportPath, report);
    console.log(`[Main] Saved analysis report: ${reportPath}`);

    // Print summary
    console.log('\n' + '='.repeat(70));
    console.log('GEMINI 3 FLASH ANALYSIS SUMMARY');
    console.log('='.repeat(70));
    console.log(`Speakers identified: ${result.result.speakerCount} (expected: 6)`);
    console.log('');
    for (const s of result.result.speakers) {
      console.log(`  ${s.label.padEnd(12)} → ${s.name} (${s.role ?? 'unknown role'})`);
    }
    console.log('');
    console.log(`Terms: ${result.result.terms.length}`);
    console.log(`Topics: ${result.result.topics.length}`);
    console.log(`Persons: ${result.result.persons.length}`);
    console.log(`API duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`Tokens: ${result.tokenUsage.completionTokens}/${65536} output (${((result.tokenUsage.completionTokens / 65536) * 100).toFixed(1)}% of ceiling)`);

    if (result.rawText) {
      console.log('\nWARNING: JSON parsing failed — raw text saved for debugging');
    }
  } finally {
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
