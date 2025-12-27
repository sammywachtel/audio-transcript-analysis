/**
 * User Activity Tracking
 *
 * Records user activity events and maintains running aggregates in _user_stats.
 * Events are stored in _user_events for audit trail, aggregates in _user_stats/{userId}.
 *
 * This enables:
 * - User-specific stats pages showing their own usage
 * - Admin drill-down to individual user activity
 * - Historical event timeline for debugging
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from './index';
import { log } from './logger';

// =============================================================================
// Event Types
// =============================================================================

export type UserEventType =
  | 'conversation_created'
  | 'conversation_deleted'
  | 'processing_completed'
  | 'processing_failed';

/**
 * A single user activity event
 */
export interface UserEvent {
  eventId?: string;
  eventType: UserEventType;
  userId: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
  timestamp: FieldValue | Timestamp;
}

// =============================================================================
// User Stats Types - Pre-computed aggregates
// =============================================================================

/**
 * Rolling window stats (7/30 day windows)
 */
export interface WindowStats {
  conversationsCreated: number;
  conversationsDeleted: number;
  jobsSucceeded: number;
  jobsFailed: number;
  audioHoursProcessed: number;
  estimatedCostUsd: number;
}

/**
 * Lifetime stats for a user
 */
export interface LifetimeStats extends WindowStats {
  conversationsExisting: number;  // Current count (created - deleted)
  totalAudioFiles: number;        // Count of files ever uploaded
}

/**
 * Complete user stats document stored in _user_stats/{userId}
 */
export interface UserStats {
  userId: string;
  lifetime: LifetimeStats;
  last7Days: WindowStats;
  last30Days: WindowStats;
  firstActivityAt: Timestamp;
  lastActivityAt: Timestamp;
  updatedAt: FieldValue | Timestamp;
}

// =============================================================================
// Event Recording
// =============================================================================

/**
 * Record a user activity event and update running aggregates
 *
 * @param event - The event to record
 */
export async function recordUserEvent(
  event: Omit<UserEvent, 'timestamp'>
): Promise<void> {
  const eventWithTimestamp: UserEvent = {
    ...event,
    timestamp: FieldValue.serverTimestamp()
  };

  try {
    // Record event in _user_events collection
    const eventRef = await db.collection('_user_events').add(eventWithTimestamp);

    log.info('User event recorded', {
      eventId: eventRef.id,
      eventType: event.eventType,
      userId: event.userId,
      conversationId: event.conversationId
    });

    // Update user stats atomically
    await updateUserStats(event.userId, event.eventType, event.metadata);

  } catch (error) {
    // Don't fail the calling operation if event recording fails
    log.warn('Failed to record user event', {
      eventType: event.eventType,
      userId: event.userId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// =============================================================================
// Stats Updates
// =============================================================================

/**
 * Update user stats atomically based on event type
 */
async function updateUserStats(
  userId: string,
  eventType: UserEventType,
  metadata?: Record<string, unknown>
): Promise<void> {
  const statsRef = db.collection('_user_stats').doc(userId);
  const now = Timestamp.now();

  try {
    await db.runTransaction(async (transaction) => {
      const statsDoc = await transaction.get(statsRef);

      if (!statsDoc.exists) {
        // First event for this user - create initial stats document
        const initialStats: UserStats = {
          userId,
          lifetime: {
            conversationsCreated: 0,
            conversationsDeleted: 0,
            conversationsExisting: 0,
            jobsSucceeded: 0,
            jobsFailed: 0,
            audioHoursProcessed: 0,
            estimatedCostUsd: 0,
            totalAudioFiles: 0
          },
          last7Days: {
            conversationsCreated: 0,
            conversationsDeleted: 0,
            jobsSucceeded: 0,
            jobsFailed: 0,
            audioHoursProcessed: 0,
            estimatedCostUsd: 0
          },
          last30Days: {
            conversationsCreated: 0,
            conversationsDeleted: 0,
            jobsSucceeded: 0,
            jobsFailed: 0,
            audioHoursProcessed: 0,
            estimatedCostUsd: 0
          },
          firstActivityAt: now,
          lastActivityAt: now,
          updatedAt: FieldValue.serverTimestamp()
        };

        applyEventToStats(initialStats, eventType, metadata);
        transaction.set(statsRef, initialStats);
      } else {
        // Update existing stats
        const existingStats = statsDoc.data() as UserStats;
        applyEventToStats(existingStats, eventType, metadata);
        existingStats.lastActivityAt = now;
        existingStats.updatedAt = FieldValue.serverTimestamp();
        transaction.update(statsRef, existingStats as unknown as Record<string, unknown>);
      }
    });

    log.debug('User stats updated', {
      userId,
      eventType
    });

  } catch (error) {
    log.warn('Failed to update user stats', {
      userId,
      eventType,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Apply an event's impact to stats object in-place
 * Note: Rolling windows (7/30 days) are approximate - exact calculation
 * happens during scheduled aggregation
 */
function applyEventToStats(
  stats: UserStats,
  eventType: UserEventType,
  metadata?: Record<string, unknown>
): void {
  switch (eventType) {
    case 'conversation_created':
      stats.lifetime.conversationsCreated++;
      stats.lifetime.conversationsExisting++;
      stats.lifetime.totalAudioFiles++;
      stats.last7Days.conversationsCreated++;
      stats.last30Days.conversationsCreated++;
      break;

    case 'conversation_deleted':
      stats.lifetime.conversationsDeleted++;
      stats.lifetime.conversationsExisting = Math.max(0, stats.lifetime.conversationsExisting - 1);
      stats.last7Days.conversationsDeleted++;
      stats.last30Days.conversationsDeleted++;
      break;

    case 'processing_completed':
      stats.lifetime.jobsSucceeded++;
      stats.last7Days.jobsSucceeded++;
      stats.last30Days.jobsSucceeded++;

      // Extract audio duration if provided in metadata
      if (metadata?.durationMs && typeof metadata.durationMs === 'number') {
        const audioHours = metadata.durationMs / (1000 * 60 * 60);
        stats.lifetime.audioHoursProcessed += audioHours;
        stats.last7Days.audioHoursProcessed += audioHours;
        stats.last30Days.audioHoursProcessed += audioHours;
      }

      // Extract estimated cost if provided in metadata
      if (metadata?.estimatedCostUsd && typeof metadata.estimatedCostUsd === 'number') {
        stats.lifetime.estimatedCostUsd += metadata.estimatedCostUsd;
        stats.last7Days.estimatedCostUsd += metadata.estimatedCostUsd;
        stats.last30Days.estimatedCostUsd += metadata.estimatedCostUsd;
      }
      break;

    case 'processing_failed':
      stats.lifetime.jobsFailed++;
      stats.last7Days.jobsFailed++;
      stats.last30Days.jobsFailed++;
      break;
  }
}

// =============================================================================
// Stats Retrieval (for frontend)
// =============================================================================

/**
 * Get stats for a specific user
 * Used by both users (for their own stats) and admins (for drill-down)
 */
export async function getUserStats(userId: string): Promise<UserStats | null> {
  try {
    const statsDoc = await db.collection('_user_stats').doc(userId).get();

    if (!statsDoc.exists) {
      return null;
    }

    return statsDoc.data() as UserStats;
  } catch (error) {
    log.warn('Failed to fetch user stats', {
      userId,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

/**
 * Get all users with stats (for admin overview)
 * Returns limited fields for efficiency
 */
export async function getAllUserStats(
  limit: number = 100
): Promise<Array<{
  userId: string;
  conversationsExisting: number;
  audioHoursProcessed: number;
  estimatedCostUsd: number;
  lastActivityAt: Timestamp;
}>> {
  try {
    const snapshot = await db.collection('_user_stats')
      .orderBy('lastActivityAt', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => {
      const data = doc.data() as UserStats;
      return {
        userId: data.userId,
        conversationsExisting: data.lifetime.conversationsExisting,
        audioHoursProcessed: data.lifetime.audioHoursProcessed,
        estimatedCostUsd: data.lifetime.estimatedCostUsd,
        lastActivityAt: data.lastActivityAt
      };
    });
  } catch (error) {
    log.warn('Failed to fetch all user stats', {
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}
