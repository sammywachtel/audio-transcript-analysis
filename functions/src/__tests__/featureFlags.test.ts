/**
 * Feature Flags — Reconciliation Rollout Tests
 *
 * Tests the deterministic hashing logic used for context-aware speaker
 * reconciliation rollout. No live Firebase dependencies — pure functions only.
 *
 * Hybrid pipeline routing tests were removed in hard cutover (scope -06).
 * All uploads now go through the hybrid pipeline directly.
 */

import { hashConversationId } from '../featureFlags';

// =============================================================================
// hashConversationId
// =============================================================================

describe('hashConversationId', () => {
  it('returns a number in 0-99 range', () => {
    for (const id of ['conv-1', 'conv-2', 'abc-xyz', '🎵', '']) {
      const bucket = hashConversationId(id);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThanOrEqual(99);
    }
  });

  it('is deterministic — same input always yields same output', () => {
    const id = 'conv-determinism-check';
    const first = hashConversationId(id);
    const second = hashConversationId(id);
    const third = hashConversationId(id);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it('distributes different IDs across the bucket range', () => {
    // Hash 200 IDs and verify we see at least 20 distinct buckets.
    // With SHA-256 this is astronomically likely — if it fails, the
    // hash function is broken.
    const buckets = new Set<number>();
    for (let i = 0; i < 200; i++) {
      buckets.add(hashConversationId(`conv-distribution-${i}`));
    }
    expect(buckets.size).toBeGreaterThanOrEqual(20);
  });
});

// shouldUseHybridPipeline and dispatchByFeatureFlags tests were removed in
// hard cutover (scope -06). All uploads now go through the hybrid pipeline
// directly — no feature-flag routing to test.
