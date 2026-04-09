#!/usr/bin/env tsx
/**
 * Quick GT Evaluation Script
 *
 * Compares Firestore segments against ground-truth .txt files
 * using the majority-vote methodology from the benchmark.
 *
 * Usage:
 *   npx tsx scripts/quick-gt-eval.ts <conversationId> <gtFilePath>
 */

import * as fs from 'fs';
import * as path from 'path';
import admin from 'firebase-admin';
import 'dotenv/config';

// ============================================================================
// Firebase init
// ============================================================================

const PROJECT_ID = process.env.VITE_FIREBASE_PROJECT_ID || 'audio-transcript-analyzer-01';
const serviceAccountPath = path.resolve(process.cwd(), 'service-account.json');
if (admin.apps.length === 0) {
  if (fs.existsSync(serviceAccountPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
      projectId: PROJECT_ID,
    });
  } else {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: PROJECT_ID,
    });
  }
}
const db = admin.firestore();

// ============================================================================
// Parse GT file
// ============================================================================

interface GTSegment {
  startMs: number;
  speaker: string;
  text: string;
}

function parseGTFile(filePath: string): GTSegment[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const segments: GTSegment[] = [];

  let currentSpeaker = '';
  let currentStartMs = 0;
  let currentText = '';

  for (const line of lines) {
    // Match timestamp line like "[0:04] Sanjay (client lead):" or "[17:42] Adam:"
    const timestampMatch = line.match(/^\[(\d+):(\d+)\]\s*([^:]+):/);

    if (timestampMatch) {
      // Save previous segment if exists
      if (currentSpeaker && currentText.trim()) {
        segments.push({
          startMs: currentStartMs,
          speaker: currentSpeaker.trim(),
          text: currentText.trim()
        });
      }

      const minutes = parseInt(timestampMatch[1], 10);
      const seconds = parseInt(timestampMatch[2], 10);
      currentStartMs = (minutes * 60 + seconds) * 1000;
      currentSpeaker = timestampMatch[3].trim();
      currentText = line.substring(line.indexOf(':') + 1).trim();
    } else if (line.trim() && !line.startsWith('═') && !line.startsWith('─') &&
               !line.startsWith('SPEAKERS') && !line.startsWith('TRANSCRIPT') &&
               !line.startsWith('•') && !line.startsWith('Date:') &&
               !line.startsWith('Duration:') && !line.match(/^[A-Z_]+$/)) {
      // Continuation of current segment
      if (currentSpeaker) {
        currentText += ' ' + line.trim();
      }
    }

    // Stop at editing marker
    if (line.includes('{{ENDED MANUAL FIXING HERE}}')) {
      break;
    }
  }

  // Don't forget last segment
  if (currentSpeaker && currentText.trim()) {
    segments.push({
      startMs: currentStartMs,
      speaker: currentSpeaker.trim(),
      text: currentText.trim()
    });
  }

  return segments;
}

// ============================================================================
// Fetch Firestore segments
// ============================================================================

interface FirestoreSegment {
  segmentId: string;
  speakerId: string;
  startMs: number;
  endMs: number;
  text: string;
}

async function getFirestoreSegments(conversationId: string): Promise<{
  segments: FirestoreSegment[];
  speakers: Map<string, string>;
  durationMs: number;
}> {
  const doc = await db.collection('conversations').doc(conversationId).get();
  if (!doc.exists) {
    throw new Error(`Conversation ${conversationId} not found`);
  }

  const data = doc.data()!;
  const rawSegments = Array.isArray(data.segments) ? data.segments : [];
  const segments: FirestoreSegment[] = rawSegments.map((s: any, i: number) => ({
    segmentId: s.segmentId || `seg_${i}`,
    speakerId: s.speakerId,
    startMs: s.startMs,
    endMs: s.endMs,
    text: s.text || ''
  }));

  // Build speaker display name map
  const speakers = new Map<string, string>();

  // Try array format first
  const rawSpeakers = Array.isArray(data.speakers) ? data.speakers : [];
  for (const spk of rawSpeakers) {
    if (spk && spk.speakerId) {
      speakers.set(spk.speakerId, spk.displayName || spk.speakerId);
    }
  }

  // If no speakers found, try object/map format
  if (speakers.size === 0 && data.speakers && typeof data.speakers === 'object') {
    for (const [key, val] of Object.entries(data.speakers)) {
      if (val && typeof val === 'object' && 'displayName' in (val as any)) {
        speakers.set(key, (val as any).displayName || key);
      }
    }
  }

  // If still no speakers, extract unique speaker IDs from segments
  if (speakers.size === 0) {
    for (const seg of segments) {
      if (seg.speakerId && !speakers.has(seg.speakerId)) {
        speakers.set(seg.speakerId, seg.speakerId);
      }
    }
  }

  // Fetch corrections subcollection and apply renames
  const correctionsSnap = await db
    .collection('conversations')
    .doc(conversationId)
    .collection('corrections')
    .get();

  // Apply rename corrections to speakers map
  for (const corrDoc of correctionsSnap.docs) {
    const corr = corrDoc.data();
    if (corr.type === 'rename' && corr.speakerId && corr.newDisplayName && !corr.undoneAt) {
      speakers.set(corr.speakerId, corr.newDisplayName);
    }
  }

  return {
    segments,
    speakers,
    durationMs: data.durationMs || 0
  };
}

// ============================================================================
// Evaluate
// ============================================================================

function normalizeForComparison(name: string): string {
  // Remove roles in parentheses, lowercase, trim
  return name
    .replace(/\s*\([^)]*\)/g, '')
    .toLowerCase()
    .trim();
}

function _speakersMatch(gtSpeaker: string, firestoreSpeaker: string, speakerMap?: Map<string, string>): boolean {
  // If we have an inferred mapping, use it
  if (speakerMap && speakerMap.has(gtSpeaker)) {
    return speakerMap.get(gtSpeaker) === firestoreSpeaker;
  }

  const gtNorm = normalizeForComparison(gtSpeaker);
  const fsNorm = normalizeForComparison(firestoreSpeaker);

  // Exact match
  if (gtNorm === fsNorm) return true;

  // Check if one contains the other
  if (gtNorm.includes(fsNorm) || fsNorm.includes(gtNorm)) return true;

  // Check first names
  const gtFirst = gtNorm.split(/\s+/)[0];
  const fsFirst = fsNorm.split(/\s+/)[0];
  if (gtFirst === fsFirst && gtFirst.length > 2) return true;

  return false;
}

// Infer speaker mapping by looking at time-aligned segments
function inferSpeakerMapping(
  gtSegments: Array<{startMs: number; endMs: number; speaker: string}>,
  fsSegments: FirestoreSegment[],
  speakers: Map<string, string>
): Map<string, string> {
  const gtToFs = new Map<string, Map<string, number>>(); // GT speaker -> FS speakerId -> overlap count

  for (const gt of gtSegments) {
    if (!gtToFs.has(gt.speaker)) {
      gtToFs.set(gt.speaker, new Map());
    }

    for (const fs of fsSegments) {
      const overlapStart = Math.max(gt.startMs, fs.startMs);
      const overlapEnd = Math.min(gt.endMs, fs.endMs);
      const overlap = Math.max(0, overlapEnd - overlapStart);

      if (overlap > 0) {
        const counts = gtToFs.get(gt.speaker)!;
        counts.set(fs.speakerId, (counts.get(fs.speakerId) || 0) + overlap);
      }
    }
  }

  // For each GT speaker, find the FS speaker with most overlap
  const mapping = new Map<string, string>();
  const usedFsSpeakers = new Set<string>();

  // Sort GT speakers by total overlap (most overlap first for better mapping)
  const gtSpeakers = [...gtToFs.entries()].sort((a, b) => {
    const totalA = [...a[1].values()].reduce((s, v) => s + v, 0);
    const totalB = [...b[1].values()].reduce((s, v) => s + v, 0);
    return totalB - totalA;
  });

  for (const [gtSpk, fsCounts] of gtSpeakers) {
    let bestFs = '';
    let bestOverlap = 0;

    for (const [fsSpk, overlap] of fsCounts) {
      if (!usedFsSpeakers.has(fsSpk) && overlap > bestOverlap) {
        bestOverlap = overlap;
        bestFs = fsSpk;
      }
    }

    if (bestFs) {
      mapping.set(gtSpk, bestFs);
      usedFsSpeakers.add(bestFs);
      console.log(`MAPPING: "${gtSpk}" -> "${bestFs}" (${speakers.get(bestFs) || bestFs}) with ${bestOverlap}ms overlap`);
    }
  }

  return mapping;
}

async function evaluate(conversationId: string, gtFilePath: string) {
  console.log(`\n=== Evaluating ${conversationId} ===\n`);
  console.log(`GT File: ${gtFilePath}\n`);

  // Parse GT
  const gtSegments = parseGTFile(gtFilePath);
  console.log(`GT segments parsed: ${gtSegments.length}`);

  // Fetch Firestore
  const { segments: fsSegments, speakers, durationMs } = await getFirestoreSegments(conversationId);
  console.log(`Firestore segments: ${fsSegments.length}`);
  console.log(`Duration: ${Math.round(durationMs / 1000 / 60)}m ${Math.round((durationMs / 1000) % 60)}s`);

  // Show speaker mappings
  console.log('\nSpeakers in Firestore:');
  for (const [id, name] of speakers) {
    console.log(`  ${id} -> ${name}`);
  }

  console.log('\nSpeakers in GT:');
  const gtSpeakerSet = new Set(gtSegments.map(s => s.speaker));
  for (const spk of gtSpeakerSet) {
    console.log(`  ${spk}`);
  }

  // Estimate GT segment end times (use next segment start or add 10s)
  const gtWithEnds = gtSegments.map((seg, i) => ({
    ...seg,
    endMs: i < gtSegments.length - 1 ? gtSegments[i + 1].startMs : seg.startMs + 10000
  }));

  // Infer speaker mapping based on time overlap
  console.log('\n=== INFERRING SPEAKER MAPPING ===');
  const speakerMapping = inferSpeakerMapping(gtWithEnds, fsSegments, speakers);

  // Evaluate using majority-vote methodology
  // For each GT segment, find overlapping Firestore segments
  // If majority of overlap duration matches GT speaker, count as correct

  let correct = 0;
  let incorrect = 0;
  let skipped = 0;

  for (const gt of gtWithEnds) {
    // Find Firestore segments with >50% overlap
    const gtDuration = gt.endMs - gt.startMs;
    let totalOverlap = 0;
    const speakerOverlaps = new Map<string, number>(); // speakerId -> overlap

    for (const fs of fsSegments) {
      const overlapStart = Math.max(gt.startMs, fs.startMs);
      const overlapEnd = Math.min(gt.endMs, fs.endMs);
      const overlap = Math.max(0, overlapEnd - overlapStart);

      if (overlap > 0) {
        totalOverlap += overlap;
        speakerOverlaps.set(fs.speakerId, (speakerOverlaps.get(fs.speakerId) || 0) + overlap);
      }
    }

    if (totalOverlap < gtDuration * 0.5) {
      skipped++;
      continue;
    }

    // Find majority speaker (by speakerId)
    let majoritySpeakerId = '';
    let maxOverlap = 0;
    for (const [spkId, overlap] of speakerOverlaps) {
      if (overlap > maxOverlap) {
        maxOverlap = overlap;
        majoritySpeakerId = spkId;
      }
    }

    // Check if this matches the expected speakerId for this GT speaker
    const expectedSpeakerId = speakerMapping.get(gt.speaker);
    if (expectedSpeakerId && majoritySpeakerId === expectedSpeakerId) {
      correct++;
    } else {
      incorrect++;
    }
  }

  const total = correct + incorrect;
  const accuracy = total > 0 ? (correct / total * 100).toFixed(1) : '0.0';
  const avgDuration = fsSegments.length > 0
    ? (durationMs / fsSegments.length / 1000).toFixed(1)
    : '0.0';

  console.log('\n=== RESULTS ===');
  console.log(`Correct: ${correct}`);
  console.log(`Incorrect: ${incorrect}`);
  console.log(`Skipped (no overlap): ${skipped}`);
  console.log(`Total evaluated: ${total}`);
  console.log(`Speaker Assignment Accuracy: ${accuracy}%`);
  console.log(`Avg Segment Duration: ${avgDuration}s`);
  console.log(`Speaker Count (Firestore): ${speakers.size}`);
  console.log(`Speaker Count (GT): ${gtSpeakerSet.size}`);

  return {
    conversationId,
    gtSpeakers: gtSpeakerSet.size,
    firestoreSpeakers: speakers.size,
    accuracy: parseFloat(accuracy),
    avgSegmentDuration: parseFloat(avgDuration),
    segmentsEvaluated: total,
    segmentsSkipped: skipped,
    durationMs
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const conversationId = process.argv[2];
  const gtFilePath = process.argv[3];

  if (!conversationId || !gtFilePath) {
    console.error('Usage: npx tsx scripts/quick-gt-eval.ts <conversationId> <gtFilePath>');
    process.exit(1);
  }

  if (!fs.existsSync(gtFilePath)) {
    console.error(`GT file not found: ${gtFilePath}`);
    process.exit(1);
  }

  try {
    const result = await evaluate(conversationId, gtFilePath);
    console.log('\n=== JSON OUTPUT ===');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }

  process.exit(0);
}

main();
