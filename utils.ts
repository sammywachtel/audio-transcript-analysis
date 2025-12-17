import { Conversation, TermOccurrence, Term, Segment, Speaker, Topic, Person } from './types';
import { GoogleGenAI, Type } from "@google/genai";

export const formatTime = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

export const cn = (...classes: (string | undefined | null | false)[]) => {
  return classes.filter(Boolean).join(' ');
};

export const createMockConversation = (file: File): Conversation => {
  return {
    conversationId: `c_${Date.now()}`,
    title: file.name.replace(/\.[^/.]+$/, ""), // Remove extension
    createdAt: new Date().toISOString(),
    durationMs: 12500, // Mock duration
    status: 'complete',
    speakers: {
      'spk_a': { speakerId: 'spk_a', displayName: 'Host', colorIndex: 0 },
      'spk_b': { speakerId: 'spk_b', displayName: 'Guest', colorIndex: 1 },
    },
    terms: {},
    termOccurrences: [],
    topics: [
      { topicId: 'top_new', title: 'Introduction', startIndex: 0, endIndex: 0, type: 'main' }
    ],
    people: [],
    segments: [
      {
        segmentId: 'seg_new_1',
        index: 0,
        speakerId: 'spk_a',
        startMs: 0,
        endMs: 5000,
        text: `This is a generated transcript for the uploaded file "${file.name}".`
      },
      {
        segmentId: 'seg_new_2',
        index: 1,
        speakerId: 'spk_b',
        startMs: 5000,
        endMs: 12500,
        text: "Since this is a client-side demo, we haven't actually processed the audio on a server, but the UI flow is fully functional."
      }
    ]
  };
};

// --- Gemini API Integration ---

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result as string;
      // Remove the data URL prefix (e.g., "data:audio/mp3;base64,")
      const base64Data = base64String.split(',')[1];
      resolve(base64Data);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

interface AIResponse {
  title: string;
  speakers: { id: string; name: string }[];
  segments: { speakerId: string; startMs: number; endMs: number; text: string }[];
  terms: { id: string; term: string; definition: string; aliases: string[] }[];
  topics: { title: string; startSegmentIndex: number; endSegmentIndex: number; type: 'main' | 'tangent' }[];
  people: { name: string; affiliation: string }[];
}

export const processAudioWithGemini = async (file: File): Promise<Conversation> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const base64Audio = await fileToBase64(file);

  // We use gemini-2.5-flash as it is fast, cost-effective, and multimodal (supports audio).
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

  const response = await ai.models.generateContent({
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
  // Remove markdown code blocks if present (just in case)
  const cleanJson = jsonText.replace(/```json\s*|\s*```/g, "").trim();

  let data: AIResponse;

  try {
    data = JSON.parse(cleanJson);
  } catch (e) {
    console.error("Failed to parse Gemini response", e);
    console.error("Raw JSON text:", jsonText);
    throw new Error("Failed to parse AI response: " + (e instanceof Error ? e.message : String(e)));
  }

  // Transform AI response to App Internal State
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

  // 2. Prepare Segments (Order might be random from AI, so we need to sort)
  // First, create intermediate objects with temporary IDs to resolve topics later
  let rawSegments = data.segments.map((s, idx) => ({
    tempId: `temp_${idx}`,
    speakerId: s.speakerId,
    startMs: s.startMs,
    endMs: s.endMs,
    text: s.text
  }));

  // 3. Resolve Topics to temporary Segment IDs (independent of order)
  const rawTopics = data.topics.map((t, idx) => {
    // Safety check for indices
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

  // 4. Sort Segments Chronologically
  rawSegments.sort((a, b) => a.startMs - b.startMs);

  // 5. Finalize Segments (Assign stable IDs and indices based on sorted order)
  const segments = rawSegments.map((s, idx) => ({
    segmentId: `seg_${idx}`, // New stable ID
    tempId: s.tempId, // Keep for mapping back
    index: idx,
    speakerId: s.speakerId,
    startMs: s.startMs,
    endMs: s.endMs,
    text: s.text
  }));

  // 6. Map Terms
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

  // 7. Calculate Term Occurrences (using the sorted segments)
  const termOccurrences: TermOccurrence[] = [];
  let occCount = 0;

  segments.forEach(seg => {
    Object.values(terms).forEach(term => {
      // Create a regex pattern for the term and its aliases
      const patterns = [term.display, ...term.aliases].map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); // Escape regex
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

  // 8. Finalize Topics (Map temp IDs back to new sorted indices)
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

  // 9. Map People
  const people: Person[] = (data.people || []).map((p, idx) => ({
    personId: `p_${idx}`,
    name: p.name,
    affiliation: p.affiliation
  }));

  // Create Blob URL for playback
  const audioUrl = URL.createObjectURL(file);
  // Calculate total duration from last segment
  const lastSegment = segments[segments.length - 1];
  const durationMs = lastSegment ? lastSegment.endMs : 0;

  // Cleanup temp property from segments before returning
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
};
