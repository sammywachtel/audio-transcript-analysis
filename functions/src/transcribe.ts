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
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { FieldValue } from 'firebase-admin/firestore';
import { db, bucket } from './index';
import { ProgressManager, ProcessingStep } from './progressManager';

// Define secrets (set via: firebase functions:secrets:set <SECRET_NAME>)
const geminiApiKey = defineSecret('GEMINI_API_KEY');
const alignmentServiceUrl = defineSecret('ALIGNMENT_SERVICE_URL');

// Types matching the client-side schema
interface AIResponse {
  title: string;
  speakers: { id: string; name: string }[];
  segments: { speakerId: string; startMs: number; endMs: number; text: string }[];
  terms: { id: string; term: string; definition: string; aliases: string[] }[];
  topics: { title: string; startSegmentIndex: number; endSegmentIndex: number; type: 'main' | 'tangent' }[];
  people: { name: string; affiliation: string }[];
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

// Alignment service types
interface AlignmentRequest {
  audio_base64: string;
  segments: { speakerId: string; text: string; startMs: number; endMs: number }[];
}

interface AlignmentResponse {
  segments: { speakerId: string; text: string; startMs: number; endMs: number; confidence: number }[];
  average_confidence: number;
}

interface AlignmentResult {
  segments: Segment[];
  alignmentStatus: 'aligned' | 'fallback';
  alignmentError?: string;
}

/**
 * Triggered when an audio file is uploaded to storage.
 * Path pattern: audio/{userId}/{conversationId}.{extension}
 */
export const transcribeAudio = onObjectFinalized(
  {
    secrets: [geminiApiKey, alignmentServiceUrl],
    memory: '1GiB', // Audio processing needs more memory
    timeoutSeconds: 540, // 9 minutes (max for 1st gen functions)
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
    if (!filePath.startsWith('audio/') || !contentType?.startsWith('audio/')) {
      console.debug('[Transcribe] Skipping non-audio file:', { filePath, contentType });
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

    console.log('[Transcribe] Processing audio file:', {
      filePath,
      userId,
      conversationId,
      contentType,
      fileExtension,
      sizeBytes: event.data.size,
      sizeMB: (event.data.size / (1024 * 1024)).toFixed(2)
    });

    // Initialize progress tracking (before try block so it's accessible in catch)
    const progressManager = new ProgressManager(conversationId);

    try {
      // Update status to processing
      await db.collection('conversations').doc(conversationId).update({
        status: 'processing',
        updatedAt: FieldValue.serverTimestamp()
      });

      // Start transcription step
      await progressManager.setStep(ProcessingStep.TRANSCRIBING);

      // Download audio file to memory
      console.debug('[Transcribe] Starting audio download from Storage...');
      const downloadStartTime = Date.now();
      const file = bucket.file(filePath);
      const [audioBuffer] = await file.download();
      const downloadDurationMs = Date.now() - downloadStartTime;

      console.log('[Transcribe] Audio downloaded:', {
        conversationId,
        bufferSizeBytes: audioBuffer.length,
        bufferSizeMB: (audioBuffer.length / (1024 * 1024)).toFixed(2),
        downloadDurationMs,
        downloadSpeedMBps: ((audioBuffer.length / (1024 * 1024)) / (downloadDurationMs / 1000)).toFixed(2)
      });

      // Process with Gemini
      console.debug('[Transcribe] Calling Gemini API...', {
        model: 'gemini-2.5-flash',
        contentType,
        audioSizeBytes: audioBuffer.length
      });
      const geminiStartTime = Date.now();

      const result = await processWithGemini(
        audioBuffer,
        contentType,
        geminiApiKey.value()
      );

      const geminiDurationMs = Date.now() - geminiStartTime;
      console.log('[Transcribe] Gemini API response received:', {
        conversationId,
        durationMs: geminiDurationMs,
        durationSec: (geminiDurationMs / 1000).toFixed(1),
        segmentCount: result.segments?.length ?? 0,
        speakerCount: result.speakers?.length ?? 0,
        termCount: result.terms?.length ?? 0,
        topicCount: result.topics?.length ?? 0,
        personCount: result.people?.length ?? 0,
        title: result.title
      });

      // Update progress: analyzing data
      await progressManager.setStep(ProcessingStep.ANALYZING);

      // DEBUG: Log sample segment timestamps from Gemini
      if (result.segments && result.segments.length > 0) {
        const firstSeg = result.segments[0];
        const lastSeg = result.segments[result.segments.length - 1];
        console.debug('[Transcribe] Gemini timestamp sample:', {
          firstSegment: { startMs: firstSeg.startMs, endMs: firstSeg.endMs, textPreview: firstSeg.text.substring(0, 50) },
          lastSegment: { startMs: lastSeg.startMs, endMs: lastSeg.endMs, textPreview: lastSeg.text.substring(0, 50) },
          totalDurationMs: lastSeg.endMs,
          totalDurationFormatted: `${Math.floor(lastSeg.endMs / 60000)}:${((lastSeg.endMs % 60000) / 1000).toFixed(1)}`
        });
      }

      // Transform AI response to our data model
      console.debug('[Transcribe] Transforming AI response to internal data model...');
      const transformStartTime = Date.now();
      const processedData = transformAIResponse(result, conversationId, userId);
      const transformDurationMs = Date.now() - transformStartTime;

      console.debug('[Transcribe] Transform complete:', {
        transformDurationMs,
        finalSegmentCount: processedData.segments.length,
        termOccurrenceCount: processedData.termOccurrences.length,
        durationMs: processedData.durationMs,
        durationFormatted: `${Math.floor(processedData.durationMs / 60000)}:${((processedData.durationMs % 60000) / 1000).toFixed(1)}`
      });

      // Call alignment service to get accurate timestamps from WhisperX
      // Calculate time remaining for alignment (540s total timeout)
      const elapsedMs = Date.now() - downloadStartTime;
      const alignmentTimeoutMs = Math.max(60000, (540 * 1000) - elapsedMs - 30000); // Leave 30s buffer

      // Update progress: aligning timestamps
      await progressManager.setStep(ProcessingStep.ALIGNING);

      console.log('[Transcribe] Calling alignment service...', {
        conversationId,
        elapsedMs,
        alignmentTimeoutMs,
        segmentCount: processedData.segments.length
      });

      const alignmentStartTime = Date.now();
      const alignmentResult = await callAlignmentService(
        audioBuffer,
        processedData.segments,
        alignmentTimeoutMs,
        alignmentServiceUrl.value()
      );
      const alignmentDurationMs = Date.now() - alignmentStartTime;

      console.log('[Transcribe] Alignment result:', {
        conversationId,
        alignmentStatus: alignmentResult.alignmentStatus,
        alignmentError: alignmentResult.alignmentError,
        alignmentDurationMs
      });

      // Use aligned segments if successful, otherwise keep Gemini segments
      const finalSegments = alignmentResult.segments;
      const lastSegment = finalSegments[finalSegments.length - 1];
      const finalDurationMs = lastSegment ? lastSegment.endMs : processedData.durationMs;

      // Update progress: finalizing and saving
      await progressManager.setStep(ProcessingStep.FINALIZING);

      // Save results to Firestore
      console.debug('[Transcribe] Saving results to Firestore...');
      const firestoreStartTime = Date.now();
      await db.collection('conversations').doc(conversationId).update({
        ...processedData,
        segments: finalSegments,
        durationMs: finalDurationMs,
        status: 'complete',
        alignmentStatus: alignmentResult.alignmentStatus,
        alignmentError: alignmentResult.alignmentError || null,
        audioStoragePath: filePath,
        updatedAt: FieldValue.serverTimestamp()
      });
      const firestoreDurationMs = Date.now() - firestoreStartTime;

      const totalDurationMs = Date.now() - downloadStartTime;
      console.log('[Transcribe] ✅ Transcription complete:', {
        conversationId,
        segmentCount: finalSegments.length,
        speakerCount: Object.keys(processedData.speakers).length,
        termCount: Object.keys(processedData.terms).length,
        topicCount: processedData.topics.length,
        personCount: processedData.people.length,
        alignmentStatus: alignmentResult.alignmentStatus,
        timingMs: {
          download: downloadDurationMs,
          gemini: geminiDurationMs,
          transform: transformDurationMs,
          alignment: alignmentDurationMs,
          firestore: firestoreDurationMs,
          total: totalDurationMs
        }
      });

      // Mark processing as complete
      await progressManager.setComplete();

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      console.error('[Transcribe] ❌ Transcription failed:', {
        conversationId,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        errorMessage,
        errorStack: error instanceof Error ? error.stack : undefined
      });

      // Mark processing as failed
      await progressManager.setFailed(errorMessage);

      // Update status to failed
      await db.collection('conversations').doc(conversationId).update({
        status: 'failed',
        processingError: errorMessage,
        updatedAt: FieldValue.serverTimestamp()
      });

      console.debug('[Transcribe] Firestore updated with failed status');
    }
  }
);

/**
 * Process audio with Gemini API
 */
async function processWithGemini(
  audioBuffer: Buffer,
  contentType: string,
  apiKey: string
): Promise<AIResponse> {
  const genAI = new GoogleGenerativeAI(apiKey);

  // Use gemini-2.5-flash for multimodal audio processing
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          title: { type: SchemaType.STRING },
          speakers: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                id: { type: SchemaType.STRING },
                name: { type: SchemaType.STRING }
              },
              required: ['id', 'name']
            }
          },
          segments: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                speakerId: { type: SchemaType.STRING },
                startMs: { type: SchemaType.INTEGER },
                endMs: { type: SchemaType.INTEGER },
                text: { type: SchemaType.STRING }
              },
              required: ['speakerId', 'startMs', 'endMs', 'text']
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
          }
        },
        required: ['title', 'speakers', 'segments', 'terms', 'topics', 'people']
      }
    }
  });

  const prompt = `
    You are an expert transcriber and analyst. Process the attached audio file.

    Tasks:
    1. Transcribe the conversation verbatim.
    2. Identify different speakers (e.g., Speaker 1, Speaker 2) and attribute each segment to them.
    3. Segment the text based on natural pauses or speaker changes. Provide accurate start and end timestamps in milliseconds.
    4. Identify technical terms, acronyms, or complex concepts mentioned. Provide a clear, short definition for each based on the context.
    5. Identify the main topics and any tangents.
    6. Identify people mentioned in the conversation (distinct from the speakers themselves, if possible). Extract their full name and inferred affiliation/organization/role.

    Populate the JSON schema provided in the configuration.
  `;

  console.debug('[Gemini] Sending request to model...', {
    mimeType: contentType,
    audioBase64Length: audioBuffer.toString('base64').length,
    promptLength: prompt.length
  });

  const result = await model.generateContent([
    {
      inlineData: {
        mimeType: contentType,
        data: audioBuffer.toString('base64')
      }
    },
    { text: prompt }
  ]);

  const responseText = result.response.text();
  console.debug('[Gemini] Raw response received:', {
    responseLength: responseText.length,
    startsWithBackticks: responseText.startsWith('```'),
    first100Chars: responseText.substring(0, 100)
  });

  const cleanJson = responseText.replace(/```json\s*|\s*```/g, '').trim();

  console.debug('[Gemini] Cleaned JSON:', {
    cleanedLength: cleanJson.length,
    first100Chars: cleanJson.substring(0, 100)
  });

  try {
    const parsed = JSON.parse(cleanJson) as AIResponse;
    console.debug('[Gemini] JSON parsed successfully');
    return parsed;
  } catch (parseError) {
    console.error('[Gemini] JSON parse failed:', {
      error: parseError instanceof Error ? parseError.message : String(parseError),
      cleanJsonPreview: cleanJson.substring(0, 500)
    });
    throw parseError;
  }
}

/**
 * Transform AI response to our internal data model
 * Matches the logic from client-side utils.ts
 */
function transformAIResponse(
  data: AIResponse,
  conversationId: string,
  userId: string
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
  console.debug('[Transform] Starting transformation:', {
    conversationId,
    inputSegmentCount: data.segments?.length ?? 0,
    inputSpeakerCount: data.speakers?.length ?? 0
  });

  // Map speakers
  const speakers: Record<string, Speaker> = {};
  data.speakers.forEach((s, idx) => {
    speakers[s.id] = {
      speakerId: s.id,
      displayName: s.name,
      colorIndex: idx
    };
  });
  console.debug('[Transform] Speakers mapped:', Object.keys(speakers));

  // Prepare segments with temp IDs for topic resolution
  let rawSegments = data.segments.map((s, idx) => ({
    tempId: `temp_${idx}`,
    speakerId: s.speakerId,
    startMs: s.startMs,
    endMs: s.endMs,
    text: s.text
  }));

  // Resolve topics to temp segment IDs
  const rawTopics = data.topics.map((t, idx) => {
    const startSeg = rawSegments[t.startSegmentIndex] || rawSegments[0];
    const endSeg = rawSegments[t.endSegmentIndex] || rawSegments[rawSegments.length - 1];
    return {
      topicId: `top_${idx}`,
      title: t.title,
      type: t.type,
      startSegmentTempId: startSeg?.tempId,
      endSegmentTempId: endSeg?.tempId
    };
  });

  // Sort segments chronologically
  rawSegments.sort((a, b) => a.startMs - b.startMs);

  // Finalize segments with stable IDs
  const segments: (Segment & { tempId: string })[] = rawSegments.map((s, idx) => ({
    segmentId: `seg_${idx}`,
    tempId: s.tempId,
    index: idx,
    speakerId: s.speakerId,
    startMs: s.startMs,
    endMs: s.endMs,
    text: s.text
  }));

  // Map terms
  const terms: Record<string, Term> = {};
  data.terms.forEach(t => {
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
          occurrenceId: `occ_${occCount++}`,
          termId: term.termId,
          segmentId: seg.segmentId,
          startChar: match.index,
          endChar: match.index + match[0].length
        });
      }
    });
  });

  // Finalize topics
  const topics: Topic[] = rawTopics.map(t => {
    const startIndex = segments.findIndex(s => s.tempId === t.startSegmentTempId);
    const endIndex = segments.findIndex(s => s.tempId === t.endSegmentTempId);
    return {
      topicId: t.topicId,
      title: t.title,
      startIndex: startIndex === -1 ? 0 : startIndex,
      endIndex: endIndex === -1 ? 0 : endIndex,
      type: t.type as 'main' | 'tangent'
    };
  });

  // Map people
  const people: Person[] = (data.people || []).map((p, idx) => ({
    personId: `p_${idx}`,
    name: p.name,
    affiliation: p.affiliation
  }));

  // Calculate duration
  const lastSegment = segments[segments.length - 1];
  const durationMs = lastSegment ? lastSegment.endMs : 0;

  // Clean up temp IDs
  const cleanSegments: Segment[] = segments.map(({ tempId, ...rest }) => rest);

  console.debug('[Transform] Transformation complete:', {
    title: data.title,
    speakerCount: Object.keys(speakers).length,
    segmentCount: cleanSegments.length,
    termCount: Object.keys(terms).length,
    termOccurrenceCount: termOccurrences.length,
    topicCount: topics.length,
    personCount: people.length,
    durationMs,
    firstSegmentMs: cleanSegments[0]?.startMs,
    lastSegmentEndMs: cleanSegments[cleanSegments.length - 1]?.endMs
  });

  return {
    title: data.title,
    speakers,
    segments: cleanSegments,
    terms,
    termOccurrences,
    topics,
    people,
    durationMs
  };
}

/**
 * Call the alignment service to get accurate timestamps from WhisperX
 * Falls back to original Gemini segments if alignment fails
 */
async function callAlignmentService(
  audioBuffer: Buffer,
  segments: Segment[],
  timeoutMs: number,
  serviceUrl: string
): Promise<AlignmentResult> {
  // If no service URL configured, skip alignment
  if (!serviceUrl || serviceUrl.trim() === '') {
    console.warn('[Alignment] No ALIGNMENT_SERVICE_URL configured, skipping alignment');
    return {
      segments,
      alignmentStatus: 'fallback',
      alignmentError: 'Alignment service not configured'
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    console.debug('[Alignment] Preparing request...', {
      serviceUrl,
      segmentCount: segments.length,
      audioSizeBytes: audioBuffer.length,
      timeoutMs
    });

    const requestBody: AlignmentRequest = {
      audio_base64: audioBuffer.toString('base64'),
      segments: segments.map(s => ({
        speakerId: s.speakerId,
        text: s.text,
        startMs: s.startMs,
        endMs: s.endMs
      }))
    };

    console.debug('[Alignment] Sending request to service...');
    const response = await fetch(`${serviceUrl}/align`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Alignment] Service returned error:', {
        status: response.status,
        statusText: response.statusText,
        errorText: errorText.substring(0, 500)
      });
      throw new Error(`Alignment service error: ${response.status} ${response.statusText}`);
    }

    const result: AlignmentResponse = await response.json();

    console.log('[Alignment] ✅ Alignment successful:', {
      averageConfidence: result.average_confidence,
      segmentCount: result.segments.length
    });

    // Quality gate: warn on low confidence but still use alignment
    // (Gemini timestamps are often worse than low-confidence alignment)
    // TODO: Stage 2 should implement per-segment confidence thresholds
    if (result.average_confidence < 0.55) {
      console.warn('[Alignment] ⚠️ Low confidence alignment (still using it):', {
        averageConfidence: result.average_confidence
      });
    }

    // Map aligned segments back to our Segment format
    const alignedSegments: Segment[] = segments.map((seg, idx) => ({
      ...seg,
      startMs: result.segments[idx]?.startMs ?? seg.startMs,
      endMs: result.segments[idx]?.endMs ?? seg.endMs
    }));

    return {
      segments: alignedSegments,
      alignmentStatus: 'aligned'
    };

  } catch (error) {
    clearTimeout(timeoutId);

    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && error.name === 'AbortError';

    console.error('[Alignment] ❌ Alignment failed:', {
      errorType: isTimeout ? 'TIMEOUT' : 'ERROR',
      errorMessage,
      usingFallback: true
    });

    // Return original segments with fallback status
    return {
      segments,
      alignmentStatus: 'fallback',
      alignmentError: isTimeout
        ? `Alignment timed out after ${timeoutMs}ms`
        : errorMessage
    };
  }
}
