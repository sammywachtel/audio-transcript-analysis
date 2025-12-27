/**
 * Metrics Service
 *
 * Frontend service for querying observability collections.
 * Provides typed queries for:
 * - Global stats (admin dashboard)
 * - Daily stats (time-series charts)
 * - User stats (personal usage)
 * - Metrics history (job details)
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  orderBy,
  limit,
  where,
  Timestamp,
  DocumentData
} from 'firebase/firestore';
import { db } from '../firebase-config';

// =============================================================================
// Types (mirrored from backend for frontend use)
// =============================================================================

/**
 * LLM usage metrics
 */
export interface GeminiUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface ReplicateUsage {
  predictionId?: string;
  computeTimeSeconds: number;
  model: string;
}

export interface LLMUsage {
  geminiAnalysis: GeminiUsage;
  geminiSpeakerCorrection: GeminiUsage;
  whisperx: ReplicateUsage;
  diarization?: ReplicateUsage;
}

export interface EstimatedCost {
  geminiUsd: number;
  whisperxUsd: number;
  diarizationUsd: number;
  totalUsd: number;
}

/**
 * Processing metrics (from _metrics collection)
 */
export interface ProcessingMetric {
  conversationId: string;
  userId: string;
  status: 'success' | 'failed';
  errorMessage?: string;
  alignmentStatus?: 'aligned' | 'fallback';
  timingMs: {
    download: number;
    whisperx: number;
    buildSegments: number;
    gemini: number;
    speakerCorrection: number;
    transform: number;
    firestore: number;
    total: number;
  };
  segmentCount: number;
  speakerCount: number;
  termCount: number;
  topicCount: number;
  personCount: number;
  speakerCorrectionsApplied: number;
  audioSizeMB: number;
  durationMs: number;
  llmUsage?: LLMUsage;
  estimatedCost?: EstimatedCost;
  timestamp: Timestamp;
}

/**
 * User stats (from _user_stats collection)
 */
export interface WindowStats {
  conversationsCreated: number;
  conversationsDeleted: number;
  jobsSucceeded: number;
  jobsFailed: number;
  audioHoursProcessed: number;
  estimatedCostUsd: number;
}

export interface LifetimeStats extends WindowStats {
  conversationsExisting: number;
  totalAudioFiles: number;
}

export interface UserStats {
  userId: string;
  lifetime: LifetimeStats;
  last7Days: WindowStats;
  last30Days: WindowStats;
  firstActivityAt: Timestamp;
  lastActivityAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Global stats (from _global_stats collection)
 */
export interface GlobalStats {
  users: {
    totalUsers: number;
    activeUsersLast7Days: number;
    activeUsersLast30Days: number;
  };
  processing: {
    totalJobsAllTime: number;
    successRate: number;
    avgProcessingTimeMs: number;
    totalAudioHoursProcessed: number;
  };
  llmUsage: {
    totalGeminiInputTokens: number;
    totalGeminiOutputTokens: number;
    totalWhisperXComputeSeconds: number;
    estimatedTotalCostUsd: number;
  };
  conversations: {
    totalConversationsCreated: number;
    totalConversationsDeleted: number;
    totalConversationsExisting: number;
  };
  lastUpdatedAt: Timestamp;
  computedAt: string;
}

/**
 * Daily stats (from _daily_stats collection)
 */
export interface DailyStats {
  date: string;
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
  createdAt: Timestamp;
}

/**
 * Pricing configuration (from _pricing collection)
 */
export interface PricingConfig {
  pricingId: string;
  model: string;
  service: 'gemini' | 'replicate';
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  pricePerSecond?: number;
  effectiveFrom: Timestamp;
  effectiveUntil?: Timestamp;
  notes?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// =============================================================================
// Query Functions
// =============================================================================

/**
 * Get global stats (admin only)
 */
export async function getGlobalStats(): Promise<GlobalStats | null> {
  try {
    const docRef = doc(db, '_global_stats', 'current');
    const snapshot = await getDoc(docRef);

    if (!snapshot.exists()) {
      console.warn('[MetricsService] No global stats found');
      return null;
    }

    return snapshot.data() as GlobalStats;
  } catch (error) {
    console.error('[MetricsService] Failed to fetch global stats:', error);
    throw error;
  }
}

/**
 * Get daily stats for a date range (admin only)
 */
export async function getDailyStats(
  startDate: string,  // YYYY-MM-DD
  endDate: string     // YYYY-MM-DD
): Promise<DailyStats[]> {
  try {
    const q = query(
      collection(db, '_daily_stats'),
      where('date', '>=', startDate),
      where('date', '<=', endDate),
      orderBy('date', 'asc')
    );

    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => doc.data() as DailyStats);
  } catch (error) {
    console.error('[MetricsService] Failed to fetch daily stats:', error);
    throw error;
  }
}

/**
 * Get user stats for current user
 */
export async function getUserStats(userId: string): Promise<UserStats | null> {
  try {
    const docRef = doc(db, '_user_stats', userId);
    const snapshot = await getDoc(docRef);

    if (!snapshot.exists()) {
      console.warn('[MetricsService] No user stats found for:', userId);
      return null;
    }

    return snapshot.data() as UserStats;
  } catch (error) {
    console.error('[MetricsService] Failed to fetch user stats:', error);
    throw error;
  }
}

/**
 * Get all user stats summaries (admin only)
 * Returns limited fields for the user list view
 */
export async function getAllUserStatsSummaries(
  maxResults: number = 100
): Promise<Array<{
  userId: string;
  conversationsExisting: number;
  audioHoursProcessed: number;
  estimatedCostUsd: number;
  lastActivityAt: Timestamp;
}>> {
  try {
    const q = query(
      collection(db, '_user_stats'),
      orderBy('lastActivityAt', 'desc'),
      limit(maxResults)
    );

    const snapshot = await getDocs(q);
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
    console.error('[MetricsService] Failed to fetch user stats summaries:', error);
    throw error;
  }
}

/**
 * Get recent processing metrics (admin or filtered by user)
 */
export async function getRecentMetrics(
  options: {
    userId?: string;
    maxResults?: number;
    status?: 'success' | 'failed';
  } = {}
): Promise<ProcessingMetric[]> {
  const { userId, maxResults = 50, status } = options;

  try {
    let q = query(
      collection(db, '_metrics'),
      orderBy('timestamp', 'desc'),
      limit(maxResults)
    );

    // Note: Firestore doesn't support dynamic where clauses well,
    // so we filter client-side for simplicity
    const snapshot = await getDocs(q);
    let results = snapshot.docs.map(doc => doc.data() as ProcessingMetric);

    // Apply filters
    if (userId) {
      results = results.filter(m => m.userId === userId);
    }
    if (status) {
      results = results.filter(m => m.status === status);
    }

    return results;
  } catch (error) {
    console.error('[MetricsService] Failed to fetch recent metrics:', error);
    throw error;
  }
}

/**
 * Get pricing configuration (for cost display)
 */
export async function getPricingConfigs(): Promise<PricingConfig[]> {
  try {
    const q = query(
      collection(db, '_pricing'),
      orderBy('effectiveFrom', 'desc')
    );

    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({
      pricingId: doc.id,
      ...doc.data()
    } as PricingConfig));
  } catch (error) {
    console.error('[MetricsService] Failed to fetch pricing configs:', error);
    throw error;
  }
}

/**
 * Get current pricing for a specific model
 */
export async function getCurrentPricing(model: string): Promise<PricingConfig | null> {
  try {
    const now = Timestamp.now();
    const q = query(
      collection(db, '_pricing'),
      where('model', '==', model),
      where('effectiveFrom', '<=', now),
      orderBy('effectiveFrom', 'desc'),
      limit(1)
    );

    const snapshot = await getDocs(q);
    if (snapshot.empty) {
      return null;
    }

    const doc = snapshot.docs[0];
    const data = doc.data();

    // Check if expired
    if (data.effectiveUntil && data.effectiveUntil.toDate() <= now.toDate()) {
      return null;
    }

    return {
      pricingId: doc.id,
      ...data
    } as PricingConfig;
  } catch (error) {
    console.error('[MetricsService] Failed to fetch current pricing:', error);
    throw error;
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Format milliseconds as human-readable duration
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${minutes.toFixed(1)}m`;
  }
  const hours = minutes / 60;
  return `${hours.toFixed(1)}h`;
}

/**
 * Format bytes as human-readable size
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

/**
 * Format USD amount
 */
export function formatUsd(amount: number): string {
  if (amount < 0.01) {
    return `$${amount.toFixed(6)}`;
  }
  if (amount < 1) {
    return `$${amount.toFixed(4)}`;
  }
  return `$${amount.toFixed(2)}`;
}

/**
 * Get date range for last N days
 */
export function getDateRange(days: number): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

  return {
    startDate: start.toISOString().split('T')[0],
    endDate: end.toISOString().split('T')[0]
  };
}
