#!/usr/bin/env tsx
/**
 * Phase 1: Evaluate Gemini Diarization Quality
 *
 * Loads Gemini's diarization output and the corrected ground truth
 * from Firestore, then computes how well Gemini did.
 *
 * The tricky part: Gemini uses names like "JJ" or "Sammy" while
 * Firestore has IDs like "spk_chunk0_SPEAKER_02". We need fuzzy
 * matching to align them before we can score anything.
 *
 * Usage:
 *   npx tsx scripts/poc-evaluate-diarization.ts [conversationId] [iteration]
 *
 * Requires:
 *   gemini_diarization_raw.json from poc-gemini-diarize.ts
 *
 * Output:
 *   .agent_process/work/poc_gemini_hybrid/<iteration>/results/phase1_diarization.md
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as admin from 'firebase-admin';
import 'dotenv/config';
import { resolvePocResultsDir } from './poc-results-dir.js';

import type { DiarizationArtifact, GeminiSpeakerSegment } from './poc-gemini-diarize.js';

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

interface GroundTruthSegment {
  segmentId: string;
  index: number;
  speakerId: string;    // canonical speaker ID (after corrections)
  startMs: number;
  endMs: number;
  text: string;
}

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

interface SpeakerMapping {
  geminiLabel: string;
  canonicalId: string;
  confidence: number;
  overlapSeconds: number;
}

interface ConfusionEntry {
  predicted: string;
  actual: string;
  count: number;
}

interface EvaluationResult {
  speakerCountGemini: number;
  speakerCountGroundTruth: number;
  speakerCountDelta: number;
  segmentAccuracy: number;
  speakerMappings: SpeakerMapping[];
  confusionMatrix: ConfusionEntry[];
  transitionAccuracy: {
    totalTransitions: number;
    correctTransitions: number;
    accuracy: number;
    meanBoundaryErrorMs: number;
  };
  segmentsEvaluated: number;
  segmentsSkipped: number;
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
// Ground truth construction
// ============================================================================

/**
 * Build ground truth by applying speaker corrections to raw segments.
 *
 * The corrections subcollection uses apply-on-read semantics:
 *   - merge: replace all sourceSpeakerId → targetSpeakerId
 *   - reassign: change speakerId for specific segmentIds
 *   - rename: change displayName (doesn't affect our evaluation)
 *
 * We only care about speaker ID assignments, not display names.
 */
async function buildGroundTruth(
  conversationId: string
): Promise<{
  segments: GroundTruthSegment[];
  speakers: Record<string, { displayName: string }>;
  corrections: SpeakerCorrection[];
}> {
  const db = admin.firestore();

  // Get conversation doc
  const convoDoc = await db.collection('conversations').doc(conversationId).get();
  if (!convoDoc.exists) {
    throw new Error(`Conversation ${conversationId} not found`);
  }
  const convoData = convoDoc.data()!;

  // Get raw segments
  const rawSegments: GroundTruthSegment[] = (convoData.segments || []).map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (seg: any, idx: number) => ({
      segmentId: seg.segmentId || `seg_${idx}`,
      index: seg.index ?? idx,
      speakerId: seg.speakerId,
      startMs: seg.startMs,
      endMs: seg.endMs,
      text: seg.text,
    })
  );

  // Get speaker corrections (active only — no undoneAt)
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

  console.log(`[GroundTruth] ${rawSegments.length} raw segments, ${corrections.length} active corrections`);

  // Apply corrections in chronological order
  const correctedSegments = applyCorrectionsPoc(rawSegments, corrections);

  // Build corrected speaker set
  const speakerIds = new Set(correctedSegments.map((s) => s.speakerId));
  const speakers: Record<string, { displayName: string }> = {};
  for (const id of speakerIds) {
    const original = convoData.speakers?.[id];
    speakers[id] = { displayName: original?.displayName || id };
  }

  // Apply renames to display names
  for (const c of corrections) {
    if (c.type === 'rename' && c.speakerId && c.newDisplayName) {
      if (speakers[c.speakerId]) {
        speakers[c.speakerId].displayName = c.newDisplayName;
      }
    }
  }

  console.log(`[GroundTruth] After corrections: ${speakerIds.size} speakers, ${correctedSegments.length} segments`);

  return { segments: correctedSegments, speakers, corrections };
}

/**
 * Apply merge and reassign corrections to segments.
 * This is our own minimal implementation — we don't import
 * production code because we're PoC rebels.
 */
function applyCorrectionsPoc(
  segments: GroundTruthSegment[],
  corrections: SpeakerCorrection[]
): GroundTruthSegment[] {
  // Deep copy so we don't mutate
  let result = segments.map((s) => ({ ...s }));

  for (const c of corrections) {
    if (c.type === 'merge' && c.sourceSpeakerId && c.targetSpeakerId) {
      // All segments with source speaker → target speaker
      result = result.map((seg) =>
        seg.speakerId === c.sourceSpeakerId
          ? { ...seg, speakerId: c.targetSpeakerId! }
          : seg
      );
    } else if (c.type === 'reassign' && c.segmentIds && c.toSpeakerId) {
      // Only specific segments get reassigned
      const segIds = new Set(c.segmentIds);
      result = result.map((seg) =>
        segIds.has(seg.segmentId) ? { ...seg, speakerId: c.toSpeakerId! } : seg
      );
    }
    // 'rename' doesn't change speaker IDs, skip
  }

  return result;
}

// ============================================================================
// Speaker alignment — matching Gemini labels to canonical IDs
// ============================================================================

/**
 * Match Gemini's speaker labels to ground-truth canonical IDs using
 * temporal overlap. For each Gemini label, find which canonical speaker
 * it overlaps with the most (in seconds).
 *
 * This is basically a greedy bipartite matching — not optimal, but
 * good enough for a PoC. If we needed perfect matching we'd use the
 * Hungarian algorithm, but the overlap signal is usually strong enough.
 */
function alignSpeakers(
  geminiSegments: GeminiSpeakerSegment[],
  groundTruth: GroundTruthSegment[]
): SpeakerMapping[] {
  // Build overlap matrix: geminiLabel → canonicalId → overlapMs
  const overlapMatrix: Record<string, Record<string, number>> = {};

  for (const gSeg of geminiSegments) {
    if (!overlapMatrix[gSeg.speaker]) {
      overlapMatrix[gSeg.speaker] = {};
    }

    for (const gtSeg of groundTruth) {
      // Compute temporal overlap
      const overlapStart = Math.max(gSeg.startMs, gtSeg.startMs);
      const overlapEnd = Math.min(gSeg.endMs, gtSeg.endMs);
      const overlapMs = Math.max(0, overlapEnd - overlapStart);

      if (overlapMs > 0) {
        overlapMatrix[gSeg.speaker][gtSeg.speakerId] =
          (overlapMatrix[gSeg.speaker][gtSeg.speakerId] || 0) + overlapMs;
      }
    }
  }

  // Greedy assignment: for each Gemini label, pick the canonical ID
  // with the most overlap. Allow many-to-one (Gemini might over-split).
  const mappings: SpeakerMapping[] = [];

  for (const [geminiLabel, overlaps] of Object.entries(overlapMatrix)) {
    const entries = Object.entries(overlaps).sort((a, b) => b[1] - a[1]);

    if (entries.length === 0) {
      console.warn(`[Align] Gemini label "${geminiLabel}" has no temporal overlap with any ground truth speaker`);
      continue;
    }

    const [bestCanonical, bestOverlapMs] = entries[0];
    const totalOverlap = entries.reduce((sum, [, ms]) => sum + ms, 0);
    const confidence = bestOverlapMs / Math.max(totalOverlap, 1);

    mappings.push({
      geminiLabel,
      canonicalId: bestCanonical,
      confidence,
      overlapSeconds: bestOverlapMs / 1000,
    });

    if (confidence < 0.7) {
      console.warn(
        `[Align] Low-confidence mapping: "${geminiLabel}" → ${bestCanonical} (${(confidence * 100).toFixed(0)}%)`
      );
    }
  }

  return mappings;
}

// ============================================================================
// Evaluation metrics
// ============================================================================

function evaluateDiarization(
  geminiSegments: GeminiSpeakerSegment[],
  groundTruth: GroundTruthSegment[],
  mappings: SpeakerMapping[]
): EvaluationResult {
  // Build lookup: geminiLabel → canonicalId
  const labelToCanonical: Record<string, string> = {};
  for (const m of mappings) {
    labelToCanonical[m.geminiLabel] = m.canonicalId;
  }

  // For each ground truth segment, find the best-matching Gemini segment
  // (by temporal overlap) and check if the speaker matches.
  let correct = 0;
  let evaluated = 0;
  let skipped = 0;

  const confusion: Record<string, Record<string, number>> = {};

  for (const gtSeg of groundTruth) {
    // Find Gemini segment with maximum overlap
    let bestGemini: GeminiSpeakerSegment | null = null;
    let bestOverlap = 0;

    for (const gSeg of geminiSegments) {
      const overlapStart = Math.max(gSeg.startMs, gtSeg.startMs);
      const overlapEnd = Math.min(gSeg.endMs, gtSeg.endMs);
      const overlapMs = Math.max(0, overlapEnd - overlapStart);

      if (overlapMs > bestOverlap) {
        bestOverlap = overlapMs;
        bestGemini = gSeg;
      }
    }

    if (!bestGemini || bestOverlap === 0) {
      skipped++;
      continue;
    }

    evaluated++;
    const predictedCanonical = labelToCanonical[bestGemini.speaker] || 'UNKNOWN';
    const actualCanonical = gtSeg.speakerId;

    // Track confusion
    if (!confusion[actualCanonical]) confusion[actualCanonical] = {};
    confusion[actualCanonical][predictedCanonical] =
      (confusion[actualCanonical][predictedCanonical] || 0) + 1;

    if (predictedCanonical === actualCanonical) {
      correct++;
    }
  }

  // Build confusion entries (for the report)
  const confusionEntries: ConfusionEntry[] = [];
  for (const [actual, predictions] of Object.entries(confusion)) {
    for (const [predicted, count] of Object.entries(predictions)) {
      confusionEntries.push({ predicted, actual, count });
    }
  }
  confusionEntries.sort((a, b) => b.count - a.count);

  // Transition accuracy: at speaker change points in ground truth,
  // does Gemini also detect a change?
  const transitions = evaluateTransitions(geminiSegments, groundTruth, labelToCanonical);

  const geminiSpeakers = new Set(geminiSegments.map((s) => s.speaker));
  const gtSpeakers = new Set(groundTruth.map((s) => s.speakerId));

  return {
    speakerCountGemini: geminiSpeakers.size,
    speakerCountGroundTruth: gtSpeakers.size,
    speakerCountDelta: geminiSpeakers.size - gtSpeakers.size,
    segmentAccuracy: evaluated > 0 ? correct / evaluated : 0,
    speakerMappings: mappings,
    confusionMatrix: confusionEntries,
    transitionAccuracy: transitions,
    segmentsEvaluated: evaluated,
    segmentsSkipped: skipped,
  };
}

/**
 * Evaluate speaker transition detection.
 * At each point where the ground truth speaker changes,
 * check if Gemini also changes speaker (within a tolerance window).
 */
function evaluateTransitions(
  geminiSegments: GeminiSpeakerSegment[],
  groundTruth: GroundTruthSegment[],
  labelToCanonical: Record<string, string>
): { totalTransitions: number; correctTransitions: number; accuracy: number; meanBoundaryErrorMs: number } {
  const TOLERANCE_MS = 2000; // ±2 second window for boundary matching

  // Find transition points in ground truth
  const gtTransitions: Array<{ timeMs: number; fromSpeaker: string; toSpeaker: string }> = [];
  for (let i = 1; i < groundTruth.length; i++) {
    if (groundTruth[i].speakerId !== groundTruth[i - 1].speakerId) {
      gtTransitions.push({
        timeMs: groundTruth[i].startMs,
        fromSpeaker: groundTruth[i - 1].speakerId,
        toSpeaker: groundTruth[i].speakerId,
      });
    }
  }

  // Find transition points in Gemini output (mapped to canonical IDs)
  const geminiTransitions: Array<{ timeMs: number; fromSpeaker: string; toSpeaker: string }> = [];
  for (let i = 1; i < geminiSegments.length; i++) {
    const prevCanonical = labelToCanonical[geminiSegments[i - 1].speaker] || geminiSegments[i - 1].speaker;
    const currCanonical = labelToCanonical[geminiSegments[i].speaker] || geminiSegments[i].speaker;
    if (currCanonical !== prevCanonical) {
      geminiTransitions.push({
        timeMs: geminiSegments[i].startMs,
        fromSpeaker: prevCanonical,
        toSpeaker: currCanonical,
      });
    }
  }

  // Match transitions
  let correctCount = 0;
  let totalBoundaryError = 0;
  const matched = new Set<number>();

  for (const gtTrans of gtTransitions) {
    // Find closest Gemini transition with matching speaker change
    let bestIdx = -1;
    let bestError = Infinity;

    for (let j = 0; j < geminiTransitions.length; j++) {
      if (matched.has(j)) continue;

      const timeDiff = Math.abs(geminiTransitions[j].timeMs - gtTrans.timeMs);
      if (
        timeDiff <= TOLERANCE_MS &&
        geminiTransitions[j].toSpeaker === gtTrans.toSpeaker &&
        timeDiff < bestError
      ) {
        bestIdx = j;
        bestError = timeDiff;
      }
    }

    if (bestIdx >= 0) {
      correctCount++;
      totalBoundaryError += bestError;
      matched.add(bestIdx);
    }
  }

  return {
    totalTransitions: gtTransitions.length,
    correctTransitions: correctCount,
    accuracy: gtTransitions.length > 0 ? correctCount / gtTransitions.length : 0,
    meanBoundaryErrorMs: correctCount > 0 ? totalBoundaryError / correctCount : 0,
  };
}

// ============================================================================
// Report generation
// ============================================================================

function generateReport(
  result: EvaluationResult,
  conversationId: string,
  groundTruthSpeakers: Record<string, { displayName: string }>
): string {
  const lines: string[] = [];
  const p = (s: string) => lines.push(s);

  p('# Phase 1: Gemini Diarization Quality Evaluation');
  p('');
  p(`**Conversation:** \`${conversationId}\``);
  p(`**Generated:** ${new Date().toISOString()}`);
  p('');
  p('## Speaker Count');
  p('');
  p(`| Metric | Value |`);
  p(`|--------|-------|`);
  p(`| Ground truth speakers | ${result.speakerCountGroundTruth} |`);
  p(`| Gemini speakers | ${result.speakerCountGemini} |`);
  p(`| Delta | ${result.speakerCountDelta > 0 ? '+' : ''}${result.speakerCountDelta} |`);
  p(`| Acceptance (within 2) | ${Math.abs(result.speakerCountDelta) <= 2 ? 'PASS' : 'FAIL'} |`);
  p('');

  p('## Speaker Mapping');
  p('');
  p('How Gemini labels were matched to canonical speaker IDs:');
  p('');
  p(`| Gemini Label | Canonical ID | Display Name | Confidence | Overlap (s) |`);
  p(`|-------------|-------------|-------------|-----------|------------|`);
  for (const m of result.speakerMappings) {
    const displayName = groundTruthSpeakers[m.canonicalId]?.displayName || '?';
    p(`| ${m.geminiLabel} | ${m.canonicalId} | ${displayName} | ${(m.confidence * 100).toFixed(0)}% | ${m.overlapSeconds.toFixed(1)} |`);
  }
  p('');

  p('## Segment-Level Speaker Accuracy');
  p('');
  p(`| Metric | Value |`);
  p(`|--------|-------|`);
  p(`| Segments evaluated | ${result.segmentsEvaluated} |`);
  p(`| Segments skipped (no overlap) | ${result.segmentsSkipped} |`);
  p(`| Correct speaker assignment | ${(result.segmentAccuracy * 100).toFixed(1)}% |`);
  p(`| Acceptance (>=60%) | ${result.segmentAccuracy >= 0.6 ? 'PASS' : 'FAIL'} |`);
  p('');

  p('## Transition Boundary Accuracy');
  p('');
  p(`| Metric | Value |`);
  p(`|--------|-------|`);
  p(`| Ground truth transitions | ${result.transitionAccuracy.totalTransitions} |`);
  p(`| Correctly detected | ${result.transitionAccuracy.correctTransitions} |`);
  p(`| Transition accuracy | ${(result.transitionAccuracy.accuracy * 100).toFixed(1)}% |`);
  p(`| Mean boundary error | ${result.transitionAccuracy.meanBoundaryErrorMs.toFixed(0)}ms |`);
  p('');

  p('## Confusion Matrix (Top 20)');
  p('');
  p('Shows which speakers Gemini confused with each other:');
  p('');
  p(`| Actual Speaker | Predicted Speaker | Count |`);
  p(`|---------------|------------------|-------|`);
  for (const entry of result.confusionMatrix.slice(0, 20)) {
    const isCorrect = entry.actual === entry.predicted;
    p(`| ${entry.actual} | ${entry.predicted} | ${entry.count} ${isCorrect ? '✓' : '✗'} |`);
  }
  p('');

  p('## Decision Gate Assessment');
  p('');
  const speakerCountPass = Math.abs(result.speakerCountDelta) <= 2;
  const accuracyPass = result.segmentAccuracy >= 0.6;
  p(`- [${speakerCountPass ? 'x' : ' '}] Speaker count within 2 of actual (${result.speakerCountGemini} vs ${result.speakerCountGroundTruth})`);
  p(`- [${accuracyPass ? 'x' : ' '}] Segment accuracy >= 60% (${(result.segmentAccuracy * 100).toFixed(1)}%)`);
  p(`- [ ] Named speakers correctly identified and not split (manual review needed)`);
  p('');
  p(`**Phase 1 Outcome:** ${speakerCountPass && accuracyPass ? 'PASS — proceed to Phase 2' : 'NEEDS REVIEW'}`);
  p('');

  return lines.join('\n');
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const conversationId = process.argv[2] || 'c_1773188486911';

  console.log('='.repeat(70));
  console.log(`PoC: Evaluate Diarization — conversation ${conversationId}`);
  console.log(`[Context] Scope: ${SCOPE}, Iteration: ${ITERATION}`);
  console.log('='.repeat(70));

  // Load Gemini artifact
  const artifactPath = path.join(RESULTS_DIR, 'gemini_diarization_raw.json');
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `Gemini diarization artifact not found at ${artifactPath}\n` +
      'Run poc-gemini-diarize.ts first!'
    );
  }
  const artifact: DiarizationArtifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));

  if (artifact.rawText && artifact.result.segments.length === 0) {
    throw new Error('Gemini diarization failed to produce parseable JSON. Check the raw artifact.');
  }

  const geminiSpkCount = Array.isArray(artifact.result.speakers)
    ? artifact.result.speakers.length
    : Object.keys(artifact.result.speakers).length;
  console.log(`[Load] Gemini output: ${artifact.result.segments.length} segments, ${geminiSpkCount} speakers`);

  // Build ground truth from Firestore
  initFirebase();
  const groundTruth = await buildGroundTruth(conversationId);
  console.log(`[Load] Ground truth: ${groundTruth.segments.length} segments, ${Object.keys(groundTruth.speakers).length} speakers`);
  console.log(`[Load] Applied ${groundTruth.corrections.length} corrections`);

  // Align speakers
  console.log('\n[Evaluate] Aligning speakers...');
  const mappings = alignSpeakers(artifact.result.segments, groundTruth.segments);
  console.log(`[Evaluate] Mapped ${mappings.length} Gemini labels to canonical IDs`);

  // Evaluate
  console.log('[Evaluate] Computing metrics...');
  const result = evaluateDiarization(
    artifact.result.segments,
    groundTruth.segments,
    mappings
  );

  // Generate report
  const report = generateReport(result, conversationId, groundTruth.speakers);
  const reportPath = path.join(RESULTS_DIR, 'phase1_diarization.md');
  fs.writeFileSync(reportPath, report);
  console.log(`\n[Report] Written to ${reportPath}`);

  // Save evaluation metrics as JSON too (for Phase 4 benchmarking)
  const metricsPath = path.join(RESULTS_DIR, 'phase1_metrics.json');
  fs.writeFileSync(metricsPath, JSON.stringify(result, null, 2));
  console.log(`[Report] Metrics saved to ${metricsPath}`);

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(70));
  console.log(`Speaker count: ${result.speakerCountGemini} (ground truth: ${result.speakerCountGroundTruth})`);
  console.log(`Segment accuracy: ${(result.segmentAccuracy * 100).toFixed(1)}%`);
  console.log(`Transition accuracy: ${(result.transitionAccuracy.accuracy * 100).toFixed(1)}%`);
  console.log(`Mean boundary error: ${result.transitionAccuracy.meanBoundaryErrorMs.toFixed(0)}ms`);
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
