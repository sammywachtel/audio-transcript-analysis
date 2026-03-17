#!/usr/bin/env tsx
/**
 * Phase 2: Compare Aligned Segments Against Ground Truth
 *
 * Takes the Gemini-aligned segments (from poc-align-speakers.ts)
 * and scores them against the corrected ground truth.
 *
 * The key question: after Gemini re-attributes speakers to the
 * existing WhisperX-timed segments, how many would still need
 * manual correction? If it's <=15%, the hybrid approach works.
 *
 * Usage:
 *   npx tsx scripts/poc-compare-segments.ts [conversationId] [iteration]
 *
 * Requires:
 *   aligned_segments.json from poc-align-speakers.ts
 *
 * Output:
 *   .agent_process/work/poc_gemini_hybrid/<iteration>/results/phase2_alignment.md
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as admin from 'firebase-admin';
import 'dotenv/config';
import { resolvePocResultsDir } from './poc-results-dir.js';

// Type from the old poc-align-speakers — inlined here since that script was rewritten
interface AlignmentArtifact {
  conversationId: string;
  segments: Array<{ speakerId: string; text: string; startMs: number; endMs: number; segmentId?: string; geminiLabel?: string }>;
  [key: string]: unknown;
}

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
// Types
// ============================================================================

interface SpeakerCorrection {
  correctionId: string;
  type: 'merge' | 'reassign' | 'rename';
  sourceSpeakerId?: string;
  targetSpeakerId?: string;
  segmentIds?: string[];
  fromSpeakerId?: string;
  toSpeakerId?: string;
  speakerId?: string;
  newDisplayName?: string;
  createdAt: string;
  undoneAt?: string;
}

interface GroundTruthSegment {
  segmentId: string;
  index: number;
  speakerId: string;
  startMs: number;
  endMs: number;
  text: string;
}

interface ComparisonResult {
  totalSegments: number;
  correctSegments: number;
  incorrectSegments: number;
  reassignmentRate: number;        // % needing correction
  currentPipelineRate: number;     // % the current pipeline needed (from corrections count)
  improvement: number;             // reduction in correction rate
  boundaryErrors: {
    meanAbsoluteErrorMs: number;
    medianAbsoluteErrorMs: number;
    p95ErrorMs: number;
  };
  transitionZoneAnalysis: {
    totalTransitionSegments: number;
    correctInTransitionZone: number;
    transitionZoneAccuracy: number;
  };
  perSpeakerAccuracy: Array<{
    speakerId: string;
    displayName: string;
    totalSegments: number;
    correctSegments: number;
    accuracy: number;
  }>;
}

// ============================================================================
// Firebase init
// ============================================================================

function initFirebase(): void {
  const saKeyPath = path.join(PROJECT_ROOT, 'firebase-sa-key.json');
  if (!fs.existsSync(saKeyPath)) {
    throw new Error(`Service account key not found at ${saKeyPath}`);
  }
  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(saKeyPath),
    });
  }
}

// ============================================================================
// Ground truth (same as evaluate-diarization, but we need it here too)
// ============================================================================

async function buildGroundTruth(
  conversationId: string
): Promise<{
  segments: GroundTruthSegment[];
  speakers: Record<string, { displayName: string }>;
  totalCorrections: number;
  reassignCorrections: number;
}> {
  const db = admin.firestore();
  const convoDoc = await db.collection('conversations').doc(conversationId).get();
  if (!convoDoc.exists) throw new Error(`Conversation ${conversationId} not found`);
  const convoData = convoDoc.data()!;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawSegments: GroundTruthSegment[] = (convoData.segments || []).map((seg: any, idx: number) => ({
    segmentId: seg.segmentId || `seg_${idx}`,
    index: seg.index ?? idx,
    speakerId: seg.speakerId,
    startMs: seg.startMs,
    endMs: seg.endMs,
    text: seg.text,
  }));

  const correctionsSnap = await db
    .collection('conversations')
    .doc(conversationId)
    .collection('speakerCorrections')
    .get();

  const corrections: SpeakerCorrection[] = correctionsSnap.docs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((doc) => doc.data() as any)
    .filter((c: SpeakerCorrection) => !c.undoneAt)
    .sort((a: SpeakerCorrection, b: SpeakerCorrection) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

  const reassignCount = corrections.filter((c) => c.type === 'reassign').length;

  // Apply corrections
  let result = rawSegments.map((s) => ({ ...s }));
  for (const c of corrections) {
    if (c.type === 'merge' && c.sourceSpeakerId && c.targetSpeakerId) {
      result = result.map((seg) =>
        seg.speakerId === c.sourceSpeakerId ? { ...seg, speakerId: c.targetSpeakerId! } : seg
      );
    } else if (c.type === 'reassign' && c.segmentIds && c.toSpeakerId) {
      const segIds = new Set(c.segmentIds);
      result = result.map((seg) =>
        segIds.has(seg.segmentId) ? { ...seg, speakerId: c.toSpeakerId! } : seg
      );
    }
  }

  // Build speakers
  const speakerIds = new Set(result.map((s) => s.speakerId));
  const speakers: Record<string, { displayName: string }> = {};
  for (const id of speakerIds) {
    const original = convoData.speakers?.[id];
    speakers[id] = { displayName: original?.displayName || id };
  }
  for (const c of corrections) {
    if (c.type === 'rename' && c.speakerId && c.newDisplayName && speakers[c.speakerId]) {
      speakers[c.speakerId].displayName = c.newDisplayName;
    }
  }

  return { segments: result, speakers, totalCorrections: corrections.length, reassignCorrections: reassignCount };
}

// ============================================================================
// Comparison logic
// ============================================================================

/**
 * Build a mapping from Gemini labels to canonical IDs using temporal
 * overlap (same approach as Phase 1 evaluation). We need this to
 * translate the aligned segments' Gemini labels into canonical IDs
 * for comparison against ground truth.
 */
function buildGeminiToCanonicalMap(
  alignedSegments: AlignmentArtifact['segments'],
  groundTruth: GroundTruthSegment[]
): Record<string, string> {
  // Accumulate overlap: geminiLabel → canonicalId → totalMs
  const overlap: Record<string, Record<string, number>> = {};

  for (const aSeg of alignedSegments) {
    const gemLabel = aSeg.geminiLabel;
    if (gemLabel === 'UNKNOWN') continue;

    if (!overlap[gemLabel]) overlap[gemLabel] = {};

    for (const gtSeg of groundTruth) {
      const oStart = Math.max(aSeg.startMs, gtSeg.startMs);
      const oEnd = Math.min(aSeg.endMs, gtSeg.endMs);
      const oMs = Math.max(0, oEnd - oStart);
      if (oMs > 0) {
        overlap[gemLabel][gtSeg.speakerId] = (overlap[gemLabel][gtSeg.speakerId] || 0) + oMs;
      }
    }
  }

  const mapping: Record<string, string> = {};
  for (const [label, overlaps] of Object.entries(overlap)) {
    const best = Object.entries(overlaps).sort((a, b) => b[1] - a[1])[0];
    if (best) mapping[label] = best[0];
  }

  return mapping;
}

function compareSegments(
  aligned: AlignmentArtifact,
  groundTruth: GroundTruthSegment[],
  speakers: Record<string, { displayName: string }>,
  totalCorrections: number
): ComparisonResult {
  // Map Gemini labels → canonical IDs
  const geminiToCanonical = buildGeminiToCanonicalMap(aligned.segments, groundTruth);

  console.log('[Compare] Gemini → Canonical mapping:', geminiToCanonical);

  // Build lookup: segmentId → ground truth speaker
  const gtSpeakerById: Record<string, string> = {};
  for (const seg of groundTruth) {
    gtSpeakerById[seg.segmentId] = seg.speakerId;
  }

  // Compare each aligned segment against ground truth
  let correct = 0;
  let incorrect = 0;
  const perSpeaker: Record<string, { total: number; correct: number }> = {};

  // Boundary error tracking
  const boundaryErrors: number[] = [];

  // Transition zone: segments within 2s of a speaker change in ground truth
  const transitionTimes = new Set<number>();
  for (let i = 1; i < groundTruth.length; i++) {
    if (groundTruth[i].speakerId !== groundTruth[i - 1].speakerId) {
      transitionTimes.add(groundTruth[i].startMs);
    }
  }

  let transitionTotal = 0;
  let transitionCorrect = 0;
  const TRANSITION_ZONE_MS = 2000;

  for (const aSeg of aligned.segments) {
    const gtSpeaker = gtSpeakerById[aSeg.segmentId];
    if (!gtSpeaker) continue;  // segment not in ground truth

    const predictedCanonical = geminiToCanonical[aSeg.geminiLabel] || 'UNMAPPED';

    // Track per-speaker stats
    if (!perSpeaker[gtSpeaker]) perSpeaker[gtSpeaker] = { total: 0, correct: 0 };
    perSpeaker[gtSpeaker].total++;

    const isCorrect = predictedCanonical === gtSpeaker;
    if (isCorrect) {
      correct++;
      perSpeaker[gtSpeaker].correct++;
    } else {
      incorrect++;
    }

    // Is this segment in a transition zone?
    const inTransition = [...transitionTimes].some(
      (t) => Math.abs(aSeg.startMs - t) <= TRANSITION_ZONE_MS
    );
    if (inTransition) {
      transitionTotal++;
      if (isCorrect) transitionCorrect++;
    }
  }

  // Boundary errors: compare ground truth segment starts to
  // closest Gemini segment boundary
  for (const gtSeg of groundTruth) {
    let minError = Infinity;
    for (const aSeg of aligned.segments) {
      const startDiff = Math.abs(aSeg.startMs - gtSeg.startMs);
      const endDiff = Math.abs(aSeg.endMs - gtSeg.endMs);
      minError = Math.min(minError, startDiff, endDiff);
    }
    if (minError < Infinity) {
      boundaryErrors.push(minError);
    }
  }

  boundaryErrors.sort((a, b) => a - b);

  const total = correct + incorrect;
  const reassignmentRate = total > 0 ? incorrect / total : 0;

  // Current pipeline correction rate: how many segments were actually corrected
  const currentPipelineRate = groundTruth.length > 0 ? totalCorrections / groundTruth.length : 0;

  return {
    totalSegments: total,
    correctSegments: correct,
    incorrectSegments: incorrect,
    reassignmentRate,
    currentPipelineRate,
    improvement: currentPipelineRate - reassignmentRate,
    boundaryErrors: {
      meanAbsoluteErrorMs:
        boundaryErrors.length > 0
          ? boundaryErrors.reduce((s, e) => s + e, 0) / boundaryErrors.length
          : 0,
      medianAbsoluteErrorMs:
        boundaryErrors.length > 0 ? boundaryErrors[Math.floor(boundaryErrors.length / 2)] : 0,
      p95ErrorMs:
        boundaryErrors.length > 0 ? boundaryErrors[Math.floor(boundaryErrors.length * 0.95)] : 0,
    },
    transitionZoneAnalysis: {
      totalTransitionSegments: transitionTotal,
      correctInTransitionZone: transitionCorrect,
      transitionZoneAccuracy: transitionTotal > 0 ? transitionCorrect / transitionTotal : 0,
    },
    perSpeakerAccuracy: Object.entries(perSpeaker)
      .map(([id, stats]) => ({
        speakerId: id,
        displayName: speakers[id]?.displayName || id,
        totalSegments: stats.total,
        correctSegments: stats.correct,
        accuracy: stats.total > 0 ? stats.correct / stats.total : 0,
      }))
      .sort((a, b) => b.totalSegments - a.totalSegments),
  };
}

// ============================================================================
// Report generation
// ============================================================================

function generateReport(result: ComparisonResult, conversationId: string): string {
  const lines: string[] = [];
  const p = (s: string) => lines.push(s);

  p('# Phase 2: Timestamp Alignment Evaluation');
  p('');
  p(`**Conversation:** \`${conversationId}\``);
  p(`**Generated:** ${new Date().toISOString()}`);
  p('');

  p('## Reassignment Rate');
  p('');
  p('The critical metric: what percentage of segments would need manual correction?');
  p('');
  p(`| Metric | Value |`);
  p(`|--------|-------|`);
  p(`| Total segments compared | ${result.totalSegments} |`);
  p(`| Correctly assigned | ${result.correctSegments} (${((1 - result.reassignmentRate) * 100).toFixed(1)}%) |`);
  p(`| Needing correction | ${result.incorrectSegments} (${(result.reassignmentRate * 100).toFixed(1)}%) |`);
  p(`| Current pipeline correction rate | ${(result.currentPipelineRate * 100).toFixed(1)}% |`);
  p(`| Improvement | ${(result.improvement * 100).toFixed(1)} percentage points |`);
  p(`| Acceptance (<=15% reassignment) | ${result.reassignmentRate <= 0.15 ? 'PASS' : 'FAIL'} |`);
  p('');

  p('## Timestamp Precision');
  p('');
  p('Since we keep WhisperX timestamps and only change speaker labels, timestamp');
  p('precision is preserved by design. But here are boundary error stats anyway:');
  p('');
  p(`| Metric | Value |`);
  p(`|--------|-------|`);
  p(`| Mean absolute error | ${result.boundaryErrors.meanAbsoluteErrorMs.toFixed(0)}ms |`);
  p(`| Median absolute error | ${result.boundaryErrors.medianAbsoluteErrorMs.toFixed(0)}ms |`);
  p(`| 95th percentile error | ${result.boundaryErrors.p95ErrorMs.toFixed(0)}ms |`);
  p(`| Acceptance (mean <=200ms) | ${result.boundaryErrors.meanAbsoluteErrorMs <= 200 ? 'PASS' : 'FAIL'} |`);
  p('');

  p('## Transition Zone Analysis');
  p('');
  p('Accuracy for segments within ±2 seconds of a speaker change:');
  p('');
  p(`| Metric | Value |`);
  p(`|--------|-------|`);
  p(`| Segments in transition zones | ${result.transitionZoneAnalysis.totalTransitionSegments} |`);
  p(`| Correctly assigned | ${result.transitionZoneAnalysis.correctInTransitionZone} |`);
  p(`| Transition zone accuracy | ${(result.transitionZoneAnalysis.transitionZoneAccuracy * 100).toFixed(1)}% |`);
  p('');

  p('## Per-Speaker Accuracy');
  p('');
  p(`| Speaker | Display Name | Segments | Correct | Accuracy |`);
  p(`|---------|-------------|----------|---------|----------|`);
  for (const s of result.perSpeakerAccuracy) {
    p(`| ${s.speakerId} | ${s.displayName} | ${s.totalSegments} | ${s.correctSegments} | ${(s.accuracy * 100).toFixed(1)}% |`);
  }
  p('');

  p('## Decision Gate Assessment');
  p('');
  const reassignPass = result.reassignmentRate <= 0.15;
  const boundaryPass = result.boundaryErrors.meanAbsoluteErrorMs <= 200;
  p(`- [${reassignPass ? 'x' : ' '}] Reassignment rate <= 15% (${(result.reassignmentRate * 100).toFixed(1)}%)`);
  p(`- [${boundaryPass ? 'x' : ' '}] Mean boundary error <= 200ms (${result.boundaryErrors.meanAbsoluteErrorMs.toFixed(0)}ms)`);
  p('');
  p(`**Phase 2 Outcome:** ${reassignPass && boundaryPass ? 'PASS — proceed to Phase 3' : 'NEEDS REVIEW'}`);
  p('');

  return lines.join('\n');
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const conversationId = process.argv[2] || 'c_1773188486911';

  console.log('='.repeat(70));
  console.log(`PoC: Compare Segments — conversation ${conversationId}`);
  console.log(`[Context] Scope: ${SCOPE}, Iteration: ${ITERATION}`);
  console.log('='.repeat(70));

  // Load aligned segments
  const alignedPath = path.join(RESULTS_DIR, 'aligned_segments.json');
  if (!fs.existsSync(alignedPath)) {
    throw new Error(
      `Aligned segments not found at ${alignedPath}\n` +
      'Run poc-align-speakers.ts first!'
    );
  }
  const aligned: AlignmentArtifact = JSON.parse(fs.readFileSync(alignedPath, 'utf-8'));
  console.log(`[Load] Aligned: ${aligned.totalSegments} segments`);

  // Build ground truth
  initFirebase();
  const gt = await buildGroundTruth(conversationId);
  console.log(`[Load] Ground truth: ${gt.segments.length} segments, ${gt.totalCorrections} corrections`);

  // Compare
  console.log('\n[Compare] Evaluating alignment quality...');
  const result = compareSegments(aligned, gt.segments, gt.speakers, gt.reassignCorrections);

  // Generate report
  const report = generateReport(result, conversationId);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const reportPath = path.join(RESULTS_DIR, 'phase2_alignment.md');
  fs.writeFileSync(reportPath, report);
  console.log(`\n[Report] Written to ${reportPath}`);

  // Save metrics
  const metricsPath = path.join(RESULTS_DIR, 'phase2_metrics.json');
  fs.writeFileSync(metricsPath, JSON.stringify(result, null, 2));
  console.log(`[Report] Metrics saved to ${metricsPath}`);

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(70));
  console.log(`Reassignment rate: ${(result.reassignmentRate * 100).toFixed(1)}% (target: <=15%)`);
  console.log(`Current pipeline rate: ${(result.currentPipelineRate * 100).toFixed(1)}%`);
  console.log(`Improvement: ${(result.improvement * 100).toFixed(1)} percentage points`);
  console.log(`Mean boundary error: ${result.boundaryErrors.meanAbsoluteErrorMs.toFixed(0)}ms`);
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
