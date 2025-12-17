import { GoogleGenAI, Type } from "@google/genai";
import { Conversation, Speaker, Segment, Term, TermOccurrence, Topic, Person } from '../types';

/**
 * Raw response structure from Gemini API
 * Separated from our internal types for clarity
 */
interface GeminiTranscriptionResponse {
  title: string;
  speakers: { id: string; name: string }[];
  segments: { speakerId: string; startMs: number; endMs: number; text: string }[];
  terms: { id: string; term: string; definition: string; aliases: string[] }[];
  topics: { title: string; startSegmentIndex: number; endSegmentIndex: number; type: 'main' | 'tangent' }[];
  people: { name: string; affiliation: string }[];
}

/**
 * TranscriptionService - Handles all AI processing via Gemini API
 *
 * Isolates the complexities of talking to Google's API and transforming
 * the response into our internal data model. If we ever switch to a different
 * transcription provider (Whisper, AssemblyAI, etc.), only this file changes.
 */
export class TranscriptionService {
  private ai: GoogleGenAI;

  constructor(apiKey?: string) {
    // Try environment variables in this order
    const key = apiKey || process.env.API_KEY || process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error('Gemini API key not found. Set GEMINI_API_KEY or API_KEY in environment.');
    }
    this.ai = new GoogleGenAI({ apiKey: key });
  }

  /**
   * Convert a File object to base64 string
   * Gemini API wants audio as base64-encoded data
   */
  private async fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = reader.result as string;
        // Strip the data URL prefix (e.g., "data:audio/mp3;base64,")
        const base64Data = base64String.split(',')[1];
        resolve(base64Data);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /**
   * Process an audio file with Gemini API
   * Returns a fully-formed Conversation object ready for storage/display
   */
  async processAudio(file: File): Promise<Conversation> {
    const base64Audio = await this.fileToBase64(file);

    // gemini-2.5-flash: fast, multimodal, cost-effective
    const model = "gemini-2.5-flash";

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

    const response = await this.ai.models.generateContent({
      model: model,
      contents: {
        parts: [
          { inlineData: { mimeType: file.type || 'audio/mp3', data: base64Audio } },
          { text: prompt }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            speakers: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  name: { type: Type.STRING }
                },
                required: ["id", "name"]
              }
            },
            segments: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  speakerId: { type: Type.STRING },
                  startMs: { type: Type.INTEGER },
                  endMs: { type: Type.INTEGER },
                  text: { type: Type.STRING }
                },
                required: ["speakerId", "startMs", "endMs", "text"]
              }
            },
            terms: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  term: { type: Type.STRING },
                  definition: { type: Type.STRING },
                  aliases: { type: Type.ARRAY, items: { type: Type.STRING } }
                },
                required: ["id", "term", "definition", "aliases"]
              }
            },
            topics: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  startSegmentIndex: { type: Type.INTEGER },
                  endSegmentIndex: { type: Type.INTEGER },
                  type: { type: Type.STRING, enum: ["main", "tangent"] }
                },
                required: ["title", "startSegmentIndex", "endSegmentIndex", "type"]
              }
            },
            people: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  affiliation: { type: Type.STRING }
                },
                required: ["name"]
              }
            }
          },
          required: ["title", "speakers", "segments", "terms", "topics", "people"]
        }
      }
    });

    const jsonText = response.text || "{}";
    // Strip markdown code blocks if Gemini gets creative
    const cleanJson = jsonText.replace(/```json\s*|\s*```/g, "").trim();

    let data: GeminiTranscriptionResponse;
    try {
      data = JSON.parse(cleanJson);
    } catch (e) {
      console.error("Failed to parse Gemini response", e);
      console.error("Raw JSON text:", jsonText);
      throw new Error("Failed to parse AI response: " + (e instanceof Error ? e.message : String(e)));
    }

    // Transform AI response to our internal Conversation model
    return this.transformResponse(data, file);
  }

  /**
   * Transform Gemini's response structure into our Conversation type
   * Handles sorting, ID generation, term occurrence detection, etc.
   */
  private transformResponse(data: GeminiTranscriptionResponse, file: File): Conversation {
    const conversationId = `c_${Date.now()}`;

    // 1. Map Speakers
    const speakers: Record<string, Speaker> = {};
    data.speakers.forEach((s, idx) => {
      speakers[s.id] = {
        speakerId: s.id,
        displayName: s.name,
        colorIndex: idx
      };
    });

    // 2. Prepare raw segments with temp IDs (for topic resolution before sorting)
    let rawSegments = data.segments.map((s, idx) => ({
      tempId: `temp_${idx}`,
      speakerId: s.speakerId,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text
    }));

    // 3. Resolve topics to temp IDs (independent of sort order)
    const rawTopics = data.topics.map((t, idx) => {
      const startSeg = rawSegments[t.startSegmentIndex] || rawSegments[0];
      const endSeg = rawSegments[t.endSegmentIndex] || rawSegments[rawSegments.length - 1];

      return {
        topicId: `top_${idx}`,
        title: t.title,
        type: t.type,
        startSegmentTempId: startSeg.tempId,
        endSegmentTempId: endSeg.tempId
      };
    });

    // 4. Sort segments chronologically (AI might return them out of order)
    rawSegments.sort((a, b) => a.startMs - b.startMs);

    // 5. Assign stable IDs based on sorted order
    const segments = rawSegments.map((s, idx) => ({
      segmentId: `seg_${idx}`,
      tempId: s.tempId,
      index: idx,
      speakerId: s.speakerId,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text
    }));

    // 6. Map terms
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

    // 7. Calculate term occurrences (regex matching against sorted segments)
    const termOccurrences: TermOccurrence[] = [];
    let occCount = 0;

    segments.forEach(seg => {
      Object.values(terms).forEach(term => {
        // Build regex from term + aliases
        const patterns = [term.display, ...term.aliases].map(p =>
          p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
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

    // 8. Finalize topics (map temp IDs back to sorted indices)
    const topics: Topic[] = rawTopics.map(t => {
      const startIndex = segments.findIndex(s => s.tempId === t.startSegmentTempId);
      const endIndex = segments.findIndex(s => s.tempId === t.endSegmentTempId);

      return {
        topicId: t.topicId,
        title: t.title,
        startIndex: startIndex === -1 ? 0 : startIndex,
        endIndex: endIndex === -1 ? 0 : endIndex,
        type: t.type
      };
    });

    // 9. Map people
    const people: Person[] = (data.people || []).map((p, idx) => ({
      personId: `p_${idx}`,
      name: p.name,
      affiliation: p.affiliation
    }));

    // 10. Create blob URL for playback
    const audioUrl = URL.createObjectURL(file);

    // 11. Calculate duration from last segment
    const lastSegment = segments[segments.length - 1];
    const durationMs = lastSegment ? lastSegment.endMs : 0;

    // Clean up temp properties before returning
    const cleanSegments: Segment[] = segments.map(({ tempId, ...rest }: any) => rest as Segment);

    return {
      conversationId,
      title: data.title,
      createdAt: new Date().toISOString(),
      durationMs,
      audioUrl,
      status: 'complete',
      speakers,
      segments: cleanSegments,
      terms,
      termOccurrences,
      topics,
      people
    };
  }
}

// Export a factory function instead of a singleton (API key might change)
export const createTranscriptionService = (apiKey?: string) => new TranscriptionService(apiKey);

// Export a default instance for convenience
export const transcriptionService = new TranscriptionService();
