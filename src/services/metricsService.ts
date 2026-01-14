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
  Timestamp
} from 'firebase/firestore';
import { db } from '@/config/firebase-config';

// =============================================================================
// Types (mirrored from backend for frontend use)
// =============================================================================

/**
 * LLM usage metrics
 * Audio and text inputs tracked separately for accurate cost calculation
 */
export interface GeminiUsage {
  inputTokens: number;           // Total input tokens (backward compat)
  audioInputTokens?: number;     // Tokens from audio input (pre-analysis)
  textInputTokens?: number;      // Tokens from text input (transcript analysis)
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
  whisperx: ReplicateUsage;  // Includes diarization (single Replicate model)
}

export interface EstimatedCost {
  geminiUsd: number;              // Combined Gemini costs (backward compat)
  geminiAudioInputUsd?: number;   // Gemini audio input cost
  geminiTextInputUsd?: number;    // Gemini text input cost
  geminiOutputUsd?: number;       // Gemini output cost
  whisperxUsd: number;            // Includes diarization
  totalUsd: number;
}

/**
 * Actual cost from BigQuery billing exports
 * This represents real billing data synced from GCP
 */
export interface ActualCost {
  geminiUsd: number;          // Actual Gemini/Vertex AI cost from BigQuery
  fetchedAt: Timestamp;       // When this data was fetched
  source: 'bigquery_billing_export';
}

/**
 * Processing metrics (from _metrics collection)
 */
export interface ProcessingMetric {
  id?: string;  // Firestore document ID (added by query functions)
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
  actualCost?: ActualCost;    // Real cost from BigQuery billing (synced by billingSync)
  pricingSnapshot?: PricingSnapshot;  // Captured pricing rates used for cost calculation
  timestamp: Timestamp;
}

/**
 * Chat metrics (from _metrics collection with type: 'chat')
 */
export interface ChatTokenUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface ChatMetric {
  id?: string;  // Firestore document ID (added by query functions)
  type: 'chat';
  conversationId: string;
  userId: string;
  queryType: 'question' | 'follow_up';
  tokenUsage: ChatTokenUsage;
  costUsd: number;
  responseTimeMs: number;
  sourcesCount: number;
  isUnanswerable: boolean;
  geminiLabels?: Record<string, string>;
  pricingId?: string | null;
  pricingSnapshot?: PricingSnapshot;
  timestamp: Timestamp;
}

/**
 * Pricing snapshot captured at metric recording time
 */
export interface PricingSnapshot {
  capturedAt: Timestamp;
  geminiPricingId: string | null;
  whisperxPricingId: string | null;
  rates: {
    geminiInputPerMillion: number;           // Backward compat (text input rate)
    geminiAudioInputPerMillion?: number;     // Audio input rate
    geminiTextInputPerMillion?: number;      // Text input rate
    geminiOutputPerMillion: number;
    whisperxPerSecond: number;
  };
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
 *
 * IMPORTANT: Non-admin users can only read their own metrics due to Firestore rules.
 * The userId filter MUST be applied in the Firestore query, not client-side,
 * otherwise non-admin users will get permission errors.
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
    // Build query with optional userId filter
    // For non-admins, userId MUST be provided to satisfy security rules
    let q;
    if (userId) {
      // Query with userId filter - required for non-admins
      q = query(
        collection(db, '_metrics'),
        where('userId', '==', userId),
        orderBy('timestamp', 'desc'),
        limit(maxResults)
      );
    } else {
      // Query without userId filter - only works for admins
      q = query(
        collection(db, '_metrics'),
        orderBy('timestamp', 'desc'),
        limit(maxResults)
      );
    }

    const snapshot = await getDocs(q);
    let results = snapshot.docs.map(doc => ({
      ...(doc.data() as ProcessingMetric),
      id: doc.id  // Include Firestore document ID for detail views
    }));

    // Apply status filter client-side (minor optimization potential but keeps code simple)
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

// =============================================================================
// Cost Aggregation Helpers
// =============================================================================

/**
 * Cost summary with both actual and estimated values
 */
export interface CostSummary {
  estimated: number;           // Sum of estimatedCost.totalUsd
  actual: number;              // Sum of actualCost.geminiUsd (only covers Gemini, not WhisperX)
  actualCoverage: number;      // Percentage of jobs with actual cost data (0-100)
  jobsWithActual: number;      // Number of jobs with actual cost synced
  totalJobs: number;           // Total number of jobs
}

/**
 * Calculate cost summary from an array of processing metrics
 * Actual cost only covers Gemini (from BigQuery), estimated covers all services
 */
export function calculateCostSummary(metrics: ProcessingMetric[]): CostSummary {
  let estimated = 0;
  let actual = 0;
  let jobsWithActual = 0;

  for (const m of metrics) {
    if (m.estimatedCost?.totalUsd) {
      estimated += m.estimatedCost.totalUsd;
    }
    if (m.actualCost?.geminiUsd) {
      actual += m.actualCost.geminiUsd;
      jobsWithActual++;
    }
  }

  return {
    estimated,
    actual,
    actualCoverage: metrics.length > 0 ? (jobsWithActual / metrics.length) * 100 : 0,
    jobsWithActual,
    totalJobs: metrics.length
  };
}

/**
 * Get the best available cost for a metric
 * Returns actual if available, otherwise estimated
 */
export function getBestCost(metric: ProcessingMetric): {
  value: number;
  type: 'actual' | 'estimated' | 'none';
  geminiActual?: number;
  geminiEstimated?: number;
} {
  const hasActual = !!metric.actualCost?.geminiUsd;
  const hasEstimated = !!metric.estimatedCost?.totalUsd;

  if (hasActual) {
    return {
      value: metric.actualCost!.geminiUsd,
      type: 'actual',
      geminiActual: metric.actualCost!.geminiUsd,
      geminiEstimated: metric.estimatedCost?.geminiUsd
    };
  }
  if (hasEstimated) {
    return {
      value: metric.estimatedCost!.totalUsd,
      type: 'estimated',
      geminiEstimated: metric.estimatedCost?.geminiUsd
    };
  }
  return { value: 0, type: 'none' };
}

/**
 * Calculate variance between actual and estimated costs
 * Positive variance = actual > estimated (costs more than expected)
 * Negative variance = actual < estimated (costs less than expected)
 */
export function calculateCostVariance(actual: number, estimated: number): {
  absolute: number;
  percentage: number;
  status: 'over' | 'under' | 'match';
} {
  const absolute = actual - estimated;
  const percentage = estimated > 0 ? (absolute / estimated) * 100 : 0;

  let status: 'over' | 'under' | 'match';
  if (Math.abs(percentage) < 5) {
    status = 'match';
  } else if (absolute > 0) {
    status = 'over';
  } else {
    status = 'under';
  }

  return { absolute, percentage, status };
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

// =============================================================================
// New Functions for Cost Verification & Chat Metrics
// =============================================================================

/**
 * Get single metric by document ID
 */
export async function getMetricById(metricId: string): Promise<ProcessingMetric | ChatMetric | null> {
  try {
    const docRef = doc(db, '_metrics', metricId);
    const snapshot = await getDoc(docRef);

    if (!snapshot.exists()) {
      console.warn('[MetricsService] No metric found with ID:', metricId);
      return null;
    }

    const docData = snapshot.data();
    const data = { ...docData, id: snapshot.id };
    // Check if it's a chat metric or processing metric
    if ('type' in docData && docData.type === 'chat') {
      return data as ChatMetric;
    }
    return data as ProcessingMetric;
  } catch (error) {
    console.error('[MetricsService] Failed to fetch metric by ID:', error);
    throw error;
  }
}

/**
 * Get chat metrics with optional filtering
 */
export async function getChatMetrics(options?: {
  conversationId?: string;
  maxResults?: number;
  startDate?: Date;
  endDate?: Date;
}): Promise<ChatMetric[]> {
  try {
    const { conversationId, maxResults = 100, startDate, endDate } = options || {};

    // Build query constraints
    const constraints = [
      where('type', '==', 'chat'),
      orderBy('timestamp', 'desc')
    ];

    if (conversationId) {
      constraints.unshift(where('conversationId', '==', conversationId));
    }

    if (startDate) {
      constraints.push(where('timestamp', '>=', Timestamp.fromDate(startDate)));
    }

    if (endDate) {
      constraints.push(where('timestamp', '<=', Timestamp.fromDate(endDate)));
    }

    const q = query(collection(db, '_metrics'), ...constraints, limit(maxResults));
    const snapshot = await getDocs(q);

    return snapshot.docs.map(doc => ({
      ...(doc.data() as ChatMetric),
      id: doc.id  // Include Firestore document ID for detail views
    }));
  } catch (error) {
    console.error('[MetricsService] Failed to fetch chat metrics:', error);
    throw error;
  }
}

/**
 * Cost variance status type
 */
export type VarianceStatus = 'match' | 'minor' | 'significant';

/**
 * Pricing accuracy information for user display
 */
export interface PricingAccuracyInfo {
  status: VarianceStatus;
  capturedAt: Date | null;
  label: string;
  hasSnapshot: boolean;
}

/**
 * Get pricing accuracy status from recent metrics
 *
 * Finds the most recent metric with a pricing snapshot and calculates variance.
 * Used for the My Stats pricing accuracy indicator.
 */
export async function getPricingAccuracyStatus(
  metrics: ProcessingMetric[]
): Promise<PricingAccuracyInfo> {
  // Find most recent metric with a pricing snapshot
  const metricWithSnapshot = metrics.find(m => m.pricingSnapshot);

  if (!metricWithSnapshot || !metricWithSnapshot.pricingSnapshot) {
    return {
      status: 'match',
      capturedAt: null,
      label: 'No pricing data available',
      hasSnapshot: false
    };
  }

  // Recalculate using current pricing
  const verification = await recalculateCostWithCurrentPricing(metricWithSnapshot);

  // If no current pricing is configured, we can't actually verify accuracy
  if (!verification.foundCurrentPricing) {
    return {
      status: 'minor',  // Use 'minor' (yellow) to indicate caution
      capturedAt: metricWithSnapshot.pricingSnapshot.capturedAt.toDate(),
      label: 'No pricing configured — unable to verify',
      hasSnapshot: true
    };
  }

  // Generate user-friendly label
  const labels: Record<VarianceStatus, string> = {
    match: 'Pricing matches current rates',
    minor: 'Minor pricing variance (<5%)',
    significant: 'Significant pricing variance (>5%)'
  };

  return {
    status: verification.status,
    capturedAt: metricWithSnapshot.pricingSnapshot.capturedAt.toDate(),
    label: labels[verification.status],
    hasSnapshot: true
  };
}

/**
 * Recalculate cost using current pricing vs stored snapshot
 */
export async function recalculateCostWithCurrentPricing(
  metric: ProcessingMetric | ChatMetric
): Promise<{
  originalUsd: number;
  recalculatedUsd: number;
  variance: number;
  variancePercent: number;
  status: VarianceStatus;
  foundCurrentPricing: boolean;  // True if we found any current pricing to compare against
}> {
  try {
    // Determine original cost
    let originalUsd = 0;
    if ('estimatedCost' in metric && metric.estimatedCost) {
      originalUsd = metric.estimatedCost.totalUsd;
    } else if ('costUsd' in metric) {
      originalUsd = metric.costUsd;
    }

    // If no pricing snapshot, can't recalculate - return original as both
    if (!metric.pricingSnapshot) {
      return {
        originalUsd,
        recalculatedUsd: originalUsd,
        variance: 0,
        variancePercent: 0,
        status: 'match',
        foundCurrentPricing: false
      };
    }

    // Track whether we found any current pricing configs
    let foundAnyPricing = false;

    // Recalculate based on metric type
    let recalculatedUsd = 0;

    if ('type' in metric && metric.type === 'chat') {
      // Chat metric recalculation
      const chatMetric = metric as ChatMetric;
      const currentPricing = await getCurrentPricing(chatMetric.tokenUsage.model);

      if (currentPricing) {
        foundAnyPricing = true;
        const inputCost = (chatMetric.tokenUsage.inputTokens / 1_000_000) *
          (currentPricing.inputPricePerMillion || 0);
        const outputCost = (chatMetric.tokenUsage.outputTokens / 1_000_000) *
          (currentPricing.outputPricePerMillion || 0);
        recalculatedUsd = inputCost + outputCost;
      } else {
        // No current pricing found, use snapshot
        recalculatedUsd = originalUsd;
      }
    } else {
      // Processing metric recalculation
      const processingMetric = metric as ProcessingMetric;

      if (!processingMetric.llmUsage) {
        return {
          originalUsd,
          recalculatedUsd: originalUsd,
          variance: 0,
          variancePercent: 0,
          status: 'match',
          foundCurrentPricing: false
        };
      }

      // Recalculate Gemini costs with audio/text breakdown if available
      // Audio input pricing from 'gemini-2.5-flash', text input from 'gemini-2.5-flash-text'
      const geminiAudioPricing = await getCurrentPricing('gemini-2.5-flash');
      const geminiTextPricing = await getCurrentPricing('gemini-2.5-flash-text');
      let geminiUsd = 0;

      // Calculate geminiAnalysis costs
      const analysis = processingMetric.llmUsage.geminiAnalysis;
      if (analysis) {
        if (geminiAudioPricing || geminiTextPricing) foundAnyPricing = true;

        // Use detailed breakdown if available, else fall back to inputTokens with text rate
        const audioTokens = analysis.audioInputTokens ?? 0;
        const textTokens = analysis.textInputTokens ?? (audioTokens === 0 ? analysis.inputTokens : 0);

        const audioCost = (audioTokens / 1_000_000) * (geminiAudioPricing?.inputPricePerMillion || 0);
        const textCost = (textTokens / 1_000_000) * (geminiTextPricing?.inputPricePerMillion || 0);
        const outputCost = (analysis.outputTokens / 1_000_000) * (geminiAudioPricing?.outputPricePerMillion || 0);

        geminiUsd += audioCost + textCost + outputCost;
      }

      // Add speaker correction if exists
      if (processingMetric.llmUsage.geminiSpeakerCorrection) {
        const correction = processingMetric.llmUsage.geminiSpeakerCorrection;

        // Speaker correction is always text input (no audio)
        const textTokens = correction.textInputTokens ?? correction.inputTokens;

        const textCost = (textTokens / 1_000_000) * (geminiTextPricing?.inputPricePerMillion || 0);
        const outputCost = (correction.outputTokens / 1_000_000) * (geminiAudioPricing?.outputPricePerMillion || 0);

        geminiUsd += textCost + outputCost;
      }

      // Recalculate WhisperX cost (includes diarization - single Replicate model)
      let whisperxUsd = 0;
      if (processingMetric.llmUsage.whisperx) {
        const whisperxPricing = await getCurrentPricing(processingMetric.llmUsage.whisperx.model);
        if (whisperxPricing && whisperxPricing.pricePerSecond) {
          foundAnyPricing = true;
          whisperxUsd = processingMetric.llmUsage.whisperx.computeTimeSeconds * whisperxPricing.pricePerSecond;
        }
      }

      recalculatedUsd = geminiUsd + whisperxUsd;
    }

    // Calculate variance
    const variance = recalculatedUsd - originalUsd;
    const variancePercent = originalUsd > 0 ? Math.abs(variance / originalUsd) * 100 : 0;

    // Determine status based on variance thresholds
    let status: VarianceStatus = 'match';
    if (variancePercent > 5) {
      status = 'significant';
    } else if (variancePercent > 1) {
      status = 'minor';
    }

    return {
      originalUsd,
      recalculatedUsd,
      variance,
      variancePercent,
      status,
      foundCurrentPricing: foundAnyPricing
    };
  } catch (error) {
    console.error('[MetricsService] Failed to recalculate cost:', error);
    // Return original values on error
    const originalUsd = ('estimatedCost' in metric && metric.estimatedCost)
      ? metric.estimatedCost.totalUsd
      : ('costUsd' in metric ? metric.costUsd : 0);

    return {
      originalUsd,
      recalculatedUsd: originalUsd,
      variance: 0,
      variancePercent: 0,
      status: 'match',
      foundCurrentPricing: false
    };
  }
}

/**
 * Result of per-service cost recalculation
 */
export interface CostBreakdown {
  geminiUsd: number;
  whisperxUsd: number;  // Includes diarization
  chatUsd: number;
  totalUsd: number;
  foundPricing: boolean;
  // Per-service pricing status for granular "no pricing" detection
  foundGeminiPricing: boolean;
  foundWhisperxPricing: boolean;
  foundChatPricing: boolean;
}

/**
 * Find the best matching pricing config for a model from pre-loaded configs.
 * Matches configs where effectiveFrom <= metric timestamp and no effectiveUntil or effectiveUntil > timestamp.
 */
function findPricingForModel(
  model: string,
  pricingConfigs: PricingConfig[],
  atTime: Date
): PricingConfig | null {
  // Filter to configs for this model that are effective at the given time
  const candidates = pricingConfigs.filter(config => {
    if (config.model !== model) return false;
    const effectiveFrom = config.effectiveFrom.toDate();
    if (effectiveFrom > atTime) return false;
    if (config.effectiveUntil) {
      const effectiveUntil = config.effectiveUntil.toDate();
      if (effectiveUntil <= atTime) return false;
    }
    return true;
  });

  if (candidates.length === 0) return null;

  // Return the most recent one (highest effectiveFrom)
  return candidates.reduce((best, current) => {
    const bestDate = best.effectiveFrom.toDate();
    const currentDate = current.effectiveFrom.toDate();
    return currentDate > bestDate ? current : best;
  });
}

/**
 * Recalculate cost breakdown synchronously using pre-loaded pricing configs.
 *
 * Unlike recalculateCostWithCurrentPricing, this doesn't query Firestore.
 * Useful for batch processing in reports where pricing is already loaded.
 */
export function recalculateCostBreakdownSync(
  metric: ProcessingMetric | ChatMetric,
  pricingConfigs: PricingConfig[]
): CostBreakdown {
  const timestamp = metric.timestamp.toDate?.() || new Date(metric.timestamp as unknown as string);
  let foundPricing = false;

  // Handle chat metrics
  if ('type' in metric && metric.type === 'chat') {
    const chatMetric = metric as ChatMetric;
    const pricing = findPricingForModel(chatMetric.tokenUsage.model, pricingConfigs, timestamp);

    if (pricing) {
      const inputCost = (chatMetric.tokenUsage.inputTokens / 1_000_000) *
        (pricing.inputPricePerMillion || 0);
      const outputCost = (chatMetric.tokenUsage.outputTokens / 1_000_000) *
        (pricing.outputPricePerMillion || 0);
      const chatUsd = inputCost + outputCost;

      return {
        geminiUsd: 0,
        whisperxUsd: 0,
        chatUsd,
        totalUsd: chatUsd,
        foundPricing: true,
        foundGeminiPricing: false,
        foundWhisperxPricing: false,
        foundChatPricing: true
      };
    }

    // No pricing found, use original
    return {
      geminiUsd: 0,
      whisperxUsd: 0,
      chatUsd: chatMetric.costUsd,
      totalUsd: chatMetric.costUsd,
      foundPricing: false,
      foundGeminiPricing: false,
      foundWhisperxPricing: false,
      foundChatPricing: false
    };
  }

  // Handle processing metrics
  const processingMetric = metric as ProcessingMetric;

  if (!processingMetric.llmUsage) {
    return {
      geminiUsd: processingMetric.estimatedCost?.geminiUsd || 0,
      whisperxUsd: processingMetric.estimatedCost?.whisperxUsd || 0,
      chatUsd: 0,
      totalUsd: processingMetric.estimatedCost?.totalUsd || 0,
      foundPricing: false,
      foundGeminiPricing: false,
      foundWhisperxPricing: false,
      foundChatPricing: false
    };
  }

  // Recalculate Gemini costs (or fall back to estimate if no pricing found)
  let geminiUsd = processingMetric.estimatedCost?.geminiUsd || 0;
  let foundGeminiPricing = false;

  const geminiPricing = findPricingForModel(
    processingMetric.llmUsage.geminiAnalysis.model,
    pricingConfigs,
    timestamp
  );

  if (geminiPricing) {
    foundPricing = true;
    foundGeminiPricing = true;
    const inputCost = (processingMetric.llmUsage.geminiAnalysis.inputTokens / 1_000_000) *
      (geminiPricing.inputPricePerMillion || 0);
    const outputCost = (processingMetric.llmUsage.geminiAnalysis.outputTokens / 1_000_000) *
      (geminiPricing.outputPricePerMillion || 0);
    geminiUsd = inputCost + outputCost;
  }

  // Add speaker correction if exists
  if (processingMetric.llmUsage.geminiSpeakerCorrection) {
    const speakerPricing = findPricingForModel(
      processingMetric.llmUsage.geminiSpeakerCorrection.model,
      pricingConfigs,
      timestamp
    );
    if (speakerPricing) {
      foundPricing = true;
      // Only add to recalculated if we're recalculating Gemini
      if (foundGeminiPricing) {
        const inputCost = (processingMetric.llmUsage.geminiSpeakerCorrection.inputTokens / 1_000_000) *
          (speakerPricing.inputPricePerMillion || 0);
        const outputCost = (processingMetric.llmUsage.geminiSpeakerCorrection.outputTokens / 1_000_000) *
          (speakerPricing.outputPricePerMillion || 0);
        geminiUsd += inputCost + outputCost;
      }
    }
  }

  // Recalculate WhisperX cost (includes diarization - single Replicate model)
  let whisperxUsd = processingMetric.estimatedCost?.whisperxUsd || 0;
  let foundWhisperxPricing = false;
  if (processingMetric.llmUsage.whisperx) {
    const whisperxPricing = findPricingForModel(
      processingMetric.llmUsage.whisperx.model,
      pricingConfigs,
      timestamp
    );
    if (whisperxPricing && whisperxPricing.pricePerSecond) {
      foundPricing = true;
      foundWhisperxPricing = true;
      whisperxUsd = processingMetric.llmUsage.whisperx.computeTimeSeconds * whisperxPricing.pricePerSecond;
    }
  }

  return {
    geminiUsd,
    whisperxUsd,
    chatUsd: 0,
    totalUsd: geminiUsd + whisperxUsd,
    foundPricing,
    foundGeminiPricing,
    foundWhisperxPricing,
    foundChatPricing: false
  };
}
