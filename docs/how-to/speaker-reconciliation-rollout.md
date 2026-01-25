# Speaker Reconciliation Rollout Guide

Manage the context-aware speaker reconciliation feature flag and monitor rollout health.

## Overview

Context-aware speaker reconciliation uses temporal signals and boundary bridging to improve speaker identification across chunk boundaries. This guide covers:

- Enabling the feature flag and adjusting rollout percentage
- Monitoring reconciliation quality in the Admin Dashboard
- Responding to auto-disable events
- Manual rollback procedures

## Feature Flag Location

Feature flags are stored in Firestore at:

```
/system/feature_flags
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `enableContextAwareReconciliation` | boolean | Master kill switch |
| `contextAwareRolloutPercentage` | number (0-100) | Percentage of conversations using context-aware |
| `forceEmbeddingOnlyConversationIds` | string[] | Override list for specific conversations |
| `disabledAt` | timestamp | Set when auto-disabled by alert handler |
| `disableReason` | string | Human-readable reason for auto-disable |
| `updatedAt` | timestamp | Last modification time |

## Automatic Initialization (CI/CD)

The feature flags document is **automatically created** during Firebase deployment if it doesn't already exist. This ensures a consistent baseline configuration across environments.

### How It Works

1. After Cloud Functions deploy, the CI/CD pipeline runs `scripts/init-feature-flags.js`
2. The script checks if `/system/feature_flags` exists
3. If missing, it creates the document with production-ready defaults:
   - `enableContextAwareReconciliation: true`
   - `contextAwareRolloutPercentage: 100`
   - `forceEmbeddingOnlyConversationIds: []`
4. If the document already exists, **existing values are preserved** (no overwrites)

### Deployment Logs

The deployment output shows initialization status:

```
# Fresh deployment (document created)
Initializing feature flags...
✓ Feature flags initialized with defaults
  Values: {"enableContextAwareReconciliation":true,"contextAwareRolloutPercentage":100,"forceEmbeddingOnlyConversationIds":[]}

# Subsequent deployment (document preserved)
Initializing feature flags...
✓ Feature flags already initialized
  Current values: {"enableContextAwareReconciliation":true,"contextAwareRolloutPercentage":50,...}
```

### Manual Initialization (Fallback)

If you need to create the feature flags document manually (e.g., before first deployment or in a fresh environment), you can:

**Option 1: Run the script locally**
```bash
# Requires gcloud auth or service account credentials
node scripts/init-feature-flags.js YOUR_PROJECT_ID
```

**Option 2: Create via Firebase Console**

Navigate to Firestore > `/system/feature_flags` and create the document with the fields listed in the table above.

## Rollout Procedure

### Step 1: Pre-flight Checks

Before enabling, verify:

1. **Cloud Monitoring setup** (see [Monitoring Setup](#monitoring-setup))
2. **Recent deployment** includes the feature flag code
3. **No active incidents** in the processing pipeline

### Step 2: Enable at Low Rollout

Start with 10% rollout to catch issues early:

```javascript
// In Firebase Console > Firestore > /system/feature_flags
{
  "enableContextAwareReconciliation": true,
  "contextAwareRolloutPercentage": 10,
  "forceEmbeddingOnlyConversationIds": []
}
```

Or via Firebase Admin SDK:

```typescript
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const db = getFirestore();
await db.doc('system/feature_flags').set({
  enableContextAwareReconciliation: true,
  contextAwareRolloutPercentage: 10,
  forceEmbeddingOnlyConversationIds: [],
  updatedAt: FieldValue.serverTimestamp()
}, { merge: true });
```

### Step 3: Monitor Quality

1. Open Admin Dashboard > **Quality** tab
2. Watch for:
   - Average confidence staying above 65%
   - Warning count not spiking
   - Latency within acceptable bounds (< 5s P95)

### Step 4: Gradual Rollout

Increase percentage after confirming stability at each level:

| Day | Percentage | Duration | Go/No-Go Criteria |
|-----|------------|----------|-------------------|
| 1 | 10% | 24h | < 2% warnings, avg confidence > 70% |
| 2 | 25% | 24h | < 3% warnings, no auto-disable |
| 3-4 | 50% | 48h | Stable metrics, no user complaints |
| 5+ | 100% | Ongoing | Full rollout |

### Step 5: Full Rollout

Once confident, enable for all conversations:

```javascript
{
  "enableContextAwareReconciliation": true,
  "contextAwareRolloutPercentage": 100,
  "forceEmbeddingOnlyConversationIds": []
}
```

## Monitoring Setup

### Prerequisites

The following must be configured in Google Cloud Console:

1. **Log-based metrics** (Monitoring > Log-based Metrics)
2. **Alert policy** (Monitoring > Alerting)
3. **Pub/Sub topic and subscription** (Pub/Sub)

### 1. Create Log-Based Metrics

Navigate to **Monitoring > Log-based Metrics > Create Metric**.

**Metric: reconciliation_errors**

```
Filter:
resource.type="cloud_function"
jsonPayload.eventType="reconciliation_error"

Labels:
strategy: jsonPayload.strategy
errorType: jsonPayload.errorType
```

**Metric: reconciliation_completed**

```
Filter:
resource.type="cloud_function"
jsonPayload.eventType="reconciliation_completed"

Labels:
strategy: jsonPayload.strategy
warning: jsonPayload.warning
```

### 2. Create Pub/Sub Topic

```bash
# Create topic for alert notifications
gcloud pubsub topics create reconciliation-alerts

# Grant Cloud Monitoring permission to publish
gcloud pubsub topics add-iam-policy-binding reconciliation-alerts \
  --member="serviceAccount:cloud-monitoring-alerts@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```

### 3. Create Notification Channel

In Cloud Monitoring > Alerting > Notification channels:

1. Click **Add new** > **Pub/Sub**
2. Select project and topic `reconciliation-alerts`
3. Name it "Reconciliation Auto-Disable"
4. Save and note the channel ID

### 4. Create Alert Policy

Navigate to **Monitoring > Alerting > Create Policy**.

**Condition:**
- Metric: `logging.googleapis.com/user/reconciliation_errors`
- Aggregator: Sum
- Rolling window: 5 minutes
- Threshold: error rate > 5% of total reconciliations

**Configuration (JSON):**

<!-- pragma: allowlist nextline secret -->
```json
{
  "displayName": "Speaker Reconciliation Error Rate > 5%",
  "conditions": [{
    "displayName": "Error rate exceeded",
    "conditionThreshold": {
      "filter": "metric.type=\"logging.googleapis.com/user/reconciliation_errors\"",
      "comparison": "COMPARISON_GT",
      "thresholdValue": 0.05,
      "duration": "300s",
      "aggregations": [{
        "alignmentPeriod": "300s",
        "perSeriesAligner": "ALIGN_RATE"
      }]
    }
  }],
  "notificationChannels": ["projects/my-project/notificationChannels/12345"],
  "alertStrategy": {
    "autoClose": "604800s"
  }
}
```

## Auto-Disable Behavior

When the alert fires:

1. Cloud Monitoring publishes to `reconciliation-alerts` topic
2. `handleReconciliationAlert` Cloud Function receives the message
3. Function sets `enableContextAwareReconciliation: false` and records:
   - `disabledAt`: timestamp of disable
   - `disableReason`: "Auto-disabled: error rate exceeded 5% threshold"

### Investigating Auto-Disable

1. Check Admin Dashboard > Quality tab for the disable banner
2. Review Cloud Logging for recent errors:

```
resource.type="cloud_function"
jsonPayload.eventType="reconciliation_error"
timestamp >= "2024-01-15T00:00:00Z"
```

3. Look for patterns in `errorType`:
   - `exception`: Code bug in reconciliation logic
   - `low_confidence`: Data quality or embedding issues
   - `timeout`: Performance problems
   - `missing_data`: Upstream processing failures

### Re-enabling After Investigation

Once the root cause is fixed:

```typescript
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const db = getFirestore();
await db.doc('system/feature_flags').set({
  enableContextAwareReconciliation: true,
  contextAwareRolloutPercentage: 10,  // Start low again
  disabledAt: FieldValue.delete(),
  disableReason: FieldValue.delete(),
  updatedAt: FieldValue.serverTimestamp()
}, { merge: true });
```

## Manual Rollback

For immediate rollback without waiting for auto-disable:

### Quick Disable (Firebase Console)

1. Go to Firestore > `/system/feature_flags`
2. Set `enableContextAwareReconciliation` to `false`
3. (Optional) Add reason: `disableReason: "Manual rollback: [reason]"`

### Override Specific Conversations

If issues are isolated to specific conversations:

```javascript
{
  "forceEmbeddingOnlyConversationIds": [
    "conversation-id-1",
    "conversation-id-2"
  ]
}
```

This keeps the feature enabled for other conversations while forcing problematic ones to use embedding-only reconciliation.

## Deterministic Rollout

Rollout uses SHA-256 hashing of conversation IDs to ensure:

- Same conversation always gets the same treatment
- No per-run drift or randomness
- Predictable debugging (if conversation X had issues, it will consistently use the same strategy)

```typescript
// Hash-based bucketing (0-99)
const bucket = hashConversationId(conversationId);
const useContextAware = bucket < rolloutPercentage;
```

## Admin Dashboard Quality Tab

The Quality tab shows:

### Feature Flag Status Banner
- Green: Context-aware enabled with rollout percentage
- Red: Auto-disabled with reason and timestamp
- Gray: Manually disabled

### Statistics Cards
- Total reconciliations and strategy breakdown
- Average confidence with low-confidence count
- Warning count and percentage
- Latency (average and P95)

### Strategy Distribution
Visual breakdown of context-aware vs embedding-only usage

### Recent Reconciliations Table
Per-reconciliation details including:
- Timestamp and conversation ID
- Strategy used
- Cluster count and confidence
- Latency and warning status

## Troubleshooting

### No metrics appearing in Quality tab

1. Verify Cloud Functions deployed with latest code:
   ```bash
   firebase deploy --only functions:processMerge
   ```

2. Check Firestore rules allow admin read of `_reconciliation_metrics`:
   ```javascript
   match /_reconciliation_metrics/{docId} {
     allow read: if isAdmin();
   }
   ```

3. Confirm multi-chunk conversations are being processed (single-chunk conversations don't trigger reconciliation)

### Auto-disable not triggering

1. Verify Pub/Sub topic exists:
   ```bash
   gcloud pubsub topics describe reconciliation-alerts
   ```

2. Check Cloud Function is deployed:
   ```bash
   gcloud functions describe handleReconciliationAlert --region us-central1
   ```

3. Verify alert policy is active in Cloud Monitoring

### High latency after rollout

1. Check `temporalBoosts` and `boundaryBridges` counts in metrics
2. Review chunk sizes - very large chunks increase processing time
3. Consider reducing rollout percentage while investigating

## Related Documentation

- [Architecture Reference](../reference/architecture.md) - System design overview
- [Deploy Guide](deploy.md) - Cloud Functions deployment
- [Cost Tracking Setup](cost-tracking-setup.md) - BigQuery billing integration
