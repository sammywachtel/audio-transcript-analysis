/**
 * Gemini 3 Flash Single-Pass Pipeline Module
 *
 * Sends full audio to Gemini 3 Flash for combined diarization + content analysis.
 * Replaces both pyannote diarization and per-chunk Gemini analysis.
 *
 * Key insight from PoC: WAV format is critical for speaker detection.
 * MP3 compression hides quiet speakers (5/6 vs 6/6 with WAV).
 *
 * Usage:
 *   const result = await processWithGemini3Flash('users/abc/audio/123.mp3');
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getStorage } from 'firebase-admin/storage';
import { log } from './logger';
import { Speaker, Segment, Term, TermOccurrence, Topic, Person } from './types';
import { sanitizeForFirestore } from './firestoreUtils';
import { GoogleGenAI, createPartFromUri } from '@google/genai';

const execFileAsync = promisify(execFile);

// =============================================================================
// Types
// =============================================================================

/**
 * Speaker identification from audio analysis
 */
export interface GeminiSpeaker {
  /** Label used to reference speaker in segments ("Speaker 1", "Speaker 2", etc.) */
  label: string;
  /** Actual name if identified from conversation */
  name: string;
  /** Role if apparent (e.g., "presenter", "client lead") */
  role?: string;
}

/**
 * A single speaker turn with transcript
 */
export interface GeminiSegment {
  /** Speaker label matching speakers array */
  speaker: string;
  /** Transcript text for this turn */
  text: string;
  /** Start timestamp in milliseconds */
  startMs: number;
  /** End timestamp in milliseconds */
  endMs: number;
}

/**
 * Domain-specific term extracted from conversation
 */
export interface GeminiTerm {
  /** Lowercase identifier */
  key: string;
  /** Display version with proper capitalization */
  display: string;
  /** Definition in context of this conversation */
  definition: string;
  /** Alternative names/abbreviations */
  aliases: string[];
}

/**
 * Topic/segment of conversation
 */
export interface GeminiTopic {
  /** Descriptive title */
  title: string;
  /** Approximate start time in milliseconds */
  startApproxMs: number;
  /** Approximate end time in milliseconds */
  endApproxMs: number;
  /** main or tangent */
  type: 'main' | 'tangent';
}

/**
 * Person mentioned in conversation (not a speaker)
 */
export interface GeminiPerson {
  /** Full name as mentioned */
  name: string;
  /** Organization/role if mentioned */
  affiliation?: string;
}

/**
 * Complete result from Gemini 3 Flash single-pass analysis
 */
export interface GeminiPipelineResult {
  speakers: GeminiSpeaker[];
  segments: GeminiSegment[];
  terms: GeminiTerm[];
  topics: GeminiTopic[];
  persons: GeminiPerson[];
  /** Usage metadata for monitoring */
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** API call duration in milliseconds */
  durationMs?: number;
}

/**
 * Options for processWithGemini3Flash
 */
export interface GeminiPipelineOptions {
  /** Gemini model to use (default: gemini-3-flash-preview) */
  model?: string;
  /** Conversation ID for logging context */
  conversationId?: string;
}

// =============================================================================
// Error Types
// =============================================================================

export class GeminiPipelineError extends Error {
  constructor(
    message: string,
    public readonly code: 'UPLOAD_FAILED' | 'PROCESSING_FAILED' | 'GENERATION_FAILED' |
                         'TIMEOUT' | 'QUOTA_EXCEEDED' | 'PARSE_FAILED' | 'CONVERSION_FAILED' |
                         'DOWNLOAD_FAILED',
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'GeminiPipelineError';
  }
}

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_MODEL = 'gemini-3-flash-preview';
const MAX_PROCESSING_WAIT_ATTEMPTS = 60; // 60 * 2s = 2 minutes max wait
const PROCESSING_POLL_INTERVAL_MS = 2000;

// =============================================================================
// Helper: Dynamic ffmpeg path (avoids build-time resolution)
// =============================================================================

async function getFfmpegPath(): Promise<string> {
  // Prefer system ffmpeg (installed via apt in the Cloud Run Dockerfile).
  // Fall back to the npm-bundled binary for Cloud Functions where system
  // ffmpeg isn't available.
  try {
    const { execFileSync } = await import('child_process');
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    const ffmpegInstaller = await import('@ffmpeg-installer/ffmpeg');
    return ffmpegInstaller.default.path;
  }
}

// =============================================================================
// Helper: Download audio from Storage
// =============================================================================

async function downloadAudioFromStorage(
  storagePath: string,
  conversationId?: string
): Promise<string> {
  const ctx = { conversationId, stage: 'gemini3-download' };
  log.info(`Downloading audio from Storage: ${storagePath}`, ctx);

  // On Cloud Run, storageBucket is set in initializeApp() from FIREBASE_STORAGE_BUCKET.
  // On Cloud Functions, it's auto-discovered. Either way, bucket() works.
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  const bucket = bucketName ? getStorage().bucket(bucketName) : getStorage().bucket();
  const file = bucket.file(storagePath);

  log.info(`Checking file exists (bucket: ${bucket.name})...`, ctx);
  const t0 = Date.now();
  const [exists] = await file.exists();
  log.info(`file.exists() returned ${exists} in ${Date.now() - t0}ms`, ctx);
  if (!exists) {
    throw new GeminiPipelineError(
      `Audio file not found in Storage: ${storagePath}`,
      'DOWNLOAD_FAILED'
    );
  }

  const tmpDir = os.tmpdir();
  const ext = path.extname(storagePath) || '.mp3';
  const tmpPath = path.join(tmpDir, `gemini3-${Date.now()}${ext}`);

  // Node's HTTP stack (fetch, gaxios, file.download) hangs on large downloads
  // from Cloud Run containers. Shell out to curl which uses its own TLS/DNS stack.
  // On Cloud Functions, fall back to the SDK since curl may not be available.
  const downloadStart = Date.now();
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const accessToken = await auth.getAccessToken();
  log.info(`Got access token in ${Date.now() - downloadStart}ms, downloading via curl...`, ctx);

  const encodedPath = encodeURIComponent(storagePath);
  const downloadUrl = `https://storage.googleapis.com/storage/v1/b/${bucket.name}/o/${encodedPath}?alt=media`;

  try {
    const { execFileSync } = await import('child_process');
    execFileSync('curl', [
      '-sS', '--fail',
      '--http1.1',  // HTTP/2 streams reset prematurely on GCS large downloads
      '-o', tmpPath,
      '-H', `Authorization: Bearer ${accessToken}`,
      downloadUrl,
    ], { timeout: 120_000 });
  } catch (curlErr) {
    throw new GeminiPipelineError(
      `Storage download failed: ${curlErr instanceof Error ? curlErr.message : String(curlErr)}`,
      'DOWNLOAD_FAILED'
    );
  }

  const stats = fs.statSync(tmpPath);
  log.info(`Downloaded ${(stats.size / 1024 / 1024).toFixed(1)}MB to temp file (${Date.now() - downloadStart}ms)`, ctx);

  return tmpPath;
}

// =============================================================================
// Helper: Convert audio to WAV (critical for speaker detection)
// =============================================================================

async function convertToWav(
  inputPath: string,
  conversationId?: string
): Promise<string> {
  const ctx = { conversationId, stage: 'gemini3-convert' };
  log.info('Converting audio to WAV (16kHz mono 16-bit PCM)', ctx);

  const ffmpegPath = await getFfmpegPath();
  const wavPath = inputPath.replace(/\.[^.]+$/, '.wav');

  try {
    await execFileAsync(ffmpegPath, [
      '-y', '-i', inputPath,
      '-ar', '16000',    // 16kHz sample rate
      '-ac', '1',        // mono
      '-sample_fmt', 's16', // 16-bit signed int
      wavPath,
    ], { timeout: 300000 }); // 5 minute timeout

    const stats = fs.statSync(wavPath);
    log.info(`WAV conversion complete: ${(stats.size / 1024 / 1024).toFixed(1)}MB`, ctx);

    return wavPath;
  } catch (err) {
    throw new GeminiPipelineError(
      'Failed to convert audio to WAV',
      'CONVERSION_FAILED',
      err instanceof Error ? err : new Error(String(err))
    );
  }
}

// =============================================================================
// Helper: JSON truncation repair
// =============================================================================

/**
 * Parse JSON from Gemini response, handling truncation gracefully.
 *
 * Gemini can hit the 65K token ceiling mid-output. When this happens,
 * we attempt to recover by finding the last complete object and closing
 * all open brackets/braces.
 */
export function parseGeminiJson(text: string): GeminiPipelineResult {
  let cleaned = text.trim();

  // Strip markdown code fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '');
    cleaned = cleaned.replace(/\n?```\s*$/, '');
  }

  // Try direct parse first
  try {
    return JSON.parse(cleaned) as GeminiPipelineResult;
  } catch (_firstErr) {
    // Likely truncated — attempt repair
  }

  // Find the last complete object (ends with '},')
  const lastComplete = cleaned.lastIndexOf('},');
  if (lastComplete > 0) {
    let repaired = cleaned.substring(0, lastComplete + 1);

    // Count unclosed brackets/braces and close them
    const openBrackets = (repaired.match(/\[/g) || []).length - (repaired.match(/\]/g) || []).length;
    const openBraces = (repaired.match(/\{/g) || []).length - (repaired.match(/\}/g) || []).length;
    repaired += ']'.repeat(Math.max(0, openBrackets)) + '}'.repeat(Math.max(0, openBraces));

    try {
      const result = JSON.parse(repaired) as GeminiPipelineResult;
      const segCount = (result.segments || []).length;
      // Log warning but don't throw — partial data is better than none
      log.warn(`JSON truncation repaired — recovered ${segCount} segments (some tail data lost)`, {
        stage: 'gemini3-parse',
      });
      return result;
    } catch (_repairErr) {
      // Repair didn't work, try one more approach
    }
  }

  // Last resort: find the last closing brace and hope for the best
  const lastBrace = cleaned.lastIndexOf('}');
  if (lastBrace !== -1) {
    try {
      const truncated = cleaned.substring(0, lastBrace + 1);
      return JSON.parse(truncated) as GeminiPipelineResult;
    } catch (_) {
      // Give up
    }
  }

  throw new GeminiPipelineError(
    'Failed to parse Gemini JSON response (truncation repair failed)',
    'PARSE_FAILED'
  );
}

// =============================================================================
// The Prompt (proven in PoC)
// =============================================================================

const GEMINI_PROMPT = `You are an expert audio transcription analyst. Listen to this entire recording carefully.

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

// =============================================================================
// JSON Schema for Gemini structured output
// =============================================================================

const RESPONSE_SCHEMA = {
  type: 'object' as const,
  properties: {
    speakers: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          label: { type: 'string' as const },
          name: { type: 'string' as const },
          role: { type: 'string' as const },
        },
        required: ['label', 'name'],
        propertyOrdering: ['label', 'name', 'role'],
      },
    },
    segments: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          speaker: { type: 'string' as const },
          startMs: { type: 'number' as const },
          endMs: { type: 'number' as const },
          text: { type: 'string' as const },
        },
        required: ['speaker', 'startMs', 'endMs', 'text'],
        propertyOrdering: ['speaker', 'startMs', 'endMs', 'text'],
      },
    },
    terms: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          key: { type: 'string' as const },
          display: { type: 'string' as const },
          definition: { type: 'string' as const },
          aliases: { type: 'array' as const, items: { type: 'string' as const } },
        },
        required: ['key', 'display', 'definition'],
        propertyOrdering: ['key', 'display', 'definition', 'aliases'],
      },
    },
    topics: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          title: { type: 'string' as const },
          startApproxMs: { type: 'number' as const },
          endApproxMs: { type: 'number' as const },
          type: { type: 'string' as const, enum: ['main', 'tangent'] },
        },
        required: ['title', 'startApproxMs', 'endApproxMs', 'type'],
        propertyOrdering: ['title', 'startApproxMs', 'endApproxMs', 'type'],
      },
    },
    persons: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const },
          affiliation: { type: 'string' as const },
        },
        required: ['name'],
        propertyOrdering: ['name', 'affiliation'],
      },
    },
  },
  required: ['speakers', 'segments', 'terms', 'topics', 'persons'],
  propertyOrdering: ['speakers', 'segments', 'terms', 'topics', 'persons'],
};

// =============================================================================
// Firestore Assembly
// =============================================================================

/**
 * Input from HARDY alignment: segment with speaker label and precise timestamps.
 */
export interface AlignedSegment {
  /** Speaker label matching Gemini's speaker labels */
  speakerId: string;
  /** Transcript text */
  text: string;
  /** Precise start time from HARDY alignment (ms) */
  startMs: number;
  /** Precise end time from HARDY alignment (ms) */
  endMs: number;
}

/**
 * Assembled data ready for Firestore persistence.
 * Shape matches the Conversation document schema the frontend consumes.
 */
export interface AssembledFirestoreData {
  speakers: Record<string, Speaker>;
  segments: Segment[];
  terms: Record<string, Term>;
  termOccurrences: TermOccurrence[];
  topics: Topic[];
  people: Person[];
  durationMs: number;
}

/**
 * Converts Gemini single-pass analysis + HARDY-aligned segments into the exact
 * Firestore schema the frontend already consumes.
 *
 * Pure transformation — no side effects, no network calls, no Firestore writes.
 * Output is sanitized (no undefined values) and safe to persist directly.
 *
 * This replaces the old mergeWhisperXAndGeminiData() which combined per-chunk
 * WhisperX + per-chunk Gemini outputs. Much simpler: one Gemini result + one
 * set of aligned segments → one complete payload.
 */
export function assembleFirestoreData(
  geminiResult: GeminiPipelineResult,
  alignedSegments: AlignedSegment[],
  durationMs: number,
): AssembledFirestoreData {
  // --- Speaker mapping ---
  // Gemini labels ("Speaker 1") → canonical IDs ("speaker_0")
  const speakerIdMap = new Map<string, string>();
  const speakers: Record<string, Speaker> = {};

  geminiResult.speakers.forEach((s, i) => {
    const id = `speaker_${i}`;
    speakerIdMap.set(s.label, id);
    const displayName = s.role ? `${s.name} (${s.role})` : s.name;
    speakers[id] = { speakerId: id, displayName, colorIndex: i };
  });

  // --- Segment assembly ---
  // HARDY-aligned timestamps are the truth; Gemini's are drifted ~1.6x
  const segments: Segment[] = alignedSegments.map((seg, i) => {
    let speakerId = speakerIdMap.get(seg.speakerId);
    if (!speakerId) {
      // Aligned segment references a speaker Gemini didn't list.
      // Deterministic fallback: stable ID from the label so every segment
      // with the same mystery speaker maps consistently.
      const safeLabel = seg.speakerId.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      speakerId = `speaker_unmapped_${safeLabel}`;
      if (!speakers[speakerId]) {
        speakers[speakerId] = {
          speakerId,
          displayName: seg.speakerId,
          colorIndex: Object.keys(speakers).length,
        };
      }
    }
    return {
      segmentId: `seg_${i}`,
      index: i,
      speakerId,
      startMs: seg.startMs,
      endMs: seg.endMs,
      text: seg.text,
    };
  });

  // --- Term assembly ---
  const terms: Record<string, Term> = {};
  geminiResult.terms.forEach((t, i) => {
    const id = `t_${i}`;
    terms[id] = {
      termId: id,
      key: t.key,
      display: t.display,
      definition: t.definition,
      aliases: t.aliases || [],
    };
  });

  // --- Term occurrence matching ---
  // Word-boundary-aware regex (from legacy mergeWhisperXAndGeminiData).
  // All patterns for a term joined as alternation so each position yields
  // at most one match per term. Longest patterns first to prefer
  // "machine learning" over "machine".
  const termOccurrences: TermOccurrence[] = [];
  let occCount = 0;

  for (const seg of segments) {
    for (const [termId, term] of Object.entries(terms)) {
      const patterns = [term.display, ...term.aliases].filter(Boolean);
      if (patterns.length === 0) continue;

      const escaped = patterns
        .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .sort((a, b) => b.length - a.length); // longest first
      const regex = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');

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

  // --- Topic assembly ---
  // Gemini topic timestamps are approximate and drift ~1.6x from reality.
  // Scale them using the same ratio as Gemini segments → real duration,
  // then find the nearest segment boundaries.
  let topics: Topic[];

  if (segments.length === 0) {
    // No segments → topics can't reference valid indices
    topics = [];
  } else {
    const geminiLastMs = geminiResult.segments[geminiResult.segments.length - 1]?.endMs || 1;
    const topicScale = durationMs / geminiLastMs;

    topics = geminiResult.topics.map((t, i) => {
      const scaledStart = t.startApproxMs * topicScale;
      const scaledEnd = t.endApproxMs * topicScale;

      // Find first segment starting at or after the scaled topic start
      let startIndex = 0;
      for (let s = 0; s < segments.length; s++) {
        if (segments[s].startMs >= scaledStart) { startIndex = s; break; }
      }

      // Find last segment starting at or before the scaled topic end
      let endIndex = segments.length - 1;
      for (let s = segments.length - 1; s >= 0; s--) {
        if (segments[s].startMs <= scaledEnd) { endIndex = s; break; }
      }

      // Clamp to valid range
      startIndex = Math.max(0, Math.min(startIndex, segments.length - 1));
      endIndex = Math.max(startIndex, Math.min(endIndex, segments.length - 1));

      return {
        topicId: `top_${i}`,
        title: t.title,
        startIndex,
        endIndex,
        type: t.type,
      };
    });
  }

  // --- People assembly ---
  // Speaking participants first, then Gemini-mentioned non-speakers.
  // Conditional field assignment keeps undefined out of the output,
  // but we also run sanitizeForFirestore as a safety net.
  const people: Person[] = [];

  geminiResult.speakers.forEach((s, i) => {
    const entry: Person = { personId: `p_${i}`, name: s.name };
    if (s.role) entry.affiliation = `Speaker (${s.role})`;
    people.push(entry);
  });

  geminiResult.persons.forEach((p, i) => {
    const entry: Person = {
      personId: `p_${geminiResult.speakers.length + i}`,
      name: p.name,
    };
    if (p.affiliation) entry.affiliation = p.affiliation;
    people.push(entry);
  });

  // Strip undefined values recursively — Firestore chokes on them
  return sanitizeForFirestore({
    speakers,
    segments,
    terms,
    termOccurrences,
    topics,
    people,
    durationMs,
  });
}

// =============================================================================
// Main Entry Point
// =============================================================================

/**
 * Process audio with Gemini 3 Flash for combined diarization + content analysis.
 *
 * Downloads audio from Firebase Storage, converts to WAV, uploads to Gemini
 * Files API, runs single-pass analysis, and returns structured result.
 *
 * @param audioStoragePath - Firebase Storage path to the audio file
 * @param options - Optional configuration (model, conversationId for logging)
 * @returns Complete analysis result with speakers, segments, terms, topics, persons
 * @throws GeminiPipelineError with specific error codes for different failure modes
 */
export async function processWithGemini3Flash(
  audioStoragePath: string,
  options?: GeminiPipelineOptions
): Promise<GeminiPipelineResult> {
  const model = options?.model || DEFAULT_MODEL;
  const conversationId = options?.conversationId;
  const ctx = { conversationId, stage: 'gemini3-pipeline' };

  log.info(`Starting Gemini 3 Flash pipeline: ${audioStoragePath}`, ctx);
  log.info(`Model: ${model}`, ctx);

  // Track temp files for cleanup
  let mp3Path: string | null = null;
  let wavPath: string | null = null;
  let uploadedFileName: string | null = null;
  let ai: GoogleGenAI | null = null;

  try {
    // Get API key from environment (Firebase Secrets)
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new GeminiPipelineError(
        'GEMINI_API_KEY not found in environment',
        'GENERATION_FAILED'
      );
    }

    ai = new GoogleGenAI({
      apiKey,
      httpOptions: { timeout: 300_000 }, // 5 minute budget — hybrid orchestrator enforces this limit
    });

    // Step 1: Download audio from Storage
    mp3Path = await downloadAudioFromStorage(audioStoragePath, conversationId);

    // Step 2: Convert to WAV (critical for speaker detection)
    wavPath = await convertToWav(mp3Path, conversationId);

    // Step 3: Upload to Gemini Files API
    log.info('Uploading WAV to Gemini Files API...', ctx);
    const uploadStart = Date.now();

    let uploadedFile;
    try {
      uploadedFile = await ai.files.upload({
        file: wavPath,
        config: {
          mimeType: 'audio/wav',
          displayName: `gemini3-${conversationId || 'unknown'}-${Date.now()}`,
        },
      });
    } catch (err) {
      throw new GeminiPipelineError(
        'Failed to upload audio to Gemini Files API',
        'UPLOAD_FAILED',
        err instanceof Error ? err : new Error(String(err))
      );
    }

    uploadedFileName = uploadedFile.name || null;
    const uploadDuration = Date.now() - uploadStart;
    log.info(`Upload complete in ${(uploadDuration / 1000).toFixed(1)}s`, ctx);

    if (!uploadedFile.uri || !uploadedFile.mimeType) {
      throw new GeminiPipelineError(
        'File upload succeeded but missing URI or mimeType',
        'UPLOAD_FAILED'
      );
    }

    // Step 4: Wait for file processing
    let fileState = uploadedFile.state;
    let waitAttempts = 0;

    while (fileState === 'PROCESSING') {
      waitAttempts++;
      if (waitAttempts > MAX_PROCESSING_WAIT_ATTEMPTS) {
        throw new GeminiPipelineError(
          `File processing timed out after ${MAX_PROCESSING_WAIT_ATTEMPTS * PROCESSING_POLL_INTERVAL_MS / 1000}s`,
          'TIMEOUT'
        );
      }

      log.debug(`File still processing... (attempt ${waitAttempts})`, ctx);
      await new Promise(r => setTimeout(r, PROCESSING_POLL_INTERVAL_MS));

      const fileInfo = await ai.files.get({ name: uploadedFile.name! });
      fileState = fileInfo.state;
    }

    if (fileState === 'FAILED') {
      throw new GeminiPipelineError(
        'Gemini file processing failed',
        'PROCESSING_FAILED'
      );
    }

    log.info('File processing complete, calling Gemini...', ctx);

    // Step 5: Generate content
    const apiStart = Date.now();
    let response;

    try {
      response = await ai.models.generateContent({
        model,
        contents: [{
          role: 'user',
          parts: [
            createPartFromUri(uploadedFile.uri, uploadedFile.mimeType),
            { text: GEMINI_PROMPT },
          ],
        }],
        config: {
          temperature: 0.1,
          maxOutputTokens: 65536,
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // Check for quota errors
      if (errMsg.includes('quota') || errMsg.includes('RESOURCE_EXHAUSTED')) {
        throw new GeminiPipelineError(
          'Gemini API quota exceeded',
          'QUOTA_EXCEEDED',
          err instanceof Error ? err : new Error(errMsg)
        );
      }

      throw new GeminiPipelineError(
        `Gemini generation failed: ${errMsg}`,
        'GENERATION_FAILED',
        err instanceof Error ? err : new Error(errMsg)
      );
    }

    const apiDuration = Date.now() - apiStart;
    const usage = response.usageMetadata;

    log.info(`Gemini response received in ${(apiDuration / 1000).toFixed(1)}s`, ctx);
    log.info(`Tokens: prompt=${usage?.promptTokenCount ?? '?'}, completion=${usage?.candidatesTokenCount ?? '?'}`, ctx);

    // Step 6: Parse response (with truncation repair)
    const rawText = response.text ?? '';
    const result = parseGeminiJson(rawText);

    log.info(`Parsed: ${result.speakers.length} speakers, ${result.segments.length} segments`, ctx);
    log.info(`Terms: ${result.terms.length}, Topics: ${result.topics.length}, Persons: ${result.persons.length}`, ctx);

    // Add metadata
    result.tokenUsage = {
      promptTokens: usage?.promptTokenCount ?? 0,
      completionTokens: usage?.candidatesTokenCount ?? 0,
      totalTokens: usage?.totalTokenCount ?? 0,
    };
    result.durationMs = apiDuration;

    return result;

  } finally {
    // Cleanup: always run regardless of success/failure

    // Clean up Gemini uploaded file
    if (ai && uploadedFileName) {
      try {
        await ai.files.delete({ name: uploadedFileName });
        log.info('Cleaned up Gemini uploaded file', ctx);
      } catch (cleanupErr) {
        log.warn('Failed to clean up Gemini uploaded file (non-fatal)', {
          ...ctx,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      }
    }

    // Clean up local temp files
    const filesToClean = [mp3Path, wavPath].filter((p): p is string => p !== null);
    for (const filePath of filesToClean) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (cleanupErr) {
        log.warn(`Failed to clean up temp file: ${filePath}`, {
          ...ctx,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      }
    }

    if (filesToClean.length > 0) {
      log.info(`Cleaned up ${filesToClean.length} temp file(s)`, ctx);
    }
  }
}
