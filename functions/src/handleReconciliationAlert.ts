/**
 * Reconciliation Alert Handler
 *
 * Pub/Sub handler that auto-disables context-aware speaker reconciliation
 * when Cloud Monitoring detects elevated error rates.
 *
 * Alert Flow:
 * 1. Log-based metric counts reconciliation_error events
 * 2. Alert policy fires when error rate > 5% in 5 minutes
 * 3. Alert publishes to 'reconciliation-alerts' Pub/Sub topic
 * 4. This function receives the alert and disables the feature flag
 *
 * Setup Requirements (manual, documented in rollout runbook):
 * - Create log-based metrics in Cloud Monitoring
 * - Create alert policy with Pub/Sub notification channel
 * - Create 'reconciliation-alerts' Pub/Sub topic
 */

import * as functions from 'firebase-functions/v1';
import { disableContextAwareReconciliation } from './featureFlags';

// ============================================================================
// Types
// ============================================================================

/**
 * Cloud Monitoring alert incident structure (subset of fields).
 * Full spec: https://cloud.google.com/monitoring/alerts/using-alerting-api
 */
interface MonitoringAlertIncident {
  incident_id?: string;
  policy_name?: string;
  condition_name?: string;
  summary?: string;
  state?: 'OPEN' | 'CLOSED';
  started_at?: number;
  ended_at?: number;
  url?: string;
  documentation?: {
    content?: string;
    mime_type?: string;
  };
}

interface MonitoringAlertMessage {
  incident?: MonitoringAlertIncident;
  version?: string;
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Handle Cloud Monitoring alerts for speaker reconciliation errors.
 *
 * When error rate exceeds threshold:
 * 1. Parse alert payload
 * 2. Disable context-aware reconciliation
 * 3. Log the action for audit trail
 *
 * Only acts on OPEN incidents (not CLOSED).
 */
export const handleReconciliationAlert = functions
  .runWith({
    memory: '256MB',
    timeoutSeconds: 60,
    // No secrets needed - uses Admin SDK
  })
  .pubsub.topic('reconciliation-alerts')
  .onPublish(async (message) => {
    console.log('[ReconciliationAlert] Received alert message');

    // Parse the alert payload
    let alertData: MonitoringAlertMessage;
    try {
      const rawData = message.data
        ? Buffer.from(message.data, 'base64').toString()
        : '{}';
      alertData = JSON.parse(rawData);
    } catch (parseError) {
      console.error('[ReconciliationAlert] Failed to parse alert payload:', parseError);
      // Log the raw data for debugging
      console.log('[ReconciliationAlert] Raw message data:', message.data);
      alertData = {};
    }

    const incident = alertData.incident;

    console.log('[ReconciliationAlert] Alert details:', {
      incidentId: incident?.incident_id,
      policyName: incident?.policy_name,
      conditionName: incident?.condition_name,
      state: incident?.state,
      summary: incident?.summary
    });

    // Only act on OPEN incidents (not CLOSED/resolved)
    if (incident?.state === 'CLOSED') {
      console.log('[ReconciliationAlert] Ignoring CLOSED incident - no action needed');
      return;
    }

    // Build a descriptive reason for the disable
    const reason = buildDisableReason(incident);

    console.log('[ReconciliationAlert] Auto-disabling context-aware reconciliation:', {
      reason,
      incidentUrl: incident?.url
    });

    // Disable the feature flag
    await disableContextAwareReconciliation(reason);

    console.log('[ReconciliationAlert] ✅ Context-aware reconciliation auto-disabled');

    // Note: Future enhancement could add Slack/PagerDuty notification here
    // For now, rely on Cloud Monitoring's native notification channels
  });

/**
 * Build a human-readable disable reason from alert incident.
 */
function buildDisableReason(incident?: MonitoringAlertIncident): string {
  const parts: string[] = ['Auto-disabled: error rate exceeded 5% threshold'];

  if (incident?.policy_name) {
    parts.push(`Policy: ${incident.policy_name}`);
  }

  if (incident?.summary) {
    parts.push(`Summary: ${incident.summary}`);
  }

  if (incident?.incident_id) {
    parts.push(`Incident: ${incident.incident_id}`);
  }

  return parts.join('. ');
}
