# Reconciliation Monitoring Queries

Firestore queries for monitoring speaker reconciliation quality, fallback rates, and identifying problematic files.

## Overview

When processing large audio files in parallel mode, speaker reconciliation attempts to match speakers across independently-processed chunks. When confidence drops below the threshold (default: 0.75), the system falls back to sequential reprocessing.

This document provides queries for:
- Monitoring fallback rates
- Analyzing confidence distributions
- Finding failed reconciliations
- Identifying processing bottlenecks

## Firestore Queries

### 1. Daily Fallback Rate

Find conversations that triggered fallback in the last 7 days:

```javascript
// Firebase Console or Admin SDK
db.collection('conversations')
  .where('fallbackMetadata.triggeredAt', '>=', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
  .get()
  .then(snapshot => {
    console.log(`Fallbacks in last 7 days: ${snapshot.size}`);
    snapshot.forEach(doc => {
      const data = doc.data();
      console.log({
        id: doc.id,
        triggeredAt: data.fallbackMetadata.triggeredAt,
        parallelConfidence: data.fallbackMetadata.parallelConfidence,
        threshold: data.fallbackMetadata.configuredThreshold
      });
    });
  });
```

**What to watch for:**
- Fallback rate > 10%: May indicate threshold is too aggressive
- Fallback rate < 1%: Threshold may be too lenient (risking mislabeled transcripts)
- Target: 3-7% fallback rate

### 2. Confidence Distribution

Analyze confidence scores for successful reconciliations:

```javascript
// Get completed parallel conversations with reconciliation data
db.collection('conversations')
  .where('status', '==', 'complete')
  .where('processingMode', '==', 'parallel')
  .orderBy('createdAt', 'desc')
  .limit(100)
  .get()
  .then(snapshot => {
    const confidences = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.reconciliationConfidence !== undefined) {
        confidences.push({
          id: doc.id,
          confidence: data.reconciliationConfidence,
          speakers: data.reconciliationDetails?.clusterCount || 0
        });
      }
    });

    // Calculate distribution
    const buckets = { '0.9-1.0': 0, '0.8-0.9': 0, '0.7-0.8': 0, '<0.7': 0 };
    confidences.forEach(c => {
      if (c.confidence >= 0.9) buckets['0.9-1.0']++;
      else if (c.confidence >= 0.8) buckets['0.8-0.9']++;
      else if (c.confidence >= 0.7) buckets['0.7-0.8']++;
      else buckets['<0.7']++;
    });

    console.log('Confidence Distribution:', buckets);
    console.log('Average:', confidences.reduce((a, b) => a + b.confidence, 0) / confidences.length);
  });
```

**Interpreting results:**
- Most conversations should be in 0.8-1.0 range
- Significant <0.7 bucket suggests audio quality or speaker detection issues
- Use this to tune `RECONCILIATION_CONFIDENCE_THRESHOLD`

### 3. Failed Reconciliations (Errors, Not Fallbacks)

Find reconciliations that failed due to errors (not low confidence):

```javascript
// Search logs for RECONCILIATION_FAILED events
// In Cloud Logging:
resource.type="cloud_function"
jsonPayload.event="RECONCILIATION_FAILED"
```

**Firestore query for failed status:**
```javascript
db.collection('conversations')
  .where('status', '==', 'failed')
  .where('processingError', '>=', 'Merge failed')
  .where('processingError', '<=', 'Merge failed\uf8ff')
  .limit(50)
  .get()
  .then(snapshot => {
    snapshot.forEach(doc => {
      const data = doc.data();
      console.log({
        id: doc.id,
        error: data.processingError,
        createdAt: data.createdAt
      });
    });
  });
```

### 4. Slow Processing Identification

Find conversations with long reconciliation times:

```javascript
db.collection('conversations')
  .where('status', '==', 'complete')
  .where('reconciliationMetadata.reconciliationDurationMs', '>', 5000)
  .orderBy('reconciliationMetadata.reconciliationDurationMs', 'desc')
  .limit(20)
  .get()
  .then(snapshot => {
    snapshot.forEach(doc => {
      const data = doc.data();
      console.log({
        id: doc.id,
        durationMs: data.reconciliationMetadata.reconciliationDurationMs,
        speakers: data.reconciliationDetails?.originalSpeakerCount || 0,
        chunks: data.chunkingMetadata?.totalChunks || 0
      });
    });
  });
```

**Typical durations:**
- <1 second: Normal (2-5 speakers, 3-5 chunks)
- 1-5 seconds: Acceptable for complex files
- >5 seconds: May indicate many speakers or edge cases

### 5. Archived Chunks Analysis

Query archived parallel chunks for post-mortem analysis:

```javascript
// List all archived chunks for a specific conversation
const conversationId = 'YOUR_CONVERSATION_ID';

db.collection('conversations')
  .doc(conversationId)
  .get()
  .then(async doc => {
    const data = doc.data();
    if (!data.fallbackMetadata?.archiveId) {
      console.log('No archived chunks (no fallback triggered)');
      return;
    }

    const archiveId = data.fallbackMetadata.archiveId;
    const archiveSnap = await db.collection('conversations')
      .doc(conversationId)
      .collection(archiveId)
      .get();

    console.log(`Archived chunks in ${archiveId}:`);
    archiveSnap.forEach(chunk => {
      const chunkData = chunk.data();
      console.log({
        chunkIndex: chunkData.chunkIndex,
        speakerSignatures: chunkData.chunkSpeakerSignatures?.length || 0,
        archivedAt: chunkData.archivedAt
      });
    });
  });
```

## Cloud Logging Queries

### Structured Log Events

The reconciliation system emits structured JSON logs for easy querying:

| Event | Severity | When |
|-------|----------|------|
| `RECONCILIATION_STARTED` | INFO | Merge begins reconciliation |
| `RECONCILIATION_COMPLETED` | INFO | Reconciliation succeeded |
| `RECONCILIATION_FALLBACK_TRIGGERED` | WARNING | Low confidence → fallback |
| `RECONCILIATION_FAILED` | ERROR | Reconciliation error |

### Example Cloud Logging Queries

**All fallbacks today:**
```
resource.type="cloud_function"
jsonPayload.event="RECONCILIATION_FALLBACK_TRIGGERED"
timestamp >= "2026-01-10T00:00:00Z"
```

**Low confidence reconciliations (0.75-0.80):**
```
resource.type="cloud_function"
jsonPayload.event="RECONCILIATION_COMPLETED"
jsonPayload.confidence >= 0.75
jsonPayload.confidence < 0.80
```

**Reconciliation errors:**
```
resource.type="cloud_function"
jsonPayload.event="RECONCILIATION_FAILED"
severity="ERROR"
```

## Operator Guidance

### When to Adjust Threshold

| Observation | Action |
|-------------|--------|
| Fallback rate > 15% | Consider lowering threshold (e.g., 0.70) |
| User complaints about mislabeled speakers | Consider raising threshold (e.g., 0.80) |
| Most confidences 0.95+ | Threshold working well, monitor for drift |
| Cluster of <0.70 confidences | Investigate audio quality, speaker detection |

### Adjusting the Threshold

Set via environment variable:

```bash
# For testing lower threshold
firebase functions:config:set reconciliation.confidence_threshold=0.70

# Deploy with new config
firebase deploy --only functions
```

Or set directly in Cloud Run:
```bash
gcloud functions deploy processReprocessing \
  --set-env-vars RECONCILIATION_CONFIDENCE_THRESHOLD=0.70
```

### Emergency Actions

**If fallback rate spikes suddenly:**
1. Check recent deployments for changes
2. Look at `RECONCILIATION_FAILED` errors in logs
3. Temporarily lower threshold if users are blocked
4. Investigate root cause (audio quality? upstream changes?)

**If users report mislabeled speakers:**
1. Query the specific conversation's `reconciliationDetails`
2. Check `matchEvidence` for weak signals
3. Consider raising threshold
4. May need manual speaker correction in future UI

## Metrics to Track

For long-term monitoring, track these metrics weekly:

1. **Fallback Rate**: `(conversations with fallbackMetadata) / (total parallel conversations)`
2. **Average Confidence**: Mean of `reconciliationConfidence` for completed parallel conversations
3. **P95 Reconciliation Time**: 95th percentile of `reconciliationMetadata.reconciliationDurationMs`
4. **Reprocessing Success Rate**: Sequential reprocessing completions / fallback triggers

## Related Documentation

- [Chunk Merge Architecture](../explanation/chunk-merge.md) - How merging and reconciliation work
- [Data Model Reference](../reference/data-model.md) - Field definitions for metadata
- [Speaker Reconciliation](../explanation/chunk-merge.md#speaker-reconciliation-parallel-mode) - Algorithm details
