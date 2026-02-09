/**
 * Processing metrics collection
 *
 * Records timing and outcome data for each transcription job.
 * Stored in _metrics collection for analysis and monitoring.
 *
 * Extended in v1.4.0 to include:
 * - LLM usage (tokens, compute time) for cost tracking
 * - Estimated costs per service
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from './index';
import { log } from './logger';

// =============================================================================
// LLM Usage Types - Track usage for cost calculation
// =============================================================================

/**
 * Gemini API usage metrics (token-based pricing)
 * Audio and text inputs have different rates (see _pricing collection):
 * - Audio input tokens: used when sending raw audio to Gemini (pre-analysis)
 * - Text input tokens: used when sending transcript text to Gemini (analysis)
 */
export interface GeminiUsage {
  inputTokens: number;           // Total input tokens (backward compat, = audioInputTokens + textInputTokens)
  audioInputTokens?: number;     // Tokens from audio input (pre-analysis)
  textInputTokens?: number;      // Tokens from text input (transcript analysis)
  outputTokens: number;
  model: string;  // e.g., 'gemini-2.5-flash'
}

/**
 * Cloud Run WhisperX API usage metrics (compute-time pricing)
 * The whisper-diarization model handles both transcription AND speaker diarization in one call.
 */
export interface CloudRunWhisperUsage {
  predictionId?: string;  // Cloud Run request ID for audit trail
  computeTimeSeconds: number;
  model: string;  // e.g., 'whisperx' (includes diarization)
}

/**
 * LLM usage breakdown by service
 */
export interface LLMUsage {
  // Gemini Analysis Call (topics, terms, people, speaker notes)
  geminiAnalysis: GeminiUsage;
  // Gemini Speaker Reassignment Call
  geminiSpeakerCorrection: GeminiUsage;
  // WhisperX via Cloud Run (transcription + timestamps + speaker diarization)
  whisperx: CloudRunWhisperUsage;
}

/**
 * Estimated costs by service (USD)
 * Calculated using pricing from _pricing collection
 */
export interface EstimatedCost {
  geminiUsd: number;              // Combined Gemini costs (backward compat)
  geminiAudioInputUsd?: number;   // Gemini audio input cost ($1/1M tokens)
  geminiTextInputUsd?: number;    // Gemini text input cost ($0.30/1M tokens)
  geminiOutputUsd?: number;       // Gemini output cost ($2.50/1M tokens)
  whisperxUsd: number;            // WhisperX compute cost (includes diarization)
  totalUsd: number;               // Grand total
}

/**
 * Pricing snapshot captured at calculation time.
 * Preserves the exact rates used for billing reconciliation,
 * allowing historical cost recalculation even after prices change.
 */
export interface PricingSnapshot {
  capturedAt: Timestamp;
  geminiPricingId: string | null;      // _pricing doc ID used, or null if default
  whisperxPricingId: string | null;
  rates: {
    geminiInputPerMillion: number;           // Backward compat (text input rate)
    geminiAudioInputPerMillion?: number;     // Audio input rate ($1/1M)
    geminiTextInputPerMillion?: number;      // Text input rate ($0.30/1M)
    geminiOutputPerMillion: number;
    whisperxPerSecond: number;
  };
}

/**
 * Result from calculateCost including both the cost breakdown and pricing snapshot.
 * The snapshot allows auditing which rates were used for a given calculation.
 */
export interface CostResult {
  estimatedCost: EstimatedCost;
  pricingSnapshot: PricingSnapshot;
}

/**
 * Actual cost from BigQuery billing exports.
 * Fetched nightly by billingSync function.
 */
export interface ActualCost {
  geminiUsd: number;          // Actual Gemini/Vertex AI cost from BigQuery
  fetchedAt: Timestamp;       // When this data was fetched
  source: 'bigquery_billing_export';
}

// =============================================================================
// Processing Metrics - Enhanced with LLM usage
// =============================================================================

/**
 * Processing stage timings (in milliseconds)
 */
export interface ProcessingMetrics {
  conversationId: string;
  userId: string;
  status: 'success' | 'failed' | 'aborted';
  errorMessage?: string;
  alignmentStatus?: 'aligned' | 'fallback';

  // Stage timings (ms)
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

  // Result counts
  segmentCount: number;
  speakerCount: number;
  termCount: number;
  topicCount: number;
  personCount: number;
  speakerCorrectionsApplied: number;

  // Audio metadata
  audioSizeMB: number;
  durationMs: number;

  // NEW: LLM usage breakdown for cost tracking (added v1.4.0)
  llmUsage?: LLMUsage;

  // NEW: Gemini billing labels for cost attribution (added with Vertex AI migration)
  // Maps to BigQuery billing exports for automatic cost reconciliation
  geminiLabels?: Record<string, string>[];

  // NEW: Estimated costs in USD (calculated from _pricing collection)
  estimatedCost?: EstimatedCost;

  // NEW: Pricing snapshot for billing reconciliation (added for cost visibility)
  // Captures the exact rates used so costs can be audited even after price changes
  pricingSnapshot?: PricingSnapshot;

  // NEW: Actual cost from BigQuery billing exports (added by billingSync function)
  // This is the real cost from GCP billing, not an estimate
  actualCost?: ActualCost;

  // Timestamp
  timestamp: FieldValue;
}

// =============================================================================
// Pricing Types - For cost calculation (stored in _pricing collection)
// =============================================================================

/**
 * Pricing configuration for an LLM service
 * Stored in _pricing collection, editable via Admin Dashboard
 */
export interface PricingConfig {
  pricingId: string;
  model: string;              // 'gemini-2.5-flash', 'gemini-2.5-flash-text', 'whisperx'
  service: 'gemini' | 'cloud-run';

  // Token-based pricing (for Gemini)
  inputPricePerMillion?: number;   // USD per 1M input tokens
  outputPricePerMillion?: number;  // USD per 1M output tokens

  // Time-based pricing (for Cloud Run WhisperX)
  pricePerSecond?: number;         // USD per compute second

  // Validity period (allows price changes over time)
  effectiveFrom: Timestamp;        // Start date (inclusive)
  effectiveUntil?: Timestamp;      // End date (exclusive), null = current

  // Metadata
  notes?: string;                  // e.g., "Price increase Jan 2025"
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// =============================================================================
// Cost Calculation - Looks up pricing from _pricing collection
// =============================================================================

/**
 * Pricing must be configured in the _pricing collection.
 * If pricing is missing, costs will be calculated as $0 with a warning.
 *
 * Required pricing records:
 * - 'gemini-2.5-flash': audio input pricing (inputPricePerMillion, outputPricePerMillion)
 * - 'gemini-2.5-flash-text': text input pricing (inputPricePerMillion)
 * - 'whisperx': compute time pricing (pricePerSecond) - includes diarization
 */

/**
 * Get pricing for a specific model at a given timestamp.
 * Looks up the most recent pricing that was effective at that time.
 *
 * Exported for use by chatMetrics.ts and other modules needing live pricing.
 *
 * @param model - The model name (e.g., 'gemini-2.5-flash', 'whisperx')
 * @param atTimestamp - The timestamp to look up pricing for (defaults to now)
 * @returns PricingConfig if found, null if falling back to defaults
 */
export async function getPricingForModel(
  model: string,
  atTimestamp: Date = new Date()
): Promise<PricingConfig | null> {
  try {
    // Query for pricing configs that were effective at the given timestamp
    const snapshot = await db.collection('_pricing')
      .where('model', '==', model)
      .where('effectiveFrom', '<=', Timestamp.fromDate(atTimestamp))
      .orderBy('effectiveFrom', 'desc')
      .limit(1)
      .get();

    if (snapshot.empty) {
      return null;
    }

    const doc = snapshot.docs[0];
    const data = doc.data();

    // Check if this pricing has expired
    if (data.effectiveUntil && data.effectiveUntil.toDate() <= atTimestamp) {
      return null;
    }

    return {
      pricingId: doc.id,
      ...data
    } as PricingConfig;
  } catch (error) {
    log.warn('Failed to fetch pricing', {
      model,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

/**
 * Calculate estimated cost based on LLM usage and pricing from database.
 * Returns both the cost breakdown and a pricing snapshot for audit purposes.
 *
 * The pricingSnapshot captures which rates were used, enabling:
 * - Billing reconciliation with BigQuery exports
 * - Historical cost recalculation after price changes
 * - Audit trail for cost discrepancies
 */
export async function calculateCost(llmUsage: LLMUsage): Promise<CostResult> {
  const now = new Date();

  // Get pricing for each service (fall back to defaults if not in DB)
  const geminiPricing = await getPricingForModel('gemini-2.5-flash', now);
  const geminiTextPricing = await getPricingForModel('gemini-2.5-flash-text', now);
  const whisperxPricing = await getPricingForModel('whisperx', now);

  // Get audio and text input token counts
  // Audio tokens come from pre-analysis (raw audio sent to Gemini)
  // Text tokens come from transcript analysis (text sent to Gemini)
  const geminiAudioInputTokens =
    (llmUsage.geminiAnalysis.audioInputTokens ?? 0) +
    (llmUsage.geminiSpeakerCorrection.audioInputTokens ?? 0);
  const geminiTextInputTokens =
    (llmUsage.geminiAnalysis.textInputTokens ?? 0) +
    (llmUsage.geminiSpeakerCorrection.textInputTokens ?? 0);
  const geminiOutputTokens =
    llmUsage.geminiAnalysis.outputTokens + llmUsage.geminiSpeakerCorrection.outputTokens;

  // Fall back to total inputTokens if audio/text not specified (backward compat)
  const totalInputTokens = llmUsage.geminiAnalysis.inputTokens + llmUsage.geminiSpeakerCorrection.inputTokens;
  const hasDetailedBreakdown = geminiAudioInputTokens > 0 || geminiTextInputTokens > 0;

  // Get pricing rates from database (0 if not configured)
  // geminiPricing is for audio input (from 'gemini-2.5-flash')
  // geminiTextPricing is for text input (from 'gemini-2.5-flash-text')
  const audioInputPricePerMillion = geminiPricing?.inputPricePerMillion ?? 0;
  const textInputPricePerMillion = geminiTextPricing?.inputPricePerMillion ?? 0;
  const outputPricePerMillion = geminiPricing?.outputPricePerMillion ?? 0;
  const whisperxPerSecond = whisperxPricing?.pricePerSecond ?? 0;

  // Log warnings for missing pricing
  const missingPricing: string[] = [];
  if (!geminiPricing) missingPricing.push('gemini-2.5-flash');
  if (!geminiTextPricing) missingPricing.push('gemini-2.5-flash-text');
  if (!whisperxPricing) missingPricing.push('whisperx');

  if (missingPricing.length > 0) {
    log.warn('Missing pricing configuration - costs will be $0 for these services', {
      missingModels: missingPricing,
      stage: 'cost-calculation'
    });
  }

  // Calculate Gemini costs with separate audio/text rates
  let geminiAudioInputUsd = 0;
  let geminiTextInputUsd = 0;
  let geminiOutputUsd = (geminiOutputTokens / 1_000_000) * outputPricePerMillion;

  if (hasDetailedBreakdown) {
    // Use detailed breakdown
    geminiAudioInputUsd = (geminiAudioInputTokens / 1_000_000) * audioInputPricePerMillion;
    geminiTextInputUsd = (geminiTextInputTokens / 1_000_000) * textInputPricePerMillion;
  } else {
    // Backward compat: treat all input as text
    geminiTextInputUsd = (totalInputTokens / 1_000_000) * textInputPricePerMillion;
  }

  const geminiUsd = geminiAudioInputUsd + geminiTextInputUsd + geminiOutputUsd;

  // Calculate WhisperX cost (includes diarization - single Replicate model)
  const whisperxUsd = llmUsage.whisperx.computeTimeSeconds * whisperxPerSecond;

  const totalUsd = geminiUsd + whisperxUsd;

  // Build pricing snapshot for audit trail
  const pricingSnapshot: PricingSnapshot = {
    capturedAt: Timestamp.now(),
    geminiPricingId: geminiPricing?.pricingId ?? null,
    whisperxPricingId: whisperxPricing?.pricingId ?? null,
    rates: {
      geminiInputPerMillion: textInputPricePerMillion,  // Backward compat
      geminiAudioInputPerMillion: audioInputPricePerMillion,
      geminiTextInputPerMillion: textInputPricePerMillion,
      geminiOutputPerMillion: outputPricePerMillion,
      whisperxPerSecond
    }
  };

  const estimatedCost: EstimatedCost = {
    geminiUsd: Math.round(geminiUsd * 1000000) / 1000000,  // 6 decimal precision
    geminiAudioInputUsd: Math.round(geminiAudioInputUsd * 1000000) / 1000000,
    geminiTextInputUsd: Math.round(geminiTextInputUsd * 1000000) / 1000000,
    geminiOutputUsd: Math.round(geminiOutputUsd * 1000000) / 1000000,
    whisperxUsd: Math.round(whisperxUsd * 1000000) / 1000000,
    totalUsd: Math.round(totalUsd * 1000000) / 1000000
  };

  return { estimatedCost, pricingSnapshot };
}

/**
 * Record processing metrics to Firestore
 * Stored in _metrics collection for analysis
 */
export async function recordMetrics(metrics: Omit<ProcessingMetrics, 'timestamp'>): Promise<void> {
  try {
    const metricsWithTimestamp: ProcessingMetrics = {
      ...metrics,
      timestamp: FieldValue.serverTimestamp()
    };

    await db.collection('_metrics').add(metricsWithTimestamp);

    log.info('Metrics recorded', {
      conversationId: metrics.conversationId,
      stage: 'metrics',
      status: metrics.status,
      totalMs: metrics.timingMs.total
    });
  } catch (error) {
    // Don't fail the transcription if metrics recording fails
    // Just log the error
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.warn('Failed to record metrics', {
      conversationId: metrics.conversationId,
      stage: 'metrics',
      error: errorMessage
    });
  }
}
