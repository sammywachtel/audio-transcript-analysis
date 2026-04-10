# Why the Pipeline Runs on Cloud Run

How the transcription pipeline outgrew Cloud Functions and why a dedicated Cloud Run orchestrator was the right fix.

## The Cloud Functions Timeout Problem

The Gemini 3 Flash + WhisperX hybrid pipeline was validated in a PoC with excellent results: HARDY confidence scores of 0.88-0.96 and a median 1.1-second timestamp error. That PoC ran locally with no timeout constraints.

In production, the pipeline initially ran inside a single Cloud Function (`transcribeAudio`), which has a hard 540-second timeout — the GCP maximum for event-driven 2nd-gen functions. The budget breaks down roughly like this for a 45-minute recording:

| Stage               | Typical Duration | Notes                     |
| ------------------- | ---------------- | ------------------------- |
| Gemini 3 Flash      | ~100s            | Single-pass WAV analysis  |
| WhisperX (4 chunks) | ~200s            | GPU timestamps            |
| HARDY alignment     | ~343s (PoC)      | CPU-bound anchor + region |
| **Total**           | **~643s**        | Exceeds 540s limit        |

The timeout pressure forced algorithmic compromises — iteration caps, fast scoring, threshold changes — that degraded alignment quality below PoC levels. The core problem was architectural: the execution environment was too small for the workload, and no amount of algorithm tuning could fix that without sacrificing the quality we had already validated.

## Why Cloud Run Beat the Alternatives

A multi-expert analysis evaluated four approaches:

### Option A: HARDY-Only Cloud Run Service

Extract just the alignment step into its own Cloud Run service. The Cloud Function would call Gemini, call WhisperX, then call the HARDY service.

**Rejected.** The Cloud Function still times out waiting for the HARDY response. You have moved the work but not escaped the timeout envelope. The function would need to fire-and-forget, at which point you are essentially building Option B with extra network hops.

### Option B: Cloud Run Orchestrator (Selected)

Move the entire pipeline into a dedicated Cloud Run service. The Cloud Function becomes a thin dispatcher that validates the upload, sets initial Firestore state, and fires off an HTTP POST to the orchestrator.

**Why this won.** The orchestrator gets a 900-second timeout with straightforward HTTP semantics. The validated PoC algorithm runs unmodified. The dispatcher is trivial (60s budget, 256MiB). The orchestrator writes progress and results directly to Firestore, so the existing real-time UI works without changes. One new service, one Dockerfile, one deploy workflow — minimal operational surface.

### Option C: Pub/Sub Decoupled Pipeline

Break the pipeline into stages connected by Pub/Sub messages: upload triggers Gemini, Gemini completion triggers WhisperX, WhisperX completion triggers HARDY, HARDY completion triggers assembly.

**Rejected.** This is the right pattern for a multi-tenant pipeline processing thousands of jobs per hour. For a single-user app processing a handful of recordings per week, it adds message routing, dead-letter queues, per-stage retry logic, and distributed state tracking — all to solve a problem that Option B handles with a single HTTP call. Over-engineered for project scale.

### Option D: Cloud Tasks

Use Cloud Tasks to defer the pipeline execution with a longer timeout window.

**Rejected.** Cloud Tasks adds queue management, task deduplication, and retry configuration without any benefit over a direct HTTP call to Cloud Run. The project had already removed Cloud Tasks infrastructure from the legacy chunked pipeline — reintroducing it would be a step backward.

## Cost Framing

The orchestrator adds roughly **$0.015/run** in Cloud Run compute cost (2 vCPU, 2Gi memory, ~10 minutes). This is a directional estimate from the requirements analysis, not measured production data — actual costs depend on audio length, alignment complexity, and cold start frequency. The figure was bounded as a requirement constraint: cost per transcription increase must stay under $0.02.

For context, the Gemini API call and WhisperX GPU time already dominate per-run cost. The orchestrator's CPU-only container is a rounding error next to GPU seconds.

## PoC Fidelity: Why We Preserved the Validated Algorithm

The hybrid pipeline's quality comes from running the full HARDY alignment algorithm without shortcuts. The PoC proved that HARDY with 5-metric scoring, full iteration budgets, and careful anchor selection produces 0.88-0.96 confidence and median 1.1-second error.

Rather than degrade the algorithm to fit inside Cloud Functions, we chose to give the algorithm an environment where it can run as validated. This is the "PoC-fidelity" principle: if the algorithm works and the only problem is the execution environment, change the environment, not the algorithm.

The orchestrator preserves every PoC-validated parameter: `MAX_MATCH_ITERATIONS`, `ANCHOR_MIN_CONFIDENCE`, `computeSimilarity` weights, and the full scoring pipeline. No quality-degrading compromises.

## Operational Notes

- **Fire-and-forget dispatch** depends on gen2 Cloud Functions and post-response CPU availability. The dispatcher returns before the orchestrator finishes; the orchestrator writes its own results to Firestore.
- **`node:20-slim` images** need `ca-certificates` installed or GCS downloads hang silently. This was a validated runtime gotcha during orchestrator development.
- **Idempotency** is handled by an `orchestratorClaimed` Firestore transaction guard. Cloud Storage fires multiple `onObjectFinalized` triggers per upload, and the guard ensures only one orchestrator instance runs the pipeline.
- **Scale-to-zero** means the first transcription after idle pays a cold start (~5s). Users already wait 2+ minutes for Gemini analysis, so this is noise.

## Implementation Details

For the full pipeline sequence, idempotency mechanics, progress contract, error handling, and Cloud Run service configuration, see [Pipeline Flow Reference](../reference/pipeline-flow.md) (`docs/reference/pipeline-flow.md`).

## PoC2 Baseline Decision (2026-04)

The `fix/transcript-content-only` branch was evaluated against ground truth to determine if the no-text diarization prompt alone could restore speaker discrimination. Result: **catastrophic single-speaker collapse** — all 540 segments assigned to `SPEAKER_00` on the benchmark conversation `c_1773188486911`.

**Decision:** Proceed to PoC2.

The 0% speaker accuracy confirms that prompt structure changes alone cannot fix the regression. The remaining PoC2 investigation (AssemblyAI spike, hybrid architecture comparison) is justified to find an alternative diarization path.

**Canonical artifacts:**
- Baseline benchmark: `.agent_process/brainstorms/transcript_pipeline_poc2/.run/01-baseline-benchmark.md`
- Failure triage: `.agent_process/brainstorms/transcript_pipeline_poc2/.run/01b-c_1773188486911-failure-triage.md`
- Requirement: `.agent_process/requirements_docs/architecture-refactor/transcript_pipeline_poc2-01.md`
