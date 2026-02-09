/**
 * Transcription Cloud Function
 *
 * Triggered when an audio file is uploaded to Firebase Storage.
 * 1. Downloads the audio file
 * 2. Sends it to Gemini API for transcription
 * 3. Saves the results to Firestore
 *
 * The Gemini API key is stored as a Firebase secret (not in client code).
 * This keeps it secure from being exposed in the browser.
 */

import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { defineSecret } from 'firebase-functions/params';
import { VertexAI, SchemaType } from '@google-cloud/vertexai';
import { FieldValue } from 'firebase-admin/firestore';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { db, bucket } from './index';
import { ProgressManager, ProcessingStep } from './progressManager';
import { transcribeWithWhisperX, transcribeWithWhisperXRobust, WhisperXSegment, WhisperXDiarizationHints } from './alignment';
import {
  recordMetrics,
  calculateCost,
  GeminiUsage,
  LLMUsage
} from './metrics';
import { recordUserEvent } from './userEvents';
import { jsonrepair } from 'jsonrepair';
import { buildGeminiLabels } from './utils/llmMetadata';
import {
  chunkAudioFile,
  cleanupChunks,
  reencodeForPlayback,
  ChunkMetadata
} from './chunking';
import { validateChunkSequence } from './chunkBounds';
import {
  createInitialChunkStatuses,
  sanitizeForFirestore
} from './chunkContext';
import {
  ChunkingMetadata,
  ChunkContext,
  ChunkPipelineResult,
  SpeakerMapping,
  ChunkArtifact,
  SpeakerSignature,
  ProcessingMode
} from './types';
import { computeSpeakerQualityMapFromWhisperXSegments } from './speakerQuality';

// Define secrets (set via: firebase functions:secrets:set <SECRET_NAME>)
const whisperServiceUrl = defineSecret('WHISPER_SERVICE_URL');

// =============================================================================
// Timeout Configuration
// =============================================================================

/**
 * Timeout for Gemini API requests (20 minutes).
 * Large audio files (46MB+) need substantial time for upload and processing.
 * Google may take 10-15+ minutes to process a 46MB audio file before responding.
 */
const GEMINI_REQUEST_TIMEOUT_MS = 1_200_000;

/**
 * Create a Vertex AI client for Gemini API calls.
 * Uses automatic project detection from Cloud Functions environment.
 * Location defaults to us-central1 unless VERTEX_AI_LOCATION is set.
 */
function getVertexAIClient(): VertexAI {
  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  if (!project) {
    throw new Error('GCP project ID not found in environment');
  }

  const location = process.env.VERTEX_AI_LOCATION || 'us-central1';

  return new VertexAI({ project, location });
}

/**
 * Custom error for abort requests - allows clean exit from processing
 */
export class AbortRequestedError extends Error {
  constructor(conversationId: string) {
    super(`Processing aborted by user for conversation ${conversationId}`);
    this.name = 'AbortRequestedError';
  }
}

/**
 * Check if abort has been requested for this conversation.
 * Throws AbortRequestedError if abort flag is set.
 */
export async function checkAbort(conversationId: string): Promise<void> {
  const doc = await db.collection('conversations').doc(conversationId).get();
  if (doc.exists && doc.data()?.abortRequested === true) {
    console.log('[Transcribe] Abort requested, stopping processing:', { conversationId });
    throw new AbortRequestedError(conversationId);
  }
}

/**
 * Retry an operation with exponential backoff.
 * Handles transient errors: Firestore timeouts, Vertex AI cancellations, etc.
 */
async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries = 3,
  baseDelayMs = 2000
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check for retryable errors:
      // - Firestore: DEADLINE_EXCEEDED, UNAVAILABLE, RESOURCE_EXHAUSTED
      // - Vertex AI: 499 (Client Closed Request), CANCELLED
      // - General: 502, 503, 504 gateway errors
      const isRetryable = errorMessage.includes('DEADLINE_EXCEEDED') ||
                          errorMessage.includes('UNAVAILABLE') ||
                          errorMessage.includes('RESOURCE_EXHAUSTED') ||
                          errorMessage.includes('499') ||
                          errorMessage.includes('CANCELLED') ||
                          errorMessage.includes('Client Closed Request') ||
                          errorMessage.includes('502') ||
                          errorMessage.includes('503') ||
                          errorMessage.includes('504');

      if (!isRetryable || attempt === maxRetries) {
        console.error(`[Retry] ${operationName} failed after ${attempt} attempts:`, errorMessage);
        throw error;
      }

      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`[Retry] ${operationName} attempt ${attempt} failed, retrying in ${delay}ms...`, {
        error: errorMessage,
        attempt,
        maxRetries,
        delayMs: delay
      });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error(`${operationName} failed after ${maxRetries} retries`);
}

// =============================================================================
// Speaker Signature Builder
// =============================================================================

/**
 * Build speaker signatures from processed data for parallel mode reconciliation.
 *
 * Each signature captures fingerprint data that helps the merge function
 * correlate speakers across independently-processed chunks:
 * - topicSignatures: Topics where this speaker spoke (vocabulary/subject correlation)
 * - termSignatures: Specific terms used (vocabulary fingerprint)
 * - segmentCount: How much this speaker talked (relative activity)
 * - sampleQuote: First substantial utterance (manual verification aid)
 */
function buildChunkSpeakerSignatures(params: {
  chunkIndex: number;
  segments: Segment[];
  speakers: Record<string, Speaker>;
  topics: Topic[];
  terms: Record<string, Term>;
  termOccurrences: TermOccurrence[];
  speakerQuality?: Record<string, { compositeScore: number }>;
}): SpeakerSignature[] {
  const { chunkIndex, segments, speakers, topics, terms, termOccurrences, speakerQuality } = params;

  // Group segments by speaker
  const segmentsBySpeaker = new Map<string, Segment[]>();
  for (const seg of segments) {
    const existing = segmentsBySpeaker.get(seg.speakerId) || [];
    existing.push(seg);
    segmentsBySpeaker.set(seg.speakerId, existing);
  }

  // Build term occurrences by segment for quick lookup
  const termsBySegment = new Map<string, Set<string>>();
  for (const occ of termOccurrences) {
    const existing = termsBySegment.get(occ.segmentId) || new Set<string>();
    // Store the term key, not the ID, for vocabulary fingerprinting
    const term = terms[occ.termId];
    if (term) {
      existing.add(term.key);
    }
    termsBySegment.set(occ.segmentId, existing);
  }

  // Build topic coverage by segment index
  // Topics span ranges of segments, so we need to check if each segment falls in a topic range
  const getTopicsForSegment = (segmentIndex: number): string[] => {
    return topics
      .filter(t => segmentIndex >= t.startIndex && segmentIndex <= t.endIndex)
      .map(t => t.topicId);
  };

  const signatures: SpeakerSignature[] = [];

  for (const [speakerId, speakerSegments] of segmentsBySpeaker) {
    const speaker = speakers[speakerId];
    if (!speaker) continue;

    // Collect unique topic and term signatures
    const topicSet = new Set<string>();
    const termSet = new Set<string>();

    for (const seg of speakerSegments) {
      // Add topics this segment belongs to
      for (const topicId of getTopicsForSegment(seg.index)) {
        topicSet.add(topicId);
      }
      // Add terms used in this segment
      const segTerms = termsBySegment.get(seg.segmentId);
      if (segTerms) {
        for (const termKey of segTerms) {
          termSet.add(termKey);
        }
      }
    }

    // Get a sample quote (first segment with substantial text, max 100 chars)
    const sampleSegment = speakerSegments.find(s => s.text.length >= 20) || speakerSegments[0];
    const sampleQuote = sampleSegment
      ? sampleSegment.text.slice(0, 100) + (sampleSegment.text.length > 100 ? '...' : '')
      : '';

    // Get quality score if available
    const quality = speakerQuality?.[speakerId]?.compositeScore;

    signatures.push({
      speakerId,
      chunkIndex,
      inferredName: speaker.displayName !== speakerId ? speaker.displayName : undefined,
      topicSignatures: Array.from(topicSet),
      termSignatures: Array.from(termSet),
      segmentCount: speakerSegments.length,
      sampleQuote,
      quality
    });
  }

  return signatures;
}

// Gemini analysis-only response (analyzes WhisperX transcript)
interface GeminiAnalysis {
  title: string;
  topics: { title: string; startSegmentIndex: number; endSegmentIndex: number; type: 'main' | 'tangent' }[];
  terms: { id: string; term: string; definition: string; aliases: string[] }[];
  people: { name: string; affiliation: string }[];
  speakerNotes?: {
    speakerId: string;
    inferredName?: string;  // Real name if speaker introduces themselves
    role?: string;          // e.g., "host", "guest", "interviewer"
    notes?: string;         // Additional context
  }[];
}

/**
 * Result from Gemini analysis including token usage for cost tracking
 */
interface GeminiAnalysisResult {
  analysis: GeminiAnalysis;
  tokenUsage: GeminiUsage;
  labels: Record<string, string>;  // Billing labels for this call
}

/**
 * Result from speaker correction analysis including token usage
 */
interface SpeakerCorrectionResult {
  corrections: SpeakerCorrection[];
  tokenUsage: GeminiUsage;
  labels: Record<string, string>;  // Billing labels for this call
}

interface Speaker {
  speakerId: string;
  displayName: string;
  colorIndex: number;
}

interface Segment {
  segmentId: string;
  index: number;
  speakerId: string;
  startMs: number;
  endMs: number;
  text: string;
}

interface Term {
  termId: string;
  key: string;
  display: string;
  definition: string;
  aliases: string[];
}

interface TermOccurrence {
  occurrenceId: string;
  termId: string;
  segmentId: string;
  startChar: number;
  endChar: number;
}

interface Topic {
  topicId: string;
  title: string;
  startIndex: number;
  endIndex: number;
  type: 'main' | 'tangent';
  parentTopicId?: string;
}

interface Person {
  personId: string;
  name: string;
  affiliation?: string;
  userNotes?: string;
}

/**
 * Represents a speaker correction identified by Gemini analysis.
 * Used to fix mid-segment speaker changes that pyannote misses.
 */
interface SpeakerCorrection {
  segmentIndex: number;
  action: 'split' | 'reassign';
  reason: string;
  // For split action:
  splitAtChar?: number;
  speakerBefore?: string;
  speakerAfter?: string;
  // For reassign action:
  newSpeaker?: string;
}

/**
 * Hints for WhisperX diarization, extracted from Gemini pre-analysis.
 * Passing num_speakers and speaker names improves diarization accuracy.
 */
interface WhisperXHints {
  numSpeakers?: number;
  speakerNames?: string[];  // e.g., ["Jimmy", "Bill"] for the prompt parameter
  // Speaker notes from pre-analysis, stored here for later use in merge step
  // Underscore prefix indicates internal field not sent to WhisperX
  _speakerNotes?: Array<{
    speakerId: string;
    inferredName?: string;
    role?: string;
  }>;
}

/**
 * Robustly parse JSON from LLM output.
 *
 * Gemini sometimes produces malformed JSON despite schema enforcement - typically
 * unescaped quotes or special characters in string values. This tries:
 * 1. Direct JSON.parse (fast path for valid JSON)
 * 2. jsonrepair library (handles most malformed JSON)
 * 3. Basic cleanup heuristics (markdown fences, trailing garbage)
 *
 * Logs what worked so we can track how often Gemini produces broken JSON.
 */
function robustJsonParse<T>(text: string, context: string): T {
  // Strip markdown code fences if present
  const cleanText = text.replace(/```json\s*|\s*```/g, '').trim();

  // Fast path: try direct parse first
  try {
    const result = JSON.parse(cleanText) as T;
    console.log(`[${context}] JSON parsed directly (valid output)`);
    return result;
  } catch (directError) {
    console.log(`[${context}] Direct JSON parse failed, attempting repair...`);
  }

  // Second attempt: use jsonrepair library
  try {
    const repaired = jsonrepair(cleanText);
    const result = JSON.parse(repaired) as T;
    console.log(`[${context}] JSON repaired successfully by jsonrepair library`);
    return result;
  } catch (repairError) {
    console.log(`[${context}] jsonrepair failed, trying truncation fallback...`);
  }

  // Last resort: try to find valid JSON by truncating at last complete object/array
  // This helps when output was cut off mid-generation
  try {
    // Find last closing brace/bracket that could complete the JSON
    let lastValidEnd = -1;
    let braceDepth = 0;
    let bracketDepth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < cleanText.length; i++) {
      const char = cleanText[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\' && inString) {
        escapeNext = true;
        continue;
      }

      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '{') braceDepth++;
        else if (char === '}') {
          braceDepth--;
          if (braceDepth === 0 && bracketDepth === 0) {
            lastValidEnd = i;
          }
        } else if (char === '[') bracketDepth++;
        else if (char === ']') {
          bracketDepth--;
          if (braceDepth === 0 && bracketDepth === 0) {
            lastValidEnd = i;
          }
        }
      }
    }

    if (lastValidEnd > 0) {
      const truncated = cleanText.slice(0, lastValidEnd + 1);
      const result = JSON.parse(truncated) as T;
      console.log(`[${context}] JSON recovered by truncating to position ${lastValidEnd}`);
      return result;
    }
  } catch (truncateError) {
    // Truncation didn't help
  }

  // All strategies failed - throw with useful context
  throw new Error(
    `[${context}] Failed to parse JSON after all repair attempts. ` +
    `Text length: ${cleanText.length}, starts with: ${cleanText.slice(0, 100)}...`
  );
}

/**
 * Result from Gemini pre-analysis of audio.
 * Provides speaker hints for WhisperX ONLY - content analysis is handled separately.
 *
 * Note: We previously tried to combine speaker hints + full content analysis in one call,
 * but Gemini would generate 60k+ tokens and hit output limits, causing JSON truncation.
 * Now pre-analysis is lightweight (~500 tokens output) and always succeeds.
 */
interface GeminiPreAnalysisResult {
  hints: WhisperXHints;
  tokenUsage: GeminiUsage;
  labels: Record<string, string>;  // Billing labels used for this call
}

/**
 * Pre-analyze audio with Gemini to extract speaker hints ONLY.
 *
 * This runs BEFORE WhisperX to determine speaker count and names for better diarization.
 * Content analysis (terms, topics, people) is handled by analyzeTranscriptWithGemini()
 * AFTER WhisperX provides the transcript text.
 *
 * Why separate? Combining speaker hints + full analysis in one call caused Gemini to
 * generate 60k+ tokens, hitting output limits and truncating JSON. Keeping pre-analysis
 * lightweight (~500 tokens) ensures reliable results.
 */
async function preAnalyzeAudioWithGemini(
  audioBuffer: Buffer,
  conversationId: string,
  userId: string
): Promise<GeminiPreAnalysisResult> {
  console.log('[Gemini Pre-Analysis] Starting audio analysis for speaker hints...');
  const startTime = Date.now();

  const vertexAI = getVertexAIClient();

  // Use gemini-2.5-flash for audio analysis
  // Schema is intentionally minimal - just speaker hints, no content analysis
  // This keeps output small (~500 tokens) and avoids JSON truncation issues
  const model = vertexAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          speakerCount: { type: SchemaType.INTEGER },
          speakers: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                id: { type: SchemaType.STRING },  // SPEAKER_00, SPEAKER_01, etc.
                name: { type: SchemaType.STRING }, // Inferred name if mentioned
                role: { type: SchemaType.STRING }  // host, guest, interviewer, etc.
              },
              required: ['id']
            }
          }
        },
        required: ['speakerCount', 'speakers']
      }
    }
  }, { timeout: GEMINI_REQUEST_TIMEOUT_MS });

  // Convert audio to base64
  const audioBase64 = audioBuffer.toString('base64');

  // Detect MIME type
  let mimeType = 'audio/mpeg';
  if (audioBuffer[0] === 0x52 && audioBuffer[1] === 0x49) {
    mimeType = 'audio/wav';
  } else if (audioBuffer[0] === 0x4F && audioBuffer[1] === 0x67) {
    mimeType = 'audio/ogg';
  }

  // Focused prompt for speaker hints only - keeps response small and reliable
  const prompt = `
Analyze this audio file and identify the speakers.

## Speaker Analysis (CRITICAL - be accurate)
1. How many distinct speakers are in this audio? Count carefully - don't hallucinate extra speakers.
2. For each speaker, provide:
   - id: Use format SPEAKER_00, SPEAKER_01, etc. (in order of first appearance)
   - name: If the speaker introduces themselves or is addressed by name
   - role: If apparent (e.g., "host", "guest", "interviewer", "expert")

Be conservative - only report speakers you can clearly distinguish by voice.
`;

  console.log('[Gemini Pre-Analysis] Sending audio to Gemini...');

  // Build labels for billing attribution
  const labels = buildGeminiLabels(conversationId, userId, 'pre_analysis');

  const result = await model.generateContent({
    contents: [
      { role: 'user', parts: [{ text: prompt }] },
      {
        role: 'user',
        parts: [{
          inlineData: {
            mimeType,
            data: audioBase64
          }
        }]
      }
    ],
    labels
  });

  const durationMs = Date.now() - startTime;
  // Vertex AI SDK response structure
  const responseText = result.response.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // Extract token usage
  const usageMetadata = result.response.usageMetadata;
  const tokenUsage: GeminiUsage = {
    inputTokens: usageMetadata?.promptTokenCount || 0,
    outputTokens: usageMetadata?.candidatesTokenCount || 0,
    model: 'gemini-2.5-flash'
  };

  console.log(`[Gemini Pre-Analysis] Response received in ${(durationMs / 1000).toFixed(1)}s`, {
    inputTokens: tokenUsage.inputTokens,
    outputTokens: tokenUsage.outputTokens
  });

  // Parse response - schema is intentionally minimal (speaker hints only)
  type PreAnalysisResponse = {
    speakerCount: number;
    speakers: Array<{ id: string; name?: string; role?: string }>;
  };
  const parsed = robustJsonParse<PreAnalysisResponse>(responseText, 'Gemini Pre-Analysis');

  // Defensive checks - even with small schema, handle potential issues
  const speakers = parsed.speakers || [];

  if (speakers.length === 0) {
    console.warn('[Gemini Pre-Analysis] No speakers in response - using defaults');
  }

  // Build WhisperX hints from speaker data
  const speakerNames = speakers
    .filter(s => s.name)
    .map(s => s.name as string);

  const hints: WhisperXHints = {
    numSpeakers: parsed.speakerCount || speakers.length || 2,  // Default to 2 if missing
    speakerNames: speakerNames.length > 0 ? speakerNames : undefined,
    // Store full speaker info for later use in merge step
    _speakerNotes: speakers.map(s => ({
      speakerId: s.id,
      inferredName: s.name,
      role: s.role
    }))
  };

  console.log('[Gemini Pre-Analysis] ✅ Speaker hints extracted:', {
    speakerCount: hints.numSpeakers,
    speakerNames: hints.speakerNames,
    speakersWithRoles: speakers.filter(s => s.role).length
  });

  return { hints, tokenUsage, labels };
}

/**
 * Fallback transcription using Gemini when WhisperX fails.
 * Uses Gemini's audio understanding capabilities for transcription.
 * Note: Timestamps are approximate (Gemini estimates, not word-level).
 */
async function transcribeWithGeminiFallback(
  audioBuffer: Buffer,
  conversationId: string,
  userId: string
): Promise<{ segments: WhisperXSegment[]; status: 'success' | 'error'; error?: string; usedFallback?: boolean }> {
  console.log('[Gemini Fallback] Starting transcription...');

  try {
    const vertexAI = getVertexAIClient();

    // Use gemini-2.5-flash for transcription (supports audio)
    const model = vertexAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            segments: {
              type: SchemaType.ARRAY,
              items: {
                type: SchemaType.OBJECT,
                properties: {
                  text: { type: SchemaType.STRING },
                  startSeconds: { type: SchemaType.NUMBER },
                  endSeconds: { type: SchemaType.NUMBER },
                  speaker: { type: SchemaType.STRING }
                },
                required: ['text', 'startSeconds', 'endSeconds']
              }
            }
          },
          required: ['segments']
        }
      }
    }, { timeout: GEMINI_REQUEST_TIMEOUT_MS });

    // Convert audio to base64 for Gemini
    const audioBase64 = audioBuffer.toString('base64');

    // Detect MIME type from buffer (simplified - assume common formats)
    let mimeType = 'audio/mpeg'; // Default
    if (audioBuffer[0] === 0x52 && audioBuffer[1] === 0x49) { // RIFF header
      mimeType = 'audio/wav';
    } else if (audioBuffer[0] === 0x4F && audioBuffer[1] === 0x67) { // OggS
      mimeType = 'audio/ogg';
    }

    const prompt = `
Transcribe this audio file into segments. For each segment, provide:
- The spoken text
- Approximate start time in seconds
- Approximate end time in seconds
- Speaker label if you can identify different speakers (use "SPEAKER_00", "SPEAKER_01", etc.)

Focus on accuracy of the transcription. Timestamps should be your best estimate.
Group related sentences into segments (typically 1-4 sentences per segment).
If you detect multiple speakers, assign consistent speaker labels throughout.

Return as JSON with a "segments" array.
`;

    console.log('[Gemini Fallback] Sending audio to Gemini...');
    const startTime = Date.now();

    // Build labels for billing attribution
    const labels = buildGeminiLabels(conversationId, userId, 'fallback_transcription');

    // Wrap in retry logic - Vertex AI can return 499 (Client Closed Request) on large files
    const result = await retryWithBackoff(
      () => model.generateContent({
        contents: [
          { role: 'user', parts: [{ text: prompt }] },
          {
            role: 'user',
            parts: [{
              inlineData: {
                mimeType,
                data: audioBase64
              }
            }]
          }
        ],
        labels
      }),
      'Gemini Fallback transcription',
      3,      // maxRetries
      10000   // 10 second base delay (longer for large file processing)
    );

    const durationMs = Date.now() - startTime;
    // Vertex AI SDK response structure
    const responseText = result.response.candidates?.[0]?.content?.parts?.[0]?.text || '';

    console.log(`[Gemini Fallback] Response received in ${(durationMs / 1000).toFixed(1)}s`);

    // Parse response with robust error handling
    type FallbackResponse = {
      segments: Array<{
        text: string;
        startSeconds: number;
        endSeconds: number;
        speaker?: string;
      }>;
    };
    const parsed = robustJsonParse<FallbackResponse>(responseText, 'Gemini Fallback');

    // Convert to WhisperXSegment format
    const segments: WhisperXSegment[] = parsed.segments.map(seg => ({
      text: seg.text,
      start: seg.startSeconds,
      end: seg.endSeconds,
      speaker: seg.speaker
    }));

    console.log(`[Gemini Fallback] ✅ Transcribed ${segments.length} segments`);

    return {
      segments,
      status: 'success',
      usedFallback: true
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Gemini Fallback] ❌ Transcription failed: ${errorMsg}`);

    return {
      segments: [],
      status: 'error',
      error: `Gemini transcription failed: ${errorMsg}`
    };
  }
}

/**
 * Parameters for the transcription pipeline (shared between storage trigger and HTTP function)
 */
export interface TranscriptionPipelineParams {
  conversationId: string;
  userId: string;
  filePath: string;
  whisperServiceUrl: string;
  audioSizeBytes?: number; // Optional - for logging only
  /** Optional chunk context for context-aware chunk processing */
  chunkContext?: ChunkContext;
  /** Optional chunk metadata - when present, indicates this is a chunk task */
  chunkMetadata?: {
    chunkIndex: number;
    totalChunks: number;
    startMs: number;
    endMs: number;
    overlapBeforeMs: number;
    overlapAfterMs: number;
  };
}

/**
 * Execute the full transcription pipeline.
 *
 * This is the core processing logic shared between:
 * - transcribeAudio (storage trigger, now just enqueues to Cloud Tasks)
 * - processTranscription (HTTP function, executes the heavy processing)
 *
 * Steps:
 * 1. Download audio from Storage
 * 2. Pre-analyze with Gemini (speaker hints)
 * 3. Transcribe with WhisperX (or Gemini fallback)
 * 4. Analyze content with Gemini (topics, terms, people)
 * 5. Identify speakers from content
 * 6. Apply speaker corrections
 * 7. Save results to Firestore
 *
 * On error, updates Firestore status to 'failed' and records metrics.
 * On abort, updates status to 'aborted' and records partial metrics.
 */
export async function executeTranscriptionPipeline(params: TranscriptionPipelineParams): Promise<ChunkPipelineResult> {
  const { conversationId, userId, filePath, whisperServiceUrl, audioSizeBytes, chunkContext, chunkMetadata } = params;
  const isChunkTask = !!chunkMetadata;

  // Initialize progress tracking (with chunk info for aggregate progress calculation)
  const progressManager = new ProgressManager(
    conversationId,
    chunkMetadata?.chunkIndex,
    chunkMetadata?.totalChunks
  );

  // Track partial metrics for abort scenarios
  const partialMetrics = {
    timingMs: {
      download: 0,
      whisperx: 0,
      buildSegments: 0,
      gemini: 0,
      speakerCorrection: 0,
      transform: 0,
      firestore: 0,
      total: 0
    },
    llmUsage: {
      geminiAnalysis: { inputTokens: 0, audioInputTokens: 0, textInputTokens: 0, outputTokens: 0, model: 'gemini-2.5-flash' as const },
      geminiSpeakerCorrection: { inputTokens: 0, audioInputTokens: 0, textInputTokens: 0, outputTokens: 0, model: 'gemini-2.5-flash' as const },
      whisperx: { predictionId: '', computeTimeSeconds: 0, model: 'whisperx-diarization' as const }
    },
    geminiLabels: [] as Record<string, string>[],
    segmentCount: 0,
    speakerCount: 0,
    termCount: 0,
    topicCount: 0,
    personCount: 0,
    speakerCorrectionsApplied: 0,
    audioSizeMB: audioSizeBytes ? audioSizeBytes / (1024 * 1024) : 0,
    durationMs: 0,
    processStartTime: Date.now()
  };

  try {
    // Start pre-analysis step
    await progressManager.setStep(ProcessingStep.PRE_ANALYZING);

    // Download audio file to memory
    console.debug('[Pipeline] Starting audio download from Storage...');
    const downloadStartTime = Date.now();
    const file = bucket.file(filePath);
    const [audioBuffer] = await file.download();
    const downloadDurationMs = Date.now() - downloadStartTime;

    console.log('[Pipeline] Audio downloaded:', {
      conversationId,
      bufferSizeBytes: audioBuffer.length,
      bufferSizeMB: (audioBuffer.length / (1024 * 1024)).toFixed(2),
      downloadDurationMs,
      downloadSpeedMBps: ((audioBuffer.length / (1024 * 1024)) / (downloadDurationMs / 1000)).toFixed(2)
    });

    partialMetrics.timingMs.download = downloadDurationMs;
    partialMetrics.audioSizeMB = audioBuffer.length / (1024 * 1024);

    // Check for abort after download
    await checkAbort(conversationId);

    // Step 1: Pre-analyze with Gemini to get speaker hints
    console.log('[Pipeline] Step 1: Pre-analyzing audio with Gemini...');
    const preAnalysisStartTime = Date.now();

    let preAnalysisResult: GeminiPreAnalysisResult | null = null;
    let whisperxHints: WhisperXDiarizationHints | undefined;

    try {
      preAnalysisResult = await preAnalyzeAudioWithGemini(
        audioBuffer,
        conversationId,
        userId
      );

      whisperxHints = {
        numSpeakers: preAnalysisResult.hints.numSpeakers,
        speakerNames: preAnalysisResult.hints.speakerNames
      };

      console.log('[Pipeline] Pre-analysis complete:', {
        speakerCount: whisperxHints.numSpeakers,
        speakerNames: whisperxHints.speakerNames,
        durationMs: Date.now() - preAnalysisStartTime
      });

      partialMetrics.geminiLabels.push(preAnalysisResult.labels);

      // Track pre-analysis tokens as audio input (sends raw audio to Gemini)
      partialMetrics.llmUsage.geminiAnalysis.audioInputTokens += preAnalysisResult.tokenUsage.inputTokens;
      partialMetrics.llmUsage.geminiAnalysis.inputTokens += preAnalysisResult.tokenUsage.inputTokens;
      partialMetrics.llmUsage.geminiAnalysis.outputTokens += preAnalysisResult.tokenUsage.outputTokens;
    } catch (error) {
      console.warn('[Pipeline] Pre-analysis failed, continuing without hints:', error);
    }

    // Check for abort after pre-analysis
    await checkAbort(conversationId);

    // Step 2: Transcribe with WhisperX
    await progressManager.setStep(ProcessingStep.TRANSCRIBING);
    console.log('[Pipeline] Step 2: Calling WhisperX for transcription with hints...');
    const whisperxStartTime = Date.now();

    // Try robust WhisperX first
    let whisperxResult = await transcribeWithWhisperXRobust(
      audioBuffer,
      whisperServiceUrl,
      2,
      whisperxHints
    );

    // If robust method failed, try standard method as backup
    if (whisperxResult.status === 'error') {
      console.warn('[Pipeline] Robust WhisperX failed, trying standard method...');
      whisperxResult = await transcribeWithWhisperX(
        audioBuffer,
        whisperServiceUrl,
        whisperxHints
      );
    }

    const whisperxDurationMs = Date.now() - whisperxStartTime;

    // If WhisperX completely failed, fall back to Gemini transcription
    if (whisperxResult.status === 'error') {
      console.warn('[Pipeline] WhisperX failed completely, falling back to Gemini transcription...');

      const geminiTranscriptResult = await transcribeWithGeminiFallback(
        audioBuffer,
        conversationId,
        userId
      );

      if (geminiTranscriptResult.status === 'error') {
        throw new Error(`Both WhisperX and Gemini transcription failed. WhisperX: ${whisperxResult.error}. Gemini: ${geminiTranscriptResult.error}`);
      }

      whisperxResult = geminiTranscriptResult;
      console.log('[Pipeline] Using Gemini transcription as fallback (timestamps may be approximate)');
      await progressManager.setStep(ProcessingStep.ANALYZING);
    }

    const usedGeminiFallback = 'usedFallback' in whisperxResult && whisperxResult.usedFallback === true;

    console.log('[Pipeline] WhisperX transcription complete:', {
      conversationId,
      durationMs: whisperxDurationMs,
      segmentCount: whisperxResult.segments.length
    });

    partialMetrics.timingMs.whisperx = whisperxDurationMs;

    const actualComputeSeconds = whisperxResult.actualComputeSeconds;
    const computeSeconds = actualComputeSeconds ?? (whisperxDurationMs / 1000);

    if (actualComputeSeconds) {
      console.log(`[Pipeline] Using actual Cloud Run compute time: ${actualComputeSeconds}s`);
    } else {
      console.warn(`[Pipeline] Estimating compute time from wall-clock: ${(whisperxDurationMs / 1000).toFixed(1)}s`);
    }

    partialMetrics.llmUsage.whisperx.computeTimeSeconds = computeSeconds;

    const whisperxPredictionId = whisperxResult.predictionId;
    if (whisperxPredictionId) {
      partialMetrics.llmUsage.whisperx.predictionId = whisperxPredictionId;
    }

    // Check for abort after WhisperX
    await checkAbort(conversationId);

    // Compute per-speaker quality scores from WhisperX word-level confidence
    // This happens BEFORE segment transformation so we have access to raw word scores
    const speakerQuality = computeSpeakerQualityMapFromWhisperXSegments(whisperxResult.segments);
    console.debug('[Pipeline] Speaker quality computed:', {
      speakerCount: Object.keys(speakerQuality).length,
      scores: Object.entries(speakerQuality).map(([id, q]) => ({
        speakerId: id,
        composite: q.compositeScore.toFixed(3),
        snr: q.snrProxy.toFixed(3),
        clarity: q.clarityScore.toFixed(3),
        contaminated: q.isContaminated
      }))
    });

    // Build segments from WhisperX output
    console.debug('[Pipeline] Building segments from WhisperX...');
    const buildStartTime = Date.now();

    const whisperxSegments = buildSegmentsFromWhisperX(whisperxResult.segments);
    whisperxSegments.segments = fixSegmentBoundaries(whisperxSegments.segments);

    const buildDurationMs = Date.now() - buildStartTime;
    console.debug('[Pipeline] Segments built:', {
      buildDurationMs,
      segmentCount: whisperxSegments.segments.length,
      speakerCount: whisperxSegments.speakers.length
    });

    // Update progress: analyzing with Gemini
    await progressManager.setStep(ProcessingStep.ANALYZING);

    // Step 3: Content analysis with Gemini
    // Pre-analysis only provides speaker hints for WhisperX - content analysis always runs here
    // This approach avoids JSON truncation issues (pre-analysis was hitting 64k token limit)
    console.log('[Pipeline] Step 3: Calling Gemini for content analysis...');
    const geminiStartTime = Date.now();

    const analysisResult = await analyzeTranscriptWithGemini(
      whisperxSegments.segments,
      whisperxSegments.speakers,
      conversationId,
      userId
    );
    const analysis = analysisResult.analysis;
    const geminiAnalysisTokens = analysisResult.tokenUsage;

    // Merge speaker notes from pre-analysis if available
    // Pre-analysis identifies speakers by voice before WhisperX runs
    if (preAnalysisResult?.hints._speakerNotes) {
      analysis.speakerNotes = preAnalysisResult.hints._speakerNotes;
      console.log('[Pipeline] Speaker notes from pre-analysis:', {
        speakerCount: analysis.speakerNotes.length,
        namedSpeakers: analysis.speakerNotes.filter(s => s.inferredName).length
      });
    }

    partialMetrics.geminiLabels.push(analysisResult.labels);

    const geminiDurationMs = Date.now() - geminiStartTime;
    console.log('[Pipeline] Gemini analysis complete:', {
      conversationId,
      durationMs: geminiDurationMs,
      title: analysis.title,
      termCount: analysis.terms?.length ?? 0,
      topicCount: analysis.topics?.length ?? 0,
      personCount: analysis.people?.length ?? 0
    });

    partialMetrics.timingMs.gemini = geminiDurationMs;
    // Content analysis sends transcript TEXT to Gemini (not audio)
    partialMetrics.llmUsage.geminiAnalysis.textInputTokens += geminiAnalysisTokens.inputTokens;
    partialMetrics.llmUsage.geminiAnalysis.inputTokens += geminiAnalysisTokens.inputTokens;
    partialMetrics.llmUsage.geminiAnalysis.outputTokens += geminiAnalysisTokens.outputTokens;
    partialMetrics.segmentCount = whisperxSegments.segments.length;
    partialMetrics.speakerCount = whisperxSegments.speakers.length;
    partialMetrics.termCount = analysis.terms?.length ?? 0;
    partialMetrics.topicCount = analysis.topics?.length ?? 0;
    partialMetrics.personCount = analysis.people?.length ?? 0;

    // Check for abort after Gemini analysis
    await checkAbort(conversationId);

    // Step 3.4: Content-based speaker identification
    console.log('[Pipeline] Step 3.4: Identifying speakers from transcript content...');
    const speakerIdStartTime = Date.now();

    const speakerIdentificationResult = await identifySpeakersFromContent(
      whisperxSegments.segments,
      whisperxSegments.speakers,
      conversationId,
      userId
    );

    partialMetrics.geminiLabels.push(speakerIdentificationResult.labels);

    const speakerIdDurationMs = Date.now() - speakerIdStartTime;
    console.log('[Pipeline] Content-based speaker identification complete:', {
      conversationId,
      durationMs: speakerIdDurationMs,
      speakerNotesFound: speakerIdentificationResult.speakerNotes?.length ?? 0
    });

    if (speakerIdentificationResult.speakerNotes && speakerIdentificationResult.speakerNotes.length > 0) {
      analysis.speakerNotes = speakerIdentificationResult.speakerNotes;
      console.log('[Pipeline] Using content-based speaker identification (overriding pre-analysis)');
    } else {
      console.warn('[Pipeline] Content-based identification returned no speaker notes, using pre-analysis fallback');
    }

    // Speaker identification sends transcript TEXT to Gemini
    partialMetrics.llmUsage.geminiAnalysis.textInputTokens += speakerIdentificationResult.tokenUsage.inputTokens;
    partialMetrics.llmUsage.geminiAnalysis.inputTokens += speakerIdentificationResult.tokenUsage.inputTokens;
    partialMetrics.llmUsage.geminiAnalysis.outputTokens += speakerIdentificationResult.tokenUsage.outputTokens;

    // Step 3.5: Speaker reassignment pass
    await progressManager.setStep(ProcessingStep.REASSIGNING);
    console.log('[Pipeline] Step 3.5: Identifying speaker reassignments...');
    const speakerCorrectionStartTime = Date.now();

    const correctionResult = await identifySpeakerReassignments(
      whisperxSegments.segments,
      whisperxSegments.speakers,
      conversationId,
      userId
    );
    const { corrections: speakerCorrections, tokenUsage: geminiCorrectionTokens } = correctionResult;

    partialMetrics.geminiLabels.push(correctionResult.labels);

    const speakerCorrectionDurationMs = Date.now() - speakerCorrectionStartTime;
    console.log('[Pipeline] Speaker reassignment analysis complete:', {
      conversationId,
      durationMs: speakerCorrectionDurationMs,
      correctionCount: speakerCorrections.length
    });

    partialMetrics.timingMs.speakerCorrection = speakerCorrectionDurationMs;
    // Speaker reassignment sends transcript TEXT to Gemini
    partialMetrics.llmUsage.geminiSpeakerCorrection = {
      inputTokens: geminiCorrectionTokens.inputTokens,
      textInputTokens: geminiCorrectionTokens.inputTokens,  // All input is text
      audioInputTokens: 0,
      outputTokens: geminiCorrectionTokens.outputTokens,
      model: 'gemini-2.5-flash'
    };
    partialMetrics.speakerCorrectionsApplied = speakerCorrections.length;

    // Apply speaker reassignments
    if (speakerCorrections.length > 0) {
      whisperxSegments.segments = applySpeakerReassignments(
        whisperxSegments.segments,
        speakerCorrections,
        whisperxSegments.speakers.map(s => s.id)
      );
    }

    // Update progress: finalizing
    await progressManager.setStep(ProcessingStep.FINALIZING);

    // Step 4: Transform to our data model
    console.debug('[Pipeline] Step 4: Merging WhisperX and Gemini data...');
    const transformStartTime = Date.now();

    const processedData = mergeWhisperXAndGeminiData(
      whisperxSegments,
      analysis,
      conversationId,
      userId,
      chunkMetadata?.chunkIndex // Pass chunk index for unique IDs
    );

    const transformDurationMs = Date.now() - transformStartTime;
    console.debug('[Pipeline] Transform complete:', {
      transformDurationMs,
      finalSegmentCount: processedData.segments.length,
      termOccurrenceCount: processedData.termOccurrences.length,
      durationMs: processedData.durationMs
    });

    partialMetrics.durationMs = processedData.durationMs;

    // Check for abort before final save
    await checkAbort(conversationId);

    // Determine alignment status
    const finalAlignmentStatus = usedGeminiFallback ? 'fallback' : 'aligned';

    // Save results to Firestore (different logic for chunks vs whole files)
    console.debug('[Pipeline] Saving results to Firestore...');
    const firestoreStartTime = Date.now();

    if (isChunkTask && chunkMetadata) {
      // For chunk tasks, save as a ChunkArtifact in the subcollection
      // The merge job will stitch these together later
      const chunkArtifact: ChunkArtifact = {
        conversationId,
        userId,
        chunkIndex: chunkMetadata.chunkIndex,
        totalChunks: chunkMetadata.totalChunks,
        segments: processedData.segments,
        speakers: processedData.speakers,
        terms: processedData.terms,
        termOccurrences: processedData.termOccurrences,
        topics: processedData.topics,
        people: processedData.people,
        chunkBounds: {
          startMs: chunkMetadata.startMs,
          endMs: chunkMetadata.endMs,
          overlapBeforeMs: chunkMetadata.overlapBeforeMs,
          overlapAfterMs: chunkMetadata.overlapAfterMs
        },
        emittedContext: chunkContext!, // Will be replaced by processTranscription with actual emitted context
        // Include speaker embeddings if present (from WhisperX fork)
        speakerEmbeddings: whisperxResult.speakerEmbeddings,
        // Include speaker quality scores for quality-weighted reconciliation
        speakerQuality,
        createdAt: new Date().toISOString(),
        storagePath: filePath
      };

      // Sanitize to remove undefined values (Firestore doesn't allow them)
      // e.g., Person.affiliation is optional but Firestore rejects undefined
      const sanitizedChunkArtifact = sanitizeForFirestore(chunkArtifact);

      await retryWithBackoff(
        () => db
          .collection('conversations')
          .doc(conversationId)
          .collection('chunks')
          .doc(String(chunkMetadata.chunkIndex))
          .set(sanitizedChunkArtifact),
        'Firestore save chunk artifact'
      );

      // Diagnostic: Log WhisperX timestamps to debug timing drift
      const firstSeg = processedData.segments[0];
      const lastSeg = processedData.segments[processedData.segments.length - 1];
      console.log('[Pipeline] DIAGNOSTIC - WhisperX timestamps (chunk-local):', {
        chunkIndex: chunkMetadata.chunkIndex,
        chunkBounds: {
          startMs: chunkMetadata.startMs,
          endMs: chunkMetadata.endMs,
          overlapBeforeMs: chunkMetadata.overlapBeforeMs,
          expectedAudioStartMs: chunkMetadata.startMs - chunkMetadata.overlapBeforeMs
        },
        firstSegment: firstSeg ? {
          startMs: firstSeg.startMs,
          endMs: firstSeg.endMs,
          text: firstSeg.text.substring(0, 50) + '...'
        } : null,
        lastSegment: lastSeg ? {
          startMs: lastSeg.startMs,
          endMs: lastSeg.endMs
        } : null
      });

      console.log('[Pipeline] ✅ Chunk artifact saved:', {
        conversationId,
        chunkIndex: chunkMetadata.chunkIndex,
        totalChunks: chunkMetadata.totalChunks,
        segmentCount: processedData.segments.length
      });
    } else {
      // For whole-file tasks, update the main conversation document as before
      // Sanitize to remove undefined values (Firestore doesn't allow them)
      const sanitizedData = sanitizeForFirestore({
        ...processedData,
        status: 'complete',
        alignmentStatus: finalAlignmentStatus,
        alignmentError: usedGeminiFallback ? 'WhisperX failed, used Gemini fallback' : null,
        abortRequested: false,
        audioStoragePath: filePath
      });

      await retryWithBackoff(
        () => db.collection('conversations').doc(conversationId).update({
          ...sanitizedData,
          updatedAt: FieldValue.serverTimestamp()
        }),
        'Firestore save results'
      );
    }

    const firestoreDurationMs = Date.now() - firestoreStartTime;

    const totalDurationMs = Date.now() - downloadStartTime;
    console.log('[Pipeline] ✅ Transcription complete:', {
      conversationId,
      segmentCount: processedData.segments.length,
      speakerCount: Object.keys(processedData.speakers).length,
      termCount: Object.keys(processedData.terms).length,
      topicCount: processedData.topics.length,
      personCount: processedData.people.length,
      alignmentStatus: finalAlignmentStatus,
      speakerCorrectionsApplied: speakerCorrections.length,
      timingMs: {
        download: downloadDurationMs,
        whisperx: whisperxDurationMs,
        buildSegments: buildDurationMs,
        gemini: geminiDurationMs,
        speakerCorrection: speakerCorrectionDurationMs,
        transform: transformDurationMs,
        firestore: firestoreDurationMs,
        total: totalDurationMs
      }
    });

    // Build LLM usage breakdown for cost tracking
    // Use the compute times from partialMetrics (which has actual Cloud Run compute time if available)
    const llmUsage: LLMUsage = {
      geminiAnalysis: geminiAnalysisTokens,
      geminiSpeakerCorrection: geminiCorrectionTokens,
      whisperx: partialMetrics.llmUsage.whisperx
    };

    // Calculate estimated costs
    const costResult = await calculateCost(llmUsage);

    console.log('[Pipeline] LLM usage and cost breakdown:', {
      conversationId,
      geminiAnalysisTokens: geminiAnalysisTokens.inputTokens + geminiAnalysisTokens.outputTokens,
      geminiCorrectionTokens: geminiCorrectionTokens.inputTokens + geminiCorrectionTokens.outputTokens,
      whisperxComputeSec: llmUsage.whisperx.computeTimeSeconds.toFixed(1),
      estimatedCostUsd: costResult.estimatedCost.totalUsd.toFixed(6)
    });

    // Record metrics for observability dashboard
    await recordMetrics({
      conversationId,
      userId,
      status: 'success',
      alignmentStatus: finalAlignmentStatus,
      timingMs: {
        download: downloadDurationMs,
        whisperx: whisperxDurationMs,
        buildSegments: buildDurationMs,
        gemini: geminiDurationMs,
        speakerCorrection: speakerCorrectionDurationMs,
        transform: transformDurationMs,
        firestore: firestoreDurationMs,
        total: totalDurationMs
      },
      segmentCount: processedData.segments.length,
      speakerCount: Object.keys(processedData.speakers).length,
      termCount: Object.keys(processedData.terms).length,
      topicCount: processedData.topics.length,
      personCount: processedData.people.length,
      speakerCorrectionsApplied: speakerCorrections.length,
      audioSizeMB: audioBuffer.length / (1024 * 1024),
      durationMs: processedData.durationMs,
      llmUsage,
      geminiLabels: partialMetrics.geminiLabels,
      estimatedCost: costResult.estimatedCost,
      pricingSnapshot: costResult.pricingSnapshot
    });

    // Record processing_completed event for user stats
    await recordUserEvent({
      eventType: 'processing_completed',
      userId,
      conversationId,
      metadata: {
        durationMs: processedData.durationMs,
        estimatedCostUsd: costResult.estimatedCost.totalUsd,
        segmentCount: processedData.segments.length
      }
    });

    // Mark processing as complete
    await progressManager.setComplete();

    // Build result for chunk context propagation
    // Map WhisperX speaker IDs to our canonical IDs
    const speakerMappings: SpeakerMapping[] = whisperxSegments.speakers.map(ws => {
      // Find the processed speaker that corresponds to this WhisperX speaker
      // Our speakers use the same ID format, so we can match directly
      const processedSpeaker = processedData.speakers[ws.id];
      return {
        originalId: ws.id,
        canonicalId: ws.id, // Same ID preserved through processing
        displayName: processedSpeaker?.displayName || ws.name || ws.id
      };
    });

    // Build a summary from the title and first topic
    const firstTopic = processedData.topics.length > 0 ? processedData.topics[0].title : '';
    const summaryText = analysis.title
      ? `${analysis.title}${firstTopic ? ` - ${firstTopic}` : ''}`
      : firstTopic || 'Audio processed';

    // Get the last timestamp from segments (end of last segment)
    const lastSegment = processedData.segments.length > 0
      ? processedData.segments[processedData.segments.length - 1]
      : null;
    const lastTimestampMs = lastSegment?.endMs ?? processedData.durationMs;

    // Build speaker signatures for parallel mode reconciliation
    // These fingerprints help the merge function correlate speakers across chunks
    const chunkSpeakerSignatures = buildChunkSpeakerSignatures({
      chunkIndex: chunkMetadata?.chunkIndex ?? 0,
      segments: processedData.segments,
      speakers: processedData.speakers,
      topics: processedData.topics,
      terms: processedData.terms,
      termOccurrences: processedData.termOccurrences,
      speakerQuality
    });

    const pipelineResult: ChunkPipelineResult = {
      speakerMappings,
      summary: summaryText,
      termIds: Object.keys(processedData.terms),
      topicIds: processedData.topics.map(t => t.topicId),
      personIds: processedData.people.map(p => p.personId),
      segmentCount: processedData.segments.length,
      lastTimestampMs,
      chunkSpeakerSignatures
    };

    if (chunkContext) {
      console.log('[Pipeline] Chunk context was provided - result ready for context propagation:', {
        conversationId,
        inputContextChunk: chunkContext.emittedByChunkIndex,
        speakerMappingsFound: pipelineResult.speakerMappings.length,
        segmentsProcessed: pipelineResult.segmentCount,
        termsExtracted: pipelineResult.termIds.length,
        topicsExtracted: pipelineResult.topicIds.length,
        personsExtracted: pipelineResult.personIds.length
      });
    }

    return pipelineResult;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const isAbort = error instanceof AbortRequestedError;

    if (isAbort) {
      // Handle abort - record partial metrics
      console.log('[Pipeline] ⏹️ Processing aborted by user:', { conversationId });

      partialMetrics.timingMs.total = Date.now() - partialMetrics.processStartTime;

      const partialCostResult = await calculateCost(partialMetrics.llmUsage);

      console.log('[Pipeline] Recording partial metrics on abort:', {
        conversationId,
        elapsedMs: partialMetrics.timingMs.total,
        estimatedCostUsd: partialCostResult.estimatedCost.totalUsd
      });

      await recordMetrics({
        conversationId,
        userId,
        status: 'aborted',
        errorMessage: 'Processing was cancelled by user',
        timingMs: partialMetrics.timingMs,
        segmentCount: partialMetrics.segmentCount,
        speakerCount: partialMetrics.speakerCount,
        termCount: partialMetrics.termCount,
        topicCount: partialMetrics.topicCount,
        personCount: partialMetrics.personCount,
        speakerCorrectionsApplied: partialMetrics.speakerCorrectionsApplied,
        audioSizeMB: partialMetrics.audioSizeMB,
        durationMs: partialMetrics.durationMs,
        llmUsage: partialMetrics.llmUsage,
        geminiLabels: partialMetrics.geminiLabels,
        estimatedCost: partialCostResult.estimatedCost,
        pricingSnapshot: partialCostResult.pricingSnapshot
      });

      await recordUserEvent({
        eventType: 'processing_aborted',
        userId,
        conversationId,
        metadata: {
          estimatedCostUsd: partialCostResult.estimatedCost.totalUsd,
          elapsedMs: partialMetrics.timingMs.total
        }
      });

      await db.collection('conversations').doc(conversationId).update({
        status: 'aborted',
        processingError: 'Processing was cancelled by user',
        abortRequested: false,
        updatedAt: FieldValue.serverTimestamp()
      });

      await progressManager.setFailed('Aborted by user');

      // Re-throw so caller can handle (e.g., mark chunk as failed for aborted)
      throw error;
    }

    // Handle general failure
    console.error('[Pipeline] ❌ Transcription failed:', {
      conversationId,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      errorMessage,
      errorStack: error instanceof Error ? error.stack : undefined
    });

    // Record failure metrics
    await recordMetrics({
      conversationId,
      userId,
      status: 'failed',
      errorMessage,
      timingMs: {
        download: 0,
        whisperx: 0,
        buildSegments: 0,
        gemini: 0,
        speakerCorrection: 0,
        transform: 0,
        firestore: 0,
        total: 0
      },
      segmentCount: 0,
      speakerCount: 0,
      termCount: 0,
      topicCount: 0,
      personCount: 0,
      speakerCorrectionsApplied: 0,
      audioSizeMB: 0,
      durationMs: 0
    });

    await recordUserEvent({
      eventType: 'processing_failed',
      userId,
      conversationId,
      metadata: {
        errorMessage
      }
    });

    // Mark processing as failed
    await progressManager.setFailed(errorMessage);

    // Update status to failed
    await db.collection('conversations').doc(conversationId).update({
      status: 'failed',
      processingError: errorMessage,
      updatedAt: FieldValue.serverTimestamp()
    });

    console.debug('[Pipeline] Firestore updated with failed status');

    // Re-throw so calling function can handle (e.g., return 500 for Cloud Tasks retry)
    throw error;
  }
}

/**
 * Triggered when an audio file is uploaded to storage.
 * Path pattern: audio/{userId}/{conversationId}.{extension}
 */
export const transcribeAudio = onObjectFinalized(
  {
    secrets: [whisperServiceUrl],
    memory: '2GiB', // Large audio files need more memory for chunking
    timeoutSeconds: 540, // 9 minutes (max for event-driven triggers, even 2nd gen)
    region: 'us-central1'
  },
  async (event) => {
    const filePath = event.data.name;
    const contentType = event.data.contentType;

    // DEBUG: Log raw event data for troubleshooting
    console.debug('[Transcribe] Storage event received:', {
      bucket: event.data.bucket,
      name: event.data.name,
      contentType: event.data.contentType,
      size: event.data.size,
      timeCreated: event.data.timeCreated,
      updated: event.data.updated,
      md5Hash: event.data.md5Hash,
      generation: event.data.generation,
      metageneration: event.data.metageneration
    });

    // Only process audio files in the audio/ directory
    // Chunk files (chunks/*) are processed via Cloud Tasks, not storage triggers
    if (!filePath.startsWith('audio/') || !contentType?.startsWith('audio/')) {
      // Don't log chunk files - they're expected to be skipped here
      if (!filePath.startsWith('chunks/')) {
        console.debug('[Transcribe] Skipping non-audio file:', { filePath, contentType });
      }
      return;
    }

    // Parse path: audio/{userId}/{conversationId}.{ext}
    const pathParts = filePath.split('/');
    if (pathParts.length !== 3) {
      console.error('[Transcribe] Invalid audio path structure:', filePath);
      return;
    }

    const userId = pathParts[1];
    const fileName = pathParts[2];
    const conversationId = fileName.split('.')[0];
    const fileExtension = fileName.split('.').pop();

    // Early exit for duplicate triggers - Cloud Storage fires "at least once"
    // Check if we've already started processing before doing any work
    // NOTE: Frontend sets status='processing' immediately on upload, so we can't use that alone.
    // Instead, check for queuedAt (set by us) or terminal states.
    const existingConversation = await db.collection('conversations').doc(conversationId).get();
    const existingData = existingConversation.data();
    const existingStatus = existingData?.status;
    const alreadyQueued = existingData?.queuedAt !== undefined;  // We set this when enqueueing
    const taskAlreadyEnqueued = existingData?.taskEnqueued === true;

    // Skip if we've already enqueued this (queuedAt is set by us, not frontend)
    // Or if it's in a terminal/active-processing state
    if (alreadyQueued || taskAlreadyEnqueued ||
        existingStatus === 'chunking' || existingStatus === 'merging' ||
        existingStatus === 'complete' || existingStatus === 'failed' ||
        existingStatus === 'aborted') {
      console.log('[Transcribe] Skipping duplicate trigger - already processing:', {
        conversationId,
        existingStatus,
        alreadyQueued,
        taskAlreadyEnqueued
      });
      return;
    }

    // Read processingMode from Storage custom metadata
    // If metadata is missing, check Firestore for an existing value (legacy uploads)
    // Only default to 'parallel' if neither source has a value
    const customMetadata = event.data.metadata as Record<string, string> | undefined;
    let processingMode: ProcessingMode = (customMetadata?.processingMode === 'sequential')
      ? 'sequential'
      : 'parallel';

    // Honor stored legacy mode when Storage metadata is absent
    // Reuse the existingConversation we already fetched for dedup check
    if (!customMetadata?.processingMode) {
      const storedMode = existingConversation.data()?.processingMode;
      if (storedMode === 'sequential') {
        processingMode = 'sequential';
        console.log('[Transcribe] Using stored sequential mode from Firestore (no Storage metadata)');
      }
    }

    console.log('[Transcribe] Audio file uploaded - enqueuing for processing:', {
      filePath,
      userId,
      conversationId,
      contentType,
      fileExtension,
      sizeBytes: event.data.size,
      sizeMB: (event.data.size / (1024 * 1024)).toFixed(2),
      processingMode
    });

    // Initialize progress manager for UI feedback
    const progressManager = new ProgressManager(conversationId);
    let tempAudioPath: string | null = null;
    let localChunkPaths: string[] = [];

    try {
      // Update status to queued (processing will start when Cloud Tasks picks it up)
      // Using set() with merge to handle race condition where storage trigger fires
      // before frontend has created the Firestore document
      // Note: processingMode is read from Storage metadata for consistency
      await db.collection('conversations').doc(conversationId).set({
        conversationId,
        userId,
        status: 'queued',
        processingMode, // 'parallel' or 'sequential' - controls chunk execution strategy
        taskGeneration: 1, // First generation - incremented on retry to invalidate stale tasks
        queuedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      // In emulator mode, skip Cloud Tasks entirely and process directly
      // Cloud Tasks has no emulator and can't call localhost endpoints
      const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true';

      if (isEmulator) {
        console.log('[Transcribe] 🧪 Emulator detected - processing directly (bypassing Cloud Tasks)');

        // Update to processing status (mimics what processTranscription would do)
        await db.collection('conversations').doc(conversationId).update({
          status: 'processing',
          processingStartedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });

        // Call the pipeline directly - same as processTranscription would
        // Pipeline handles its own error states and Firestore updates
        await executeTranscriptionPipeline({
          conversationId,
          userId,
          filePath,
          whisperServiceUrl: whisperServiceUrl.value(),
          audioSizeBytes: event.data.size
        });

        console.log('[Transcribe] ✅ Direct processing complete:', { conversationId });
      } else {
        // Production: Download audio to check if chunking is needed
        // For long files, we split into chunks before enqueuing Cloud Tasks

        // Update status to 'chunking' so UI shows progress (not stuck on 'queued')
        await db.collection('conversations').doc(conversationId).update({
          status: 'chunking',
          processingStartedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });

        // Update progress manager to show chunking step
        await progressManager.setStep(ProcessingStep.CHUNKING);

        // Download audio to temp file for duration check and potential chunking
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-upload-'));
        const sourceExt = path.extname(filePath) || '.mp3';
        tempAudioPath = path.join(tempDir, `original${sourceExt}`);

        console.log('[Transcribe] Downloading audio for chunking analysis:', {
          conversationId,
          filePath,
          tempAudioPath
        });

        const file = bucket.file(filePath);
        await file.download({ destination: tempAudioPath });

        console.log('[Transcribe] Audio downloaded to temp file:', {
          conversationId,
          tempAudioPath,
          sizeBytes: fs.statSync(tempAudioPath).size
        });

        // Re-encode audio for clean playback seeking (to a SEPARATE file)
        // This fixes MP3 VBR seeking issues where browsers estimate byte position incorrectly
        // IMPORTANT: Keep original for chunking to avoid double-encoding quality loss
        await progressManager.setStep(ProcessingStep.OPTIMIZING);
        const playbackAudioPath = tempAudioPath.replace(/(\.[^.]+)$/, '-playback$1');
        console.log('[Transcribe] Re-encoding audio for playback (seeking fix)...');
        const reencodeResult = await reencodeForPlayback(tempAudioPath, playbackAudioPath);

        // Upload re-encoded file back to Storage (overwrites original for playback)
        console.log('[Transcribe] Uploading re-encoded audio to Storage...');
        await file.save(fs.readFileSync(playbackAudioPath), {
          contentType: 'audio/mpeg',
          metadata: {
            metadata: {
              reencoded: 'true',
              originalSizeBytes: String(reencodeResult.originalSizeBytes),
              reencodedSizeBytes: String(reencodeResult.outputSizeBytes)
            }
          }
        });
        console.log('[Transcribe] Re-encoded audio uploaded successfully:', {
          conversationId,
          filePath,
          sizeChange: `${reencodeResult.originalSizeBytes} -> ${reencodeResult.outputSizeBytes} bytes`,
          reencodeTimeSec: (reencodeResult.reencodeTimeMs / 1000).toFixed(1)
        });

        // Clean up playback temp file (no longer needed after upload)
        fs.unlinkSync(playbackAudioPath);

        // Attempt chunking on ORIGINAL audio (not re-encoded) to preserve quality
        const { result: chunkingResult, localChunkPaths: chunkPaths } = await chunkAudioFile(
          tempAudioPath,
          filePath
        );
        localChunkPaths = chunkPaths;

        // Set up Cloud Tasks client
        const { CloudTasksClient } = await import('@google-cloud/tasks');
        const tasksClient = new CloudTasksClient();

        const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
        if (!project) {
          throw new Error('GCP project ID not found in environment');
        }

        const location = 'us-central1';
        const queue = 'transcription-queue';
        const parent = tasksClient.queuePath(project, location, queue);

        const functionName = 'processTranscription';
        const processTranscriptionUrl = `https://${location}-${project}.cloudfunctions.net/${functionName}`;

        const DISPATCH_DEADLINE_SECONDS = 1800; // 30 minutes (max for HTTP targets)

        if (!chunkingResult.chunked) {
          // Short file - no chunking needed, process as single file
          console.log('[Transcribe] File is short enough - no chunking needed:', {
            conversationId,
            durationMs: chunkingResult.originalDurationMs
          });

          // Build task payload (original behavior)
          const payload = {
            conversationId,
            userId,
            filePath,
            processingMode,
            taskGeneration: 1 // Allows stale task detection on retry
          };

          const task = {
            httpRequest: {
              httpMethod: 'POST' as const,
              url: processTranscriptionUrl,
              headers: { 'Content-Type': 'application/json' },
              body: Buffer.from(JSON.stringify(payload)).toString('base64'),
              oidcToken: { serviceAccountEmail: `${project}@appspot.gserviceaccount.com` }
            },
            scheduleTime: { seconds: Math.floor(Date.now() / 1000) + 5 },
            dispatchDeadline: { seconds: DISPATCH_DEADLINE_SECONDS }
          };

          console.log('[Transcribe] Creating Cloud Task:', {
            conversationId,
            queue: `${location}/${queue}`,
            targetUrl: processTranscriptionUrl,
            scheduleDelaySeconds: 5
          });

          // Check for abort before enqueuing task (allows fast cancellation)
          await checkAbort(conversationId);

          const [createdTask] = await tasksClient.createTask({ parent, task });

          console.log('[Transcribe] ✅ Task enqueued successfully:', {
            conversationId,
            taskName: createdTask.name,
            scheduleTime: createdTask.scheduleTime
          });

        } else {
          // Long file - upload chunks and create one task per chunk
          console.log('[Transcribe] File requires chunking:', {
            conversationId,
            originalDurationMs: chunkingResult.originalDurationMs,
            chunkCount: chunkingResult.chunks.length
          });

          // Validate chunk sequence before proceeding
          const validation = validateChunkSequence(chunkingResult.chunks);
          if (!validation.valid) {
            console.error('[Transcribe] Chunk validation failed:', validation.errors);
            throw new Error(`Chunk validation failed: ${validation.errors.join(', ')}`);
          }
          if (validation.warnings.length > 0) {
            console.warn('[Transcribe] Chunk validation warnings:', validation.warnings);
          }

          // Upload each chunk to Storage
          const chunksStoragePrefix = `chunks/${conversationId}`;
          const uploadedChunks: ChunkMetadata[] = [];

          for (let i = 0; i < chunkingResult.chunks.length; i++) {
            const chunk = chunkingResult.chunks[i];
            const localPath = localChunkPaths[i];
            const chunkFileName = `chunk-${chunk.chunkIndex.toString().padStart(3, '0')}${sourceExt}`;
            const chunkStoragePath = `${chunksStoragePrefix}/${chunkFileName}`;

            console.log('[Transcribe] Uploading chunk:', {
              conversationId,
              chunkIndex: chunk.chunkIndex,
              localPath,
              chunkStoragePath
            });

            await bucket.upload(localPath, {
              destination: chunkStoragePath,
              metadata: {
                contentType: contentType || 'audio/mpeg',
                metadata: {
                  conversationId,
                  chunkIndex: chunk.chunkIndex.toString(),
                  totalChunks: chunk.totalChunks.toString(),
                  startMs: chunk.startMs.toString(),
                  endMs: chunk.endMs.toString()
                }
              }
            });

            // Update chunk with storage path
            const uploadedChunk: ChunkMetadata = {
              ...chunk,
              chunkStoragePath
            };
            uploadedChunks.push(uploadedChunk);

            console.log('[Transcribe] Chunk uploaded:', {
              conversationId,
              chunkIndex: chunk.chunkIndex,
              chunkStoragePath
            });
          }

          // Initialize chunk statuses for resumable execution
          const initialStatuses = createInitialChunkStatuses(uploadedChunks.length);

          // Store chunk metadata with status tracking (chunkingMetadata replaces old chunkMetadata)
          const chunkingMetadata: Omit<ChunkingMetadata, 'chunkedAt'> & { chunkedAt: ReturnType<typeof FieldValue.serverTimestamp> } = {
            chunkingEnabled: true,
            totalChunks: uploadedChunks.length,
            completedChunks: 0,
            chunkStatuses: initialStatuses,
            chunkContexts: [], // Will be populated as chunks complete
            chunkedAt: FieldValue.serverTimestamp() as ReturnType<typeof FieldValue.serverTimestamp>,
            originalDurationMs: chunkingResult.originalDurationMs,
            originalStoragePath: filePath
          };

          await db.collection('conversations').doc(conversationId).update({
            // New format with status tracking
            chunkingMetadata,
            // Keep legacy format for backward compatibility during transition
            chunkMetadata: {
              chunked: true,
              chunks: uploadedChunks,
              originalDurationMs: chunkingResult.originalDurationMs,
              originalStoragePath: filePath,
              totalChunks: uploadedChunks.length,
              chunkedAt: FieldValue.serverTimestamp()
            },
            updatedAt: FieldValue.serverTimestamp()
          });

          console.log('[Transcribe] Chunk metadata with status tracking saved:', {
            conversationId,
            chunkCount: uploadedChunks.length,
            initialStatuses: initialStatuses.map(s => ({ index: s.chunkIndex, status: s.status }))
          });

          // Check for abort before enqueueing chunk tasks
          await checkAbort(conversationId);

          // Create one Cloud Task per chunk
          // Stagger scheduling to avoid thundering herd
          // Note: For sequential mode, chunks wait for predecessors
          //       For parallel mode, chunks run independently
          const taskPromises = uploadedChunks.map(async (chunk, index) => {
            const payload = {
              conversationId,
              userId,
              filePath: chunk.chunkStoragePath,
              chunkIndex: chunk.chunkIndex,
              totalChunks: chunk.totalChunks,
              chunkMetadata: chunk,
              processingMode, // Controls whether chunk waits for predecessor context
              taskGeneration: 1, // Allows stale task detection on retry
              // Include timing metadata for offset calculations
              chunkStartMs: chunk.startMs,
              chunkEndMs: chunk.endMs,
              overlapBeforeMs: chunk.overlapBeforeMs,
              overlapAfterMs: chunk.overlapAfterMs
            };

            const task = {
              httpRequest: {
                httpMethod: 'POST' as const,
                url: processTranscriptionUrl,
                headers: { 'Content-Type': 'application/json' },
                body: Buffer.from(JSON.stringify(payload)).toString('base64'),
                oidcToken: { serviceAccountEmail: `${project}@appspot.gserviceaccount.com` }
              },
              // Stagger tasks: 5s base + 2s per chunk to avoid overload
              scheduleTime: { seconds: Math.floor(Date.now() / 1000) + 5 + (index * 2) },
              dispatchDeadline: { seconds: DISPATCH_DEADLINE_SECONDS }
            };

            const [createdTask] = await tasksClient.createTask({ parent, task });

            console.log('[Transcribe] Chunk task enqueued:', {
              conversationId,
              chunkIndex: chunk.chunkIndex,
              taskName: createdTask.name,
              scheduleTime: createdTask.scheduleTime
            });

            return createdTask;
          });

          const createdTasks = await Promise.all(taskPromises);

          console.log('[Transcribe] ✅ All chunk tasks enqueued:', {
            conversationId,
            taskCount: createdTasks.length,
            chunkIndices: uploadedChunks.map(c => c.chunkIndex)
          });
        }
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Check if this was an abort request (not a real failure)
      if (error instanceof AbortRequestedError) {
        console.log('[Transcribe] Processing was aborted by user:', { conversationId });
        // Status already set to 'aborted' by executeTranscriptionPipeline, just ensure it's correct
        await db.collection('conversations').doc(conversationId).update({
          status: 'aborted',
          processingError: 'Processing cancelled by user',
          updatedAt: FieldValue.serverTimestamp()
        });
        // Don't record as failure - abort event already recorded by pipeline
        return;
      }

      console.error('[Transcribe] ❌ Failed to enqueue task:', {
        conversationId,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        errorMessage,
        errorStack: error instanceof Error ? error.stack : undefined
      });

      // Update Firestore to mark as failed
      await db.collection('conversations').doc(conversationId).update({
        status: 'failed',
        processingError: `Failed to enqueue processing task: ${errorMessage}`,
        updatedAt: FieldValue.serverTimestamp()
      });

      // Record failure event
      await recordUserEvent({
        eventType: 'processing_failed',
        userId,
        conversationId,
        metadata: {
          errorMessage: `Enqueue failed: ${errorMessage}`
        }
      });
    } finally {
      // Always clean up temp files
      if (localChunkPaths.length > 0) {
        console.log('[Transcribe] Cleaning up temp chunk files:', { count: localChunkPaths.length });
        cleanupChunks(localChunkPaths);
      }
      if (tempAudioPath && fs.existsSync(tempAudioPath)) {
        try {
          fs.unlinkSync(tempAudioPath);
          const tempDir = path.dirname(tempAudioPath);
          fs.rmdirSync(tempDir);
        } catch (cleanupError) {
          console.warn('[Transcribe] Failed to clean up temp audio file:', cleanupError);
        }
      }
    }
  }
);


/**
 * NEW: Build segments from WhisperX output
 *
 * IMPORTANT: WhisperX (rafaelgalle/whisper-diarization-advanced) returns WORD-LEVEL
 * segments, not sentence-level. We must group consecutive words by speaker into
 * proper sentence-level segments for a usable transcript.
 */
function buildSegmentsFromWhisperX(whisperxSegments: WhisperXSegment[]): {
  segments: Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }>;
  speakers: Array<{ id: string; name: string }>;
} {
  // Extract unique speakers from WhisperX (e.g., "SPEAKER_00", "SPEAKER_01")
  const speakerSet = new Set<string>();
  whisperxSegments.forEach(seg => {
    if (seg.speaker) {
      speakerSet.add(seg.speaker);
    }
  });

  // Create speaker list with friendly names
  const speakers = Array.from(speakerSet).sort().map((id, idx) => ({
    id,
    name: `Speaker ${idx + 1}`  // "SPEAKER_00" -> "Speaker 1"
  }));

  // If no speaker diarization, use default speaker
  if (speakers.length === 0) {
    speakers.push({ id: 'SPEAKER_00', name: 'Speaker 1' });
  }

  // Check if we have word-level segments (typical for whisper-diarization-advanced)
  // Word-level: many short segments with single words
  // Sentence-level: fewer segments with multiple words
  const avgWordsPerSegment = whisperxSegments.reduce((sum, seg) =>
    sum + seg.text.split(/\s+/).length, 0) / Math.max(whisperxSegments.length, 1);

  const isWordLevel = avgWordsPerSegment < 2;

  if (isWordLevel) {
    // Check if diarization is broken (near 50/50 speaker split = alternating speakers)
    const speakerWordCounts: Record<string, number> = {};
    whisperxSegments.forEach(seg => {
      const spk = seg.speaker || 'SPEAKER_00';
      speakerWordCounts[spk] = (speakerWordCounts[spk] || 0) + 1;
    });

    const speakerCounts = Object.values(speakerWordCounts);
    const totalWords = speakerCounts.reduce((a, b) => a + b, 0);
    const maxSpeakerRatio = Math.max(...speakerCounts) / totalWords;

    // If the dominant speaker has less than 60% of words, diarization is likely broken
    // (real conversations rarely have exactly equal speaker time at the word level)
    const isDiarizationBroken = speakers.length >= 2 && maxSpeakerRatio < 0.6;

    if (isDiarizationBroken) {
      console.log('[BuildSegments] Detected BROKEN diarization (near 50/50 split on word-level)');
      console.log(`[BuildSegments] Speaker distribution: ${JSON.stringify(speakerWordCounts)}`);
      console.log('[BuildSegments] Grouping by sentence boundaries ONLY, ignoring speaker assignments');

      // Deduplicate repeated words (common WhisperX issue)
      const deduplicatedSegments = deduplicateWhisperXWords(whisperxSegments);
      return groupWordSegmentsIgnoringSpeaker(deduplicatedSegments, speakers);
    }

    console.log('[BuildSegments] Detected WORD-LEVEL output, grouping into sentences...');
    // Deduplicate repeated words (common WhisperX issue)
    const deduplicatedSegments = deduplicateWhisperXWords(whisperxSegments);
    return groupWordSegmentsBySpeaker(deduplicatedSegments, speakers);
  }

  // Sentence-level output - use as-is
  const segments = whisperxSegments.map((seg, idx) => ({
    text: seg.text,
    startMs: Math.floor(seg.start * 1000),
    endMs: Math.floor(seg.end * 1000),
    speakerId: seg.speaker || 'SPEAKER_00',
    index: idx
  }));

  console.debug('[BuildSegments] Built segments:', {
    segmentCount: segments.length,
    speakerCount: speakers.length,
    speakers: speakers.map(s => s.id).join(', ')
  });

  return { segments, speakers };
}

/**
 * Group word-level segments into sentence-level segments by speaker.
 *
 * Strategy:
 * 1. Group consecutive words with the same speaker
 * 2. Split at natural sentence boundaries (., !, ?) when they occur
 * 3. Also split if a segment gets too long (prevents giant monologue segments)
 */
function groupWordSegmentsBySpeaker(
  wordSegments: WhisperXSegment[],
  speakers: Array<{ id: string; name: string }>
): {
  segments: Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }>;
  speakers: Array<{ id: string; name: string }>;
} {
  if (wordSegments.length === 0) {
    return { segments: [], speakers };
  }

  const MAX_SEGMENT_WORDS = 50;  // Split long monologues at ~50 words
  const MIN_SEGMENT_WORDS = 3;   // Minimum words before allowing sentence-end split

  const groupedSegments: Array<{
    text: string;
    startMs: number;
    endMs: number;
    speakerId: string;
    index: number;
  }> = [];

  let currentWords: string[] = [];
  let currentSpeaker = wordSegments[0].speaker || 'SPEAKER_00';
  let currentStartMs = Math.floor(wordSegments[0].start * 1000);
  let currentEndMs = Math.floor(wordSegments[0].end * 1000);

  const finishCurrentSegment = () => {
    if (currentWords.length > 0) {
      groupedSegments.push({
        text: currentWords.join(' '),
        startMs: currentStartMs,
        endMs: currentEndMs,
        speakerId: currentSpeaker,
        index: groupedSegments.length
      });
      currentWords = [];
    }
  };

  for (let i = 0; i < wordSegments.length; i++) {
    const word = wordSegments[i];
    const wordSpeaker = word.speaker || 'SPEAKER_00';
    const wordText = word.text.trim();
    const wordEndMs = Math.floor(word.end * 1000);

    // Speaker change - finish current segment
    if (wordSpeaker !== currentSpeaker) {
      finishCurrentSegment();
      currentSpeaker = wordSpeaker;
      currentStartMs = Math.floor(word.start * 1000);
    }

    // Add word to current segment
    currentWords.push(wordText);
    currentEndMs = wordEndMs;

    // Check if we should split the segment
    const shouldSplitAtSentence = currentWords.length >= MIN_SEGMENT_WORDS &&
      /[.!?]$/.test(wordText);
    const shouldSplitAtLength = currentWords.length >= MAX_SEGMENT_WORDS;

    if (shouldSplitAtSentence || shouldSplitAtLength) {
      finishCurrentSegment();
      // Next word will start a new segment
      if (i + 1 < wordSegments.length) {
        currentStartMs = Math.floor(wordSegments[i + 1].start * 1000);
      }
    }
  }

  // Don't forget the last segment
  finishCurrentSegment();

  // Re-index all segments
  groupedSegments.forEach((seg, idx) => {
    seg.index = idx;
  });

  console.log('[BuildSegments] Grouped word-level segments:', {
    inputWordCount: wordSegments.length,
    outputSegmentCount: groupedSegments.length,
    compressionRatio: (wordSegments.length / Math.max(groupedSegments.length, 1)).toFixed(1),
    speakerCount: speakers.length,
    speakers: speakers.map(s => s.id).join(', ')
  });

  // Log speaker distribution for debugging
  const speakerCounts: Record<string, number> = {};
  groupedSegments.forEach(seg => {
    speakerCounts[seg.speakerId] = (speakerCounts[seg.speakerId] || 0) + 1;
  });
  console.debug('[BuildSegments] Speaker distribution:', speakerCounts);

  return { segments: groupedSegments, speakers };
}

/**
 * Deduplicate consecutive repeated words from WhisperX output.
 *
 * WhisperX sometimes stutters and returns duplicate words. This function
 * removes consecutive identical words while preserving timing from the first occurrence.
 */
function deduplicateWhisperXWords(segments: WhisperXSegment[]): WhisperXSegment[] {
  if (segments.length === 0) return segments;

  const deduplicated: WhisperXSegment[] = [];
  let lastWord = '';

  for (const seg of segments) {
    const word = seg.text.trim().toLowerCase();

    // Skip if this is an exact duplicate of the previous word
    if (word === lastWord) {
      continue;
    }

    deduplicated.push(seg);
    lastWord = word;
  }

  const removed = segments.length - deduplicated.length;
  if (removed > 0) {
    console.log(`[BuildSegments] Deduplicated ${removed} repeated words (${((removed / segments.length) * 100).toFixed(1)}%)`);
  }

  return deduplicated;
}

/**
 * Group word-level segments into sentences IGNORING speaker assignments.
 *
 * Used when WhisperX diarization is broken (e.g., alternating speakers on every word).
 * Groups purely by sentence boundaries, assigns all segments to SPEAKER_00,
 * and lets the speaker reassignment step (Gemini) assign proper speakers later.
 */
function groupWordSegmentsIgnoringSpeaker(
  wordSegments: WhisperXSegment[],
  speakers: Array<{ id: string; name: string }>
): {
  segments: Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }>;
  speakers: Array<{ id: string; name: string }>;
} {
  if (wordSegments.length === 0) {
    return { segments: [], speakers };
  }

  const MAX_SEGMENT_WORDS = 50;  // Split long segments at ~50 words
  const MIN_SEGMENT_WORDS = 3;   // Minimum words before allowing sentence-end split

  const groupedSegments: Array<{
    text: string;
    startMs: number;
    endMs: number;
    speakerId: string;
    index: number;
  }> = [];

  let currentWords: string[] = [];
  let currentStartMs = Math.floor(wordSegments[0].start * 1000);
  let currentEndMs = Math.floor(wordSegments[0].end * 1000);

  // Use first speaker as default - Gemini reassignment will fix it
  const defaultSpeaker = speakers[0]?.id || 'SPEAKER_00';

  const finishCurrentSegment = () => {
    if (currentWords.length > 0) {
      groupedSegments.push({
        text: currentWords.join(' '),
        startMs: currentStartMs,
        endMs: currentEndMs,
        speakerId: defaultSpeaker,  // Will be reassigned by Gemini
        index: groupedSegments.length
      });
      currentWords = [];
    }
  };

  for (let i = 0; i < wordSegments.length; i++) {
    const word = wordSegments[i];
    const wordText = word.text.trim();
    const wordEndMs = Math.floor(word.end * 1000);

    // If this is the first word of a new segment, set start time
    if (currentWords.length === 0) {
      currentStartMs = Math.floor(word.start * 1000);
    }

    // Add word to current segment
    currentWords.push(wordText);
    currentEndMs = wordEndMs;

    // Check if we should split the segment (sentence boundary or max length)
    const shouldSplitAtSentence = currentWords.length >= MIN_SEGMENT_WORDS &&
      /[.!?]$/.test(wordText);
    const shouldSplitAtLength = currentWords.length >= MAX_SEGMENT_WORDS;

    if (shouldSplitAtSentence || shouldSplitAtLength) {
      finishCurrentSegment();
    }
  }

  // Don't forget the last segment
  finishCurrentSegment();

  // Re-index all segments
  groupedSegments.forEach((seg, idx) => {
    seg.index = idx;
  });

  console.log('[BuildSegments] Grouped word-level segments (ignoring broken diarization):', {
    inputWordCount: wordSegments.length,
    outputSegmentCount: groupedSegments.length,
    compressionRatio: (wordSegments.length / Math.max(groupedSegments.length, 1)).toFixed(1),
    note: 'All segments assigned to default speaker - Gemini will reassign'
  });

  return { segments: groupedSegments, speakers };
}

/**
 * Fix segment boundaries where diarization split too late.
 *
 * Common issue: speaker change detected a few words late, so the end of
 * one speaker's sentence gets attached to the start of the next speaker's segment.
 *
 * Example: "all these other things. Anyways. But having tools..."
 *          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ should be in previous segment
 *
 * Heuristic: If a segment starts with a sentence fragment (text ending in
 * sentence-ending punctuation within first N chars), move it to prev segment.
 */
function fixSegmentBoundaries(
  segments: Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }>
): Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }> {
  if (segments.length < 2) {
    return segments;
  }

  const MAX_FRAGMENT_CHARS = 80;  // Only look for fragments in first 80 chars
  const MIN_REMAINING_CHARS = 20; // Don't move if it leaves segment too short

  // Regex to find sentence-ending punctuation followed by space and more text
  // Matches: "text here. More text" or "question? Answer" or "wow! Response"
  const fragmentPattern = /^(.+?[.!?])\s+([A-Z].*)/s;

  let movedCount = 0;
  const result = [...segments];

  for (let i = 1; i < result.length; i++) {
    const current = result[i];
    const previous = result[i - 1];

    // Only fix boundaries between DIFFERENT speakers
    if (current.speakerId === previous.speakerId) {
      continue;
    }

    const text = current.text.trim();

    // Check if segment starts with a fragment (sentence ending within first N chars)
    const match = text.match(fragmentPattern);
    if (!match) {
      continue;
    }

    const fragment = match[1];  // The part to move (e.g., "all these other things. Anyways.")
    const remainder = match[2]; // The part to keep (e.g., "But having tools...")

    // Only move if fragment is reasonably short and remainder is long enough
    if (fragment.length > MAX_FRAGMENT_CHARS || remainder.length < MIN_REMAINING_CHARS) {
      continue;
    }

    // Additional check: fragment should look like a continuation, not a complete thought
    // Skip if fragment starts with common sentence starters
    const startsWithSentenceStarter = /^(I|You|We|They|He|She|It|The|A|An|This|That|So|But|And|Or|If|When|What|How|Why|Where|Who)\s/i.test(fragment);
    if (startsWithSentenceStarter && fragment.length > 40) {
      // Longer fragments starting with sentence starters are probably intentional
      continue;
    }

    console.debug(`[FixBoundaries] Moving fragment from segment ${i} to ${i-1}:`, {
      fragment: fragment.substring(0, 50) + (fragment.length > 50 ? '...' : ''),
      fromSpeaker: current.speakerId,
      toSpeaker: previous.speakerId
    });

    // Calculate new timestamps (interpolate based on character ratio)
    const totalChars = current.text.length;
    const fragmentRatio = fragment.length / totalChars;
    const durationMs = current.endMs - current.startMs;
    const fragmentDurationMs = Math.floor(durationMs * fragmentRatio);
    const newBoundaryMs = current.startMs + fragmentDurationMs;

    // Update previous segment: append fragment and extend end time
    result[i - 1] = {
      ...previous,
      text: previous.text.trimEnd() + ' ' + fragment,
      endMs: newBoundaryMs
    };

    // Update current segment: remove fragment and adjust start time
    result[i] = {
      ...current,
      text: remainder,
      startMs: newBoundaryMs
    };

    movedCount++;
  }

  if (movedCount > 0) {
    console.log(`[FixBoundaries] Moved ${movedCount} sentence fragments to previous segments`);
  }

  // Re-index segments
  return result.map((seg, idx) => ({ ...seg, index: idx }));
}

/**
 * NEW: Analyze transcript with Gemini (text-only, no audio)
 * Returns analysis results AND token usage for cost tracking
 */
async function analyzeTranscriptWithGemini(
  segments: Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }>,
  speakers: Array<{ id: string; name: string }>,
  conversationId: string,
  userId: string
): Promise<GeminiAnalysisResult> {
  const vertexAI = getVertexAIClient();

  // Use gemini-2.5-flash for analysis
  const model = vertexAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          title: { type: SchemaType.STRING },
          topics: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                title: { type: SchemaType.STRING },
                startSegmentIndex: { type: SchemaType.INTEGER },
                endSegmentIndex: { type: SchemaType.INTEGER },
                type: { type: SchemaType.STRING }
              },
              required: ['title', 'startSegmentIndex', 'endSegmentIndex', 'type']
            }
          },
          terms: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                id: { type: SchemaType.STRING },
                term: { type: SchemaType.STRING },
                definition: { type: SchemaType.STRING },
                aliases: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } }
              },
              required: ['id', 'term', 'definition', 'aliases']
            }
          },
          people: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                name: { type: SchemaType.STRING },
                affiliation: { type: SchemaType.STRING }
              },
              required: ['name']
            }
          },
          speakerNotes: {
            type: SchemaType.ARRAY,
            description: 'Speaker identification and notes inferred from content',
            items: {
              type: SchemaType.OBJECT,
              properties: {
                speakerId: { type: SchemaType.STRING },
                inferredName: { type: SchemaType.STRING, description: 'Real name if speaker introduces themselves (e.g., "Hi, I\'m John")' },
                role: { type: SchemaType.STRING, description: 'Inferred role (e.g., "host", "guest", "interviewer")' },
                notes: { type: SchemaType.STRING, description: 'Additional context about this speaker' }
              },
              required: ['speakerId']
            }
          }
        },
        required: ['title', 'topics', 'terms', 'people']
      }
    }
  }, { timeout: GEMINI_REQUEST_TIMEOUT_MS });

  // Format transcript with segment indices and speaker labels
  const formattedTranscript = segments.map((seg, idx) => {
    const speakerName = speakers.find(s => s.id === seg.speakerId)?.name || seg.speakerId;
    return `[${idx}] ${speakerName}: ${seg.text}`;
  }).join('\n\n');

  const speakerList = speakers.map(s => `${s.id} (${s.name})`).join(', ');

  const prompt = `
Analyze this audio transcript and extract:

1. TITLE: Generate a concise, descriptive title for this conversation (5-10 words).

2. TOPICS: Identify topic segments with their approximate positions.
   For each topic, specify which segment indices it covers (0-based).
   Mark topics as "main" or "tangent" based on whether they're central to the conversation.

3. TERMS: Extract key technical terms, acronyms, names, and domain-specific vocabulary.
   Provide clear, concise definitions based on context.
   Include common aliases or variations.

4. PEOPLE: Identify mentions of people (names, titles, references).
   These should be DISTINCT from the speakers themselves.
   Extract their name and any inferred role/affiliation/organization.

5. SPEAKER IDENTIFICATION: For each speaker, try to identify:
   - inferredName: Their actual name if they introduce themselves (e.g., "Hi, I'm John",
     "This is Sarah", "My name is...", or if another speaker addresses them by name)
   - role: Their role in the conversation (e.g., "host", "guest", "interviewer", "expert")
   - notes: Any additional context (e.g., "works at Google", "PhD in AI")

   IMPORTANT: Only set inferredName if you have HIGH CONFIDENCE from explicit introduction
   or direct address. Don't guess names from context clues alone.

The transcript has speaker labels: ${speakerList}

Transcript (with speaker labels and segment indices):
${formattedTranscript}

Return your analysis as JSON matching the provided schema.
`;

  console.debug('[Gemini Analysis] Sending request...', {
    promptLength: prompt.length,
    segmentCount: segments.length,
    speakerCount: speakers.length
  });

  // Build labels for billing attribution
  const labels = buildGeminiLabels(conversationId, userId, 'analysis');

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    labels
  });
  // Vertex AI SDK response structure
  const responseText = result.response.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // Extract token usage for cost tracking
  const usageMetadata = result.response.usageMetadata;
  const tokenUsage: GeminiUsage = {
    inputTokens: usageMetadata?.promptTokenCount ?? 0,
    outputTokens: usageMetadata?.candidatesTokenCount ?? 0,
    model: 'gemini-2.5-flash'
  };

  console.debug('[Gemini Analysis] Raw response received:', {
    responseLength: responseText.length,
    inputTokens: tokenUsage.inputTokens,
    outputTokens: tokenUsage.outputTokens
  });

  // Parse response with robust error handling
  const parsed = robustJsonParse<GeminiAnalysis>(responseText, 'Gemini Analysis');
  return {
    analysis: parsed,
    tokenUsage,
    labels
  };
}

/**
 * Identify speakers from transcript content (runs AFTER WhisperX).
 *
 * This solves the speaker label reversal problem:
 * - Pre-analysis assigns SPEAKER_00/01 arbitrarily (before WhisperX)
 * - WhisperX assigns SPEAKER_00/01 based on acoustic features
 * - These don't match! Pre-analysis might say SPEAKER_00="Feynman" but WhisperX
 *   assigns SPEAKER_00 to the interviewer based on voice characteristics.
 *
 * This function sees the ACTUAL transcript with WhisperX's SPEAKER_XX labels
 * and identifies which speaker is which based on content (who introduces themselves,
 * who asks questions vs answers, etc.).
 *
 * Returns speaker notes with CORRECT SPEAKER_XX -> name mapping.
 */
async function identifySpeakersFromContent(
  segments: Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }>,
  speakers: Array<{ id: string; name: string }>,
  conversationId: string,
  userId: string
): Promise<{ speakerNotes: GeminiAnalysis['speakerNotes']; tokenUsage: GeminiUsage; labels: Record<string, string> }> {
  const vertexAI = getVertexAIClient();

  // Use gemini-2.5-flash for speaker identification
  const model = vertexAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          speakerNotes: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                speakerId: { type: SchemaType.STRING },
                inferredName: { type: SchemaType.STRING },
                role: { type: SchemaType.STRING },
                notes: { type: SchemaType.STRING }
              },
              required: ['speakerId']
            }
          }
        },
        required: ['speakerNotes']
      }
    }
  }, { timeout: GEMINI_REQUEST_TIMEOUT_MS });

  // Format transcript with actual SPEAKER_XX labels from WhisperX
  const formattedTranscript = segments.map((seg, idx) => {
    return `[${idx}] ${seg.speakerId}: ${seg.text}`;
  }).join('\n\n');

  const speakerList = speakers.map(s => s.id).join(', ');

  // Calculate speaker distribution to help identify dominant/guest speakers
  const speakerCounts: Record<string, number> = {};
  segments.forEach(seg => {
    speakerCounts[seg.speakerId] = (speakerCounts[seg.speakerId] || 0) + 1;
  });
  const speakerDistribution = Object.entries(speakerCounts)
    .map(([id, count]) => `${id}: ${count} segments (${Math.round(count / segments.length * 100)}%)`)
    .join(', ');

  const prompt = `
You are analyzing a conversation transcript to identify which speaker is which person.

The transcript has these speakers (from voice recognition): ${speakerList}
Speaker distribution: ${speakerDistribution}

Your task: For each speaker, identify:
1. inferredName: Their actual name if they introduce themselves OR another speaker addresses them by name
   - Examples: "Hi, I'm John", "This is Sarah", "My name is...", "Thanks, Bill"
   - ONLY set this if you have HIGH CONFIDENCE from explicit introduction or direct address
   - Leave blank if no clear name identification

2. role: Their role in the conversation
   - Common roles: "host", "guest", "interviewer", "interviewee", "expert", "moderator"
   - Base this on conversational patterns (who asks vs answers, who dominates, etc.)

3. notes: Additional context if relevant
   - Examples: "works at Google", "PhD in physics", "asks most questions"

IMPORTANT GUIDELINES:
- The SPEAKER_XX labels are from voice recognition and are INDEPENDENT of any names
- A speaker with 85%+ of segments is likely the guest/interviewee/expert
- A speaker with <20% of segments is likely the host/interviewer
- Don't guess names - only use them if explicitly stated in the transcript
- Interview pattern: interviewer asks questions, interviewee gives long answers

Available speakers: ${speakerList}

Transcript (with actual SPEAKER_XX labels from voice recognition):
${formattedTranscript}

Return JSON with speakerNotes array containing one entry per speaker.
Each entry needs: speakerId (SPEAKER_XX), inferredName (only if confident), role, notes (optional).
`;

  console.log('[Speaker Identification] Analyzing transcript for speaker identification...', {
    promptLength: prompt.length,
    segmentCount: segments.length,
    speakerCount: speakers.length,
    speakerDistribution
  });

  // Build labels for billing attribution
  const labels = buildGeminiLabels(conversationId, userId, 'speaker_identification');

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    labels
  });
  // Vertex AI SDK response structure
  const responseText = result.response.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // Extract token usage for cost tracking
  const usageMetadata = result.response.usageMetadata;
  const tokenUsage: GeminiUsage = {
    inputTokens: usageMetadata?.promptTokenCount ?? 0,
    outputTokens: usageMetadata?.candidatesTokenCount ?? 0,
    model: 'gemini-2.5-flash'
  };

  console.debug('[Speaker Identification] Raw response received:', {
    responseLength: responseText.length,
    inputTokens: tokenUsage.inputTokens,
    outputTokens: tokenUsage.outputTokens
  });

  // Parse response with robust error handling (fallback to empty notes on failure)
  try {
    type SpeakerIdResponse = { speakerNotes: GeminiAnalysis['speakerNotes'] };
    const parsed = robustJsonParse<SpeakerIdResponse>(responseText, 'Speaker Identification');

    console.log('[Speaker Identification] Analysis complete:', {
      speakerNotesCount: parsed.speakerNotes?.length ?? 0,
      speakerNotes: parsed.speakerNotes?.map(n =>
        `${n.speakerId}: ${n.inferredName || 'unknown'} (${n.role || 'no role'})`
      )
    });

    return {
      speakerNotes: parsed.speakerNotes,
      tokenUsage,
      labels
    };
  } catch (parseError) {
    console.error('[Speaker Identification] JSON parse failed even after repair:', {
      error: parseError instanceof Error ? parseError.message : String(parseError)
    });
    // Return empty speaker notes on parse failure - will fall back to pre-analysis
    return {
      speakerNotes: [],
      tokenUsage,
      labels
    };
  }
}

/**
 * Identify speaker corrections using Gemini conversational analysis.
 * Only identifies REASSIGN corrections (entire segment to different speaker).
 * Split corrections are disabled as they caused timestamp issues.
 * Returns corrections AND token usage for cost tracking.
 */
async function identifySpeakerReassignments(
  segments: Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }>,
  speakers: Array<{ id: string; name: string }>,
  conversationId: string,
  userId: string
): Promise<SpeakerCorrectionResult> {
  const vertexAI = getVertexAIClient();

  // Use gemini-2.5-flash for speaker reassignment analysis
  // Schema simplified to only support reassign (no split)
  const model = vertexAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          corrections: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                segmentIndex: { type: SchemaType.INTEGER },
                newSpeaker: { type: SchemaType.STRING },
                reason: { type: SchemaType.STRING }
              },
              required: ['segmentIndex', 'newSpeaker', 'reason']
            }
          }
        },
        required: ['corrections']
      }
    }
  }, { timeout: GEMINI_REQUEST_TIMEOUT_MS });

  // Format transcript with segment indices and speaker labels
  const formattedTranscript = segments.map((seg, idx) => {
    const speakerName = speakers.find(s => s.id === seg.speakerId)?.name || seg.speakerId;
    return `[${idx}] ${speakerName}: ${seg.text}`;
  }).join('\n\n');

  const speakerList = speakers.map(s => `${s.id} (${s.name})`).join(', ');

  // Calculate speaker distribution to help Gemini understand the imbalance
  const speakerCounts: Record<string, number> = {};
  segments.forEach(seg => {
    speakerCounts[seg.speakerId] = (speakerCounts[seg.speakerId] || 0) + 1;
  });
  const speakerDistribution = Object.entries(speakerCounts)
    .map(([id, count]) => `${id}: ${count} segments (${Math.round(count / segments.length * 100)}%)`)
    .join(', ');

  const prompt = `
You are an expert at identifying speaker attribution errors in conversation transcripts.

CURRENT SPEAKER DISTRIBUTION: ${speakerDistribution}

Analyze this transcript and identify segments where the ENTIRE SEGMENT is attributed to the WRONG speaker.

Focus on these patterns that indicate MISATTRIBUTION:

1. QUESTION/ANSWER PATTERNS:
   - If Speaker 1 asks questions and Speaker 2 gives answers, but a question is attributed to Speaker 2
   - Interview patterns: interviewer asks, interviewee responds
   - Example: "Where do you go shopping?" should be the interviewer, not interviewee

2. ROLE CONSISTENCY:
   - One speaker is clearly the questioner/interviewer throughout
   - One speaker is clearly the responder/interviewee throughout
   - Short responses ("New Look, Primark", "Normal places") are typically from the responder

3. CONVERSATIONAL FLOW:
   - Back-and-forth exchanges where attribution doesn't make sense
   - A question followed by another question from the "same" speaker (likely wrong)
   - An answer that doesn't fit the previous question's context

4. SHORT ACKNOWLEDGMENTS:
   - Brief responses like "Yeah", "Mm-hmm", "Right" during someone's extended speech
   - These are often from the listener, not the speaker

IMPORTANT GUIDELINES:
- Only identify segments where the ENTIRE segment should be reassigned to a different speaker
- Do NOT suggest splitting segments - only whole-segment reassignments
- Be conservative - only flag clear errors based on conversational logic
- Provide the newSpeaker ID (must be one of: ${speakerList})

Available speakers: ${speakerList}

Transcript (with speaker labels and segment indices):
${formattedTranscript}

Return your analysis as JSON with an array of corrections.
Each correction needs: segmentIndex (0-based), newSpeaker (the correct speaker ID), reason (brief explanation).
If no corrections are needed, return an empty array.
`;

  console.log('[Speaker Reassignment] Analyzing transcript...', {
    promptLength: prompt.length,
    segmentCount: segments.length,
    speakerCount: speakers.length,
    speakerDistribution
  });

  // Build labels for billing attribution
  const labels = buildGeminiLabels(conversationId, userId, 'speaker_correction');

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    labels
  });
  // Vertex AI SDK response structure
  const responseText = result.response.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // Extract token usage for cost tracking
  const usageMetadata = result.response.usageMetadata;
  const tokenUsage: GeminiUsage = {
    inputTokens: usageMetadata?.promptTokenCount ?? 0,
    outputTokens: usageMetadata?.candidatesTokenCount ?? 0,
    model: 'gemini-2.5-flash'
  };

  console.debug('[Speaker Reassignment] Raw response received:', {
    responseLength: responseText.length,
    inputTokens: tokenUsage.inputTokens,
    outputTokens: tokenUsage.outputTokens
  });

  // Parse response with robust error handling (fallback to no corrections on failure)
  try {
    type ReassignResponse = { corrections: Array<{ segmentIndex: number; newSpeaker: string; reason: string }> };
    const parsed = robustJsonParse<ReassignResponse>(responseText, 'Speaker Reassignment');

    // Convert to SpeakerCorrection format with action='reassign'
    const corrections: SpeakerCorrection[] = parsed.corrections.map(c => ({
      segmentIndex: c.segmentIndex,
      action: 'reassign' as const,
      reason: c.reason,
      newSpeaker: c.newSpeaker
    }));

    console.log('[Speaker Reassignment] Analysis complete:', {
      correctionCount: corrections.length,
      corrections: corrections.map(c => `[${c.segmentIndex}] -> ${c.newSpeaker}: ${c.reason?.substring(0, 50)}`)
    });

    return {
      corrections,
      tokenUsage,
      labels
    };
  } catch (parseError) {
    console.error('[Speaker Reassignment] JSON parse failed even after repair:', {
      error: parseError instanceof Error ? parseError.message : String(parseError)
    });
    // Don't fail the whole transcription if speaker correction fails
    // Still return token usage even on parse failure (Gemini was still called)
    return {
      corrections: [],
      tokenUsage,
      labels
    };
  }
}

/**
 * Apply speaker reassignments to segments.
 * Only changes speaker IDs - NO timestamp manipulation.
 * This is the safe version that won't cause timestamp clustering issues.
 */
function applySpeakerReassignments(
  segments: Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }>,
  corrections: SpeakerCorrection[],
  allSpeakers: string[]
): Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }> {
  if (corrections.length === 0) {
    return segments;
  }

  // Only process reassign actions (ignore any split actions that might slip through)
  const reassignments = corrections.filter(c => c.action === 'reassign' && c.newSpeaker);

  if (reassignments.length === 0) {
    return segments;
  }

  const result = [...segments];

  for (const correction of reassignments) {
    const { segmentIndex, newSpeaker } = correction;

    // Validate segment index
    if (segmentIndex < 0 || segmentIndex >= result.length) {
      console.warn(`[Speaker Reassignment] Invalid segment index ${segmentIndex}, skipping`);
      continue;
    }

    // Validate new speaker exists
    if (!allSpeakers.includes(newSpeaker!)) {
      console.warn(`[Speaker Reassignment] Unknown speaker ${newSpeaker}, skipping`);
      continue;
    }

    const oldSpeaker = result[segmentIndex].speakerId;

    // Only apply if actually changing speaker
    if (oldSpeaker !== newSpeaker) {
      console.debug(`[Speaker Reassignment] Segment ${segmentIndex}: ${oldSpeaker} -> ${newSpeaker}`);
      result[segmentIndex] = {
        ...result[segmentIndex],
        speakerId: newSpeaker!
      };
    }
  }

  return result;
}

/**
 * DEPRECATED: Apply speaker corrections to segments.
 * Handles both 'split' and 'reassign' actions.
 * Use applySpeakerReassignments instead (no timestamp manipulation).
 */
export function _applySpeakerCorrections(
  segments: Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }>,
  corrections: SpeakerCorrection[],
  allSpeakers: string[]
): Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }> {
  if (corrections.length === 0) {
    console.debug('[Apply Corrections] No corrections to apply');
    return segments;
  }

  console.log('[Apply Corrections] Applying corrections...', {
    correctionCount: corrections.length,
    splitCount: corrections.filter(c => c.action === 'split').length,
    reassignCount: corrections.filter(c => c.action === 'reassign').length,
    availableSpeakers: allSpeakers
  });

  let modifiedSegments = [...segments];

  // Sort corrections by segment index DESCENDING to avoid index shifting
  const sortedCorrections = [...corrections].sort((a, b) => b.segmentIndex - a.segmentIndex);

  sortedCorrections.forEach(correction => {
    const segIndex = correction.segmentIndex;

    if (segIndex < 0 || segIndex >= modifiedSegments.length) {
      console.warn('[Apply Corrections] Invalid segment index, skipping:', {
        segmentIndex: segIndex,
        totalSegments: modifiedSegments.length
      });
      return;
    }

    const segment = modifiedSegments[segIndex];

    if (correction.action === 'reassign') {
      // Simple reassignment - just change the speaker
      if (!correction.newSpeaker) {
        console.warn('[Apply Corrections] Reassign action missing newSpeaker, skipping:', correction);
        return;
      }

      console.debug('[Apply Corrections] Reassigning segment:', {
        segmentIndex: segIndex,
        oldSpeaker: segment.speakerId,
        newSpeaker: correction.newSpeaker,
        reason: correction.reason
      });

      modifiedSegments[segIndex] = {
        ...segment,
        speakerId: correction.newSpeaker
      };

    } else if (correction.action === 'split') {
      // Split segment at character position
      // speakerBefore is optional - defaults to original segment's speaker
      // speakerAfter can be inferred for 2-speaker conversations
      if (!correction.splitAtChar) {
        console.warn('[Apply Corrections] Split action missing splitAtChar, skipping:', correction);
        return;
      }

      // Default speakerBefore to original speaker if not provided
      const speakerBefore = correction.speakerBefore || segment.speakerId;

      // Infer speakerAfter if not provided
      let speakerAfter = correction.speakerAfter;
      if (!speakerAfter) {
        // For 2-speaker conversations, the "other" speaker is obvious
        if (allSpeakers.length === 2) {
          speakerAfter = allSpeakers.find(s => s !== speakerBefore) || speakerBefore;
          console.debug('[Apply Corrections] Inferred speakerAfter for 2-speaker conversation:', {
            speakerBefore,
            speakerAfter,
            allSpeakers
          });
        } else {
          // Can't infer with >2 speakers - skip this correction
          console.warn('[Apply Corrections] Split action missing speakerAfter and cannot infer (>2 speakers), skipping:', correction);
          return;
        }
      }

      const splitPos = correction.splitAtChar;
      if (splitPos <= 0 || splitPos >= segment.text.length) {
        console.warn('[Apply Corrections] Invalid split position, skipping:', {
          splitAtChar: splitPos,
          textLength: segment.text.length
        });
        return;
      }

      const textBefore = segment.text.substring(0, splitPos).trim();
      const textAfter = segment.text.substring(splitPos).trim();

      // Interpolate timestamps based on character ratio (rough but reasonable)
      const charRatio = textBefore.length / segment.text.length;
      const durationMs = segment.endMs - segment.startMs;
      const splitTimeMs = segment.startMs + Math.floor(durationMs * charRatio);

      console.debug('[Apply Corrections] Splitting segment:', {
        segmentIndex: segIndex,
        splitAtChar: splitPos,
        charRatio: charRatio.toFixed(2),
        speakerBefore: speakerBefore,
        speakerAfter: speakerAfter,
        reason: correction.reason,
        beforeLength: textBefore.length,
        afterLength: textAfter.length
      });

      // Create two new segments
      const segmentBefore = {
        text: textBefore,
        startMs: segment.startMs,
        endMs: splitTimeMs,
        speakerId: speakerBefore,
        index: segment.index  // Will be re-indexed later
      };

      const segmentAfter = {
        text: textAfter,
        startMs: splitTimeMs,
        endMs: segment.endMs,
        speakerId: speakerAfter,
        index: segment.index  // Will be re-indexed later
      };

      // Replace the original segment with the two new ones
      modifiedSegments.splice(segIndex, 1, segmentBefore, segmentAfter);
    }
  });

  // Re-index all segments after corrections
  modifiedSegments = modifiedSegments.map((seg, idx) => ({
    ...seg,
    index: idx
  }));

  console.log('[Apply Corrections] Corrections applied:', {
    originalSegmentCount: segments.length,
    finalSegmentCount: modifiedSegments.length,
    segmentsAdded: modifiedSegments.length - segments.length
  });

  return modifiedSegments;
}

/**
 * NEW: Merge WhisperX segments with Gemini analysis
 */
function mergeWhisperXAndGeminiData(
  whisperxData: {
    segments: Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }>;
    speakers: Array<{ id: string; name: string }>;
  },
  analysis: GeminiAnalysis,
  conversationId: string,
  userId: string,
  chunkIndex?: number // Optional chunk index for generating unique IDs in parallel mode
): {
  title: string;
  speakers: Record<string, Speaker>;
  segments: Segment[];
  terms: Record<string, Term>;
  termOccurrences: TermOccurrence[];
  topics: Topic[];
  people: Person[];
  durationMs: number;
} {
  console.debug('[Merge] Merging WhisperX and Gemini data...');

  // Build a set of names mentioned in the People list (people talked ABOUT, not speakers)
  // We use this to prevent Gemini from confusing mentioned people with actual speakers
  const mentionedPeopleNames = new Set<string>(
    (analysis.people || [])
      .map(p => p.name?.toLowerCase().trim())
      .filter((name): name is string => !!name)
  );

  // Map speakers (use Gemini's inferred names/roles if available)
  const speakers: Record<string, Speaker> = {};
  let speakerIdentificationSource = 'default';  // Track which source we used

  whisperxData.speakers.forEach((s, idx) => {
    let displayName = s.name;  // Default: "Speaker 1", "Speaker 2", etc.

    // If Gemini identified the speaker, use that information
    if (analysis.speakerNotes) {
      const speakerNote = analysis.speakerNotes.find(n => n.speakerId === s.id);
      if (speakerNote) {
        speakerIdentificationSource = 'content-analysis';  // Using post-WhisperX analysis
        if (speakerNote.inferredName) {
          const inferredLower = speakerNote.inferredName.toLowerCase().trim();

          // SAFETY CHECK: Don't use the inferred name if it matches someone in the People list
          // This prevents confusing people talked ABOUT with actual speakers
          // EXCEPTION: If we have a speaker role (host, guest, interviewer, etc.), trust the identification
          // because someone can be both a speaker AND mentioned (e.g., Bill Gates being interviewed)
          const hasConfirmingRole = speakerNote.role &&
            ['host', 'guest', 'interviewer', 'interviewee', 'speaker', 'expert', 'panelist', 'moderator', 'co-host']
              .some(role => speakerNote.role!.toLowerCase().includes(role));

          if (mentionedPeopleNames.has(inferredLower) && !hasConfirmingRole) {
            console.warn(`[Merge] Rejecting inferred speaker name "${speakerNote.inferredName}" - matches someone in People list (talked about, not a speaker)`);
            // Fall through to use role or default name instead
            if (speakerNote.role) {
              displayName = `${s.name} (${speakerNote.role})`;
            }
          } else {
            // Use the real name if detected (e.g., "John" instead of "Speaker 1")
            // Also use it if they have a confirming role even if in People list
            if (mentionedPeopleNames.has(inferredLower) && hasConfirmingRole) {
              console.log(`[Merge] Allowing speaker name "${speakerNote.inferredName}" despite People list match - has confirming role: ${speakerNote.role}`);
            }
            displayName = speakerNote.inferredName;
            // Optionally append role if we have it
            if (speakerNote.role) {
              displayName = `${speakerNote.inferredName} (${speakerNote.role})`;
            }
          }
        } else if (speakerNote.role) {
          // No name but we know the role (e.g., "Speaker 1 (host)")
          displayName = `${s.name} (${speakerNote.role})`;
        } else if (speakerNote.notes) {
          // Just notes (e.g., "Speaker 1 (works at Google)")
          displayName = `${s.name} (${speakerNote.notes})`;
        }
      }
    }

    speakers[s.id] = {
      speakerId: s.id,
      displayName,
      colorIndex: idx
    };
  });

  // Log speaker identification results with source
  const speakerSummary = Object.values(speakers).map(s => s.displayName).join(', ');
  console.log(`[Merge] Speaker identification (source: ${speakerIdentificationSource}): ${speakerSummary}`);

  // Generate segment ID suffix for chunk mode (ensures uniqueness across chunks)
  const idSuffix = chunkIndex !== undefined ? `_chunk${chunkIndex}` : '';

  // Map segments (already have correct timestamps from WhisperX)
  const segments: Segment[] = whisperxData.segments.map((seg, idx) => ({
    segmentId: `seg_${idx}${idSuffix}`,
    index: idx,
    speakerId: seg.speakerId,
    startMs: seg.startMs,
    endMs: seg.endMs,
    text: seg.text
  }));

  // Map terms
  const terms: Record<string, Term> = {};
  analysis.terms.forEach(t => {
    terms[t.id] = {
      termId: t.id,
      key: t.term.toLowerCase(),
      display: t.term,
      definition: t.definition,
      aliases: t.aliases || []
    };
  });

  // Calculate term occurrences
  const termOccurrences: TermOccurrence[] = [];
  let occCount = 0;

  segments.forEach(seg => {
    Object.values(terms).forEach(term => {
      const patterns = [term.display, ...term.aliases].map(p =>
        p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      );
      const regex = new RegExp(`\\b(${patterns.join('|')})\\b`, 'gi');

      let match;
      while ((match = regex.exec(seg.text)) !== null) {
        termOccurrences.push({
          occurrenceId: `occ_${occCount++}${idSuffix}`, // Chunk-aware occurrence IDs
          termId: term.termId,
          segmentId: seg.segmentId, // Already includes chunk suffix from above
          startChar: match.index,
          endChar: match.index + match[0].length
        });
      }
    });
  });

  // Map topics
  const topics: Topic[] = analysis.topics.map((t, idx) => ({
    topicId: `top_${idx}`,
    title: t.title,
    startIndex: t.startSegmentIndex,
    endIndex: t.endSegmentIndex,
    type: t.type as 'main' | 'tangent'
  }));

  // Map people - start with Gemini's list of mentioned people
  const people: Person[] = (analysis.people || []).map((p, idx) => ({
    personId: `p_${idx}`,
    name: p.name,
    affiliation: p.affiliation
  }));

  // Add identified speakers to the People list if not already present
  // This ensures the People list includes everyone relevant (speakers + mentioned)
  if (analysis.speakerNotes) {
    const existingNames = new Set(people.map(p => p.name.toLowerCase().trim()));
    let addedCount = 0;

    for (const speakerNote of analysis.speakerNotes) {
      if (speakerNote.inferredName) {
        const nameLower = speakerNote.inferredName.toLowerCase().trim();
        if (!existingNames.has(nameLower)) {
          people.push({
            personId: `p_${people.length}`,
            name: speakerNote.inferredName,
            affiliation: speakerNote.role ? `Speaker (${speakerNote.role})` : 'Speaker'
          });
          existingNames.add(nameLower);
          addedCount++;
        }
      }
    }

    if (addedCount > 0) {
      console.log(`[Merge] Added ${addedCount} speaker(s) to People list`);
    }
  }

  // Calculate duration from WhisperX segments
  const lastSegment = segments[segments.length - 1];
  const durationMs = lastSegment ? lastSegment.endMs : 0;

  console.debug('[Merge] Merge complete:', {
    title: analysis.title,
    speakerCount: Object.keys(speakers).length,
    segmentCount: segments.length,
    termCount: Object.keys(terms).length,
    termOccurrenceCount: termOccurrences.length,
    topicCount: topics.length,
    personCount: people.length,
    durationMs
  });

  return {
    title: analysis.title,
    speakers,
    segments,
    terms,
    termOccurrences,
    topics,
    people,
    durationMs
  };
}
