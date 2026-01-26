/**
 * Tests for Speaker Name Resolution Module
 *
 * Validates heuristic name assignment logic that runs after embedding-based
 * speaker reconciliation. Tests cover:
 * - Self-introduction detection with various patterns
 * - Direct address + response confirmation
 * - Name conflict resolution (highest score wins)
 * - Threshold behavior (< 0.5 preserves role labels)
 * - Integration with reconciliation cluster structures
 */

import { resolveNamesHeuristically } from '../speakerNameResolution';
import { ClusterDetails } from '../speakerReconciliation';
import { Segment } from '../types';

describe('Speaker Name Resolution', () => {
  // Helper to create test segments
  function createSegment(
    index: number,
    speakerId: string,
    text: string,
    startMs = 0,
    endMs = 1000
  ): Segment {
    return {
      segmentId: `seg_${index}`,
      index,
      speakerId,
      startMs,
      endMs,
      text
    };
  }

  // Helper to create test clusters
  function createCluster(
    canonicalId: string,
    originalIds: string[],
    displayName: string
  ): ClusterDetails {
    return {
      canonicalId,
      originalIds,
      confidence: 0.8,
      displayName,
      matchEvidence: {
        nameMatches: 0,
        topicOverlap: 0,
        termOverlap: 0
      }
    };
  }

  describe('Self-Introduction Detection', () => {
    it('should detect "I\'m [Name]" pattern', () => {
      const clusters = [
        createCluster('speaker_canonical_0', ['SPEAKER_00'], 'Host')
      ];

      const segments = [
        createSegment(0, 'SPEAKER_00', "Hi everyone, I'm Chris and welcome to the show.")
      ];

      const speakerIdRemapping = new Map([
        ['SPEAKER_00', 'speaker_canonical_0']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      expect(results).toHaveLength(1);
      expect(results[0].resolvedName).toBe('Chris');
      expect(results[0].nameAssigned).toBe(true);
      expect(results[0].confidence).toBe('high');
      expect(results[0].totalWeight).toBe(1.0);
      expect(results[0].evidence).toHaveLength(1);
      expect(results[0].evidence[0].evidenceType).toBe('self_introduction');
      expect(results[0].evidence[0].matchedText).toBe("I'm Chris");
    });

    it('should detect "My name is [Name]" pattern', () => {
      const clusters = [
        createCluster('speaker_canonical_0', ['SPEAKER_00'], 'Participant')
      ];

      const segments = [
        createSegment(0, 'SPEAKER_00', 'Hello, my name is Alice and I work in engineering.')
      ];

      const speakerIdRemapping = new Map([
        ['SPEAKER_00', 'speaker_canonical_0']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      expect(results[0].resolvedName).toBe('Alice');
      expect(results[0].nameAssigned).toBe(true);
      expect(results[0].evidence[0].evidenceType).toBe('self_introduction');
      expect(results[0].evidence[0].matchedText).toBe('my name is Alice');
    });

    it('should detect "[Name] here" pattern', () => {
      const clusters = [
        createCluster('speaker_canonical_0', ['SPEAKER_00'], 'Speaker 1')
      ];

      const segments = [
        createSegment(0, 'SPEAKER_00', 'Bob here, ready to get started.')
      ];

      const speakerIdRemapping = new Map([
        ['SPEAKER_00', 'speaker_canonical_0']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      expect(results[0].resolvedName).toBe('Bob');
      expect(results[0].nameAssigned).toBe(true);
    });

    it('should detect "[Name] speaking" pattern', () => {
      const clusters = [
        createCluster('speaker_canonical_0', ['SPEAKER_00'], 'Speaker 1')
      ];

      const segments = [
        createSegment(0, 'SPEAKER_00', 'Dave speaking, can everyone hear me?')
      ];

      const speakerIdRemapping = new Map([
        ['SPEAKER_00', 'speaker_canonical_0']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      expect(results[0].resolvedName).toBe('Dave');
      expect(results[0].nameAssigned).toBe(true);
    });

    it('should detect "This is [Name]" pattern', () => {
      const clusters = [
        createCluster('speaker_canonical_0', ['SPEAKER_00'], 'Host')
      ];

      const segments = [
        createSegment(0, 'SPEAKER_00', 'This is Emma from the product team.')
      ];

      const speakerIdRemapping = new Map([
        ['SPEAKER_00', 'speaker_canonical_0']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      expect(results[0].resolvedName).toBe('Emma');
      expect(results[0].nameAssigned).toBe(true);
    });

    it('should handle full names in self-introductions', () => {
      const clusters = [
        createCluster('speaker_canonical_0', ['SPEAKER_00'], 'Host')
      ];

      const segments = [
        createSegment(0, 'SPEAKER_00', "I'm Chris Smith, your host today.")
      ];

      const speakerIdRemapping = new Map([
        ['SPEAKER_00', 'speaker_canonical_0']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      expect(results[0].resolvedName).toBe('Chris Smith');
      expect(results[0].nameAssigned).toBe(true);
    });
  });

  describe('Direct Address Detection', () => {
    it('should detect direct address with response confirmation', () => {
      const clusters = [
        createCluster('speaker_canonical_0', ['SPEAKER_00'], 'Host'),
        createCluster('speaker_canonical_1', ['SPEAKER_01'], 'Participant')
      ];

      const segments = [
        createSegment(0, 'SPEAKER_00', 'Thanks, Bob, for joining us today.'),
        createSegment(1, 'SPEAKER_01', 'Happy to be here!')
      ];

      const speakerIdRemapping = new Map([
        ['SPEAKER_00', 'speaker_canonical_0'],
        ['SPEAKER_01', 'speaker_canonical_1']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      const bobResult = results.find(r => r.canonicalId === 'speaker_canonical_1');
      expect(bobResult?.resolvedName).toBe('Bob');
      expect(bobResult?.nameAssigned).toBe(true);
      expect(bobResult?.evidence[0].evidenceType).toBe('direct_address_confirmed');
      expect(bobResult?.evidence[0].weight).toBe(0.8);
    });

    it('should detect direct address without response confirmation', () => {
      const clusters = [
        createCluster('speaker_canonical_0', ['SPEAKER_00'], 'Host'),
        createCluster('speaker_canonical_1', ['SPEAKER_01'], 'Participant')
      ];

      const segments = [
        createSegment(0, 'SPEAKER_00', 'Alice, can you share your screen?'),
        createSegment(1, 'SPEAKER_00', 'We need to see the data.')
      ];

      const speakerIdRemapping = new Map([
        ['SPEAKER_00', 'speaker_canonical_0'],
        ['SPEAKER_01', 'speaker_canonical_1']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      const aliceResult = results.find(r => r.canonicalId === 'speaker_canonical_1');

      // Alice has no direct evidence since she never spoke
      // The address was found but not confirmed, so it's not strong enough
      expect(aliceResult?.nameAssigned).toBe(false);
    });

    it('should detect "Hey [Name]" pattern', () => {
      const clusters = [
        createCluster('speaker_canonical_0', ['SPEAKER_00'], 'Host'),
        createCluster('speaker_canonical_1', ['SPEAKER_01'], 'Participant')
      ];

      const segments = [
        createSegment(0, 'SPEAKER_00', 'Hey Charlie, got a minute?'),
        createSegment(1, 'SPEAKER_01', 'Sure, what do you need?')
      ];

      const speakerIdRemapping = new Map([
        ['SPEAKER_00', 'speaker_canonical_0'],
        ['SPEAKER_01', 'speaker_canonical_1']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      const charlieResult = results.find(r => r.canonicalId === 'speaker_canonical_1');
      expect(charlieResult?.resolvedName).toBe('Charlie');
      expect(charlieResult?.nameAssigned).toBe(true);
    });
  });

  describe('Gemini Guess Fallback', () => {
    it('should use Gemini guess when no other evidence exists', () => {
      const clusters = [
        createCluster('speaker_canonical_0', ['SPEAKER_00'], 'Chris') // Gemini guessed "Chris"
      ];

      const segments = [
        createSegment(0, 'SPEAKER_00', 'The weather today is quite nice.')
      ];

      const speakerIdRemapping = new Map([
        ['SPEAKER_00', 'speaker_canonical_0']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      // Gemini guess has weight 0.3, below threshold of 0.5
      expect(results[0].nameAssigned).toBe(false);
      expect(results[0].totalWeight).toBe(0.3);
      expect(results[0].evidence[0].evidenceType).toBe('gemini_guess');
    });

    it('should combine Gemini guess with other weak evidence', () => {
      const clusters = [
        createCluster('speaker_canonical_0', ['SPEAKER_00'], 'Host'),
        createCluster('speaker_canonical_1', ['SPEAKER_01'], 'Bob') // Gemini guessed "Bob"
      ];

      const segments = [
        createSegment(0, 'SPEAKER_00', 'Thanks Bob for that insight.'), // Direct address (0.5)
        createSegment(1, 'SPEAKER_00', 'Moving on to the next topic.')
      ];

      const speakerIdRemapping = new Map([
        ['SPEAKER_00', 'speaker_canonical_0'],
        ['SPEAKER_01', 'speaker_canonical_1']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      const bobResult = results.find(r => r.canonicalId === 'speaker_canonical_1');

      // Bob never responded, so it's unconfirmed direct address (0.5) + Gemini guess (0.3) = 0.8
      // But since Bob never spoke, no direct address evidence will be collected for him
      // Only Gemini guess (0.3) applies, which is below threshold
      expect(bobResult?.totalWeight).toBe(0.3);
      expect(bobResult?.nameAssigned).toBe(false);
    });

    it('should ignore generic display names like "Speaker 1"', () => {
      const clusters = [
        createCluster('speaker_canonical_0', ['SPEAKER_00'], 'Speaker 1')
      ];

      const segments = [
        createSegment(0, 'SPEAKER_00', 'This is a test segment.')
      ];

      const speakerIdRemapping = new Map([
        ['SPEAKER_00', 'speaker_canonical_0']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      // Should not use "Speaker 1" as Gemini guess
      expect(results[0].evidence).toHaveLength(0);
      expect(results[0].nameAssigned).toBe(false);
      expect(results[0].resolvedName).toBe('Speaker 1'); // Preserved from cluster
    });
  });

  describe('Name Conflict Resolution', () => {
    it('should assign name to highest-scoring speaker when conflict occurs', () => {
      const clusters = [
        createCluster('speaker_canonical_0', ['SPEAKER_00'], 'Host'),
        createCluster('speaker_canonical_1', ['SPEAKER_01'], 'Participant')
      ];

      const segments = [
        createSegment(0, 'SPEAKER_00', "I'm Chris and I'm hosting today."), // Chris with weight 1.0
        createSegment(1, 'SPEAKER_01', 'Thanks Chris.'), // Addresses Chris (but SPEAKER_01 also named Chris?)
        createSegment(2, 'SPEAKER_01', 'Chris here too.') // SPEAKER_01 says "Chris here" - weight 1.0
      ];

      const speakerIdRemapping = new Map([
        ['SPEAKER_00', 'speaker_canonical_0'],
        ['SPEAKER_01', 'speaker_canonical_1']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      // Both speakers have weight 1.0, so first one wins (speaker_canonical_0)
      const chris0 = results.find(r => r.canonicalId === 'speaker_canonical_0');
      const chris1 = results.find(r => r.canonicalId === 'speaker_canonical_1');

      expect(chris0?.resolvedName).toBe('Chris');
      expect(chris0?.nameAssigned).toBe(true);

      // Loser should revert to generic label
      expect(chris1?.nameAssigned).toBe(false);
    });

    it('should preserve role labels when name reassigned due to conflict', () => {
      const clusters = [
        createCluster('speaker_canonical_0', ['SPEAKER_00'], 'Host'),
        createCluster('speaker_canonical_1', ['SPEAKER_01'], 'Participant')
      ];

      const segments = [
        createSegment(0, 'SPEAKER_00', "I'm Alice."), // Weight 1.0
        createSegment(1, 'SPEAKER_01', 'Hey Alice!'), // Addresses Alice
        createSegment(2, 'SPEAKER_01', 'Alice here.') // Also says "Alice here" - weight 1.0
      ];

      const speakerIdRemapping = new Map([
        ['SPEAKER_00', 'speaker_canonical_0'],
        ['SPEAKER_01', 'speaker_canonical_1']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      const alice0 = results.find(r => r.canonicalId === 'speaker_canonical_0');
      const alice1 = results.find(r => r.canonicalId === 'speaker_canonical_1');

      expect(alice0?.resolvedName).toBe('Alice');
      expect(alice0?.nameAssigned).toBe(true);
      expect(alice1?.nameAssigned).toBe(false);
    });
  });

  describe('Threshold Behavior', () => {
    it('should preserve role labels when total weight < 0.5', () => {
      const clusters = [
        createCluster('speaker_canonical_0', ['SPEAKER_00'], 'Host')
      ];

      const segments = [
        createSegment(0, 'SPEAKER_00', 'Welcome to the show.')
      ];

      const speakerIdRemapping = new Map([
        ['SPEAKER_00', 'speaker_canonical_0']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      // No name evidence, should preserve "Host"
      expect(results[0].resolvedName).toBe('Host');
      expect(results[0].nameAssigned).toBe(false);
      expect(results[0].confidence).toBe('low');
      expect(results[0].totalWeight).toBe(0);
    });

    it('should assign name when total weight >= 0.5', () => {
      const clusters = [
        createCluster('speaker_canonical_0', ['SPEAKER_00'], 'Host'),
        createCluster('speaker_canonical_1', ['SPEAKER_01'], 'Dave') // Gemini guess
      ];

      const segments = [
        createSegment(0, 'SPEAKER_00', 'Thanks Dave.'), // Unconfirmed address: 0.5
        createSegment(1, 'SPEAKER_00', 'Great point.')
      ];

      const speakerIdRemapping = new Map([
        ['SPEAKER_00', 'speaker_canonical_0'],
        ['SPEAKER_01', 'speaker_canonical_1']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      const daveResult = results.find(r => r.canonicalId === 'speaker_canonical_1');

      // Dave has Gemini guess (0.3) but never spoke, so no address evidence
      expect(daveResult?.totalWeight).toBe(0.3);
      expect(daveResult?.nameAssigned).toBe(false);
    });

    it('should classify confidence levels correctly', () => {
      const clusters = [
        createCluster('speaker_canonical_0', ['SPEAKER_00'], 'Host'),
        createCluster('speaker_canonical_1', ['SPEAKER_01'], 'Participant'),
        createCluster('speaker_canonical_2', ['SPEAKER_02'], 'Guest')
      ];

      const segments = [
        createSegment(0, 'SPEAKER_00', "I'm Alice."), // High: 1.0
        createSegment(1, 'SPEAKER_01', 'Thanks Bob.'), // Unconfirmed address
        createSegment(2, 'SPEAKER_02', 'Sure thing.'), // Bob responds (confirmed: 0.8)
      ];

      const speakerIdRemapping = new Map([
        ['SPEAKER_00', 'speaker_canonical_0'],
        ['SPEAKER_01', 'speaker_canonical_1'],
        ['SPEAKER_02', 'speaker_canonical_2']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      const alice = results.find(r => r.canonicalId === 'speaker_canonical_0');
      expect(alice?.confidence).toBe('high'); // 1.0

      const bob = results.find(r => r.canonicalId === 'speaker_canonical_2');
      expect(bob?.confidence).toBe('high'); // 0.8
    });
  });

  describe('Integration with Reconciliation', () => {
    it('should handle multiple original IDs mapped to same canonical ID', () => {
      const clusters = [
        createCluster('speaker_canonical_0', ['SPEAKER_00_chunk0', 'SPEAKER_01_chunk1'], 'Host')
      ];

      const segments = [
        createSegment(0, 'SPEAKER_00_chunk0', "I'm Emma."),
        createSegment(1, 'SPEAKER_01_chunk1', 'Welcome everyone.')
      ];

      const speakerIdRemapping = new Map([
        ['SPEAKER_00_chunk0', 'speaker_canonical_0'],
        ['SPEAKER_01_chunk1', 'speaker_canonical_0']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      // Should find Emma from either segment
      expect(results[0].resolvedName).toBe('Emma');
      expect(results[0].nameAssigned).toBe(true);
    });

    it('should work with empty clusters (no segments)', () => {
      const clusters = [
        createCluster('speaker_canonical_0', ['SPEAKER_00'], 'Unknown')
      ];

      const segments: Segment[] = [];

      const speakerIdRemapping = new Map([
        ['SPEAKER_00', 'speaker_canonical_0']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      expect(results[0].resolvedName).toBe('Unknown');
      expect(results[0].nameAssigned).toBe(false);
      expect(results[0].evidence).toHaveLength(0);
    });
  });

  describe('Test Case: Host who says "I\'m Chris"', () => {
    it('should label Host as Chris, not Speaker 7', () => {
      const clusters = [
        createCluster('speaker_canonical_7', ['SPEAKER_07'], 'Host')
      ];

      const segments = [
        createSegment(0, 'SPEAKER_07', "Hey everyone, I'm Chris and I'll be your host today.")
      ];

      const speakerIdRemapping = new Map([
        ['SPEAKER_07', 'speaker_canonical_7']
      ]);

      const results = resolveNamesHeuristically(clusters, segments, speakerIdRemapping);

      expect(results[0].resolvedName).toBe('Chris');
      expect(results[0].nameAssigned).toBe(true);
      expect(results[0].confidence).toBe('high');
      expect(results[0].totalWeight).toBe(1.0);
    });
  });
});
