/**
 * Tests for chunk merging logic
 *
 * Validates:
 * - Segment deduplication in overlap regions
 * - Speaker mapping reconciliation
 * - Term/topic/person merging with deterministic IDs
 * - Idempotency (already merged = no-op)
 * - Content-based signature quality enrichment flow
 */

import { ChunkArtifact, SpeakerSignature } from '../types';

// Mock Firestore - track the update payload
let lastUpdatePayload: Record<string, unknown> | null = null;
const mockGet = jest.fn();
const mockUpdate = jest.fn((payload: Record<string, unknown>) => {
  lastUpdatePayload = payload;
  return Promise.resolve();
});
const mockQueryGet = jest.fn();

// Each call to doc() returns an object with update/get/collection methods
// We capture the update calls via lastUpdatePayload
const mockDocFn = jest.fn(() => ({
  get: mockGet,
  update: mockUpdate,
  collection: jest.fn(() => ({
    orderBy: jest.fn(() => ({
      get: mockQueryGet
    }))
  }))
}));

const mockFirestore = {
  collection: jest.fn(() => ({
    doc: mockDocFn
  }))
};

// Mock the db instance before importing chunkMerge
jest.mock('../index', () => ({
  db: mockFirestore
}));

// Capture signatures passed to content-based reconcileSpeakers
let capturedSignatures: SpeakerSignature[] | null = null;
const mockReconcileSpeakers = jest.fn((sigs: SpeakerSignature[]) => {
  capturedSignatures = sigs;

  // Build a reasonable mock result based on the input signatures
  // Group signatures by speakerId to simulate basic clustering
  const speakerMap = new Map<string, SpeakerSignature[]>();
  for (const sig of sigs) {
    const existing = speakerMap.get(sig.speakerId) || [];
    existing.push(sig);
    speakerMap.set(sig.speakerId, existing);
  }

  // Create clusters and speakerIdMap
  const speakerIdMap = new Map<string, string>();
  const clusterDetails: Array<{
    canonicalId: string;
    originalIds: string[];
    confidence: number;
    displayName: string;
    matchEvidence: { nameMatches: number; topicOverlap: number; termOverlap: number };
  }> = [];

  let clusterIndex = 0;
  for (const [_speakerId, sigList] of speakerMap) {
    const canonicalId = `speaker_canonical_${clusterIndex}`;
    const originalIds = sigList.map(s => `${s.speakerId}_chunk${s.chunkIndex}`);

    for (const oid of originalIds) {
      speakerIdMap.set(oid, canonicalId);
    }

    clusterDetails.push({
      canonicalId,
      originalIds,
      confidence: 1.0,
      displayName: sigList[0].inferredName || `Speaker ${clusterIndex}`,
      matchEvidence: { nameMatches: 1, topicOverlap: 0, termOverlap: 0 }
    });

    clusterIndex++;
  }

  return {
    speakerIdMap,
    clusterDetails,
    overallConfidence: 1.0
  };
});

// Mock speakerReconciliation module
jest.mock('../speakerReconciliation', () => ({
  reconcileSpeakers: mockReconcileSpeakers
}));

// Mock speakerReconciliationEmbeddings to disable embeddings path and force content-based
jest.mock('../speakerReconciliationEmbeddings', () => ({
  hasValidEmbeddings: () => false,  // Force content-based path
  reconcileSpeakersWithEmbeddings: jest.fn(),
  EmbeddingReconciliationConfig: { CONFIDENCE_THRESHOLD: 0.5 }
}));

// Mock transcribe module to avoid Firebase storage trigger initialization issues
jest.mock('../transcribe', () => ({
  checkAbort: jest.fn().mockResolvedValue(undefined),
  AbortRequestedError: class AbortRequestedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'AbortRequestedError';
    }
  }
}));

// Import after mocking
import { mergeChunks } from '../chunkMerge';

describe('chunkMerge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lastUpdatePayload = null;
    capturedSignatures = null;
  });

  describe('mergeChunks', () => {
    it('should handle idempotency - skip if already merged', async () => {
      const conversationId = 'test-conv-123';

      // Mock conversation with mergedAt already set
      mockGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({
          chunkingMetadata: {
            totalChunks: 2,
            mergedAt: '2024-01-01T00:00:00.000Z'
          }
        })
      });

      await mergeChunks(conversationId);

      // Should check idempotency and return early
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('should deduplicate segments in overlap regions with chunk-local timestamps', async () => {
      const conversationId = 'test-conv-123';

      // Mock conversation without mergedAt
      mockGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({
          userId: 'user-123',
          chunkingMetadata: {
            totalChunks: 2,
            originalStoragePath: 'audio/original.mp3',
            originalDurationMs: 60000
          }
        })
      });

      // Mock chunk artifacts with CHUNK-LOCAL timestamps (start at 0 for each chunk)
      // This is what Gemini actually produces - timestamps relative to chunk audio start
      //
      // Original audio layout:
      //   Chunk 0: covers 0-15000ms of original, with 3s overlap into chunk 1's region
      //   Chunk 1: covers 15000-30000ms of original, with 3s overlap back into chunk 0's region
      //
      // Chunk 0 audio file contains: 0-18000ms of original (logical + overlap after)
      // Chunk 1 audio file contains: 12000-30000ms of original (overlap before + logical)
      //
      // Gemini timestamps are relative to chunk audio file start (always 0)
      const chunk0: ChunkArtifact = {
        conversationId,
        userId: 'user-123',
        chunkIndex: 0,
        totalChunks: 2,
        segments: [
          // All timestamps are chunk-local (relative to chunk audio start)
          { segmentId: 'seg-0', index: 0, speakerId: 'spk-0', startMs: 0, endMs: 5000, text: 'First segment' },
          { segmentId: 'seg-1', index: 1, speakerId: 'spk-0', startMs: 5000, endMs: 10000, text: 'Second segment' },
          { segmentId: 'seg-2', index: 2, speakerId: 'spk-1', startMs: 10000, endMs: 15000, text: 'Third segment' },
          // Overlap region - chunk-local 15000-18000ms = original 15000-18000ms
          // Since chunk0 has no overlapBefore, chunk-local == original for this chunk
          { segmentId: 'seg-3-dup', index: 3, speakerId: 'spk-1', startMs: 15000, endMs: 18000, text: 'Overlap segment from chunk 0' }
        ],
        speakers: { 'spk-0': { speakerId: 'spk-0', displayName: 'Speaker 0', colorIndex: 0 } },
        terms: {},
        termOccurrences: [],
        topics: [],
        people: [],
        chunkBounds: {
          startMs: 0,
          endMs: 15000,
          overlapBeforeMs: 0,
          overlapAfterMs: 3000
        },
        emittedContext: {} as ChunkArtifact['emittedContext'],
        createdAt: '2024-01-01T00:00:00.000Z',
        storagePath: 'chunks/test/0.mp3'
      };

      const chunk1: ChunkArtifact = {
        conversationId,
        userId: 'user-123',
        chunkIndex: 1,
        totalChunks: 2,
        segments: [
          // CRITICAL: These timestamps start at 0 (chunk-local), NOT at original timeline position!
          // Chunk 1 audio starts at original 12000ms (15000 - 3000 overlap)
          // So chunk-local 0ms = original 12000ms
          //
          // Overlap region - chunk-local 0-6000ms maps to original 12000-18000ms
          // This chunk owns the overlap (higher index) so seg-3 should survive
          { segmentId: 'seg-3', index: 0, speakerId: 'spk-1', startMs: 0, endMs: 6000, text: 'Overlap segment from chunk 1' },
          // chunk-local 6000ms = original 18000ms, chunk-local 13000ms = original 25000ms
          { segmentId: 'seg-4', index: 1, speakerId: 'spk-1', startMs: 6000, endMs: 13000, text: 'Fourth segment' },
          // chunk-local 13000ms = original 25000ms, chunk-local 18000ms = original 30000ms
          { segmentId: 'seg-5', index: 2, speakerId: 'spk-0', startMs: 13000, endMs: 18000, text: 'Fifth segment' }
        ],
        speakers: { 'spk-1': { speakerId: 'spk-1', displayName: 'Speaker 1', colorIndex: 1 } },
        terms: {},
        termOccurrences: [],
        topics: [],
        people: [],
        chunkBounds: {
          startMs: 15000,
          endMs: 30000,
          overlapBeforeMs: 3000,
          overlapAfterMs: 0
        },
        emittedContext: {} as ChunkArtifact['emittedContext'],
        createdAt: '2024-01-01T00:00:00.000Z',
        storagePath: 'chunks/test/1.mp3'
      };

      mockQueryGet.mockResolvedValueOnce({
        empty: false,
        docs: [
          { data: () => chunk0 },
          { data: () => chunk1 }
        ]
      });

      await mergeChunks(conversationId);

      // Verify update was called with merged data
      expect(mockUpdate).toHaveBeenCalled();

      // lastUpdatePayload should contain the final update with segments
      expect(lastUpdatePayload).not.toBeNull();
      const segments = lastUpdatePayload!.segments as Array<{ segmentId: string; index: number; startMs: number; endMs: number }>;

      // Should have 6 segments:
      // - seg-0, seg-1, seg-2 from chunk 0 (non-overlapping region)
      // - seg-3 from chunk 1 (chunk 1 wins overlap, seg-3-dup dropped)
      // - seg-4, seg-5 from chunk 1
      expect(segments).toHaveLength(6);

      // Verify seg-3 is from chunk 1 (has the correct text)
      const seg3 = segments.find(s => s.segmentId === 'seg-3');
      expect(seg3).toBeDefined();

      // Verify seg-3-dup was dropped
      const seg3dup = segments.find(s => s.segmentId === 'seg-3-dup');
      expect(seg3dup).toBeUndefined();

      // Verify timestamps were normalized to original timeline
      // seg-3 had chunk-local startMs=0, should now be 12000 (chunk1.startMs - chunk1.overlapBeforeMs)
      expect(seg3!.startMs).toBe(12000);
      expect(seg3!.endMs).toBe(18000);

      // seg-5 had chunk-local startMs=13000, should now be 25000 (12000 + 13000)
      const seg5 = segments.find(s => s.segmentId === 'seg-5');
      expect(seg5!.startMs).toBe(25000);
      expect(seg5!.endMs).toBe(30000);

      // Segments should be reindexed sequentially
      segments.forEach((seg, idx) => {
        expect(seg.index).toBe(idx);
      });
    });

    it('should merge speakers from all chunks', async () => {
      const conversationId = 'test-conv-123';

      mockGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({
          userId: 'user-123',
          processingMode: 'sequential',  // Use sequential to test basic speaker union (no reconciliation)
          chunkingMetadata: {
            totalChunks: 2,
            originalStoragePath: 'audio/original.mp3',
            originalDurationMs: 60000
          }
        })
      });

      const chunk0: ChunkArtifact = {
        conversationId,
        userId: 'user-123',
        chunkIndex: 0,
        totalChunks: 2,
        segments: [
          { segmentId: 'seg-0', index: 0, speakerId: 'spk-0', startMs: 0, endMs: 10000, text: 'Test' }
        ],
        speakers: {
          'spk-0': { speakerId: 'spk-0', displayName: 'Alice', colorIndex: 0 }
        },
        terms: {},
        termOccurrences: [],
        topics: [],
        people: [],
        chunkBounds: { startMs: 0, endMs: 10000, overlapBeforeMs: 0, overlapAfterMs: 0 },
        emittedContext: {} as ChunkArtifact['emittedContext'],
        createdAt: '2024-01-01T00:00:00.000Z',
        storagePath: 'chunks/test/0.mp3'
      };

      const chunk1: ChunkArtifact = {
        conversationId,
        userId: 'user-123',
        chunkIndex: 1,
        totalChunks: 2,
        segments: [
          // Chunk-local timestamps: 0ms in chunk 1 = 10000ms in original
          { segmentId: 'seg-1', index: 0, speakerId: 'spk-1', startMs: 0, endMs: 10000, text: 'Test' }
        ],
        speakers: {
          'spk-1': { speakerId: 'spk-1', displayName: 'Bob', colorIndex: 1 }
        },
        terms: {},
        termOccurrences: [],
        topics: [],
        people: [],
        chunkBounds: { startMs: 10000, endMs: 20000, overlapBeforeMs: 0, overlapAfterMs: 0 },
        emittedContext: {} as ChunkArtifact['emittedContext'],
        createdAt: '2024-01-01T00:00:00.000Z',
        storagePath: 'chunks/test/1.mp3'
      };

      mockQueryGet.mockResolvedValueOnce({
        empty: false,
        docs: [
          { data: () => chunk0 },
          { data: () => chunk1 }
        ]
      });

      await mergeChunks(conversationId);

      // lastUpdatePayload should contain the final update with speakers
      expect(lastUpdatePayload).not.toBeNull();
      const speakers = lastUpdatePayload!.speakers as Record<string, { displayName: string }>;

      // Should have both speakers merged from all chunks
      expect(Object.keys(speakers)).toHaveLength(2);
      expect(speakers['spk-0'].displayName).toBe('Alice');
      expect(speakers['spk-1'].displayName).toBe('Bob');
    });

    it('should merge terms and filter term occurrences for kept segments', async () => {
      const conversationId = 'test-conv-123';

      mockGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({
          userId: 'user-123',
          chunkingMetadata: {
            totalChunks: 2,
            originalStoragePath: 'audio/original.mp3',
            originalDurationMs: 60000
          }
        })
      });

      const chunk0: ChunkArtifact = {
        conversationId,
        userId: 'user-123',
        chunkIndex: 0,
        totalChunks: 2,
        segments: [
          { segmentId: 'seg_0_chunk0', index: 0, speakerId: 'spk-0', startMs: 0, endMs: 10000, text: 'Kubernetes cluster' }
        ],
        speakers: {},
        terms: {
          'term-1': { termId: 'term-1', key: 'kubernetes', display: 'Kubernetes', definition: 'Container orchestration', aliases: ['k8s'] }
        },
        termOccurrences: [
          { occurrenceId: 'occ_0_chunk0', termId: 'term-1', segmentId: 'seg_0_chunk0', startChar: 0, endChar: 10 }
        ],
        topics: [],
        people: [],
        chunkBounds: { startMs: 0, endMs: 10000, overlapBeforeMs: 0, overlapAfterMs: 0 },
        emittedContext: {} as ChunkArtifact['emittedContext'],
        createdAt: '2024-01-01T00:00:00.000Z',
        storagePath: 'chunks/test/0.mp3'
      };

      const chunk1: ChunkArtifact = {
        conversationId,
        userId: 'user-123',
        chunkIndex: 1,
        totalChunks: 2,
        segments: [
          // Chunk-local timestamps: 0ms in chunk 1 = 10000ms in original (chunkBounds.startMs - overlapBeforeMs)
          { segmentId: 'seg_0_chunk1', index: 0, speakerId: 'spk-0', startMs: 0, endMs: 10000, text: 'Docker containers' }
        ],
        speakers: {},
        terms: {
          'term-2': { termId: 'term-2', key: 'docker', display: 'Docker', definition: 'Container platform', aliases: [] }
        },
        termOccurrences: [
          { occurrenceId: 'occ_0_chunk1', termId: 'term-2', segmentId: 'seg_0_chunk1', startChar: 0, endChar: 6 }
        ],
        topics: [],
        people: [],
        chunkBounds: { startMs: 10000, endMs: 20000, overlapBeforeMs: 0, overlapAfterMs: 0 },
        emittedContext: {} as ChunkArtifact['emittedContext'],
        createdAt: '2024-01-01T00:00:00.000Z',
        storagePath: 'chunks/test/1.mp3'
      };

      mockQueryGet.mockResolvedValueOnce({
        empty: false,
        docs: [
          { data: () => chunk0 },
          { data: () => chunk1 }
        ]
      });

      await mergeChunks(conversationId);

      // lastUpdatePayload should contain the final update with terms
      expect(lastUpdatePayload).not.toBeNull();
      const terms = lastUpdatePayload!.terms as Record<string, { key: string }>;
      const termOccurrences = lastUpdatePayload!.termOccurrences as Array<{ occurrenceId: string; segmentId: string; startChar: number; endChar: number }>;

      // Should have both terms
      expect(Object.keys(terms)).toHaveLength(2);
      expect(terms['term-1'].key).toBe('kubernetes');
      expect(terms['term-2'].key).toBe('docker');

      // Should have both occurrences (both segments kept)
      expect(termOccurrences).toHaveLength(2);

      // Verify term occurrences have chunk-aware IDs and correct segment references
      const occ0 = termOccurrences.find(o => o.occurrenceId === 'occ_0_chunk0');
      expect(occ0).toBeDefined();
      expect(occ0!.segmentId).toBe('seg_0_chunk0'); // Chunk-aware segment ID
      expect(occ0!.startChar).toBe(0);
      expect(occ0!.endChar).toBe(10);

      const occ1 = termOccurrences.find(o => o.occurrenceId === 'occ_0_chunk1');
      expect(occ1).toBeDefined();
      expect(occ1!.segmentId).toBe('seg_0_chunk1'); // Chunk-aware segment ID
      expect(occ1!.startChar).toBe(0);
      expect(occ1!.endChar).toBe(6);

      // CRITICAL: Verify substring(startChar, endChar) actually matches the term
      // This is the real test - if offsets are wrong, highlights will show garbage
      const segments = lastUpdatePayload!.segments as Array<{ segmentId: string; text: string }>;

      const seg0 = segments.find(s => s.segmentId === 'seg_0_chunk0')!;
      const highlight0 = seg0.text.substring(occ0!.startChar, occ0!.endChar);
      const term1 = (lastUpdatePayload!.terms as Record<string, { display: string; aliases: string[] }>)['term-1'];
      // Must match display OR one of the aliases
      expect(
        highlight0 === term1.display || term1.aliases.includes(highlight0)
      ).toBe(true);

      const seg1 = segments.find(s => s.segmentId === 'seg_0_chunk1')!;
      const highlight1 = seg1.text.substring(occ1!.startChar, occ1!.endChar);
      const term2 = (lastUpdatePayload!.terms as Record<string, { display: string; aliases: string[] }>)['term-2'];
      expect(
        highlight1 === term2.display || term2.aliases.includes(highlight1)
      ).toBe(true);
    });

    describe('content-based signature quality enrichment', () => {
      it('should populate quality from artifact.speakerQuality[speakerId].compositeScore', async () => {
        const conversationId = 'test-conv-quality';

        // Mock conversation in parallel mode (triggers content-based reconciliation)
        mockGet.mockResolvedValueOnce({
          exists: true,
          data: () => ({
            userId: 'user-123',
            processingMode: 'parallel',
            chunkingMetadata: {
              totalChunks: 2,
              originalStoragePath: 'audio/original.mp3',
              originalDurationMs: 60000
            }
          })
        });

        // Create chunk artifacts with speakerQuality data
        // Chunk 0: SPEAKER_00 has quality data
        // Chunk 1: SPEAKER_00 has quality data, SPEAKER_01 is MISSING quality
        const chunk0: ChunkArtifact = {
          conversationId,
          userId: 'user-123',
          chunkIndex: 0,
          totalChunks: 2,
          segments: [
            { segmentId: 'seg-0', index: 0, speakerId: 'SPEAKER_00', startMs: 0, endMs: 10000, text: 'Hello from chunk 0' }
          ],
          speakers: {
            'SPEAKER_00': { speakerId: 'SPEAKER_00', displayName: 'Alice', colorIndex: 0 }
          },
          terms: {},
          termOccurrences: [],
          topics: [],
          people: [],
          chunkBounds: { startMs: 0, endMs: 15000, overlapBeforeMs: 0, overlapAfterMs: 0 },
          emittedContext: {} as ChunkArtifact['emittedContext'],
          createdAt: '2024-01-01T00:00:00.000Z',
          storagePath: 'chunks/test/0.mp3',
          // The key data: chunkSpeakerSignatures with NO quality field (should be enriched)
          chunkSpeakerSignatures: [
            {
              speakerId: 'SPEAKER_00',
              chunkIndex: 0,
              inferredName: 'Alice',
              topicSignatures: [],
              termSignatures: [],
              segmentCount: 1,
              sampleQuote: 'Hello from chunk 0'
              // quality is UNDEFINED - should be enriched from speakerQuality
            }
          ],
          // speakerQuality with compositeScore = 0.85 for SPEAKER_00
          speakerQuality: {
            'SPEAKER_00': {
              snrProxy: 0.9,
              clarityScore: 0.8,
              isContaminated: false,
              compositeScore: 0.85
            }
          }
        };

        const chunk1: ChunkArtifact = {
          conversationId,
          userId: 'user-123',
          chunkIndex: 1,
          totalChunks: 2,
          segments: [
            { segmentId: 'seg-1', index: 0, speakerId: 'SPEAKER_00', startMs: 0, endMs: 10000, text: 'Hello from chunk 1' },
            { segmentId: 'seg-2', index: 1, speakerId: 'SPEAKER_01', startMs: 10000, endMs: 15000, text: 'I have no quality data' }
          ],
          speakers: {
            'SPEAKER_00': { speakerId: 'SPEAKER_00', displayName: 'Alice', colorIndex: 0 },
            'SPEAKER_01': { speakerId: 'SPEAKER_01', displayName: 'Bob', colorIndex: 1 }
          },
          terms: {},
          termOccurrences: [],
          topics: [],
          people: [],
          chunkBounds: { startMs: 15000, endMs: 30000, overlapBeforeMs: 0, overlapAfterMs: 0 },
          emittedContext: {} as ChunkArtifact['emittedContext'],
          createdAt: '2024-01-01T00:00:00.000Z',
          storagePath: 'chunks/test/1.mp3',
          // Signatures without quality
          chunkSpeakerSignatures: [
            {
              speakerId: 'SPEAKER_00',
              chunkIndex: 1,
              inferredName: 'Alice',
              topicSignatures: [],
              termSignatures: [],
              segmentCount: 1,
              sampleQuote: 'Hello from chunk 1'
            },
            {
              speakerId: 'SPEAKER_01',
              chunkIndex: 1,
              inferredName: 'Bob',
              topicSignatures: [],
              termSignatures: [],
              segmentCount: 1,
              sampleQuote: 'I have no quality data'
            }
          ],
          // speakerQuality only has SPEAKER_00, SPEAKER_01 is missing
          speakerQuality: {
            'SPEAKER_00': {
              snrProxy: 0.7,
              clarityScore: 0.75,
              isContaminated: false,
              compositeScore: 0.72
            }
            // SPEAKER_01 is intentionally MISSING - should default to 1.0
          }
        };

        mockQueryGet.mockResolvedValueOnce({
          empty: false,
          docs: [
            { data: () => chunk0 },
            { data: () => chunk1 }
          ]
        });

        // Execute merge (will call content-based reconcileSpeakers)
        await mergeChunks(conversationId);

        // Verify reconcileSpeakers was called with enriched signatures
        expect(mockReconcileSpeakers).toHaveBeenCalled();
        expect(capturedSignatures).not.toBeNull();
        expect(capturedSignatures).toHaveLength(3); // 1 from chunk0, 2 from chunk1

        // Find each signature and verify quality
        const sig0_chunk0 = capturedSignatures!.find(
          s => s.speakerId === 'SPEAKER_00' && s.chunkIndex === 0
        );
        const sig0_chunk1 = capturedSignatures!.find(
          s => s.speakerId === 'SPEAKER_00' && s.chunkIndex === 1
        );
        const sig1_chunk1 = capturedSignatures!.find(
          s => s.speakerId === 'SPEAKER_01' && s.chunkIndex === 1
        );

        // CRITICAL: All signatures must have quality defined (not undefined)
        expect(sig0_chunk0).toBeDefined();
        expect(sig0_chunk1).toBeDefined();
        expect(sig1_chunk1).toBeDefined();

        expect(sig0_chunk0!.quality).toBeDefined();
        expect(sig0_chunk1!.quality).toBeDefined();
        expect(sig1_chunk1!.quality).toBeDefined();

        // Verify quality values
        // SPEAKER_00 chunk0: compositeScore = 0.85
        expect(sig0_chunk0!.quality).toBe(0.85);
        // SPEAKER_00 chunk1: compositeScore = 0.72
        expect(sig0_chunk1!.quality).toBe(0.72);
        // SPEAKER_01 chunk1: no speakerQuality entry, should default to 1.0
        expect(sig1_chunk1!.quality).toBe(1.0);
      });

      it('should default quality to 1.0 when speakerQuality is completely missing', async () => {
        const conversationId = 'test-conv-no-quality';

        mockGet.mockResolvedValueOnce({
          exists: true,
          data: () => ({
            userId: 'user-123',
            processingMode: 'parallel',
            chunkingMetadata: {
              totalChunks: 1,
              originalStoragePath: 'audio/original.mp3',
              originalDurationMs: 30000
            }
          })
        });

        // Chunk with NO speakerQuality at all
        const chunk0: ChunkArtifact = {
          conversationId,
          userId: 'user-123',
          chunkIndex: 0,
          totalChunks: 1,
          segments: [
            { segmentId: 'seg-0', index: 0, speakerId: 'SPEAKER_00', startMs: 0, endMs: 10000, text: 'Test' }
          ],
          speakers: {
            'SPEAKER_00': { speakerId: 'SPEAKER_00', displayName: 'Test', colorIndex: 0 }
          },
          terms: {},
          termOccurrences: [],
          topics: [],
          people: [],
          chunkBounds: { startMs: 0, endMs: 30000, overlapBeforeMs: 0, overlapAfterMs: 0 },
          emittedContext: {} as ChunkArtifact['emittedContext'],
          createdAt: '2024-01-01T00:00:00.000Z',
          storagePath: 'chunks/test/0.mp3',
          chunkSpeakerSignatures: [
            {
              speakerId: 'SPEAKER_00',
              chunkIndex: 0,
              inferredName: 'Test',
              topicSignatures: [],
              termSignatures: [],
              segmentCount: 1,
              sampleQuote: 'Test'
            }
          ]
          // NOTE: speakerQuality is completely ABSENT
        };

        mockQueryGet.mockResolvedValueOnce({
          empty: false,
          docs: [{ data: () => chunk0 }]
        });

        // Single-chunk files skip reconciliation, so we need 2+ chunks
        // Actually looking at chunkMerge.ts:416-452, single-chunk skips reconcileSpeakers
        // Let's use a 2-chunk scenario instead
        const chunk1: ChunkArtifact = {
          ...chunk0,
          chunkIndex: 1,
          segments: [
            { segmentId: 'seg-1', index: 0, speakerId: 'SPEAKER_00', startMs: 0, endMs: 10000, text: 'Test 2' }
          ],
          chunkBounds: { startMs: 30000, endMs: 60000, overlapBeforeMs: 0, overlapAfterMs: 0 },
          storagePath: 'chunks/test/1.mp3',
          chunkSpeakerSignatures: [
            {
              speakerId: 'SPEAKER_00',
              chunkIndex: 1,
              inferredName: 'Test',
              topicSignatures: [],
              termSignatures: [],
              segmentCount: 1,
              sampleQuote: 'Test 2'
            }
          ]
          // Still no speakerQuality
        };

        // Re-mock for 2 chunks
        mockGet.mockReset();
        mockQueryGet.mockReset();
        mockGet.mockResolvedValueOnce({
          exists: true,
          data: () => ({
            userId: 'user-123',
            processingMode: 'parallel',
            chunkingMetadata: {
              totalChunks: 2,
              originalStoragePath: 'audio/original.mp3',
              originalDurationMs: 60000
            }
          })
        });
        mockQueryGet.mockResolvedValueOnce({
          empty: false,
          docs: [
            { data: () => ({ ...chunk0, totalChunks: 2 }) },
            { data: () => ({ ...chunk1, totalChunks: 2 }) }
          ]
        });

        await mergeChunks(conversationId);

        expect(mockReconcileSpeakers).toHaveBeenCalled();
        expect(capturedSignatures).not.toBeNull();

        // All signatures should have quality = 1.0 (default)
        for (const sig of capturedSignatures!) {
          expect(sig.quality).toBeDefined();
          expect(sig.quality).toBe(1.0);
        }
      });

      it('should preserve existing quality if already set on signature', async () => {
        const conversationId = 'test-conv-preserve';

        mockGet.mockResolvedValueOnce({
          exists: true,
          data: () => ({
            userId: 'user-123',
            processingMode: 'parallel',
            chunkingMetadata: {
              totalChunks: 2,
              originalStoragePath: 'audio/original.mp3',
              originalDurationMs: 60000
            }
          })
        });

        // Chunk with signature that ALREADY has quality set
        const chunk0: ChunkArtifact = {
          conversationId,
          userId: 'user-123',
          chunkIndex: 0,
          totalChunks: 2,
          segments: [
            { segmentId: 'seg-0', index: 0, speakerId: 'SPEAKER_00', startMs: 0, endMs: 10000, text: 'Test' }
          ],
          speakers: {
            'SPEAKER_00': { speakerId: 'SPEAKER_00', displayName: 'Test', colorIndex: 0 }
          },
          terms: {},
          termOccurrences: [],
          topics: [],
          people: [],
          chunkBounds: { startMs: 0, endMs: 30000, overlapBeforeMs: 0, overlapAfterMs: 0 },
          emittedContext: {} as ChunkArtifact['emittedContext'],
          createdAt: '2024-01-01T00:00:00.000Z',
          storagePath: 'chunks/test/0.mp3',
          chunkSpeakerSignatures: [
            {
              speakerId: 'SPEAKER_00',
              chunkIndex: 0,
              inferredName: 'Test',
              topicSignatures: [],
              termSignatures: [],
              segmentCount: 1,
              sampleQuote: 'Test',
              quality: 0.42  // ALREADY SET - should be preserved
            }
          ],
          speakerQuality: {
            'SPEAKER_00': {
              snrProxy: 0.9,
              clarityScore: 0.9,
              isContaminated: false,
              compositeScore: 0.95  // Different from sig.quality - should NOT override
            }
          }
        };

        const chunk1: ChunkArtifact = {
          ...chunk0,
          chunkIndex: 1,
          chunkBounds: { startMs: 30000, endMs: 60000, overlapBeforeMs: 0, overlapAfterMs: 0 },
          storagePath: 'chunks/test/1.mp3',
          chunkSpeakerSignatures: [
            {
              speakerId: 'SPEAKER_00',
              chunkIndex: 1,
              inferredName: 'Test',
              topicSignatures: [],
              termSignatures: [],
              segmentCount: 1,
              sampleQuote: 'Test chunk 1'
              // NO quality - should get from speakerQuality
            }
          ]
        };

        mockQueryGet.mockResolvedValueOnce({
          empty: false,
          docs: [
            { data: () => chunk0 },
            { data: () => chunk1 }
          ]
        });

        await mergeChunks(conversationId);

        expect(capturedSignatures).not.toBeNull();

        const sig_chunk0 = capturedSignatures!.find(s => s.chunkIndex === 0);
        const sig_chunk1 = capturedSignatures!.find(s => s.chunkIndex === 1);

        // Chunk 0: quality was already 0.42, should be preserved (NOT overwritten by 0.95)
        expect(sig_chunk0!.quality).toBe(0.42);
        // Chunk 1: quality was undefined, should be populated from speakerQuality (0.95)
        expect(sig_chunk1!.quality).toBe(0.95);
      });
    });

    it('should throw error if conversation not found', async () => {
      mockGet.mockResolvedValueOnce({
        exists: false
      });

      await expect(mergeChunks('nonexistent')).rejects.toThrow('Conversation nonexistent not found');
    });

    it('should throw error if no chunking metadata', async () => {
      mockGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({
          userId: 'user-123'
          // No chunkingMetadata
        })
      });

      await expect(mergeChunks('test-conv')).rejects.toThrow('No chunking metadata');
    });

    it('should throw error if missing chunks', async () => {
      mockGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({
          userId: 'user-123',
          chunkingMetadata: {
            totalChunks: 3,
            originalStoragePath: 'audio/original.mp3'
          }
        })
      });

      // Only return 2 chunks instead of 3
      mockQueryGet.mockResolvedValueOnce({
        empty: false,
        docs: [
          { data: () => ({ chunkIndex: 0 } as ChunkArtifact) },
          { data: () => ({ chunkIndex: 1 } as ChunkArtifact) }
        ]
      });

      await expect(mergeChunks('test-conv')).rejects.toThrow('Missing chunks: expected 3, found 2');
    });
  });
});
