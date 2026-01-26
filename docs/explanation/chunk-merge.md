# Chunk Merge Architecture

This document explains the chunk merge system - the final step in processing large audio files (>30 minutes). After all chunks have been processed individually, the merge layer stitches them back together into a single coherent conversation.

## Overview

The chunk merge system is part of the large file upload flow:

```
Audio Upload → Chunking → Chunk Processing → Chunk Merge → Complete
                ↓              ↓                  ↓
           (30s overlap)  (WhisperX + Gemini)  (Deduplicate)
```

**Purpose**: Transform multiple chunk artifacts into a single merged conversation document with no duplicates or gaps.

## System Architecture

### Data Flow

```
conversations/{id}/chunks/*  → mergeChunks() → conversations/{id}
         ↓                           ↓                    ↓
   ChunkArtifacts           Speaker Reconciliation  Final Conversation
                                     ↓
                            Deduplicate & Merge
```

### Components

1. **Chunk Artifacts** (`conversations/{id}/chunks/{chunkIndex}`)
   - Firestore subcollection storing per-chunk results
   - Each artifact contains: segments, speakers, terms, topics, people
   - Includes overlap boundaries for deduplication

2. **Merge Worker** (`functions/src/chunkMerge.ts`)
   - Cloud Function invoked by Cloud Tasks
   - Loads all chunk artifacts
   - Deduplicates segments in overlap regions
   - Merges speakers, terms, topics, people
   - Writes final conversation document

3. **Merge Trigger** (`processTranscription.ts`)
   - Checks if all chunks complete after each chunk finishes
   - Enqueues merge task atomically (guard flag prevents duplicates)
   - Updates conversation status to 'merging'

## Status Transitions

```
processing → chunking → merging → complete
                ↓           ↓
           (chunks enqueued) [fallback?] → reprocessing → complete
```

- **processing**: Initial audio upload (before chunking decision)
- **chunking**: Chunks created, tasks enqueued, processing in progress
- **merging**: All chunks complete, merge task running
- **reprocessing**: Fallback triggered, sequential reprocessing in progress (see Fallback section)
- **complete**: Merge complete, final conversation ready

## Speaker Reconciliation (Parallel Mode)

### Problem

In **parallel mode**, chunks process independently without shared context. This means:

- Each chunk assigns speaker IDs independently (e.g., `SPEAKER_00`, `SPEAKER_01`)
- The **same speaker** may get **different IDs** in different chunks
- Without reconciliation, the merged transcript would show multiple speakers for the same person

**Example**:
```
Chunk 0: Alice speaks → assigned "SPEAKER_00"
Chunk 1: Alice speaks → assigned "SPEAKER_00" (different person!)
Chunk 2: Alice speaks → assigned "SPEAKER_01"
```

After merge without reconciliation: 3 different speakers (WRONG!)

### Solution: Speaker Signatures + Clustering

The reconciliation algorithm matches speakers across chunks using three signals:

1. **Name matching (50% weight)**: If speakers introduced themselves ("Hi, I'm Alice")
2. **Topic overlap (25% weight)**: Jaccard similarity of topics discussed
3. **Term overlap (25% weight)**: Jaccard similarity of technical terms used

**Algorithm**:
1. Build speaker signatures during chunk processing (name, topics, terms, sample quote)
2. Compute similarity matrix between all speaker pairs (cross-chunk only)
3. Greedy clustering: merge pairs with similarity > 0.7
4. Generate canonical IDs (`speaker_canonical_0`, `speaker_canonical_1`, ...)
5. Remap segment `speakerId` fields to canonical IDs

**Confidence Threshold**:
- Configurable via `RECONCILIATION_CONFIDENCE_THRESHOLD` env var (default: 0.75)
- If overall confidence < threshold, triggers fallback to sequential reprocessing
- This prevents merging speakers when the match is too uncertain

**Metadata Stored**:
- `reconciliationConfidence`: Overall confidence score (0-1)
- `reconciliationDetails`: Per-cluster match evidence for debugging
- `reconciliationMetadata`: Extended observability data (signals used, per-speaker confidences, duration)

**Sequential Mode**: No reconciliation needed - speaker IDs are consistent via context propagation.

## Fallback to Sequential Processing

When speaker reconciliation confidence is too low, the system automatically falls back to sequential reprocessing to ensure consistent speaker identification.

### Fallback Flow

```
Parallel Processing → Low Confidence → Fallback Triggered
                                              ↓
                                    Archive Parallel Chunks
                                              ↓
                                    Update Status: reprocessing
                                              ↓
                                    Enqueue Sequential Tasks
                                              ↓
Sequential Processing → Merge (no reconciliation needed) → Complete
```

### When Fallback Triggers

1. **Merge attempts reconciliation**: `mergeChunks()` runs `reconcileSpeakers()` on parallel chunk signatures
2. **Confidence check fails**: The result's `overallConfidence` is compared against `ReconciliationConfig.CONFIDENCE_THRESHOLD`
3. **Exception thrown**: If confidence is below threshold, `ReconciliationLowConfidenceError` is thrown
4. **Exception caught**: The catch block handles the error, persists reconciliation metadata, and calls `handleLowConfidenceFallback()`:
   - Archives existing chunk artifacts to `conversations/{id}/chunks.archived-{timestamp}/`
   - Records `fallbackMetadata` with parallel attempt details
   - Updates status to `reprocessing`
   - Enqueues sequential reprocessing via `processReprocessing` Cloud Task

### Fallback Metadata

When fallback occurs, the conversation record stores:

```typescript
fallbackMetadata: {
  triggeredAt: string;          // ISO timestamp
  parallelConfidence: number;   // Confidence that triggered fallback
  archiveId: string;            // Path to archived parallel chunks
  reason: 'low_speaker_confidence' | 'reconciliation_error';
  parallelDurationMs?: number;  // How long parallel attempt took
  sequentialDurationMs?: number; // Populated after sequential completes
  configuredThreshold: number;  // Threshold at time of trigger
}
```

### Archived Chunks

Parallel chunks are preserved for debugging:
- Location: `conversations/{id}/chunks.archived-{timestamp}/{chunkIndex}`
- Contains full chunk artifacts including speaker signatures
- Useful for post-mortem analysis of reconciliation failures
- Can be TTL'd after 30 days if storage is a concern

### Sequential Reprocessing

After fallback:
1. Original audio is re-chunked (same boundaries as parallel)
2. Chunks are processed sequentially with context propagation
3. Speaker IDs remain consistent across chunks (no reconciliation needed)
4. Merge completes normally with sequential speaker data

### Idempotency

The fallback system is idempotent:
- If `fallbackMetadata.triggeredAt` exists, merge is skipped (already in reprocessing)
- Prevents double-fallback if merge is retried
- Sequential reprocessing handles its own idempotency via chunk status tracking

### Status Transitions with Fallback

```
processing → chunking → merging → [fallback?]
                          ↓              ↓
                       complete    reprocessing → complete
```

- **reprocessing**: Fallback triggered, sequential processing in progress
- **complete**: Either parallel succeeded or sequential fallback completed

## Deduplication Strategy

### Problem

Chunks have 30-second overlaps for speaker continuity. Without deduplication, we'd have duplicate segments:

```
Chunk 0: [0s────────────────15s]──[15s──18s]
                             ↑  overlap  ↑
Chunk 1:                    [15s──18s]──[18s────────30s]
```

Segments in the overlap region (15s-18s) appear in **both chunks**.

### Solution: Preferred Chunk Logic

For each segment, we determine which chunk "owns" it:

```typescript
const preferredChunk = getPreferredChunkForTimestamp(segment.startMs, chunks);
if (preferredChunk === artifact.chunkIndex) {
  // This chunk owns this segment - include it
  mergedSegments.push(segment);
}
```

**Rule**: The **later chunk** (higher index) owns segments in the overlap region.

**Why?** Ensures deterministic, consistent deduplication. Each segment is attributed to exactly one chunk.

### Example

```
Chunk 0 segments:
  [0ms─5000ms]   ← kept (chunk 0 owns)
  [5000ms─10000ms]  ← kept (chunk 0 owns)
  [15000ms─18000ms] ← DROPPED (chunk 1 owns overlap)

Chunk 1 segments:
  [15000ms─18000ms] ← kept (chunk 1 owns overlap)
  [18000ms─25000ms] ← kept (chunk 1 owns)

Merged result:
  [0ms─5000ms, 5000ms─10000ms, 15000ms─18000ms, 18000ms─25000ms]
  ↑ no duplicates, no gaps
```

## Merging Other Data

### Speakers

**Parallel Mode**: Use reconciliation results to build canonical speaker map:

```typescript
if (processingMode === 'parallel' && reconciliationDetails) {
  for (const cluster of reconciliationDetails.clusters) {
    mergedSpeakers[cluster.canonicalId] = {
      speakerId: cluster.canonicalId,
      displayName: cluster.displayName,
      colorIndex: assignedIndex
    };
  }
}
```

**Sequential Mode**: Simple union - speaker IDs should be consistent across chunks (context propagation ensures this):

```typescript
for (const [speakerId, speaker] of Object.entries(artifact.speakers)) {
  if (!mergedSpeakers[speakerId]) {
    mergedSpeakers[speakerId] = speaker;
  }
}
```

### Post-Reconciliation Name Resolution

After speakers are clustered, a heuristic name resolution step assigns display names based on evidence from the full transcript. This runs only in parallel mode (gated by `enableContextAwareReconciliation` flag) and makes **zero additional Gemini API calls**.

**Problem**: Per-chunk Gemini guesses may be inconsistent or wrong. A speaker identified as "Host" in chunk 0 might say "I'm Chris" in chunk 5, but by then their display name is already set.

**Solution**: Post-reconciliation name resolution scans all segments belonging to each canonical speaker and collects name evidence:

| Evidence Type | Weight | Example |
|---------------|--------|---------|
| Self-introduction | 1.0 | "I'm Chris", "My name is Alice", "Bob here" |
| Direct address + response | 0.8 | "Thanks, Bob" → Bob responds next |
| Direct address (unconfirmed) | 0.5 | "Hey Alice" with no immediate response |
| Per-chunk Gemini guess | 0.3 | Display name from chunk processing (fallback) |

**Algorithm**:
1. For each canonical speaker, collect all segments they spoke
2. Scan segments for self-introduction patterns (highest priority)
3. Look for direct-address patterns where speaker responds immediately after
4. Fall back to per-chunk Gemini guesses (lowest weight)
5. Sum weights per candidate name
6. Assign name only if total weight ≥ 0.5 threshold
7. Resolve conflicts: if same name matches multiple speakers, highest score wins
8. Below threshold: preserve role-based labels ("Host", "Participant", etc.)

**Key Design Decisions**:
- **Self-introductions take absolute priority**: "I'm Chris" beats any indirect evidence
- **No duplicate names**: Same name cannot be assigned to multiple canonical speakers
- **Graceful degradation**: Low-confidence speakers keep their role labels
- **Full logging**: Evidence summaries logged for debugging (`[NameResolution]` prefix)

**Implementation**: `functions/src/speakerNameResolution.ts`

### Terms & Occurrences

- **Terms**: Deduplicate by `termId` (Gemini generates deterministic IDs)
- **Term Occurrences**: Only include if the referenced segment was kept

```typescript
for (const occurrence of artifact.termOccurrences) {
  if (seenSegmentIds.has(occurrence.segmentId)) {
    mergedTermOccurrences.push(occurrence);
  }
}
```

### Topics

Deduplicate by `topicId`, sort by `startIndex`:

```typescript
for (const topic of artifact.topics) {
  if (!seenTopicIds.has(topic.topicId)) {
    mergedTopics.push(topic);
  }
}
mergedTopics.sort((a, b) => a.startIndex - b.startIndex);
```

### People

Deduplicate by `personId`:

```typescript
for (const person of artifact.people) {
  if (!seenPersonIds.has(person.personId)) {
    mergedPeople.push(person);
  }
}
```

## Idempotency

The merge operation is idempotent - safe to run multiple times:

```typescript
if (chunkingMeta.mergedAt) {
  console.log('Already merged, skipping');
  return;
}
```

**Why idempotency matters**:
- Cloud Tasks may retry failed merges
- Manual reruns during debugging
- Prevents data corruption from duplicate merges

## Error Handling

### Validation

Before merging, we validate:

1. **Conversation exists**: `throw new Error('Conversation not found')`
2. **Chunking metadata present**: `throw new Error('No chunking metadata')`
3. **All chunks present**: `throw new Error('Missing chunks: expected X, found Y')`

### Failure Recovery

If merge fails:

1. Status updated to `'failed'` with error message
2. Cloud Tasks retries with exponential backoff
3. Manual retry possible (idempotency ensures safety)

### Monitoring

Key log events:

```
[ChunkMerge] Starting merge process
[ChunkMerge] Loaded chunk artifacts: { chunkCount, totalSegments }
[ChunkMerge] Segment deduplication complete: { duplicatesRemoved }
[ChunkMerge] ✅ Merge complete: { finalCounts, durationMs }
```

## Security

### Firestore Rules

```javascript
match /conversations/{conversationId}/chunks/{chunkIndex} {
  // Users can read chunks for their own conversations
  allow read: if isAuthenticated()
    && get(.../conversations/$(conversationId)).data.userId == request.auth.uid;

  // Only Cloud Functions can write chunks
  allow write: if false;
}
```

Chunk artifacts are read-only from the client - only Cloud Functions can create/modify them.

## Performance Considerations

### Memory Usage

- Loads all chunk artifacts into memory
- For very large files (multiple GB), this could be substantial
- Current limit: 512MiB function memory (sufficient for ~1000 chunks)

### Processing Time

- O(n) where n = total segments across all chunks
- Typical: <1 second for 100 segments
- Timeout: 10 minutes (generous buffer)

### Cost Optimization

Merge is cheaper than chunk processing:
- No LLM calls (Gemini already ran on chunks)
- Pure data transformation
- Fast execution (<1s typically)

## Reconciliation Quality Indicators

The reconciliation system provides several quality indicators:

- **Overall Confidence** (0-1): Minimum of all cluster confidences. Values above 0.7 indicate high confidence matches.
- **Cluster Confidence**: Per-speaker confidence score based on match evidence.
- **Match Evidence**: Breakdown of name matches, topic overlap, and term overlap.

**When to Review**:
- Overall confidence < 0.7: Review speaker assignments manually
- Cluster count >> expected speakers: May indicate false negatives (speakers not merged)
- Cluster count << expected speakers: May indicate false positives (different speakers merged)

## Future Improvements

### 1. Voice Embeddings

Add voice biometric signatures to speaker reconciliation for more robust matching. Would complement name/content signals with acoustic fingerprints.

### 2. Manual Override UI

Allow users to manually merge or split speakers if reconciliation makes mistakes. Store overrides in Firestore for future reference.

### 3. Adaptive Thresholds

Adjust confidence thresholds based on chunk count, audio quality, and historical accuracy. Learn from user feedback.

### 4. Progressive Merge

Start merging early chunks while later chunks still processing (reduces time to first view).

## Related Documentation

- [Chunking Overview](./chunking.md) - How audio is split into chunks
- [Context Propagation](./chunk-context.md) - How data flows between chunks
- [Chunk Bounds](./chunk-bounds.md) - Timestamp math for overlap regions
- [Reconciliation Queries](../admin/reconciliation-queries.md) - Monitoring and operator queries
- [Data Model Reference](../reference/data-model.md) - Field definitions
- [How-To: Deploy Functions](../how-to/deploy.md) - Deploying the merge function

## Key Takeaways

1. **Chunk artifacts** store intermediate results in `conversations/{id}/chunks/*`
2. **Speaker reconciliation** (parallel mode) matches speakers across chunks using name/topic/term signals
3. **Confidence threshold** (default 0.75) triggers fallback if reconciliation is uncertain
4. **Fallback flow**: Low confidence → archive parallel chunks → reprocess sequentially
5. **Merge trigger** fires atomically when all chunks complete
6. **Deduplication** uses "preferred chunk" logic (later chunk wins in overlaps)
7. **Idempotency** ensures safe retries and prevents double-fallback
8. **Status flow**: `chunking → merging → [reprocessing?] → complete`
9. **Observability**: Structured logs + `reconciliationMetadata` + `fallbackMetadata` for monitoring

The merge layer is the final step that transforms chunked processing back into a seamless user experience. Speaker reconciliation ensures consistent identities across chunk boundaries, and automatic fallback to sequential processing protects users from mislabeled transcripts when confidence is low.
