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
import { transcribeWithWhisperX, WhisperXSegment } from './alignment';

// Define secrets (set via: firebase functions:secrets:set <SECRET_NAME>)
const geminiApiKey = defineSecret('GEMINI_API_KEY');
const replicateApiToken = defineSecret('REPLICATE_API_TOKEN');
const huggingfaceAccessToken = defineSecret('HUGGINGFACE_ACCESS_TOKEN');  // For speaker diarization

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
 * Triggered when an audio file is uploaded to storage.
 * Path pattern: audio/{userId}/{conversationId}.{extension}
 */
export const transcribeAudio = onObjectFinalized(
  {
    secrets: [geminiApiKey, replicateApiToken, huggingfaceAccessToken],
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

      // === NEW ARCHITECTURE: WhisperX-first transcription ===
      // Step 1: Get transcript + timestamps from WhisperX
      console.log('[Transcribe] Step 1: Calling WhisperX for transcription...');
      const whisperxStartTime = Date.now();

      // Pass HF token for speaker diarization (optional but recommended)
      const hfToken = huggingfaceAccessToken.value();
      if (!hfToken) {
        console.warn('[Transcribe] HUGGINGFACE_ACCESS_TOKEN not set - speaker diarization will be disabled');
      }

      const whisperxResult = await transcribeWithWhisperX(
        audioBuffer,
        replicateApiToken.value(),
        hfToken || undefined  // Pass undefined if empty to trigger warning
      );

      const whisperxDurationMs = Date.now() - whisperxStartTime;

      if (whisperxResult.status === 'error') {
        throw new Error(`WhisperX failed: ${whisperxResult.error}`);
      }

      console.log('[Transcribe] WhisperX transcription complete:', {
        conversationId,
        durationMs: whisperxDurationMs,
        durationSec: (whisperxDurationMs / 1000).toFixed(1),
        segmentCount: whisperxResult.segments.length,
        firstSegment: whisperxResult.segments[0],
        lastSegment: whisperxResult.segments[whisperxResult.segments.length - 1]
      });

      // Step 2: Build segments from WhisperX output
      console.debug('[Transcribe] Step 2: Building segments from WhisperX...');
      const buildStartTime = Date.now();

      const whisperxSegments = buildSegmentsFromWhisperX(whisperxResult.segments);

      const buildDurationMs = Date.now() - buildStartTime;
      console.debug('[Transcribe] Segments built:', {
        buildDurationMs,
        segmentCount: whisperxSegments.segments.length,
        speakerCount: whisperxSegments.speakers.length
      });

      // Update progress: analyzing with Gemini
      await progressManager.setStep(ProcessingStep.ANALYZING);

      // Step 3: Call Gemini to analyze the transcript (not the audio!)
      console.log('[Transcribe] Step 3: Calling Gemini for analysis...');
      const geminiStartTime = Date.now();

      const analysis = await analyzeTranscriptWithGemini(
        whisperxSegments.segments,
        whisperxSegments.speakers,
        geminiApiKey.value()
      );

      const geminiDurationMs = Date.now() - geminiStartTime;
      console.log('[Transcribe] Gemini analysis complete:', {
        conversationId,
        durationMs: geminiDurationMs,
        durationSec: (geminiDurationMs / 1000).toFixed(1),
        title: analysis.title,
        termCount: analysis.terms?.length ?? 0,
        topicCount: analysis.topics?.length ?? 0,
        personCount: analysis.people?.length ?? 0
      });

      // Step 3.5: Speaker correction pass (NEW)
      console.log('[Transcribe] Step 3.5: Identifying speaker corrections...');
      const speakerCorrectionStartTime = Date.now();

      const speakerCorrections = await identifySpeakerCorrections(
        whisperxSegments.segments,
        whisperxSegments.speakers,
        geminiApiKey.value()
      );

      const speakerCorrectionDurationMs = Date.now() - speakerCorrectionStartTime;
      console.log('[Transcribe] Speaker correction analysis complete:', {
        conversationId,
        durationMs: speakerCorrectionDurationMs,
        durationSec: (speakerCorrectionDurationMs / 1000).toFixed(1),
        correctionCount: speakerCorrections.length,
        splitCount: speakerCorrections.filter(c => c.action === 'split').length,
        reassignCount: speakerCorrections.filter(c => c.action === 'reassign').length
      });

      // Apply speaker corrections to segments
      const correctedSegments = applySpeakerCorrections(
        whisperxSegments.segments,
        speakerCorrections
      );

      // Update the whisperxSegments with corrected segments
      whisperxSegments.segments = correctedSegments;

      // Update progress: finalizing
      await progressManager.setStep(ProcessingStep.FINALIZING);

      // Step 4: Transform to our data model (merge WhisperX + Gemini)
      console.debug('[Transcribe] Step 4: Merging WhisperX and Gemini data...');
      const transformStartTime = Date.now();

      const processedData = mergeWhisperXAndGeminiData(
        whisperxSegments,
        analysis,
        conversationId,
        userId
      );

      const transformDurationMs = Date.now() - transformStartTime;
      console.debug('[Transcribe] Transform complete:', {
        transformDurationMs,
        finalSegmentCount: processedData.segments.length,
        termOccurrenceCount: processedData.termOccurrences.length,
        durationMs: processedData.durationMs
      });

      // Save results to Firestore
      console.debug('[Transcribe] Saving results to Firestore...');
      const firestoreStartTime = Date.now();
      await db.collection('conversations').doc(conversationId).update({
        ...processedData,
        status: 'complete',
        alignmentStatus: 'aligned',  // Always aligned since WhisperX is the source
        alignmentError: null,
        audioStoragePath: filePath,
        updatedAt: FieldValue.serverTimestamp()
      });
      const firestoreDurationMs = Date.now() - firestoreStartTime;

      const totalDurationMs = Date.now() - downloadStartTime;
      console.log('[Transcribe] ✅ Transcription complete (NEW ARCHITECTURE):', {
        conversationId,
        segmentCount: processedData.segments.length,
        speakerCount: Object.keys(processedData.speakers).length,
        termCount: Object.keys(processedData.terms).length,
        topicCount: processedData.topics.length,
        personCount: processedData.people.length,
        alignmentStatus: 'aligned',
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
 * NEW: Build segments from WhisperX output
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

  // Build segments with timestamps in milliseconds
  const segments = whisperxSegments.map((seg, idx) => ({
    text: seg.text,
    startMs: Math.floor(seg.start * 1000),
    endMs: Math.floor(seg.end * 1000),
    speakerId: seg.speaker || 'SPEAKER_00',  // Default if no diarization
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
 * NEW: Analyze transcript with Gemini (text-only, no audio)
 */
async function analyzeTranscriptWithGemini(
  segments: Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }>,
  speakers: Array<{ id: string; name: string }>,
  apiKey: string
): Promise<GeminiAnalysis> {
  const genAI = new GoogleGenerativeAI(apiKey);

  // Use gemini-2.5-flash for analysis
  const model = genAI.getGenerativeModel({
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
  });

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

  const result = await model.generateContent([{ text: prompt }]);
  const responseText = result.response.text();

  console.debug('[Gemini Analysis] Raw response received:', {
    responseLength: responseText.length
  });

  const cleanJson = responseText.replace(/```json\s*|\s*```/g, '').trim();

  try {
    const parsed = JSON.parse(cleanJson) as GeminiAnalysis;
    console.debug('[Gemini Analysis] JSON parsed successfully');
    return parsed;
  } catch (parseError) {
    console.error('[Gemini Analysis] JSON parse failed:', {
      error: parseError instanceof Error ? parseError.message : String(parseError),
      cleanJsonPreview: cleanJson.substring(0, 500)
    });
    throw parseError;
  }
}

/**
 * NEW: Identify speaker corrections using Gemini conversational analysis.
 * Detects mid-segment speaker changes that WhisperX/pyannote miss.
 */
async function identifySpeakerCorrections(
  segments: Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }>,
  speakers: Array<{ id: string; name: string }>,
  apiKey: string
): Promise<SpeakerCorrection[]> {
  const genAI = new GoogleGenerativeAI(apiKey);

  // Use gemini-2.5-flash for speaker correction analysis
  const model = genAI.getGenerativeModel({
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
                action: { type: SchemaType.STRING },
                reason: { type: SchemaType.STRING },
                splitAtChar: { type: SchemaType.INTEGER },
                speakerBefore: { type: SchemaType.STRING },
                speakerAfter: { type: SchemaType.STRING },
                newSpeaker: { type: SchemaType.STRING }
              },
              required: ['segmentIndex', 'action', 'reason']
            }
          }
        },
        required: ['corrections']
      }
    }
  });

  // Format transcript with segment indices and speaker labels
  const formattedTranscript = segments.map((seg, idx) => {
    const speakerName = speakers.find(s => s.id === seg.speakerId)?.name || seg.speakerId;
    return `[${idx}] ${speakerName}: ${seg.text}`;
  }).join('\n\n');

  const speakerList = speakers.map(s => `${s.id} (${s.name})`).join(', ');

  const prompt = `
You are an expert at identifying speaker attribution errors in conversation transcripts.

Analyze this transcript and identify segments where the speaker attribution is LIKELY WRONG.
Focus on:

1. MID-SEGMENT SPEAKER CHANGES: Look for cases where the speaker changes mid-utterance.
   Common patterns:
   - Question followed by answer: "What do you think? Yeah, I agree..." (likely two speakers)
   - Back-and-forth acknowledgments: "Right, exactly. Mm-hmm. So anyway..." (likely different speakers)
   - Name mentions: "Chris mentioned..." or "Michael, what do you think?" (indicates another speaker)
   - Direct address: "You know what I mean?" followed by "Yeah" (likely different speakers)

2. MISATTRIBUTED SEGMENTS: Entire segments where speaker is clearly wrong.
   Common patterns:
   - Context clues (person A asks question, answer attributed to person A instead of person B)
   - Filler words from wrong speaker ("yeah", "mm-hmm", "right" during someone else's turn)
   - Self-references that don't match ("I work at Google" but speaker is introduced as working at Meta)

IMPORTANT GUIDELINES:
- Only return HIGH-CONFIDENCE corrections (80%+ sure)
- For split actions, identify the character position where speaker changes
- For reassign actions, identify which speaker ID should be used instead
- The speakerId values available are: ${speakerList}
- Be conservative - false negatives are better than false positives
- Don't suggest corrections based on speculation - need clear conversational evidence

Actions:
- "split": Segment contains multiple speakers, should be split at character position
- "reassign": Entire segment attributed to wrong speaker

Available speakers: ${speakerList}

Transcript (with speaker labels and segment indices):
${formattedTranscript}

Return your analysis as JSON with an array of corrections.
If no corrections are needed, return an empty array.
`;

  console.debug('[Speaker Correction] Sending request...', {
    promptLength: prompt.length,
    segmentCount: segments.length,
    speakerCount: speakers.length
  });

  const result = await model.generateContent([{ text: prompt }]);
  const responseText = result.response.text();

  console.debug('[Speaker Correction] Raw response received:', {
    responseLength: responseText.length
  });

  const cleanJson = responseText.replace(/```json\s*|\s*```/g, '').trim();

  try {
    const parsed = JSON.parse(cleanJson) as { corrections: SpeakerCorrection[] };
    console.debug('[Speaker Correction] JSON parsed successfully:', {
      correctionCount: parsed.corrections.length
    });
    return parsed.corrections;
  } catch (parseError) {
    console.error('[Speaker Correction] JSON parse failed:', {
      error: parseError instanceof Error ? parseError.message : String(parseError),
      cleanJsonPreview: cleanJson.substring(0, 500)
    });
    // Don't fail the whole transcription if speaker correction fails
    // Just log the error and return empty corrections
    return [];
  }
}

/**
 * Apply speaker corrections to segments.
 * Handles both 'split' and 'reassign' actions.
 */
function applySpeakerCorrections(
  segments: Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }>,
  corrections: SpeakerCorrection[]
): Array<{ text: string; startMs: number; endMs: number; speakerId: string; index: number }> {
  if (corrections.length === 0) {
    console.debug('[Apply Corrections] No corrections to apply');
    return segments;
  }

  console.log('[Apply Corrections] Applying corrections...', {
    correctionCount: corrections.length,
    splitCount: corrections.filter(c => c.action === 'split').length,
    reassignCount: corrections.filter(c => c.action === 'reassign').length
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
      if (!correction.splitAtChar || !correction.speakerBefore || !correction.speakerAfter) {
        console.warn('[Apply Corrections] Split action missing required fields, skipping:', correction);
        return;
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
        speakerBefore: correction.speakerBefore,
        speakerAfter: correction.speakerAfter,
        reason: correction.reason,
        beforeLength: textBefore.length,
        afterLength: textAfter.length
      });

      // Create two new segments
      const segmentBefore = {
        text: textBefore,
        startMs: segment.startMs,
        endMs: splitTimeMs,
        speakerId: correction.speakerBefore,
        index: segment.index  // Will be re-indexed later
      };

      const segmentAfter = {
        text: textAfter,
        startMs: splitTimeMs,
        endMs: segment.endMs,
        speakerId: correction.speakerAfter,
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
  console.debug('[Merge] Merging WhisperX and Gemini data...');

  // Map speakers (use Gemini's inferred names/roles if available)
  const speakers: Record<string, Speaker> = {};
  whisperxData.speakers.forEach((s, idx) => {
    let displayName = s.name;  // Default: "Speaker 1", "Speaker 2", etc.

    // If Gemini identified the speaker, use that information
    if (analysis.speakerNotes) {
      const speakerNote = analysis.speakerNotes.find(n => n.speakerId === s.id);
      if (speakerNote) {
        if (speakerNote.inferredName) {
          // Use the real name if detected (e.g., "John" instead of "Speaker 1")
          displayName = speakerNote.inferredName;
          // Optionally append role if we have it
          if (speakerNote.role) {
            displayName = `${speakerNote.inferredName} (${speakerNote.role})`;
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

  // Log speaker identification results
  const speakerSummary = Object.values(speakers).map(s => s.displayName).join(', ');
  console.debug(`[Merge] Speaker identification: ${speakerSummary}`);

  // Map segments (already have correct timestamps from WhisperX)
  const segments: Segment[] = whisperxData.segments.map((seg, idx) => ({
    segmentId: `seg_${idx}`,
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
          occurrenceId: `occ_${occCount++}`,
          termId: term.termId,
          segmentId: seg.segmentId,
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

  // Map people
  const people: Person[] = (analysis.people || []).map((p, idx) => ({
    personId: `p_${idx}`,
    name: p.name,
    affiliation: p.affiliation
  }));

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
