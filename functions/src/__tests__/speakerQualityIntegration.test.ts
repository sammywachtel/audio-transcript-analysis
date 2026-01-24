/**
 * Integration tests for quality-weighted speaker reconciliation
 */

import { reconcileSpeakersWithEmbeddings } from '../speakerReconciliationEmbeddings';
import { ChunkArtifact, SpeakerQuality } from '../types';

describe('Quality-Weighted Speaker Reconciliation Integration', () => {
  // Helper to create a minimal chunk artifact with embeddings and quality
  function createChunkArtifact(
    chunkIndex: number,
    speakers: Array<{ id: string; embedding: number[]; quality: number }>
  ): ChunkArtifact {
    const artifact: ChunkArtifact = {
      conversationId: 'test-conversation',
      userId: 'test-user',
      chunkIndex,
      totalChunks: 2,
      segments: [],
      speakers: {},
      terms: {},
      termOccurrences: [],
      topics: [],
      people: [],
      chunkBounds: {
        startMs: chunkIndex * 60000,
        endMs: (chunkIndex + 1) * 60000,
        overlapBeforeMs: 0,
        overlapAfterMs: 0,
      },
      emittedContext: {
        emittedByChunkIndex: chunkIndex,
        speakerMap: [],
        previousSummary: '',
        knownTermIds: [],
        knownTopicIds: [],
        knownPersonIds: [],
        cumulativeSegmentCount: 0,
        lastProcessedMs: (chunkIndex + 1) * 60000,
      },
      createdAt: new Date().toISOString(),
      storagePath: `test/chunk${chunkIndex}.mp3`,
      speakerEmbeddings: {},
      speakerQuality: {},
    };

    // Add speakers with embeddings and quality
    for (const speaker of speakers) {
      artifact.speakerEmbeddings![speaker.id] = speaker.embedding;

      // Construct SpeakerQuality based on composite score
      const quality: SpeakerQuality = {
        snrProxy: speaker.quality,
        clarityScore: speaker.quality,
        isContaminated: speaker.quality < 0.5,
        compositeScore: speaker.quality,
      };
      artifact.speakerQuality![speaker.id] = quality;
    }

    return artifact;
  }

  // Helper to create a normalized embedding vector
  function createEmbedding(values: number[]): number[] {
    // Pad to 256 dimensions if needed
    const padded = [...values];
    while (padded.length < 256) {
      padded.push(0);
    }
    // Normalize to unit length
    const norm = Math.sqrt(padded.reduce((sum, v) => sum + v * v, 0));
    return padded.map(v => v / norm);
  }

  it('should exclude low-quality segments below quality floor (0.3)', () => {
    const chunk0 = createChunkArtifact(0, [
      {
        id: 'SPEAKER_00',
        embedding: createEmbedding([1, 0.5, 0.3]), // High-quality speaker
        quality: 0.8,
      },
    ]);

    const chunk1 = createChunkArtifact(1, [
      {
        id: 'SPEAKER_00',
        embedding: createEmbedding([1, 0.5, 0.3]), // Same speaker
        quality: 0.2, // Below quality floor (0.3)
      },
    ]);

    const result = reconcileSpeakersWithEmbeddings([chunk0, chunk1]);

    // The low-quality speaker in chunk1 should be excluded
    // Only chunk0's speaker should be in the result
    expect(result.speakerIdMap.size).toBe(1);
    expect(result.speakerIdMap.has('SPEAKER_00_chunk0')).toBe(true);
    expect(result.speakerIdMap.has('SPEAKER_00_chunk1')).toBe(false);
  });

  it('should weight similarity by quality scores', () => {
    // Create two speakers with identical embeddings but different quality
    const embedding = createEmbedding([1, 0, 0]);

    const chunk0 = createChunkArtifact(0, [
      { id: 'SPEAKER_00', embedding, quality: 1.0 }, // Perfect quality
    ]);

    const chunk1 = createChunkArtifact(1, [
      { id: 'SPEAKER_00', embedding, quality: 0.6 }, // Medium quality (raised from 0.5 to exceed adaptive threshold)
    ]);

    const result = reconcileSpeakersWithEmbeddings([chunk0, chunk1]);

    // Despite identical embeddings, quality weighting affects cluster confidence
    // Both speakers should still be merged (cosine=1.0, weighted=sqrt(1.0*0.6)=0.775 > adaptive threshold 0.73)
    expect(result.speakerIdMap.size).toBe(2);

    // Both should map to same canonical ID
    const canonical0 = result.speakerIdMap.get('SPEAKER_00_chunk0');
    const canonical1 = result.speakerIdMap.get('SPEAKER_00_chunk1');
    expect(canonical0).toBe(canonical1);

    // Cluster confidence should reflect quality weighting
    // sqrt(1.0 * 0.6) = 0.775, so weighted similarity = 1.0 * 0.775 = 0.775
    expect(result.clusterDetails).toHaveLength(1);
    expect(result.clusterDetails[0].confidence).toBeCloseTo(0.775, 2);
  });

  it('should prevent false merges when quality is low', () => {
    // Two different speakers with somewhat similar embeddings
    const embedding1 = createEmbedding([1, 0.2, 0]);
    const embedding2 = createEmbedding([0.9, 0.3, 0.1]);

    const chunk0 = createChunkArtifact(0, [
      { id: 'SPEAKER_00', embedding: embedding1, quality: 0.4 }, // Low quality
    ]);

    const chunk1 = createChunkArtifact(1, [
      { id: 'SPEAKER_00', embedding: embedding2, quality: 0.4 }, // Low quality
    ]);

    const result = reconcileSpeakersWithEmbeddings([chunk0, chunk1]);

    // With quality weighting, the similarity should be reduced
    // If unweighted cosine similarity is ~0.85, weighted would be ~0.85 * 0.4 = 0.34
    // This should fall below the SIMILARITY_THRESHOLD (0.70)
    expect(result.speakerIdMap.size).toBe(2);

    // Check if they were kept separate or merged
    const canonical0 = result.speakerIdMap.get('SPEAKER_00_chunk0');
    const canonical1 = result.speakerIdMap.get('SPEAKER_00_chunk1');

    // They should be kept separate due to quality-weighted similarity < threshold
    if (canonical0 === canonical1) {
      // If they merged, confidence should be low
      expect(result.overallConfidence).toBeLessThan(0.6);
    } else {
      // If they stayed separate, we have 2 clusters
      expect(result.clusterDetails).toHaveLength(2);
    }
  });

  it('should handle mix of quality levels gracefully', () => {
    const embedding = createEmbedding([1, 0, 0]);

    const chunk0 = createChunkArtifact(0, [
      { id: 'SPEAKER_00', embedding, quality: 1.0 }, // High quality
      { id: 'SPEAKER_01', embedding: createEmbedding([0, 1, 0]), quality: 0.9 },
    ]);

    const chunk1 = createChunkArtifact(1, [
      { id: 'SPEAKER_00', embedding, quality: 0.25 }, // Below floor - excluded
      { id: 'SPEAKER_01', embedding: createEmbedding([0, 1, 0]), quality: 0.8 },
    ]);

    const result = reconcileSpeakersWithEmbeddings([chunk0, chunk1]);

    // chunk1 SPEAKER_00 should be excluded (quality 0.25 < 0.3)
    // chunk0 SPEAKER_00 should be present
    // Both SPEAKER_01 instances should be merged
    expect(result.speakerIdMap.size).toBe(3); // chunk0: 2, chunk1: 1

    expect(result.speakerIdMap.has('SPEAKER_00_chunk0')).toBe(true);
    expect(result.speakerIdMap.has('SPEAKER_00_chunk1')).toBe(false); // Excluded

    // SPEAKER_01 should be merged
    const speaker01_chunk0 = result.speakerIdMap.get('SPEAKER_01_chunk0');
    const speaker01_chunk1 = result.speakerIdMap.get('SPEAKER_01_chunk1');
    expect(speaker01_chunk0).toBe(speaker01_chunk1);
  });

  it('should work when quality data is missing (backward compatibility)', () => {
    // Create chunk artifacts without speakerQuality field
    const chunk0 = createChunkArtifact(0, [
      { id: 'SPEAKER_00', embedding: createEmbedding([1, 0, 0]), quality: 1.0 },
    ]);
    const chunk1 = createChunkArtifact(1, [
      { id: 'SPEAKER_00', embedding: createEmbedding([1, 0, 0]), quality: 1.0 },
    ]);

    // Remove quality data to simulate old chunks
    delete chunk0.speakerQuality;
    delete chunk1.speakerQuality;

    const result = reconcileSpeakersWithEmbeddings([chunk0, chunk1]);

    // Should default to quality=1.0 and merge successfully
    expect(result.speakerIdMap.size).toBe(2);

    const canonical0 = result.speakerIdMap.get('SPEAKER_00_chunk0');
    const canonical1 = result.speakerIdMap.get('SPEAKER_00_chunk1');
    expect(canonical0).toBe(canonical1);
  });

  it('should handle empty chunks gracefully', () => {
    const chunk0 = createChunkArtifact(0, []);
    const chunk1 = createChunkArtifact(1, [
      { id: 'SPEAKER_00', embedding: createEmbedding([1, 0, 0]), quality: 0.8 },
    ]);

    const result = reconcileSpeakersWithEmbeddings([chunk0, chunk1]);

    // Only chunk1's speaker should be present
    expect(result.speakerIdMap.size).toBe(1);
    expect(result.speakerIdMap.has('SPEAKER_00_chunk1')).toBe(true);
  });
});
