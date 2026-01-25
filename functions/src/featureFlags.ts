/**
 * Feature Flags Module
 *
 * Manages feature flags for context-aware speaker reconciliation rollout.
 * Supports:
 * - Kill switch (enableContextAwareReconciliation)
 * - Gradual rollout (rolloutPercentage: 0-100)
 * - Override list (force specific conversations to embedding-only)
 * - Auto-disable tracking (disabledAt, disableReason)
 *
 * Deterministic rollout: Same conversation always gets same treatment
 * using consistent hashing. No per-run drift.
 */

import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { createHash } from 'crypto';

// ============================================================================
// Types
// ============================================================================

export interface FeatureFlags {
  /** Master switch for context-aware reconciliation */
  enableContextAwareReconciliation: boolean;

  /** Rollout percentage (0-100). Deterministic per conversation. */
  contextAwareRolloutPercentage: number;

  /** Conversations forced to embedding-only (override list) */
  forceEmbeddingOnlyConversationIds: string[];

  /** Timestamp when auto-disabled (if applicable) */
  disabledAt?: Timestamp;

  /** Reason for auto-disable (if applicable) */
  disableReason?: string;

  /** Last updated timestamp */
  updatedAt?: Timestamp;
}

export interface ReconciliationStrategy {
  /** Which strategy to use */
  strategy: 'context-aware' | 'embedding-only';

  /** Reason for strategy selection */
  reason: string;

  /** Current rollout percentage */
  rolloutPercentage: number;

  /** Whether feature flag is enabled */
  flagEnabled: boolean;

  /** Whether conversation is in override list */
  isOverridden: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const FEATURE_FLAGS_DOC_PATH = 'system/feature_flags';

const DEFAULT_FLAGS: FeatureFlags = {
  enableContextAwareReconciliation: false,
  contextAwareRolloutPercentage: 0,
  forceEmbeddingOnlyConversationIds: []
};

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Get current feature flags from Firestore.
 * Returns defaults if document doesn't exist.
 */
export async function getFeatureFlags(): Promise<FeatureFlags> {
  const db = getFirestore();
  const docRef = db.doc(FEATURE_FLAGS_DOC_PATH);

  try {
    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      console.log('[FeatureFlags] No feature_flags document found, using defaults');
      return DEFAULT_FLAGS;
    }

    const data = snapshot.data() as Partial<FeatureFlags>;

    // Merge with defaults to ensure all fields exist
    return {
      enableContextAwareReconciliation: data.enableContextAwareReconciliation ?? DEFAULT_FLAGS.enableContextAwareReconciliation,
      contextAwareRolloutPercentage: data.contextAwareRolloutPercentage ?? DEFAULT_FLAGS.contextAwareRolloutPercentage,
      forceEmbeddingOnlyConversationIds: data.forceEmbeddingOnlyConversationIds ?? DEFAULT_FLAGS.forceEmbeddingOnlyConversationIds,
      disabledAt: data.disabledAt,
      disableReason: data.disableReason,
      updatedAt: data.updatedAt
    };
  } catch (error) {
    console.error('[FeatureFlags] Failed to read feature flags:', error);
    // Return defaults on error to avoid blocking processing
    return DEFAULT_FLAGS;
  }
}

/**
 * Compute deterministic hash bucket for a conversation ID.
 *
 * Uses SHA-256 to generate a stable hash, then maps to 0-99.
 * Same conversation ID always returns the same bucket.
 *
 * @param conversationId - Conversation to hash
 * @returns Number from 0-99 (inclusive)
 */
export function hashConversationId(conversationId: string): number {
  // SHA-256 produces consistent output across platforms
  const hash = createHash('sha256')
    .update(conversationId)
    .digest('hex');

  // Take first 8 hex chars (32 bits) and convert to number
  // This gives us plenty of entropy for percentage bucketing
  const numericHash = parseInt(hash.substring(0, 8), 16);

  // Map to 0-99 range
  return numericHash % 100;
}

/**
 * Determine which reconciliation strategy to use for a conversation.
 *
 * Decision order:
 * 1. Kill switch off → embedding-only
 * 2. In override list → embedding-only
 * 3. Hash bucket >= rollout percentage → embedding-only
 * 4. Otherwise → context-aware
 *
 * @param conversationId - Conversation to check
 * @param flags - Feature flags (pass to avoid re-fetching if already loaded)
 * @returns Strategy decision with reasoning
 */
export function shouldUseContextAware(
  conversationId: string,
  flags: FeatureFlags
): ReconciliationStrategy {
  // Check kill switch
  if (!flags.enableContextAwareReconciliation) {
    return {
      strategy: 'embedding-only',
      reason: flags.disabledAt
        ? `Auto-disabled: ${flags.disableReason || 'unknown reason'}`
        : 'Feature flag disabled',
      rolloutPercentage: flags.contextAwareRolloutPercentage,
      flagEnabled: false,
      isOverridden: false
    };
  }

  // Check override list
  if (flags.forceEmbeddingOnlyConversationIds.includes(conversationId)) {
    return {
      strategy: 'embedding-only',
      reason: 'Conversation in override list',
      rolloutPercentage: flags.contextAwareRolloutPercentage,
      flagEnabled: true,
      isOverridden: true
    };
  }

  // Deterministic rollout check
  const bucket = hashConversationId(conversationId);
  if (bucket >= flags.contextAwareRolloutPercentage) {
    return {
      strategy: 'embedding-only',
      reason: `Outside rollout (bucket ${bucket} >= ${flags.contextAwareRolloutPercentage}%)`,
      rolloutPercentage: flags.contextAwareRolloutPercentage,
      flagEnabled: true,
      isOverridden: false
    };
  }

  // All checks passed - use context-aware
  return {
    strategy: 'context-aware',
    reason: `In rollout (bucket ${bucket} < ${flags.contextAwareRolloutPercentage}%)`,
    rolloutPercentage: flags.contextAwareRolloutPercentage,
    flagEnabled: true,
    isOverridden: false
  };
}

/**
 * Get strategy for a conversation, fetching flags if needed.
 *
 * Convenience wrapper that handles flag fetching.
 *
 * @param conversationId - Conversation to check
 * @returns Strategy decision
 */
export async function getReconciliationStrategy(
  conversationId: string
): Promise<ReconciliationStrategy> {
  const flags = await getFeatureFlags();
  return shouldUseContextAware(conversationId, flags);
}

// ============================================================================
// Admin Functions (for auto-disable handler)
// ============================================================================

/**
 * Disable context-aware reconciliation.
 * Called by the Pub/Sub alert handler when error rate exceeds threshold.
 *
 * @param reason - Reason for disabling (stored in Firestore)
 */
export async function disableContextAwareReconciliation(reason: string): Promise<void> {
  const db = getFirestore();
  const docRef = db.doc(FEATURE_FLAGS_DOC_PATH);

  console.log('[FeatureFlags] Disabling context-aware reconciliation:', { reason });

  await docRef.set({
    enableContextAwareReconciliation: false,
    disabledAt: FieldValue.serverTimestamp(),
    disableReason: reason,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  console.log('[FeatureFlags] Context-aware reconciliation disabled');
}

/**
 * Re-enable context-aware reconciliation.
 * Used by admins after investigating and fixing issues.
 *
 * @param rolloutPercentage - Optional new rollout percentage (defaults to previous)
 */
export async function enableContextAwareReconciliation(
  rolloutPercentage?: number
): Promise<void> {
  const db = getFirestore();
  const docRef = db.doc(FEATURE_FLAGS_DOC_PATH);

  console.log('[FeatureFlags] Re-enabling context-aware reconciliation:', {
    rolloutPercentage
  });

  const updateData: Record<string, unknown> = {
    enableContextAwareReconciliation: true,
    disabledAt: FieldValue.delete(),
    disableReason: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp()
  };

  if (rolloutPercentage !== undefined) {
    updateData.contextAwareRolloutPercentage = rolloutPercentage;
  }

  await docRef.set(updateData, { merge: true });

  console.log('[FeatureFlags] Context-aware reconciliation enabled');
}

/**
 * Update rollout percentage.
 *
 * @param percentage - New percentage (0-100)
 */
export async function setRolloutPercentage(percentage: number): Promise<void> {
  if (percentage < 0 || percentage > 100) {
    throw new Error(`Invalid rollout percentage: ${percentage}. Must be 0-100.`);
  }

  const db = getFirestore();
  const docRef = db.doc(FEATURE_FLAGS_DOC_PATH);

  console.log('[FeatureFlags] Setting rollout percentage:', { percentage });

  await docRef.set({
    contextAwareRolloutPercentage: percentage,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  console.log('[FeatureFlags] Rollout percentage updated');
}
