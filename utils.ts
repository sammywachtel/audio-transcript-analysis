import { Conversation } from './types';

export const formatTime = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

export const cn = (...classes: (string | undefined | null | false)[]) => {
  return classes.filter(Boolean).join(' ');
};

/**
 * Creates a minimal placeholder conversation for upload.
 * Only contains real data (filename, timestamps) - no fake metadata.
 * Cloud Function will populate all actual content after processing.
 */
export const createMockConversation = (file: File): Conversation => {
  return {
    conversationId: `c_${Date.now()}`,
    userId: 'local', // Placeholder - will be set by ConversationContext
    title: file.name.replace(/\.[^/.]+$/, ""), // Real filename without extension
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    durationMs: 0, // Unknown until processed - 0 signals "not yet known"
    status: 'processing', // Will be updated to 'complete' by Cloud Function
    speakers: {}, // Empty - no fake speakers
    terms: {},
    termOccurrences: [],
    topics: [], // Empty - no fake topics
    people: [],
    segments: [], // Empty - no fake segments
    alignmentStatus: 'pending' // Waiting for server-side alignment
  };
};
