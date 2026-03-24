# How to Set Up Cost Tracking and Billing Verification

Guide to setting up centralized billing exports and verifying actual costs against application estimates.

## Prerequisites

Before starting, ensure you have:

1. **GCP Billing Account Access**
   - A GCP billing account with payment method configured
   - `roles/billing.admin` or `roles/billing.projectManager` on the billing account
   - Run `gcloud billing accounts list` to verify access

2. **gcloud CLI Installed and Authenticated**
   ```bash
   gcloud auth login
   gcloud config set project audio-transcript-analyzer-01  # Your app project
   ```

3. **BigQuery API Enabled**
   - Will be enabled automatically when creating datasets
   - Or manually: `gcloud services enable bigquery.googleapis.com`

4. **Your Actual Billing Account ID**
   ```bash
   # Find your billing account ID (format: XXXXXX-XXXXXX-XXXXXX)
   gcloud billing accounts list

   # Save it for later steps
   export BILLING_ACCOUNT_ID="012345-6789AB-CDEFGH"  # Replace with your actual ID
   ```

## Architecture Overview

**Best Practice**: Create one centralized billing export at the billing account level, hosted in a dedicated "ops" project. Individual projects query their slice of the data.

```
Billing Account: 012345-6789AB-CDEFGH
├── Project: my-org-ops (hosts billing dataset)
│   └── BigQuery Dataset: billing_export
│       └── Table: gcp_billing_export_v1_YYYYMMDD
│           ├── Data for audio-transcript-app
│           ├── Data for other-app-prod
│           └── Data for other-app-dev
├── Project: audio-transcript-app
├── Project: other-app-prod
└── Project: other-app-dev
```

**Why Centralized?**
- Billing exports are configured at the billing account level (GCP's design)
- Single source of truth for all costs
- Enables cross-project cost analysis
- Simpler maintenance (one export configuration)

## Step 1: Create the Ops Project

Create a dedicated project to host billing data:

```bash
# Replace "my-org-ops" with your organization name
export OPS_PROJECT_ID="my-org-ops"

# Create the project
gcloud projects create $OPS_PROJECT_ID \
  --name="Ops and Billing" \
  --set-as-default=false

# Link to billing account (use your actual billing account ID)
gcloud billing projects link $OPS_PROJECT_ID \
  --billing-account=$BILLING_ACCOUNT_ID
```

**Troubleshooting**:
- If project ID is taken, add a suffix: `my-org-ops-billing`
- If you get `INVALID_ARGUMENT`, verify `$BILLING_ACCOUNT_ID` is correct
- Check permissions: You need billing admin or project manager role

## Step 2: Create BigQuery Dataset

Create a dataset in the ops project to hold billing data:

```bash
# Create the billing export dataset
bq mk \
  --project_id=$OPS_PROJECT_ID \
  --dataset \
  --location=US \
  --description="Centralized billing export for all projects" \
  billing_export

# Verify creation
bq ls --project=$OPS_PROJECT_ID
```

**Note**: Use `US` multi-region for billing exports (GCP requirement).

## Step 3: Enable Billing Export

**This must be done in the GCP Console** (not available via gcloud):

1. Go to [GCP Console - Billing](https://console.cloud.google.com/billing)
2. Select your billing account
3. Click **Billing export** in the left menu
4. Under **Detailed usage cost**, click **Edit Settings**
5. Configure:
   - **Project**: Select `my-org-ops` (your ops project)
   - **Dataset**: Select `billing_export`
   - Click **Save**

6. Verify:
   - You should see: "Exporting detailed usage cost data to BigQuery"
   - Data appears within 24-48 hours

## Step 4: Grant Access to Project Teams

Allow your application project's team to query billing data:

```bash
# Grant individual user access
gcloud projects add-iam-policy-binding $OPS_PROJECT_ID \
  --member="user:developer@example.com" \
  --role="roles/bigquery.dataViewer"

# Or grant group access (recommended for teams)
gcloud projects add-iam-policy-binding $OPS_PROJECT_ID \
  --member="group:eng-team@example.com" \
  --role="roles/bigquery.dataViewer"

# Grant service account access (for automated queries)
gcloud projects add-iam-policy-binding $OPS_PROJECT_ID \
  --member="serviceAccount:<service-account>@appspot.gserviceaccount.com" \
  --role="roles/bigquery.dataViewer"
```

## Step 5: Wait for Data Population

- **Initial delay**: 24-48 hours before first data appears
- **Update frequency**: Daily (data for previous day appears next day)
- **Data retention**: Billing export data is retained indefinitely

Check if data is available:

```bash
# List tables in billing_export dataset
bq ls --project_id=$OPS_PROJECT_ID billing_export

# You should see tables like:
# gcp_billing_export_v1_20260103
# gcp_billing_export_v1_20260102
# ...
```

## Querying Your Costs

### Find Your Project's Total Costs

```sql
-- Replace my-org-ops and audio-transcript-analyzer-01 with your values
SELECT
  service.description,
  SUM(cost) AS total_cost_usd,
  DATE(usage_start_time) AS date
FROM `my-org-ops.billing_export.gcp_billing_export_v1_*`
WHERE
  project.id = 'audio-transcript-analyzer-01'  -- Your app project
  AND _TABLE_SUFFIX >= FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
GROUP BY service.description, date
ORDER BY date DESC, total_cost_usd DESC;
```

### Verify Gemini Costs with Labels

Our application adds billing labels to track costs per conversation:

```sql
-- Find Gemini costs for a specific conversation
SELECT
  labels.value AS conversation_id,
  SUM(cost) AS actual_gemini_cost_usd,
  COUNT(*) AS api_calls
FROM `my-org-ops.billing_export.gcp_billing_export_v1_*`
CROSS JOIN UNNEST(labels) AS labels
WHERE
  project.id = 'audio-transcript-analyzer-01'
  AND service.description = 'Vertex AI API'
  AND labels.key = 'conversation_id'
  AND labels.value = 'c_1234567890'  -- Replace with your conversation ID
  AND _TABLE_SUFFIX >= FORMAT_DATE('%Y%m%d', CURRENT_DATE())
GROUP BY conversation_id;
```

### Compare Estimated vs Actual Costs

```sql
-- See all Gemini costs by call type
SELECT
  labels_conv.value AS conversation_id,
  labels_call.value AS call_type,
  SUM(cost) AS actual_cost_usd,
  COUNT(*) AS requests
FROM `my-org-ops.billing_export.gcp_billing_export_v1_*`
CROSS JOIN UNNEST(labels) AS labels_conv
CROSS JOIN UNNEST(labels) AS labels_call
WHERE
  project.id = 'audio-transcript-analyzer-01'
  AND service.description = 'Vertex AI API'
  AND labels_conv.key = 'conversation_id'
  AND labels_call.key = 'call_type'
  AND _TABLE_SUFFIX >= FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY))
GROUP BY conversation_id, call_type
ORDER BY actual_cost_usd DESC;
```

Then compare to your Firestore `_metrics` collection:

```typescript
// Fetch your app's estimate
const metricsRef = db.collection('_metrics');
const doc = await metricsRef
  .where('conversationId', '==', 'c_1234567890')
  .get();

const estimate = doc.docs[0].data().estimatedCost.geminiUsd;
console.log('App estimate:', estimate);
console.log('BigQuery actual:', actualFromQuery);
console.log('Difference:', Math.abs(estimate - actualFromQuery));
```

## Verify WhisperX (Cloud Run GPU) Costs

WhisperX runs on Cloud Run with an NVIDIA L4 GPU. Costs are included in your GCP billing export alongside other Cloud Run charges.

1. Query Cloud Run costs in BigQuery:
   ```sql
   SELECT
     SUM(cost) AS whisperx_cost_usd,
     DATE(usage_start_time) AS date
   FROM `my-org-ops.billing_export.gcp_billing_export_v1_*`
   WHERE
     project.id = 'audio-transcript-analyzer-01'
     AND service.description = 'Cloud Run'
     AND resource.name LIKE '%whisperx%'
     AND _TABLE_SUFFIX >= FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
   GROUP BY date
   ORDER BY date DESC;
   ```
2. Compare `computeTimeSeconds × $0.0023/sec` from your `_metrics` document to the actual Cloud Run charge

## Create Project-Specific Views (Optional)

For convenience, create an authorized view in your app project:

```sql
-- Run in BigQuery Console for your app project
CREATE OR REPLACE VIEW `audio-transcript-analyzer-01.analytics.my_billing_data` AS
SELECT *
FROM `my-org-ops.billing_export.gcp_billing_export_v1_*`
WHERE
  project.id = 'audio-transcript-analyzer-01'
  AND _TABLE_SUFFIX >= FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY));
```

Then authorize the view:

```bash
# Grant the view access to read from ops project
bq add-iam-policy-binding \
  --project_id=$OPS_PROJECT_ID \
  billing_export \
  --member="serviceAccount:audio-transcript-analyzer-01@appspot.gserviceaccount.com" \
  --role="roles/bigquery.dataViewer"
```

Now you can query `audio-transcript-analyzer-01.analytics.my_billing_data` without seeing other projects' costs.

## Verifying Cost Accuracy

### Current Pricing (as of January 2026)

Our application uses these rates (from [Vertex AI Pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing)):

- **Gemini 2.5 Flash**:
  - Input: $0.15 per 1M tokens (< 200K context)
  - Output: $0.60 per 1M tokens (no reasoning)
- **WhisperX (Cloud Run GPU)**:
  - Compute: $0.0023 per second (~$0.14/min)

### Manual Verification Example

From a `_metrics` document:
```json
{
  "llmUsage": {
    "geminiAnalysis": { "inputTokens": 16657, "outputTokens": 1296 },
    "geminiSpeakerCorrection": { "inputTokens": 4749, "outputTokens": 881 }
  },
  "estimatedCost": {
    "geminiUsd": 0.004517
  }
}
```

**Calculate manually**:
```
Total input:  16657 + 4749 = 21,406 tokens
Total output: 1296 + 881 = 2,177 tokens

Cost = (21,406 / 1,000,000) × $0.15 + (2,177 / 1,000,000) × $0.60
     = $0.003211 + $0.001306
     = $0.004517 ✓
```

If your BigQuery actual cost is within **±5%**, your estimates are accurate!

## Update Pricing in Firestore

Override default pricing by adding records to the `_pricing` collection:

```javascript
// Via Firebase Console or script
const admin = require('firebase-admin');
const db = admin.firestore();

await db.collection('_pricing').add({
  model: 'gemini-2.5-flash',
  service: 'gemini',
  inputPricePerMillion: 0.15,
  outputPricePerMillion: 0.60,
  effectiveFrom: admin.firestore.Timestamp.now(),
  effectiveUntil: null,  // null = current pricing
  notes: 'January 2026 pricing - https://cloud.google.com/vertex-ai/generative-ai/pricing',
  createdAt: admin.firestore.Timestamp.now(),
  updatedAt: admin.firestore.Timestamp.now()
});
```

This allows:
- Tracking price changes over time
- Recalculating historical costs with correct rates
- Easy pricing updates without code deployment

## Troubleshooting

### "No data in billing_export"

- Wait 24-48 hours after enabling export
- Verify export is enabled: GCP Console → Billing → Billing export
- Check you're querying the right project and dataset
- Ensure billing account has actual charges (free tier projects may not export)

### "Permission denied" errors

```bash
# Check your access
gcloud projects get-iam-policy $OPS_PROJECT_ID \
  --flatten="bindings[].members" \
  --format="table(bindings.role)" \
  --filter="bindings.members:user:$(gcloud config get-value account)"

# You need: roles/bigquery.dataViewer or higher
```

### "Table not found" errors

```bash
# List available tables
bq ls --project=$OPS_PROJECT_ID billing_export

# Table names use YYYYMMDD suffix
# Make sure your query uses the wildcard: gcp_billing_export_v1_*
```

### Estimates Don't Match Actuals

1. **Check pricing defaults** in `functions/src/metrics.ts`
2. **Add pricing records** to `_pricing` collection (see above)
3. **Wait 24-48h** for BigQuery to catch up
4. **Verify labels** are being sent (check `_metrics` documents for `geminiLabels` field)

## Next Steps

- **Set up alerts**: Create BigQuery scheduled queries that alert on cost spikes
- **Build dashboards**: Use Looker Studio to visualize billing_export data
- **Automate reconciliation**: Run periodic jobs comparing estimates to actuals
- **Track trends**: Monitor cost per conversation over time

## References

- [GCP Billing Export Documentation](https://cloud.google.com/billing/docs/how-to/export-data-bigquery)
- [Vertex AI Pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing)
- [BigQuery Standard SQL Reference](https://cloud.google.com/bigquery/docs/reference/standard-sql/query-syntax)
- Project Architecture: [`docs/reference/architecture.md`](../reference/architecture.md)
- Data Model: [`docs/reference/data-model.md`](../reference/data-model.md)
