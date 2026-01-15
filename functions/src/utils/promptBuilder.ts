/**
 * Prompt Builder for Chat with Conversation
 *
 * Constructs context-rich prompts for Gemini API that include:
 * - Full transcript with speaker attribution and timestamps
 * - Topics, terms, and people mentioned
 * - Strict instructions for timestamp-backed answers
 */

import type { Conversation, Segment, Topic, Term, Person } from '../types';

/**
 * Build a chat prompt that includes full transcript context
 * and requires timestamp citations in responses.
 */
export function buildChatPrompt(conversation: Conversation, userMessage: string): string {
  const { segments, topics, terms, people, speakers } = conversation;

  // Build context sections
  const transcriptContext = buildTranscriptContext(segments, speakers);
  const topicsContext = buildTopicsContext(topics);
  const termsContext = buildTermsContext(terms);
  const peopleContext = buildPeopleContext(people);

  // System instructions for answer format
  const systemInstructions = `You are a helpful assistant analyzing an audio transcript. Your task is to answer questions based ONLY on the information present in the transcript below.

CRITICAL REQUIREMENTS:
1. When answering questions, you MUST cite specific segments by their index number
2. You MUST include the exact timestamp range (startMs and endMs) for each cited segment
3. If the answer cannot be found in the transcript, say "This topic is not mentioned in the transcript"
4. Do NOT make assumptions or provide information not explicitly stated in the transcript
5. When multiple segments support your answer, cite all relevant ones
6. Format citations like: [Segment 5: 1:23-1:45]
7. INLINE SOURCE MARKERS: After each statement that cites a segment, add {{SOURCE_n}} where n is the 0-indexed position of that citation in your response (order of first appearance). For example, if you cite [Segment 5] first and [Segment 12] second:
   "The speaker mentioned X {{SOURCE_0}}. Later they discussed Y {{SOURCE_1}}."
   If you cite the same segment multiple times, use the same source index each time.

TRANSCRIPT CONTEXT:
${transcriptContext}

${topicsContext}
${termsContext}
${peopleContext}

USER QUESTION:
${userMessage}

Please provide a concise answer with timestamp citations. If the question cannot be answered from the transcript, clearly state that.`;

  return systemInstructions;
}

/**
 * Format segments with index, speaker, timestamp, and text
 */
function buildTranscriptContext(
  segments: Segment[],
  speakers: Record<string, { displayName: string }>
): string {
  const lines = segments.map(seg => {
    const speakerName = speakers[seg.speakerId]?.displayName || 'Unknown';
    const startTime = formatTimestamp(seg.startMs);
    const endTime = formatTimestamp(seg.endMs);

    return `[Segment ${seg.index}] ${speakerName} (${startTime} - ${endTime}): ${seg.text}`;
  });

  return `TRANSCRIPT:\n${lines.join('\n')}`;
}

/**
 * Format topics with their segment ranges
 */
function buildTopicsContext(topics: Topic[]): string {
  if (topics.length === 0) {
    return '';
  }

  const lines = topics.map(topic => {
    const typeLabel = topic.type === 'tangent' ? ' (tangent)' : '';
    return `- ${topic.title}${typeLabel} [Segments ${topic.startIndex}-${topic.endIndex}]`;
  });

  return `\nTOPICS DISCUSSED:\n${lines.join('\n')}`;
}

/**
 * Format terms with definitions
 */
function buildTermsContext(terms: Record<string, Term>): string {
  const termsList = Object.values(terms);
  if (termsList.length === 0) {
    return '';
  }

  const lines = termsList.map(term => {
    const aliases = term.aliases.length > 0 ? ` (also: ${term.aliases.join(', ')})` : '';
    return `- ${term.display}${aliases}: ${term.definition}`;
  });

  return `\nKEY TERMS:\n${lines.join('\n')}`;
}

/**
 * Format people mentioned with affiliations
 */
function buildPeopleContext(people: Person[]): string {
  if (people.length === 0) {
    return '';
  }

  const lines = people.map(person => {
    const affiliation = person.affiliation ? ` (${person.affiliation})` : '';
    return `- ${person.name}${affiliation}`;
  });

  return `\nPEOPLE MENTIONED:\n${lines.join('\n')}`;
}

/**
 * Format milliseconds as MM:SS timestamp
 */
function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
