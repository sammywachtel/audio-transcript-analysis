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
  userId: string; // Owner's Firebase UID - isolates data per user
  title: string;
  createdAt: string;
  updatedAt: string; // For sync conflict resolution and tracking
  durationMs: number;
  audioUrl?: string; // Added field for real audio playback
  status: 'processing' | 'needs_review' | 'complete' | 'failed';
  speakers: Record<string, Speaker>;
  segments: Segment[];
  terms: Record<string, Term>;
  termOccurrences: TermOccurrence[]; // Flat list for easy lookup
  topics: Topic[];
  people: Person[];
  // Server-side alignment status (set by Cloud Function after WhisperX processing)
  // - 'pending': Alignment not yet attempted (processing)
  // - 'aligned': WhisperX alignment succeeded
  // - 'fallback': WhisperX failed, using Gemini timestamps (may be inaccurate)
  alignmentStatus?: 'pending' | 'aligned' | 'fallback';
  alignmentError?: string; // Error message if alignment failed (for fallback status)

  // Progressive processing status (all optional for backward compatibility)
  processingProgress?: ProcessingProgress;
  processingTimeline?: ProcessingTimeline[];

  // Sync metadata (future use for Firestore sync)
  syncStatus?: 'local_only' | 'synced' | 'pending_upload' | 'conflict';
  lastSyncedAt?: string;
}

export interface PlaybackState {
  isPlaying: boolean;
  currentTimeMs: number;
  durationMs: number;
  playbackRate: number;
}

// User profile stored in Firestore users/{userId} collection
export interface UserProfile {
  userId: string;
  email: string;
  displayName?: string;
  photoURL?: string;
  isAdmin: boolean; // Admin users can access observability dashboard
  createdAt: string;
  lastLoginAt?: string;
}

// Processing step enum for granular status tracking
export enum ProcessingStep {
  PENDING = 'pending',
  UPLOADING = 'uploading',
  TRANSCRIBING = 'transcribing',
  ANALYZING = 'analyzing',
  ALIGNING = 'aligning',
  FINALIZING = 'finalizing',
  COMPLETE = 'complete',
  FAILED = 'failed'
}

// Real-time processing progress for user feedback
export interface ProcessingProgress {
  currentStep: ProcessingStep;
  percentComplete: number; // 0-100
  stepStartedAt?: string; // ISO timestamp
  estimatedRemainingMs?: number;
  errorMessage?: string;
}

// Timeline tracking for performance analysis
export interface ProcessingTimeline {
  stepName: ProcessingStep;
  startedAt: string; // ISO timestamp
  completedAt?: string; // ISO timestamp
  durationMs?: number;
}
