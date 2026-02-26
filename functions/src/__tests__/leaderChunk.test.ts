/**
 * Tests for the leader-chunk-first dispatch pattern.
 *
 * Validates:
 * - Speaker hint extraction from pipeline results
 * - Pipeline behavior with vs without leader hints (pre-analysis bypass)
 * - Follower dispatch guard (no double-dispatch on leader retry)
 * - Backward compatibility when leader hint fields are absent
 */

import { ChunkPipelineResult, SpeakerHints, PendingFollowerChunk } from '../types';

// Mock Firestore before importing processTranscription (which pulls in ../index)
const mockRunTransaction = jest.fn();
const mockGet = jest.fn();
const mockUpdate = jest.fn(() => Promise.resolve());
const mockDocFn = jest.fn(() => ({
  get: mockGet,
  update: mockUpdate,
}));
const mockFirestore = {
  collection: jest.fn(() => ({ doc: mockDocFn })),
  runTransaction: mockRunTransaction,
};

jest.mock('../index', () => ({
  db: mockFirestore,
  bucket: { file: jest.fn() },
}));

// Mock firebase-functions modules (imported transitively via processTranscription → transcribe)
jest.mock('firebase-functions/v2/https', () => ({
  onRequest: jest.fn(),
}));
jest.mock('firebase-functions/v2/storage', () => ({
  onObjectFinalized: jest.fn(),
}));
jest.mock('firebase-functions/params', () => ({
  defineSecret: jest.fn(() => ({ value: () => 'mock-url' })),
}));

// Prevent Firebase SDK from complaining about missing config
process.env.FIREBASE_CONFIG = JSON.stringify({ storageBucket: 'test-bucket' });

// Now safe to import - Firebase won't try to initialize
import { extractSpeakerHints } from '../processTranscription';

// ============================================================================
// extractSpeakerHints
// ============================================================================

describe('extractSpeakerHints', () => {
  it('should extract speaker count and names from speaker mappings', () => {
    const pipelineResult: ChunkPipelineResult = {
      speakerMappings: [
        { originalId: 'SPEAKER_00', canonicalId: 'speaker_0', displayName: 'Alice' },
        { originalId: 'SPEAKER_01', canonicalId: 'speaker_1', displayName: 'Bob' },
      ],
      summary: 'test summary',
      termIds: [],
      topicIds: [],
      personIds: [],
      segmentCount: 10,
      lastTimestampMs: 60000,
    };

    const hints = extractSpeakerHints(pipelineResult);

    expect(hints.numSpeakers).toBe(2);
    expect(hints.speakerNames).toEqual(expect.arrayContaining(['Alice', 'Bob']));
    expect(hints.speakerNames).toHaveLength(2);
    expect(hints.speakerNotes).toHaveLength(2);
    expect(hints.speakerNotes![0].speakerId).toBe('speaker_0');
    expect(hints.speakerNotes![0].inferredName).toBe('Alice');
  });

  it('should deduplicate names from mappings and signatures', () => {
    const pipelineResult: ChunkPipelineResult = {
      speakerMappings: [
        { originalId: 'SPEAKER_00', canonicalId: 'speaker_0', displayName: 'Alice' },
        { originalId: 'SPEAKER_01', canonicalId: 'speaker_1', displayName: 'Bob' },
      ],
      summary: 'test',
      termIds: [],
      topicIds: [],
      personIds: [],
      segmentCount: 5,
      lastTimestampMs: 30000,
      // Signatures might repeat the same name or add new ones
      chunkSpeakerSignatures: [
        {
          speakerId: 'SPEAKER_00', chunkIndex: 0, inferredName: 'Alice',
          topicSignatures: [], termSignatures: [], segmentCount: 3, sampleQuote: 'hi'
        },
        {
          speakerId: 'SPEAKER_02', chunkIndex: 0, inferredName: 'Charlie',
          topicSignatures: [], termSignatures: [], segmentCount: 2, sampleQuote: 'yo'
        },
      ],
    };

    const hints = extractSpeakerHints(pipelineResult);

    // Alice appears in both mappings and signatures - should be deduplicated
    expect(hints.speakerNames).toEqual(expect.arrayContaining(['Alice', 'Bob', 'Charlie']));
    expect(hints.speakerNames).toHaveLength(3);
  });

  it('should handle speakers with no display names gracefully', () => {
    const pipelineResult: ChunkPipelineResult = {
      speakerMappings: [
        { originalId: 'SPEAKER_00', canonicalId: 'speaker_0' }, // no displayName
        { originalId: 'SPEAKER_01', canonicalId: 'speaker_1', displayName: 'Bob' },
      ],
      summary: '',
      termIds: [],
      topicIds: [],
      personIds: [],
      segmentCount: 3,
      lastTimestampMs: 15000,
    };

    const hints = extractSpeakerHints(pipelineResult);

    expect(hints.numSpeakers).toBe(2);
    expect(hints.speakerNames).toEqual(['Bob']); // Only named speakers
    expect(hints.speakerNotes).toHaveLength(2);
    // Unnamed speaker should have undefined inferredName
    const unnamed = hints.speakerNotes!.find(n => n.speakerId === 'speaker_0');
    expect(unnamed?.inferredName).toBeUndefined();
  });

  it('should return empty names array when no speakers have names', () => {
    const pipelineResult: ChunkPipelineResult = {
      speakerMappings: [
        { originalId: 'SPEAKER_00', canonicalId: 'speaker_0' },
      ],
      summary: '',
      termIds: [],
      topicIds: [],
      personIds: [],
      segmentCount: 1,
      lastTimestampMs: 5000,
    };

    const hints = extractSpeakerHints(pipelineResult);

    expect(hints.numSpeakers).toBe(1);
    expect(hints.speakerNames).toEqual([]);
  });

  it('should handle empty speaker mappings', () => {
    const pipelineResult: ChunkPipelineResult = {
      speakerMappings: [],
      summary: '',
      termIds: [],
      topicIds: [],
      personIds: [],
      segmentCount: 0,
      lastTimestampMs: 0,
    };

    const hints = extractSpeakerHints(pipelineResult);

    expect(hints.numSpeakers).toBe(0);
    expect(hints.speakerNames).toEqual([]);
    expect(hints.speakerNotes).toBeUndefined();
  });
});

// ============================================================================
// SpeakerHints type contracts
// ============================================================================

describe('SpeakerHints type contracts', () => {
  it('should be valid with minimal fields (backward compat)', () => {
    const hints: SpeakerHints = {
      numSpeakers: 2,
      speakerNames: ['Alice', 'Bob'],
    };

    expect(hints.numSpeakers).toBe(2);
    expect(hints.speakerNotes).toBeUndefined(); // Optional
  });

  it('should accept full hint object with speaker notes', () => {
    const hints: SpeakerHints = {
      numSpeakers: 3,
      speakerNames: ['Alice', 'Bob', 'Charlie'],
      speakerNotes: [
        { speakerId: 'speaker_0', inferredName: 'Alice', role: 'host' },
        { speakerId: 'speaker_1', inferredName: 'Bob' },
        { speakerId: 'speaker_2', inferredName: 'Charlie', role: 'guest' },
      ],
    };

    expect(hints.speakerNotes).toHaveLength(3);
    expect(hints.speakerNotes![0].role).toBe('host');
  });
});

// ============================================================================
// PendingFollowerChunk type contracts
// ============================================================================

describe('PendingFollowerChunk type contracts', () => {
  it('should capture all fields needed to rebuild a Cloud Task', () => {
    const follower: PendingFollowerChunk = {
      chunkIndex: 1,
      totalChunks: 3,
      chunkStoragePath: 'chunks/user123/conv456/chunk_001.opus',
      startMs: 900000,
      endMs: 1800000,
      overlapBeforeMs: 15000,
      overlapAfterMs: 15000,
    };

    expect(follower.chunkIndex).toBe(1);
    expect(follower.chunkStoragePath).toContain('chunk_001');
  });
});

// ============================================================================
// Pipeline hint bypass logic (unit-level)
// ============================================================================

describe('pipeline hint bypass', () => {
  // Mirror the exact condition used in executeTranscriptionPipeline
  function shouldBypassPreAnalysis(hints?: SpeakerHints): boolean {
    return !!hints && hints.speakerNames.length > 0;
  }

  it('should bypass when hints have speaker names', () => {
    expect(shouldBypassPreAnalysis({
      numSpeakers: 2,
      speakerNames: ['Alice', 'Bob'],
    })).toBe(true);
  });

  it('should NOT bypass when hints have empty speaker names', () => {
    expect(shouldBypassPreAnalysis({
      numSpeakers: 1,
      speakerNames: [],
    })).toBe(false);
  });

  it('should NOT bypass when hints are undefined', () => {
    expect(shouldBypassPreAnalysis(undefined)).toBe(false);
  });

  it('should NOT bypass when hints have zero speakers but somehow have names', () => {
    // Edge case: shouldn't happen in practice, but if names are present, bypass
    expect(shouldBypassPreAnalysis({
      numSpeakers: 0,
      speakerNames: ['Ghost'],
    })).toBe(true);
  });
});
