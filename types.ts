export interface Speaker {
  speakerId: string;
  displayName: string;
  colorIndex: number;
}

export interface Term {
  termId: string;
  key: string;
  display: string;
  definition: string;
  aliases: string[];
}

export interface TermOccurrence {
  occurrenceId: string;
  termId: string;
  segmentId: string;
  startChar: number;
  endChar: number;
}

export interface Topic {
  topicId: string;
  title: string;
  startIndex: number; // Segment index
  endIndex: number; // Segment index
  type: 'main' | 'tangent';
  parentTopicId?: string; // For tangents
}

export interface Person {
  personId: string;
  name: string;
  affiliation?: string;
  userNotes?: string;
}

export interface Segment {
  segmentId: string;
  index: number;
  speakerId: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface Conversation {
  conversationId: string;
  title: string;
  createdAt: string;
  durationMs: number;
  audioUrl?: string; // Added field for real audio playback
  status: 'processing' | 'needs_review' | 'complete' | 'failed';
  speakers: Record<string, Speaker>;
  segments: Segment[];
  terms: Record<string, Term>;
  termOccurrences: TermOccurrence[]; // Flat list for easy lookup
  topics: Topic[];
  people: Person[];
}

export interface PlaybackState {
  isPlaying: boolean;
  currentTimeMs: number;
  durationMs: number;
  playbackRate: number;
}
