/**
 * Export Transcript Utility
 *
 * Formats a conversation as clean, readable text and triggers download.
 * Designed for humans - not JSON dumps, actual readable transcripts.
 */

import type { Conversation, Segment, Topic, Term, Person, Speaker } from '@/config/types';

/**
 * Format milliseconds as MM:SS timestamp
 */
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Format duration in human-readable form
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

/**
 * Build the speakers section
 */
function buildSpeakersSection(speakers: Record<string, Speaker>): string {
  const speakerList = Object.values(speakers);
  if (speakerList.length === 0) return '';

  const lines = speakerList.map(s => `• ${s.displayName}`);
  return `SPEAKERS\n${lines.join('\n')}`;
}

/**
 * Build the transcript section with timestamps
 * Groups consecutive segments by speaker for readability
 */
function buildTranscriptSection(
  segments: Segment[],
  speakers: Record<string, Speaker>
): string {
  if (segments.length === 0) return 'TRANSCRIPT\n(No segments)';

  const lines: string[] = [];
  let currentSpeaker = '';
  let currentText: string[] = [];
  let currentStartTime = 0;

  const flushSpeaker = () => {
    if (currentText.length > 0) {
      const timestamp = formatTime(currentStartTime);
      const speakerName = speakers[currentSpeaker]?.displayName || 'Unknown';
      lines.push(`[${timestamp}] ${speakerName}:`);
      lines.push(currentText.join(' '));
      lines.push('');
    }
  };

  for (const segment of segments) {
    if (segment.speakerId !== currentSpeaker) {
      flushSpeaker();
      currentSpeaker = segment.speakerId;
      currentText = [segment.text];
      currentStartTime = segment.startMs;
    } else {
      currentText.push(segment.text);
    }
  }
  flushSpeaker();

  return `TRANSCRIPT\n\n${lines.join('\n')}`;
}

/**
 * Build the topics section with hierarchy
 */
function buildTopicsSection(topics: Topic[], segments: Segment[]): string {
  if (topics.length === 0) return '';

  const getTimestamp = (segmentIndex: number): string => {
    const segment = segments[segmentIndex];
    return segment ? formatTime(segment.startMs) : '??:??';
  };

  const mainTopics = topics.filter(t => t.type === 'main');
  const tangents = topics.filter(t => t.type === 'tangent');

  const lines: string[] = [];
  for (const topic of mainTopics) {
    const start = getTimestamp(topic.startIndex);
    const end = getTimestamp(topic.endIndex);
    lines.push(`• ${topic.title} (${start} - ${end})`);

    // Find tangents for this topic
    const childTangents = tangents.filter(t => t.parentTopicId === topic.topicId);
    for (const tangent of childTangents) {
      const tStart = getTimestamp(tangent.startIndex);
      const tEnd = getTimestamp(tangent.endIndex);
      lines.push(`  └─ ${tangent.title} (${tStart} - ${tEnd})`);
    }
  }

  // Orphan tangents (shouldn't happen, but just in case)
  const orphanTangents = tangents.filter(
    t => !mainTopics.some(m => m.topicId === t.parentTopicId)
  );
  for (const tangent of orphanTangents) {
    const start = getTimestamp(tangent.startIndex);
    const end = getTimestamp(tangent.endIndex);
    lines.push(`• [Tangent] ${tangent.title} (${start} - ${end})`);
  }

  return `TOPICS DISCUSSED\n${lines.join('\n')}`;
}

/**
 * Build the key terms section
 */
function buildTermsSection(terms: Record<string, Term>): string {
  const termList = Object.values(terms);
  if (termList.length === 0) return '';

  const lines = termList.map(term => {
    const aliases = term.aliases.length > 0
      ? `\n  Also known as: ${term.aliases.join(', ')}`
      : '';
    return `• ${term.display}: ${term.definition}${aliases}`;
  });

  return `KEY TERMS\n${lines.join('\n\n')}`;
}

/**
 * Build the people mentioned section
 */
function buildPeopleSection(people: Person[]): string {
  if (people.length === 0) return '';

  const lines = people.map(person => {
    const affiliation = person.affiliation ? ` (${person.affiliation})` : '';
    return `• ${person.name}${affiliation}`;
  });

  return `PEOPLE MENTIONED\n${lines.join('\n')}`;
}

/**
 * Export a conversation as formatted text and trigger download
 */
export function exportTranscript(conversation: Conversation): void {
  const { title, createdAt, durationMs, speakers, segments, topics, terms, people } = conversation;

  const date = new Date(createdAt).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const sections = [
    `${title.toUpperCase()}`,
    `Date: ${date}`,
    `Duration: ${formatDuration(durationMs)}`,
    '',
    '═'.repeat(60),
    '',
    buildSpeakersSection(speakers),
    '',
    '─'.repeat(60),
    '',
    buildTranscriptSection(segments, speakers),
    '─'.repeat(60),
    '',
    buildTopicsSection(topics, segments),
    '',
    buildTermsSection(terms),
    '',
    buildPeopleSection(people),
    '',
    '═'.repeat(60),
    `Exported from Audio Transcript Analysis App`,
    `Conversation ID: ${conversation.conversationId}`
  ].filter(s => s !== undefined);

  const content = sections.join('\n');

  // Trigger download
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  // Clean filename: remove special chars, limit length
  const safeTitle = title
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 50);
  const dateStr = new Date(createdAt).toISOString().split('T')[0];

  link.href = url;
  link.download = `${safeTitle}_${dateStr}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
