/**
 * BigQuery Billing Sync
 *
 * Scheduled Cloud Function that fetches actual Gemini costs from BigQuery
 * billing exports and updates _metrics documents with real cost data.
 *
 * This enables true cost reconciliation by comparing:
 * - Estimated costs (calculated at processing time using configured rates)
 * - Actual costs (from BigQuery billing exports with our labels)
 *
 * The billing exports use labels we attach via llmMetadata.ts:
 * - conversation_id: Links costs to specific conversations
 * - user_id: Links costs to users
 * - call_type: 'analysis', 'speaker_correction', 'chat'
 *
 * Note: Billing data has 24-48 hour delay. We query a 7-day window to
 * catch any late-arriving data and avoid missing costs.
 */

import { onSchedule, ScheduledEvent } from 'firebase-functions/v2/scheduler';
import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { BigQuery } from '@google-cloud/bigquery';
import { Timestamp, WriteBatch } from 'firebase-admin/firestore';
import { db } from './index';
import { log } from './logger';
import { ActualCost } from './metrics';

// =============================================================================
// Configuration
// =============================================================================

// BigQuery billing export configuration
// The ops project hosts centralized billing exports for all projects
const BILLING_PROJECT_ID = 'wachtel-ops';
const BILLING_DATASET_ID = 'billing_export';
// Table name format: gcp_billing_export_resource_v1_{BILLING_ACCOUNT_ID}
// where billing account ID has dashes replaced with underscores
const BILLING_TABLE_ID = 'gcp_billing_export_resource_v1_01C7CD_A1C045_C0EF11';

// The project we're tracking costs for
const APP_PROJECT_ID = 'audio-transcript-analyzer-01';

// Service name in billing data (Gemini costs appear under Vertex AI)
const VERTEX_AI_SERVICE = 'Vertex AI';

// =============================================================================
// Types
// =============================================================================

/**
 * Result from BigQuery billing query
 */
interface BillingRow {
  conversation_id: string;
  actual_cost_usd: number;
  first_usage: Date;
  last_usage: Date;
}

/**
 * Summary of sync operation
 */
interface SyncResult {
  conversationsQueried: number;
  metricsFound: number;
  metricsUpdated: number;
  metricsAlreadySynced: number;
  totalActualCostUsd: number;
  errors: string[];
}

// =============================================================================
// BigQuery Client
// =============================================================================

// Lazy-load BigQuery client (avoids initialization at deploy time)
let bigQueryClient: BigQuery | null = null;

function getBigQueryClient(): BigQuery {
  if (!bigQueryClient) {
    // The default service account will be used for authentication
    // Cross-project access requires IAM binding in wachtel-ops
    bigQueryClient = new BigQuery({
      projectId: BILLING_PROJECT_ID,
    });
  }
  return bigQueryClient;
}

// =============================================================================
// Scheduled Function - Daily at 4 AM UTC
// =============================================================================

/**
 * Daily sync of actual Gemini costs from BigQuery billing exports.
 *
 * Runs at 4 AM UTC, after:
 * - GCP billing export (runs overnight)
 * - Daily stats aggregation (2 AM UTC)
 *
 * This gives billing data time to populate before we query it.
 */
export const syncBillingCosts = onSchedule(
  {
    schedule: '0 4 * * *',  // 4 AM UTC daily
    timeZone: 'UTC',
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 540  // 9 minutes (BigQuery can be slow)
  },
  async (event: ScheduledEvent) => {
    log.info('Starting billing sync', {
      scheduledTime: event.scheduleTime
    });

    try {
      const result = await performBillingSync();

      log.info('Billing sync complete', {
        conversationsQueried: result.conversationsQueried,
        metricsUpdated: result.metricsUpdated,
        metricsAlreadySynced: result.metricsAlreadySynced,
        totalActualCostUsd: result.totalActualCostUsd,
        errorCount: result.errors.length
      });

      if (result.errors.length > 0) {
        log.warn('Billing sync had errors', {
          errors: result.errors.slice(0, 10)  // Log first 10 errors
        });
      }

    } catch (error) {
      log.error('Billing sync failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;  // Re-throw to mark function as failed
    }
  }
);

// =============================================================================
// Diagnostic Function (for debugging labels)
// =============================================================================

/**
 * Diagnostic function to check what labels exist on Vertex AI usage.
 * This helps debug whether labels are reaching BigQuery at all.
 *
 * Returns:
 * - All unique label keys found on Vertex AI usage
 * - Sample values for each key
 * - Total Vertex AI costs (to confirm data exists)
 */
export const diagnoseBillingLabels = onCall(
  {
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 60
  },
  async (request: CallableRequest) => {
    // Check authentication
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be logged in');
    }

    const userId = request.auth.uid;

    // Check if user is admin
    const userDoc = await db.collection('users').doc(userId).get();
    const isAdmin = userDoc.exists && userDoc.data()?.isAdmin === true;

    if (!isAdmin) {
      throw new HttpsError('permission-denied', 'Only admins can diagnose billing');
    }

    log.info('Billing label diagnosis triggered', { userId });

    try {
      const client = getBigQueryClient();

      // Query 1: Get all unique label keys on Vertex AI usage
      const labelKeysQuery = `
        SELECT
          labels.key,
          COUNT(*) as occurrence_count,
          ARRAY_AGG(DISTINCT labels.value LIMIT 5) as sample_values
        FROM \`${BILLING_PROJECT_ID}.${BILLING_DATASET_ID}.${BILLING_TABLE_ID}\`
        CROSS JOIN UNNEST(labels) AS labels
        WHERE
          project.id = @appProjectId
          AND service.description = @serviceDescription
          AND _PARTITIONTIME >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
        GROUP BY labels.key
        ORDER BY occurrence_count DESC
      `;

      // Query 2: Get total Vertex AI costs (to confirm data exists)
      const totalCostQuery = `
        SELECT
          COUNT(*) as row_count,
          SUM(cost) as total_cost_usd,
          MIN(usage_start_time) as earliest_usage,
          MAX(usage_end_time) as latest_usage,
          COUNT(DISTINCT DATE(usage_start_time)) as days_with_usage
        FROM \`${BILLING_PROJECT_ID}.${BILLING_DATASET_ID}.${BILLING_TABLE_ID}\`
        WHERE
          project.id = @appProjectId
          AND service.description = @serviceDescription
          AND _PARTITIONTIME >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
      `;

      // Query 3: Check if ANY labels exist on Vertex AI rows
      const anyLabelsQuery = `
        SELECT
          COUNT(*) as rows_with_labels,
          COUNT(DISTINCT labels.key) as unique_label_keys
        FROM \`${BILLING_PROJECT_ID}.${BILLING_DATASET_ID}.${BILLING_TABLE_ID}\`
        CROSS JOIN UNNEST(labels) AS labels
        WHERE
          project.id = @appProjectId
          AND service.description = @serviceDescription
          AND _PARTITIONTIME >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
      `;

      const params = {
        appProjectId: APP_PROJECT_ID,
        serviceDescription: VERTEX_AI_SERVICE
      };

      // Query 4: Get conversation_id details with cost breakdown
      const conversationCostQuery = `
        SELECT
          labels.value AS conversation_id,
          SUM(cost) AS total_cost,
          SUM(CASE WHEN cost > 0 THEN cost ELSE 0 END) AS positive_cost,
          SUM(CASE WHEN cost <= 0 THEN cost ELSE 0 END) AS zero_or_negative_cost,
          COUNT(*) AS row_count
        FROM \`${BILLING_PROJECT_ID}.${BILLING_DATASET_ID}.${BILLING_TABLE_ID}\`
        CROSS JOIN UNNEST(labels) AS labels
        WHERE
          project.id = @appProjectId
          AND service.description = @serviceDescription
          AND labels.key = 'conversation_id'
          AND _PARTITIONTIME >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
        GROUP BY conversation_id
        ORDER BY total_cost DESC
        LIMIT 10
      `;

      const [labelKeysResult] = await client.query({ query: labelKeysQuery, params });
      const [totalCostResult] = await client.query({ query: totalCostQuery, params });
      const [anyLabelsResult] = await client.query({ query: anyLabelsQuery, params });
      const [conversationCostResult] = await client.query({ query: conversationCostQuery, params });

      return {
        success: true,
        diagnosis: {
          vertexAiUsage: totalCostResult[0] || { row_count: 0, total_cost_usd: 0 },
          labelsOverview: anyLabelsResult[0] || { rows_with_labels: 0, unique_label_keys: 0 },
          labelKeys: labelKeysResult.map((row: Record<string, unknown>) => ({
            key: row.key,
            occurrences: Number(row.occurrence_count),
            sampleValues: row.sample_values
          })),
          conversationCosts: conversationCostResult.map((row: Record<string, unknown>) => ({
            conversationId: String(row.conversation_id),
            totalCost: Number(row.total_cost),
            positiveCost: Number(row.positive_cost),
            zeroOrNegativeCost: Number(row.zero_or_negative_cost),
            rowCount: Number(row.row_count)
          }))
        },
        hint: labelKeysResult.length === 0
          ? 'No labels found on Vertex AI usage. Labels may take 24-48 hours to appear, or the SDK might not be propagating them correctly.'
          : conversationCostResult.length === 0
          ? 'Labels exist but no conversation_id costs found. Check if cost > 0 filter is too restrictive.'
          : 'Labels found! Check conversationCosts for details.'
      };

    } catch (error) {
      log.error('Billing diagnosis failed', {
        userId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw new HttpsError('internal', 'Diagnosis failed: ' + (error instanceof Error ? error.message : String(error)));
    }
  }
);

// =============================================================================
// Manual Trigger (for testing)
// =============================================================================

/**
 * HTTP-callable function to manually trigger billing sync.
 * Useful for testing, initial backfill, or after fixing data issues.
 *
 * Only admins can call this function.
 */
export const triggerBillingSync = onCall(
  {
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 540
  },
  async (request: CallableRequest) => {
    // Check authentication
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be logged in to trigger billing sync');
    }

    const userId = request.auth.uid;

    // Check if user is admin
    const userDoc = await db.collection('users').doc(userId).get();
    const isAdmin = userDoc.exists && userDoc.data()?.isAdmin === true;

    if (!isAdmin) {
      throw new HttpsError('permission-denied', 'Only admins can trigger billing sync');
    }

    log.info('Manual billing sync triggered', { userId });

    try {
      const result = await performBillingSync();

      return {
        success: true,
        ...result
      };

    } catch (error) {
      log.error('Manual billing sync failed', {
        userId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw new HttpsError('internal', 'Billing sync failed: ' + (error instanceof Error ? error.message : String(error)));
    }
  }
);

// =============================================================================
// Core Sync Logic
// =============================================================================

/**
 * Perform the actual billing sync operation.
 *
 * 1. Query BigQuery for Gemini costs in the last 7 days
 * 2. Group by conversation_id (from our labels)
 * 3. Find matching _metrics documents
 * 4. Update documents that don't already have actualCost
 */
async function performBillingSync(): Promise<SyncResult> {
  const result: SyncResult = {
    conversationsQueried: 0,
    metricsFound: 0,
    metricsUpdated: 0,
    metricsAlreadySynced: 0,
    totalActualCostUsd: 0,
    errors: []
  };

  // Query BigQuery for actual costs
  const billingData = await queryBillingCosts();
  result.conversationsQueried = billingData.length;

  if (billingData.length === 0) {
    log.info('No billing data found for the query period');
    return result;
  }

  // Get conversation IDs from billing data
  const conversationIds = billingData.map(row => row.conversation_id);

  // Find matching metrics documents
  // We need to batch this because Firestore 'in' queries are limited to 30 values
  const metricsMap = await findMetricsForConversations(conversationIds);
  result.metricsFound = metricsMap.size;

  // Calculate total actual cost
  result.totalActualCostUsd = billingData.reduce((sum, row) => sum + row.actual_cost_usd, 0);

  // Update metrics documents in batches
  const batchSize = 500;  // Firestore batch limit
  let batch: WriteBatch = db.batch();
  let batchCount = 0;

  for (const row of billingData) {
    const metricsDocRef = metricsMap.get(row.conversation_id);

    if (!metricsDocRef) {
      // No metrics doc found for this conversation
      // Could be a chat message or old data
      continue;
    }

    // Check if already has actualCost
    const doc = await metricsDocRef.get();
    const data = doc.data();

    if (data?.actualCost) {
      result.metricsAlreadySynced++;
      continue;
    }

    // Build actualCost update
    const actualCost: ActualCost = {
      geminiUsd: Math.round(row.actual_cost_usd * 1000000) / 1000000,  // 6 decimal precision
      fetchedAt: Timestamp.now(),
      source: 'bigquery_billing_export'
    };

    try {
      batch.update(metricsDocRef, { actualCost });
      batchCount++;
      result.metricsUpdated++;

      // Commit batch when it reaches the limit
      if (batchCount >= batchSize) {
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
        log.debug('Batch committed', { updatedSoFar: result.metricsUpdated });
      }
    } catch (error) {
      result.errors.push(`Failed to update ${row.conversation_id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Commit remaining batch
  if (batchCount > 0) {
    await batch.commit();
  }

  return result;
}

/**
 * Query BigQuery billing exports for Gemini/Vertex AI costs.
 *
 * Groups costs by conversation_id label, summing all costs for each
 * conversation over the past 7 days.
 */
async function queryBillingCosts(): Promise<BillingRow[]> {
  const client = getBigQueryClient();

  // Query costs from the last 7 days
  // Using literal strings instead of parameterized queries for reliability
  // The resource export table is day-partitioned on export_time
  const query = `
    SELECT
      labels.value AS conversation_id,
      SUM(cost) AS actual_cost_usd,
      MIN(usage_start_time) AS first_usage,
      MAX(usage_end_time) AS last_usage
    FROM \`${BILLING_PROJECT_ID}.${BILLING_DATASET_ID}.${BILLING_TABLE_ID}\`
    CROSS JOIN UNNEST(labels) AS labels
    WHERE
      project.id = '${APP_PROJECT_ID}'
      AND service.description = '${VERTEX_AI_SERVICE}'
      AND labels.key = 'conversation_id'
      AND _PARTITIONTIME >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
      AND cost > 0
    GROUP BY conversation_id
    ORDER BY actual_cost_usd DESC
  `;

  log.debug('Executing BigQuery billing query', {
    project: BILLING_PROJECT_ID,
    dataset: BILLING_DATASET_ID,
    table: BILLING_TABLE_ID,
    appProject: APP_PROJECT_ID
  });

  try {
    const [rows] = await client.query({ query });

    log.info('BigQuery query complete', {
      rowCount: rows.length
    });

    return rows.map((row: Record<string, unknown>) => ({
      conversation_id: String(row.conversation_id),
      actual_cost_usd: Number(row.actual_cost_usd),
      first_usage: row.first_usage as Date,
      last_usage: row.last_usage as Date
    }));

  } catch (error) {
    // Common errors:
    // - 403: Missing BigQuery permissions
    // - 404: Dataset/table not found (billing export not configured)
    log.error('BigQuery query failed', {
      error: error instanceof Error ? error.message : String(error),
      hint: 'Ensure service account has roles/bigquery.dataViewer on wachtel-ops project'
    });
    throw error;
  }
}

/**
 * Find _metrics documents for the given conversation IDs.
 *
 * Returns a map of conversationId -> DocumentReference for efficient lookup.
 * Handles Firestore's 30-item limit on 'in' queries by batching.
 */
async function findMetricsForConversations(
  conversationIds: string[]
): Promise<Map<string, FirebaseFirestore.DocumentReference>> {
  const metricsMap = new Map<string, FirebaseFirestore.DocumentReference>();

  // Firestore 'in' query limit is 30 (changed from 10 to 30 in recent versions)
  const batchSize = 30;

  for (let i = 0; i < conversationIds.length; i += batchSize) {
    const batch = conversationIds.slice(i, i + batchSize);

    const snapshot = await db.collection('_metrics')
      .where('conversationId', 'in', batch)
      .get();

    for (const doc of snapshot.docs) {
      const conversationId = doc.data().conversationId;
      if (conversationId) {
        metricsMap.set(conversationId, doc.ref);
      }
    }
  }

  return metricsMap;
}
