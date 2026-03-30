# Cloud Functions Flow Reference

> **This document has moved.** The transcription pipeline now runs on the `transcription-orchestrator` Cloud Run service, not inside Cloud Functions.
>
> See **[Pipeline Flow Reference](pipeline-flow.md)** for the canonical pipeline documentation (docs/reference/pipeline-flow.md).

The information below covers Cloud Functions that are **not** part of the transcription pipeline (callables, stats, billing). For the pipeline itself — dispatcher, orchestrator, Gemini, WhisperX, HARDY — see [pipeline-flow.md](pipeline-flow.md).

---

## Dispatcher (Thin Cloud Function)

| Function          | File            | Trigger                     | Memory | Timeout | Purpose                                                                |
| ----------------- | --------------- | --------------------------- | ------ | ------- | ---------------------------------------------------------------------- |
| `transcribeAudio` | `transcribe.ts` | Storage `onObjectFinalized` | 256MiB | 60s     | Validates upload, dispatches to `transcription-orchestrator` Cloud Run |

The dispatcher no longer runs the pipeline. It validates the upload event, writes initial processing state, and fires an IAM-authenticated HTTP POST to the Cloud Run orchestrator. Under `FUNCTIONS_EMULATOR=true`, it falls back to running `processWithNewPipeline()` inline.

## User-Facing Callables

| Function               | File                    | Trigger        | Memory | Timeout | Purpose                              |
| ---------------------- | ----------------------- | -------------- | ------ | ------- | ------------------------------------ |
| `chatWithConversation` | `chat.ts`               | HTTPS Callable | 512MiB | 5 min   | LLM chat with timestamp citations    |
| `mergeSpeakers`        | `speakerCorrections.ts` | HTTPS Callable | 256MiB | 30 sec  | Merge two speakers into one          |
| `reassignSegments`     | `speakerCorrections.ts` | HTTPS Callable | 256MiB | 30 sec  | Move segments to a different speaker |
| `renameSpeaker`        | `speakerCorrections.ts` | HTTPS Callable | 256MiB | 30 sec  | Change a speaker's display name      |
| `undoCorrection`       | `speakerCorrections.ts` | HTTPS Callable | 256MiB | 30 sec  | Undo a previous correction           |

## Stats & Analytics

| Function                  | File                 | Trigger                       | Memory  | Timeout | Purpose                      |
| ------------------------- | -------------------- | ----------------------------- | ------- | ------- | ---------------------------- |
| `onConversationCreated`   | `statsTriggers.ts`   | Firestore `onDocumentCreated` | default | default | Record creation event        |
| `onConversationDeleted`   | `statsTriggers.ts`   | Firestore `onDocumentDeleted` | default | default | Record deletion event        |
| `computeDailyStats`       | `statsAggregator.ts` | Scheduler (2 AM UTC)          | 512MiB  | 5 min   | Aggregate usage statistics   |
| `triggerStatsComputation` | `statsAggregator.ts` | HTTPS Callable                | 512MiB  | 5 min   | Manual stats trigger (admin) |

## Billing

| Function                | File             | Trigger              | Memory | Timeout | Purpose                             |
| ----------------------- | ---------------- | -------------------- | ------ | ------- | ----------------------------------- |
| `syncBillingCosts`      | `billingSync.ts` | Scheduler (4 AM UTC) | 512MiB | 9 min   | Sync actual costs from BigQuery     |
| `triggerBillingSync`    | `billingSync.ts` | HTTPS Callable       | 512MiB | 9 min   | Manual billing sync trigger (admin) |
| `diagnoseBillingLabels` | `billingSync.ts` | HTTPS Callable       | 512MiB | 60 sec  | Diagnostic for billing label issues |

## Related Documentation

- [Pipeline Flow](pipeline-flow.md) — Transcription pipeline (dispatcher + orchestrator)
- [Architecture](architecture.md) — Full system architecture
- [Data Model](data-model.md) — Firestore schema
