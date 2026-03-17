#!/usr/bin/env tsx
/**
 * Phase 4: Cost + Latency Benchmarking
 *
 * Collects timing and cost data from the PoC runs and compares
 * against the current pipeline's known performance characteristics.
 *
 * We don't re-run everything — we pull metrics from the artifacts
 * saved by previous phases and combine them with known baseline data
 * from the current pipeline.
 *
 * Current pipeline data for c_1773188486911 (from logs/observations):
 *   - Total wall-clock: ~14 minutes
 *   - 4 chunks processed
 *   - Each chunk: WhisperX ASR+diarization + Gemini analysis
 *   - Post-processing: merge + reconciliation + alignment
 *
 * Usage:
 *   npx tsx scripts/poc-benchmark-hybrid.ts [conversationId] [iteration]
 *
 * Requires:
 *   gemini_diarization_raw.json from poc-gemini-diarize.ts
 *
 * Output:
 *   .agent_process/work/poc_gemini_hybrid/<iteration>/results/phase4_benchmarks.md
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { resolvePocResultsDir } from './poc-results-dir.js';

import type { DiarizationArtifact } from './poc-gemini-diarize.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCOPE = 'poc_gemini_hybrid';
const { iteration: ITERATION, resultsDir: RESULTS_DIR } = resolvePocResultsDir(
  PROJECT_ROOT,
  SCOPE,
  process.argv[3]
);

// ============================================================================
// Pricing constants (as of 2026 — these change, so pin them here)
// ============================================================================

// Gemini 2.5 Flash pricing (per 1M tokens)
// Audio input: counted as tokens (1 second of audio ≈ 32 tokens for Gemini)
const GEMINI_25_FLASH_INPUT_PER_1M = 0.15;   // $0.15 per 1M input tokens
const GEMINI_25_FLASH_OUTPUT_PER_1M = 0.60;   // $0.60 per 1M output tokens
// Note: thinking tokens have different pricing but Flash-preview may vary

// WhisperX on Cloud Run GPU (NVIDIA L4)
// Estimated from Cloud Run pricing: ~$0.006/min for L4 GPU
const WHISPERX_GPU_COST_PER_MINUTE = 0.006;

// Replicate WhisperX (current pipeline)
// Estimated ~$0.006/sec of GPU time, ~2x realtime for ASR+diarization
const REPLICATE_COST_PER_AUDIO_MINUTE = 0.012;

// ============================================================================
// Baseline data (current pipeline for this specific conversation)
// ============================================================================

interface PipelineBaseline {
  totalWallClockMs: number;
  chunks: number;
  whisperxPerChunkMs: number;   // ASR + diarization per chunk
  geminiPerChunkMs: number;     // analysis per chunk
  mergeMs: number;              // post-processing (merge + reconciliation)
  geminiTokensPerChunk: number; // estimated tokens per chunk analysis
  audioDurationMinutes: number;
}

// These are approximations based on observed behavior.
// Not exact — we'd need structured telemetry for that,
// which is on the backlog but not built yet.
const BASELINE: PipelineBaseline = {
  totalWallClockMs: 14 * 60 * 1000,  // ~14 minutes observed
  chunks: 4,
  whisperxPerChunkMs: 120_000,   // ~2 min per 10-min chunk (ASR + diarization)
  geminiPerChunkMs: 30_000,      // ~30s per chunk analysis
  mergeMs: 45_000,               // merge + reconciliation + alignment
  geminiTokensPerChunk: 15_000,  // ~15k tokens per chunk (text analysis)
  audioDurationMinutes: 45,
};

// ============================================================================
// Types
// ============================================================================

interface BenchmarkResult {
  current: {
    totalWallClockMs: number;
    whisperxTotalMs: number;
    whisperxHasDiarization: boolean;
    geminiTotalMs: number;
    geminiTotalTokens: number;
    mergeTotalMs: number;
    estimatedCost: {
      whisperx: number;
      gemini: number;
      total: number;
    };
  };
  hybrid: {
    geminiDiarizationMs: number;
    geminiDiarizationTokens: {
      prompt: number;
      completion: number;
      total: number;
    };
    // WhisperX without diarization is ~40% faster (no pyannote pass)
    estimatedWhisperxNoDiarMs: number;
    alignmentMs: number;  // trivial — just overlap matching
    totalEstimatedMs: number;
    estimatedCost: {
      whisperx: number;
      gemini: number;
      total: number;
    };
  };
  comparison: {
    latencyReduction: number;   // percentage reduction
    costReduction: number;      // percentage reduction
    latencySavingsMs: number;
    costSavings: number;
  };
}

// ============================================================================
// Benchmark computation
// ============================================================================

function computeBenchmarks(artifact: DiarizationArtifact): BenchmarkResult {
  // Current pipeline costs
  const currentWhisperxTotal = BASELINE.whisperxPerChunkMs * BASELINE.chunks;
  const currentGeminiTotal = BASELINE.geminiPerChunkMs * BASELINE.chunks;
  const currentGeminiTokens = BASELINE.geminiTokensPerChunk * BASELINE.chunks;

  const currentWhisperxCost =
    BASELINE.audioDurationMinutes * REPLICATE_COST_PER_AUDIO_MINUTE;
  const currentGeminiCost =
    (currentGeminiTokens / 1_000_000) * GEMINI_25_FLASH_INPUT_PER_1M +
    (currentGeminiTokens * 0.3 / 1_000_000) * GEMINI_25_FLASH_OUTPUT_PER_1M; // ~30% output ratio

  // Hybrid pipeline costs
  const geminiDiarizationMs = artifact.durationMs;
  const geminiTokens = artifact.tokenUsage;

  // WhisperX without diarization: skip the pyannote speaker embedding pass,
  // which is typically ~40% of the total WhisperX runtime.
  // We still chunk the audio for memory reasons, but each chunk is faster.
  const whisperxNoDiarPerChunk = BASELINE.whisperxPerChunkMs * 0.6;
  const whisperxNoDiarTotal = whisperxNoDiarPerChunk * BASELINE.chunks;

  // Alignment is just an in-memory overlap computation — milliseconds at most
  const alignmentMs = 500;

  const hybridTotal = geminiDiarizationMs + whisperxNoDiarTotal + alignmentMs;

  const hybridWhisperxCost =
    BASELINE.audioDurationMinutes * WHISPERX_GPU_COST_PER_MINUTE * 0.6; // 60% time = 60% cost

  const hybridGeminiCost =
    (geminiTokens.promptTokens / 1_000_000) * GEMINI_25_FLASH_INPUT_PER_1M +
    (geminiTokens.completionTokens / 1_000_000) * GEMINI_25_FLASH_OUTPUT_PER_1M;

  const currentTotalCost = currentWhisperxCost + currentGeminiCost;
  const hybridTotalCost = hybridWhisperxCost + hybridGeminiCost;

  return {
    current: {
      totalWallClockMs: BASELINE.totalWallClockMs,
      whisperxTotalMs: currentWhisperxTotal,
      whisperxHasDiarization: true,
      geminiTotalMs: currentGeminiTotal,
      geminiTotalTokens: currentGeminiTokens,
      mergeTotalMs: BASELINE.mergeMs,
      estimatedCost: {
        whisperx: currentWhisperxCost,
        gemini: currentGeminiCost,
        total: currentTotalCost,
      },
    },
    hybrid: {
      geminiDiarizationMs,
      geminiDiarizationTokens: {
        prompt: geminiTokens.promptTokens,
        completion: geminiTokens.completionTokens,
        total: geminiTokens.totalTokens,
      },
      estimatedWhisperxNoDiarMs: whisperxNoDiarTotal,
      alignmentMs,
      totalEstimatedMs: hybridTotal,
      estimatedCost: {
        whisperx: hybridWhisperxCost,
        gemini: hybridGeminiCost,
        total: hybridTotalCost,
      },
    },
    comparison: {
      latencyReduction:
        BASELINE.totalWallClockMs > 0
          ? ((BASELINE.totalWallClockMs - hybridTotal) / BASELINE.totalWallClockMs) * 100
          : 0,
      costReduction:
        currentTotalCost > 0
          ? ((currentTotalCost - hybridTotalCost) / currentTotalCost) * 100
          : 0,
      latencySavingsMs: BASELINE.totalWallClockMs - hybridTotal,
      costSavings: currentTotalCost - hybridTotalCost,
    },
  };
}

// ============================================================================
// Report generation
// ============================================================================

function generateReport(result: BenchmarkResult, conversationId: string): string {
  const lines: string[] = [];
  const p = (s: string) => lines.push(s);

  const fmtMs = (ms: number) => {
    if (ms > 60_000) return `${(ms / 60_000).toFixed(1)} min`;
    return `${(ms / 1000).toFixed(1)}s`;
  };
  const fmtCost = (c: number) => `$${c.toFixed(4)}`;

  p('# Phase 4: Cost + Latency Benchmarking');
  p('');
  p(`**Conversation:** \`${conversationId}\``);
  p(`**Generated:** ${new Date().toISOString()}`);
  p('');

  p('## Latency Comparison');
  p('');
  p(`| Component | Current Pipeline | Hybrid Pipeline |`);
  p(`|-----------|-----------------|-----------------|`);
  p(`| WhisperX (ASR) | ${fmtMs(result.current.whisperxTotalMs)} (with diarization) | ${fmtMs(result.hybrid.estimatedWhisperxNoDiarMs)} (ASR only, est.) |`);
  p(`| Gemini API | ${fmtMs(result.current.geminiTotalMs)} (4x chunk analysis) | ${fmtMs(result.hybrid.geminiDiarizationMs)} (1x full diarization+analysis) |`);
  p(`| Merge/Reconciliation | ${fmtMs(result.current.mergeTotalMs)} | N/A |`);
  p(`| Alignment | N/A | ${fmtMs(result.hybrid.alignmentMs)} |`);
  p(`| **Total** | **${fmtMs(result.current.totalWallClockMs)}** | **${fmtMs(result.hybrid.totalEstimatedMs)}** |`);
  p('');
  p(`**Latency reduction:** ${result.comparison.latencyReduction.toFixed(1)}% (${fmtMs(result.comparison.latencySavingsMs)} saved)`);
  p('');

  p('## Token Usage');
  p('');
  p(`| Metric | Current Pipeline | Hybrid Pipeline |`);
  p(`|--------|-----------------|-----------------|`);
  p(`| Total tokens | ~${result.current.geminiTotalTokens.toLocaleString()} (est.) | ${result.hybrid.geminiDiarizationTokens.total.toLocaleString()} (actual) |`);
  p(`| Prompt tokens | N/A | ${result.hybrid.geminiDiarizationTokens.prompt.toLocaleString()} |`);
  p(`| Completion tokens | N/A | ${result.hybrid.geminiDiarizationTokens.completion.toLocaleString()} |`);
  p(`| API calls | ${BASELINE.chunks} | 1 |`);
  p('');

  p('## Cost Comparison');
  p('');
  p(`| Component | Current Pipeline | Hybrid Pipeline |`);
  p(`|-----------|-----------------|-----------------|`);
  p(`| WhisperX GPU | ${fmtCost(result.current.estimatedCost.whisperx)} | ${fmtCost(result.hybrid.estimatedCost.whisperx)} |`);
  p(`| Gemini API | ${fmtCost(result.current.estimatedCost.gemini)} | ${fmtCost(result.hybrid.estimatedCost.gemini)} |`);
  p(`| **Total** | **${fmtCost(result.current.estimatedCost.total)}** | **${fmtCost(result.hybrid.estimatedCost.total)}** |`);
  p('');
  p(`**Cost reduction:** ${result.comparison.costReduction.toFixed(1)}% (${fmtCost(result.comparison.costSavings)} saved per file)`);
  p('');

  p('## Architecture Complexity');
  p('');
  p(`| Aspect | Current Pipeline | Hybrid Pipeline |`);
  p(`|--------|-----------------|-----------------|`);
  p(`| Cloud Functions | processTranscription + processMerge | processTranscription only |`);
  p(`| Speaker reconciliation | Yes (cross-chunk merge) | No (Gemini handles globally) |`);
  p(`| pyannote dependency | Yes (fragile, GPU-bound) | No |`);
  p(`| Gemini API calls per file | ${BASELINE.chunks} (analysis per chunk) | 1 (diarization + analysis) |`);
  p(`| Failure modes | Chunk failures, reconciliation errors | Single API call (simpler retry) |`);
  p('');

  p('## Caveats');
  p('');
  p('- Current pipeline timings are approximations from observed behavior, not structured telemetry');
  p('- WhisperX "without diarization" estimate assumes 40% reduction — actual measurement needed');
  p('- Cost estimates use listed Gemini API pricing which may differ from actual billing');
  p('- Hybrid pipeline latency is partially estimated (WhisperX portion)');
  p('- The Gemini diarization call runs in parallel with WhisperX in production, so wall-clock savings may be larger');
  p('');

  p('## Decision Gate Assessment');
  p('');
  const latencyPass = result.comparison.latencyReduction > 0;
  const costPass = result.comparison.costReduction > 0;
  p(`- [${latencyPass ? 'x' : ' '}] Total latency <= current pipeline (${result.comparison.latencyReduction.toFixed(1)}% reduction)`);
  p(`- [${costPass ? 'x' : ' '}] Cost per file <= current pipeline (${result.comparison.costReduction.toFixed(1)}% reduction)`);
  p('');
  p(`**Phase 4 Outcome:** ${latencyPass && costPass ? 'PASS' : 'NEEDS REVIEW'}`);
  p('');

  return lines.join('\n');
}

// ============================================================================
// Comprehensive decision gate — loads all phase metrics and renders verdict
// ============================================================================

interface DecisionGateResult {
  criteria: Array<{
    label: string;
    phase: string;
    pass: boolean;
    value: string;
    threshold: string;
    manualCheck: boolean;
  }>;
  decision: 'GO' | 'PARTIAL-GO' | 'NO-GO';
  rationale: string;
}

function evaluateDecisionGate(resultsDir: string): DecisionGateResult {
  const criteria: DecisionGateResult['criteria'] = [];

  // --- Phase 1 metrics ---
  const phase1Path = path.join(resultsDir, 'phase1_metrics.json');
  let phase1Pass = true;

  if (fs.existsSync(phase1Path)) {
    const p1 = JSON.parse(fs.readFileSync(phase1Path, 'utf-8'));

    const speakerCountOk = Math.abs(p1.speakerCountDelta) <= 2;
    criteria.push({
      label: 'Speaker count within 2 of actual (<=13)',
      phase: 'Phase 1',
      pass: speakerCountOk,
      value: `${p1.speakerCountGemini} speakers (delta: ${p1.speakerCountDelta > 0 ? '+' : ''}${p1.speakerCountDelta})`,
      threshold: '<=13 speakers (within 2 of 11 actual)',
      manualCheck: false,
    });
    if (!speakerCountOk) phase1Pass = false;

    const segAccOk = p1.segmentAccuracy >= 0.6;
    criteria.push({
      label: 'Segment accuracy >= 60%',
      phase: 'Phase 1',
      pass: segAccOk,
      value: `${(p1.segmentAccuracy * 100).toFixed(1)}%`,
      threshold: '>=60%',
      manualCheck: false,
    });
    if (!segAccOk) phase1Pass = false;

    // Named speakers — flagged for manual check
    criteria.push({
      label: 'Named speakers correctly identified and not split',
      phase: 'Phase 1',
      pass: true,  // default true, requires manual verification
      value: 'Requires manual review of speaker mapping table',
      threshold: 'JJ, Sanjay, Sammy identified as distinct speakers',
      manualCheck: true,
    });
  } else {
    criteria.push({
      label: 'Phase 1 metrics',
      phase: 'Phase 1',
      pass: false,
      value: 'MISSING — phase1_metrics.json not found',
      threshold: 'N/A',
      manualCheck: false,
    });
    phase1Pass = false;
  }

  // --- Phase 2 metrics ---
  const phase2Path = path.join(resultsDir, 'phase2_metrics.json');
  let phase2Pass = true;

  if (fs.existsSync(phase2Path)) {
    const p2 = JSON.parse(fs.readFileSync(phase2Path, 'utf-8'));

    const reassignOk = p2.reassignmentRate <= 0.15;
    criteria.push({
      label: 'Aligned segment reassignment rate <=15%',
      phase: 'Phase 2',
      pass: reassignOk,
      value: `${(p2.reassignmentRate * 100).toFixed(1)}%`,
      threshold: '<=15%',
      manualCheck: false,
    });
    if (!reassignOk) phase2Pass = false;

    const boundaryOk = p2.boundaryErrors.meanAbsoluteErrorMs <= 200;
    criteria.push({
      label: 'Timestamp precision preserved (mean error <=200ms)',
      phase: 'Phase 2',
      pass: boundaryOk,
      value: `${p2.boundaryErrors.meanAbsoluteErrorMs.toFixed(0)}ms mean error`,
      threshold: '<=200ms',
      manualCheck: false,
    });
    if (!boundaryOk) phase2Pass = false;
  } else {
    criteria.push({
      label: 'Phase 2 metrics',
      phase: 'Phase 2',
      pass: false,
      value: 'MISSING — phase2_metrics.json not found',
      threshold: 'N/A',
      manualCheck: false,
    });
    phase2Pass = false;
  }

  // --- Phase 3 metrics ---
  const phase3Path = path.join(resultsDir, 'phase3_metrics.json');

  if (fs.existsSync(phase3Path)) {
    const p3 = JSON.parse(fs.readFileSync(phase3Path, 'utf-8'));

    const termCovOk = p3.terms.coverage >= 0.8;
    criteria.push({
      label: 'Content analysis quality — term coverage >= 80%',
      phase: 'Phase 3',
      pass: termCovOk,
      value: `${(p3.terms.coverage * 100).toFixed(1)}% coverage`,
      threshold: '>=80%',
      manualCheck: false,
    });
  } else {
    criteria.push({
      label: 'Phase 3 metrics',
      phase: 'Phase 3',
      pass: false,
      value: 'MISSING — phase3_metrics.json not found',
      threshold: 'N/A',
      manualCheck: false,
    });
  }

  // --- Phase 4 metrics ---
  const phase4Path = path.join(resultsDir, 'phase4_metrics.json');

  if (fs.existsSync(phase4Path)) {
    const p4 = JSON.parse(fs.readFileSync(phase4Path, 'utf-8'));

    const latencyOk = p4.comparison.latencyReduction > 0;
    criteria.push({
      label: 'Total latency <= current pipeline',
      phase: 'Phase 4',
      pass: latencyOk,
      value: `${p4.comparison.latencyReduction.toFixed(1)}% reduction`,
      threshold: '>0% reduction',
      manualCheck: false,
    });

    const costOk = p4.comparison.costReduction > 0;
    criteria.push({
      label: 'Cost per file <= current pipeline',
      phase: 'Phase 4',
      pass: costOk,
      value: `${p4.comparison.costReduction.toFixed(1)}% reduction`,
      threshold: '>0% reduction',
      manualCheck: false,
    });
  } else {
    criteria.push({
      label: 'Phase 4 metrics',
      phase: 'Phase 4',
      pass: false,
      value: 'MISSING — phase4_metrics.json not found',
      threshold: 'N/A',
      manualCheck: false,
    });
  }

  // --- Decision logic ---
  // GO: all criteria pass
  // PARTIAL-GO: Phase 1 passes but Phase 2 fails (good diarization, bad alignment)
  // NO-GO: Phase 1 fails (diarization quality insufficient)
  const allPass = criteria.filter((c) => !c.manualCheck).every((c) => c.pass);

  let decision: DecisionGateResult['decision'];
  let rationale: string;

  if (allPass) {
    decision = 'GO';
    rationale =
      'All automated criteria pass. Gemini diarization quality is sufficient, ' +
      'alignment preserves timestamps, content analysis is comparable, and the hybrid ' +
      'pipeline is faster and cheaper. Manual review of named speaker identification ' +
      'is still recommended before proceeding to implementation.';
  } else if (phase1Pass && !phase2Pass) {
    decision = 'PARTIAL-GO';
    rationale =
      'Phase 1 passes (Gemini diarization quality is acceptable) but Phase 2 fails ' +
      '(alignment with WhisperX timestamps has issues). Consider: use Gemini for speaker ' +
      'identification + content analysis only, keep pyannote for diarization but upgrade ' +
      'to Community-1, use Gemini speaker names to improve reconciliation.';
  } else if (!phase1Pass) {
    decision = 'NO-GO';
    rationale =
      'Phase 1 fails — Gemini diarization quality is insufficient. Fallback plan: ' +
      'run pyannote Community-1 on full audio before chunking, pass global speaker IDs ' +
      'as constraints to per-chunk WhisperX. This eliminates cross-chunk reconciliation ' +
      'without depending on Gemini for diarization.';
  } else {
    // Phase 1 passes, Phase 2 passes, but something else fails
    decision = 'PARTIAL-GO';
    rationale =
      'Core diarization and alignment criteria pass, but one or more secondary criteria ' +
      '(content analysis, latency, or cost) did not meet thresholds. Review the failing ' +
      'criteria to determine if they are blocking or can be addressed in implementation.';
  }

  return { criteria, decision, rationale };
}

function generateDecisionGateReport(gate: DecisionGateResult): string {
  const lines: string[] = [];
  const p = (s: string) => lines.push(s);

  p('');
  p('---');
  p('');
  p('# Comprehensive Decision Gate');
  p('');
  p(`**Decision: ${gate.decision}**`);
  p('');
  p('## All Criteria');
  p('');
  p('| # | Phase | Criterion | Result | Value | Threshold |');
  p('|---|-------|-----------|--------|-------|-----------|');

  gate.criteria.forEach((c, i) => {
    const result = c.manualCheck ? 'MANUAL' : (c.pass ? 'PASS' : 'FAIL');
    p(`| ${i + 1} | ${c.phase} | ${c.label} | ${result} | ${c.value} | ${c.threshold} |`);
  });

  p('');

  const passCount = gate.criteria.filter((c) => c.pass && !c.manualCheck).length;
  const failCount = gate.criteria.filter((c) => !c.pass && !c.manualCheck).length;
  const manualCount = gate.criteria.filter((c) => c.manualCheck).length;
  p(`**Summary:** ${passCount} passed, ${failCount} failed, ${manualCount} require manual review`);
  p('');

  p('## Rationale');
  p('');
  p(gate.rationale);
  p('');

  return lines.join('\n');
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const conversationId = process.argv[2] || 'c_1773188486911';

  console.log('='.repeat(70));
  console.log(`PoC: Benchmark Hybrid Pipeline — conversation ${conversationId}`);
  console.log(`[Context] Scope: ${SCOPE}, Iteration: ${ITERATION}`);
  console.log('='.repeat(70));

  // Load Gemini artifact for timing/token data
  const artifactPath = path.join(RESULTS_DIR, 'gemini_diarization_raw.json');
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `Gemini diarization artifact not found at ${artifactPath}\n` +
      'Run poc-gemini-diarize.ts first!'
    );
  }
  const artifact: DiarizationArtifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));

  console.log(`[Load] Gemini call: ${(artifact.durationMs / 1000).toFixed(1)}s, ${artifact.tokenUsage.totalTokens} tokens`);

  // Compute benchmarks
  const result = computeBenchmarks(artifact);

  // Generate Phase 4 report
  let report = generateReport(result, conversationId);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  // Save metrics first (decision gate reads them)
  const metricsPath = path.join(RESULTS_DIR, 'phase4_metrics.json');
  fs.writeFileSync(metricsPath, JSON.stringify(result, null, 2));
  console.log(`[Report] Metrics saved to ${metricsPath}`);

  // Evaluate comprehensive decision gate across all phases
  console.log('\n[Decision Gate] Loading all phase metrics...');
  const gate = evaluateDecisionGate(RESULTS_DIR);
  const gateReport = generateDecisionGateReport(gate);

  // Append decision gate to the Phase 4 report
  report += gateReport;

  const reportPath = path.join(RESULTS_DIR, 'phase4_benchmarks.md');
  fs.writeFileSync(reportPath, report);
  console.log(`[Report] Written to ${reportPath}`);

  // Save decision gate as standalone JSON too
  const gatePath = path.join(RESULTS_DIR, 'decision_gate.json');
  fs.writeFileSync(gatePath, JSON.stringify(gate, null, 2));
  console.log(`[Report] Decision gate saved to ${gatePath}`);

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(70));
  console.log(`Current pipeline: ${(result.current.totalWallClockMs / 60000).toFixed(1)} min, $${result.current.estimatedCost.total.toFixed(4)}`);
  console.log(`Hybrid pipeline: ${(result.hybrid.totalEstimatedMs / 60000).toFixed(1)} min (est.), $${result.hybrid.estimatedCost.total.toFixed(4)}`);
  console.log(`Latency reduction: ${result.comparison.latencyReduction.toFixed(1)}%`);
  console.log(`Cost reduction: ${result.comparison.costReduction.toFixed(1)}%`);

  // Print decision gate prominently
  console.log('\n' + '#'.repeat(70));
  console.log('#');
  console.log(`#  DECISION GATE: ${gate.decision}`);
  console.log('#');
  console.log('#'.repeat(70));
  console.log('');
  for (const c of gate.criteria) {
    const icon = c.manualCheck ? '?' : (c.pass ? '+' : 'X');
    console.log(`  [${icon}] ${c.label}`);
    console.log(`      ${c.value} (threshold: ${c.threshold})`);
  }
  console.log('');
  console.log(`Rationale: ${gate.rationale}`);
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
