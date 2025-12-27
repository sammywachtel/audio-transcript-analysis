/**
 * Stats Aggregation System
 *
 * Scheduled Cloud Functions that compute aggregate statistics:
 * - _global_stats/current: System-wide stats for admin dashboard
 * - _daily_stats/{YYYY-MM-DD}: Time-series data for charts
 *
 * Runs daily at 2 AM UTC to compute rolling windows and daily snapshots.
 * User stats are updated in real-time by userEvents.ts, but rolling windows
 * (7/30 days) are recalculated here for accuracy.
 */

import { onSchedule, ScheduledEvent } from 'firebase-functions/v2/scheduler';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from './index';
import { log } from './logger';

// =============================================================================
// Global Stats Types
// =============================================================================

/**
 * User activity summary for global stats
 */
interface UserActivitySummary {
  totalUsers: number;
  activeUsersLast7Days: number;
  activeUsersLast30Days: number;
}

/**
 * Processing summary for global stats
 */
interface ProcessingSummary {
  totalJobsAllTime: number;
  successRate: number;  // 0-100
  avgProcessingTimeMs: number;
  totalAudioHoursProcessed: number;
}

/**
 * LLM usage summary for global stats
 */
interface LLMUsageSummary {
  totalGeminiInputTokens: number;
  totalGeminiOutputTokens: number;
  totalWhisperXComputeSeconds: number;
  estimatedTotalCostUsd: number;
}

/**
 * Conversation summary for global stats
 */
interface ConversationSummary {
  totalConversationsCreated: number;
  totalConversationsDeleted: number;
  totalConversationsExisting: number;
}

/**
 * Complete global stats document stored in _global_stats/current
 */
export interface GlobalStats {
  users: UserActivitySummary;
  processing: ProcessingSummary;
  llmUsage: LLMUsageSummary;
  conversations: ConversationSummary;
  lastUpdatedAt: FieldValue | Timestamp;
  computedAt: string;  // ISO timestamp of when this was computed
}

// =============================================================================
// Daily Stats Types
// =============================================================================

/**
 * Daily stats snapshot stored in _daily_stats/{YYYY-MM-DD}
 */
export interface DailyStats {
  date: string;  // YYYY-MM-DD
  activeUsers: number;
  newUsers: number;
  conversationsCreated: number;
  conversationsDeleted: number;
  jobsSucceeded: number;
  jobsFailed: number;
  audioHoursProcessed: number;
  geminiTokensUsed: number;
  whisperXComputeSeconds: number;
  estimatedCostUsd: number;
  avgProcessingTimeMs: number;
  createdAt: FieldValue | Timestamp;
}

// =============================================================================
// Scheduled Aggregation Function
// =============================================================================

/**
 * Scheduled function that runs daily at 2 AM UTC
 *
 * Computes:
 * 1. Global stats (system-wide aggregates)
 * 2. Daily stats (yesterday's snapshot)
 * 3. Recalculates rolling windows in _user_stats
 */
export const computeDailyStats = onSchedule(
  {
    schedule: '0 2 * * *',  // 2 AM UTC daily
    timeZone: 'UTC',
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 300  // 5 minutes
  },
  async (event: ScheduledEvent) => {
    log.info('Starting daily stats aggregation', {
      scheduledTime: event.scheduleTime
    });

    try {
      // Compute all aggregates
      const [globalStats, dailyStats] = await Promise.all([
        computeGlobalStats(),
        computeYesterdayStats()
      ]);

      // Save results
      await Promise.all([
        saveGlobalStats(globalStats),
        saveDailyStats(dailyStats)
      ]);

      // Recalculate rolling windows for user stats
      await recalculateUserRollingWindows();

      log.info('Daily stats aggregation complete', {
        globalStats: {
          totalUsers: globalStats.users.totalUsers,
          totalConversations: globalStats.conversations.totalConversationsExisting,
          estimatedCostUsd: globalStats.llmUsage.estimatedTotalCostUsd
        },
        dailyStats: {
          date: dailyStats.date,
          activeUsers: dailyStats.activeUsers,
          jobsSucceeded: dailyStats.jobsSucceeded
        }
      });

    } catch (error) {
      log.error('Daily stats aggregation failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;  // Re-throw to mark function as failed
    }
  }
);

// =============================================================================
// Global Stats Computation
// =============================================================================

async function computeGlobalStats(): Promise<GlobalStats> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Get user stats
  const userStatsSnapshot = await db.collection('_user_stats').get();
  const userStats = userStatsSnapshot.docs.map(doc => doc.data());

  const totalUsers = userStats.length;
  const activeUsersLast7Days = userStats.filter(u =>
    u.lastActivityAt?.toDate && u.lastActivityAt.toDate() >= sevenDaysAgo
  ).length;
  const activeUsersLast30Days = userStats.filter(u =>
    u.lastActivityAt?.toDate && u.lastActivityAt.toDate() >= thirtyDaysAgo
  ).length;

  // Get metrics for processing stats
  const metricsSnapshot = await db.collection('_metrics')
    .orderBy('timestamp', 'desc')
    .limit(1000)  // Last 1000 jobs for performance
    .get();

  const metrics = metricsSnapshot.docs.map(doc => doc.data());
  const successfulJobs = metrics.filter(m => m.status === 'success');

  const totalJobsAllTime = metrics.length;
  const successRate = totalJobsAllTime > 0
    ? (successfulJobs.length / totalJobsAllTime) * 100
    : 0;

  const avgProcessingTimeMs = successfulJobs.length > 0
    ? successfulJobs.reduce((sum, m) => sum + (m.timingMs?.total || 0), 0) / successfulJobs.length
    : 0;

  const totalAudioHoursProcessed = metrics.reduce((sum, m) =>
    sum + ((m.durationMs || 0) / (1000 * 60 * 60)), 0);

  // LLM usage totals
  const totalGeminiInputTokens = metrics.reduce((sum, m) =>
    sum + (m.llmUsage?.geminiAnalysis?.inputTokens || 0) +
          (m.llmUsage?.geminiSpeakerCorrection?.inputTokens || 0), 0);

  const totalGeminiOutputTokens = metrics.reduce((sum, m) =>
    sum + (m.llmUsage?.geminiAnalysis?.outputTokens || 0) +
          (m.llmUsage?.geminiSpeakerCorrection?.outputTokens || 0), 0);

  const totalWhisperXComputeSeconds = metrics.reduce((sum, m) =>
    sum + (m.llmUsage?.whisperx?.computeTimeSeconds || 0), 0);

  const estimatedTotalCostUsd = metrics.reduce((sum, m) =>
    sum + (m.estimatedCost?.totalUsd || 0), 0);

  // Conversation counts from user stats
  const totalConversationsCreated = userStats.reduce((sum, u) =>
    sum + (u.lifetime?.conversationsCreated || 0), 0);
  const totalConversationsDeleted = userStats.reduce((sum, u) =>
    sum + (u.lifetime?.conversationsDeleted || 0), 0);
  const totalConversationsExisting = userStats.reduce((sum, u) =>
    sum + (u.lifetime?.conversationsExisting || 0), 0);

  return {
    users: {
      totalUsers,
      activeUsersLast7Days,
      activeUsersLast30Days
    },
    processing: {
      totalJobsAllTime,
      successRate: Math.round(successRate * 10) / 10,
      avgProcessingTimeMs: Math.round(avgProcessingTimeMs),
      totalAudioHoursProcessed: Math.round(totalAudioHoursProcessed * 100) / 100
    },
    llmUsage: {
      totalGeminiInputTokens,
      totalGeminiOutputTokens,
      totalWhisperXComputeSeconds: Math.round(totalWhisperXComputeSeconds),
      estimatedTotalCostUsd: Math.round(estimatedTotalCostUsd * 100) / 100
    },
    conversations: {
      totalConversationsCreated,
      totalConversationsDeleted,
      totalConversationsExisting
    },
    lastUpdatedAt: FieldValue.serverTimestamp(),
    computedAt: now.toISOString()
  };
}

async function saveGlobalStats(stats: GlobalStats): Promise<void> {
  await db.collection('_global_stats').doc('current').set(stats, { merge: true });
  log.debug('Global stats saved');
}

// =============================================================================
// Daily Stats Computation
// =============================================================================

async function computeYesterdayStats(): Promise<DailyStats> {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const dateStr = yesterday.toISOString().split('T')[0];

  // Query metrics from yesterday
  const metricsSnapshot = await db.collection('_metrics')
    .where('timestamp', '>=', Timestamp.fromDate(yesterday))
    .where('timestamp', '<', Timestamp.fromDate(todayStart))
    .get();

  const metrics = metricsSnapshot.docs.map(doc => doc.data());
  const successfulJobs = metrics.filter(m => m.status === 'success');
  const failedJobs = metrics.filter(m => m.status === 'failed');

  // Get unique users from metrics
  const activeUserIds = new Set(metrics.map(m => m.userId).filter(Boolean));

  // Query user events from yesterday
  const eventsSnapshot = await db.collection('_user_events')
    .where('timestamp', '>=', Timestamp.fromDate(yesterday))
    .where('timestamp', '<', Timestamp.fromDate(todayStart))
    .get();

  const events = eventsSnapshot.docs.map(doc => doc.data());
  const conversationsCreated = events.filter(e => e.eventType === 'conversation_created').length;
  const conversationsDeleted = events.filter(e => e.eventType === 'conversation_deleted').length;

  // Count new users (first activity yesterday)
  const newUsersSnapshot = await db.collection('_user_stats')
    .where('firstActivityAt', '>=', Timestamp.fromDate(yesterday))
    .where('firstActivityAt', '<', Timestamp.fromDate(todayStart))
    .get();

  // Calculate aggregates
  const audioHoursProcessed = metrics.reduce((sum, m) =>
    sum + ((m.durationMs || 0) / (1000 * 60 * 60)), 0);

  const geminiTokensUsed = metrics.reduce((sum, m) =>
    sum + (m.llmUsage?.geminiAnalysis?.inputTokens || 0) +
          (m.llmUsage?.geminiAnalysis?.outputTokens || 0) +
          (m.llmUsage?.geminiSpeakerCorrection?.inputTokens || 0) +
          (m.llmUsage?.geminiSpeakerCorrection?.outputTokens || 0), 0);

  const whisperXComputeSeconds = metrics.reduce((sum, m) =>
    sum + (m.llmUsage?.whisperx?.computeTimeSeconds || 0), 0);

  const estimatedCostUsd = metrics.reduce((sum, m) =>
    sum + (m.estimatedCost?.totalUsd || 0), 0);

  const avgProcessingTimeMs = successfulJobs.length > 0
    ? successfulJobs.reduce((sum, m) => sum + (m.timingMs?.total || 0), 0) / successfulJobs.length
    : 0;

  return {
    date: dateStr,
    activeUsers: activeUserIds.size,
    newUsers: newUsersSnapshot.size,
    conversationsCreated,
    conversationsDeleted,
    jobsSucceeded: successfulJobs.length,
    jobsFailed: failedJobs.length,
    audioHoursProcessed: Math.round(audioHoursProcessed * 1000) / 1000,
    geminiTokensUsed,
    whisperXComputeSeconds: Math.round(whisperXComputeSeconds),
    estimatedCostUsd: Math.round(estimatedCostUsd * 1000000) / 1000000,
    avgProcessingTimeMs: Math.round(avgProcessingTimeMs),
    createdAt: FieldValue.serverTimestamp()
  };
}

async function saveDailyStats(stats: DailyStats): Promise<void> {
  await db.collection('_daily_stats').doc(stats.date).set(stats);
  log.debug('Daily stats saved', { date: stats.date });
}

// =============================================================================
// Rolling Window Recalculation
// =============================================================================

/**
 * Recalculate 7-day and 30-day rolling windows for all users
 *
 * Real-time updates in userEvents.ts are approximate (they just increment).
 * This function recalculates accurate rolling windows by querying events.
 */
async function recalculateUserRollingWindows(): Promise<void> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Get all user stats documents
  const userStatsSnapshot = await db.collection('_user_stats').get();

  log.info('Recalculating rolling windows', {
    userCount: userStatsSnapshot.size
  });

  // Process in batches to avoid overwhelming Firestore
  const batch = db.batch();
  let updatedCount = 0;

  for (const doc of userStatsSnapshot.docs) {
    const userId = doc.id;

    // Query events for this user in last 7 and 30 days
    const [events7d, events30d] = await Promise.all([
      db.collection('_user_events')
        .where('userId', '==', userId)
        .where('timestamp', '>=', Timestamp.fromDate(sevenDaysAgo))
        .get(),
      db.collection('_user_events')
        .where('userId', '==', userId)
        .where('timestamp', '>=', Timestamp.fromDate(thirtyDaysAgo))
        .get()
    ]);

    // Also query metrics for audio hours and costs
    const [metrics7d, metrics30d] = await Promise.all([
      db.collection('_metrics')
        .where('userId', '==', userId)
        .where('timestamp', '>=', Timestamp.fromDate(sevenDaysAgo))
        .get(),
      db.collection('_metrics')
        .where('userId', '==', userId)
        .where('timestamp', '>=', Timestamp.fromDate(thirtyDaysAgo))
        .get()
    ]);

    // Calculate 7-day window
    const last7Days = calculateWindowStats(events7d.docs, metrics7d.docs);

    // Calculate 30-day window
    const last30Days = calculateWindowStats(events30d.docs, metrics30d.docs);

    // Update the user stats document
    batch.update(doc.ref, {
      last7Days,
      last30Days,
      updatedAt: FieldValue.serverTimestamp()
    });

    updatedCount++;

    // Commit in batches of 500 (Firestore limit)
    if (updatedCount % 500 === 0) {
      await batch.commit();
      log.debug('Batch committed', { updatedCount });
    }
  }

  // Commit remaining updates
  if (updatedCount % 500 !== 0) {
    await batch.commit();
  }

  log.info('Rolling window recalculation complete', { updatedCount });
}

/**
 * Helper to calculate window stats from events and metrics
 */
function calculateWindowStats(
  eventDocs: FirebaseFirestore.QueryDocumentSnapshot[],
  metricDocs: FirebaseFirestore.QueryDocumentSnapshot[]
): {
  conversationsCreated: number;
  conversationsDeleted: number;
  jobsSucceeded: number;
  jobsFailed: number;
  audioHoursProcessed: number;
  estimatedCostUsd: number;
} {
  const events = eventDocs.map(doc => doc.data());
  const metrics = metricDocs.map(doc => doc.data());

  const conversationsCreated = events.filter(e => e.eventType === 'conversation_created').length;
  const conversationsDeleted = events.filter(e => e.eventType === 'conversation_deleted').length;
  const jobsSucceeded = metrics.filter(m => m.status === 'success').length;
  const jobsFailed = metrics.filter(m => m.status === 'failed').length;

  const audioHoursProcessed = metrics.reduce((sum, m) =>
    sum + ((m.durationMs || 0) / (1000 * 60 * 60)), 0);

  const estimatedCostUsd = metrics.reduce((sum, m) =>
    sum + (m.estimatedCost?.totalUsd || 0), 0);

  return {
    conversationsCreated,
    conversationsDeleted,
    jobsSucceeded,
    jobsFailed,
    audioHoursProcessed: Math.round(audioHoursProcessed * 1000) / 1000,
    estimatedCostUsd: Math.round(estimatedCostUsd * 1000000) / 1000000
  };
}

// =============================================================================
// Manual Trigger (for testing/backfill)
// =============================================================================

/**
 * HTTP-callable function to manually trigger stats computation
 * Useful for testing or catching up after missed runs
 */
export { computeGlobalStats, computeYesterdayStats };
