#!/usr/bin/env node
/* global process, console */
/**
 * Reset Metrics Script
 *
 * Fixes historical metrics that have inflated cost estimates due to
 * using wall-clock time instead of actual Replicate compute time.
 *
 * Also fixes metrics with missing durationMs fields (pre-v2.2.0 data).
 *
 * Usage:
 *   node scripts/reset-metrics.mjs --mode=dry-run         # Preview cost recalculation
 *   node scripts/reset-metrics.mjs --mode=recalculate     # Recalculate costs
 *   node scripts/reset-metrics.mjs --mode=analyze         # Analyze existing metrics
 *   node scripts/reset-metrics.mjs --mode=fix-missing-dry # Preview missing durationMs fixes
 *   node scripts/reset-metrics.mjs --mode=fix-missing     # Fix missing durationMs fields
 *   node scripts/reset-metrics.mjs --mode=delete          # Delete all metrics
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root
config({ path: join(__dirname, '../.env') });

const projectId = process.env.GCP_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID;
if (!projectId) {
  console.error('Error: GCP_PROJECT_ID or VITE_FIREBASE_PROJECT_ID not found in .env');
  process.exit(1);
}

// Initialize Firebase Admin using Application Default Credentials
// Run `gcloud auth application-default login` if not authenticated
initializeApp({
  credential: applicationDefault(),
  projectId
});

console.log(`Using project: ${projectId}\n`);
const db = getFirestore();

// Fetch current pricing from Firestore _pricing collection
async function fetchPricingFromFirestore() {
  console.log('Fetching pricing from Firestore _pricing collection...\n');

  const pricingSnap = await db.collection('_pricing')
    .orderBy('effectiveFrom', 'desc')
    .get();

  const pricing = {
    gemini: {
      audioInputPerMillion: null,  // From 'gemini-2.5-flash'
      textInputPerMillion: null,   // From 'gemini-2.5-flash-text'
      outputPerMillion: null       // From 'gemini-2.5-flash'
    },
    whisperx: { perSecond: null }  // Includes diarization (single Replicate model)
  };

  // Get the most recent pricing for each model
  for (const doc of pricingSnap.docs) {
    const data = doc.data();
    const model = data.model;

    // Audio input pricing from 'gemini-2.5-flash'
    if (model === 'gemini-2.5-flash' && !pricing.gemini.audioInputPerMillion) {
      pricing.gemini.audioInputPerMillion = data.inputPricePerMillion;
      pricing.gemini.outputPerMillion = data.outputPricePerMillion;
      console.log(`  Gemini Audio: $${data.inputPricePerMillion}/1M input (from ${data.effectiveFrom?.toDate?.().toLocaleDateString() || 'unknown'})`);
      console.log(`  Gemini Output: $${data.outputPricePerMillion}/1M output`);
    }
    // Text input pricing from 'gemini-2.5-flash-text'
    if (model === 'gemini-2.5-flash-text' && !pricing.gemini.textInputPerMillion) {
      pricing.gemini.textInputPerMillion = data.inputPricePerMillion;
      console.log(`  Gemini Text: $${data.inputPricePerMillion}/1M input (from ${data.effectiveFrom?.toDate?.().toLocaleDateString() || 'unknown'})`);
    }
    if (model === 'whisperx' && !pricing.whisperx.perSecond) {
      pricing.whisperx.perSecond = data.pricePerSecond;
      console.log(`  WhisperX: $${data.pricePerSecond}/sec (from ${data.effectiveFrom?.toDate?.().toLocaleDateString() || 'unknown'})`);
    }
  }

  // Validate we got all required pricing
  const missing = [];
  if (!pricing.gemini.audioInputPerMillion) missing.push('gemini-2.5-flash (audio input)');
  if (!pricing.gemini.textInputPerMillion) missing.push('gemini-2.5-flash-text (text input)');
  if (!pricing.whisperx.perSecond) missing.push('whisperx');

  if (missing.length > 0) {
    console.error('\n❌ Missing required pricing in _pricing collection!');
    console.error(`   Missing: ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log('');
  return pricing;
}

async function analyzeMetrics() {
  console.log(`\n🔍 Analyzing stored metrics data...\n`);

  const snapshot = await db.collection('_metrics').get();
  console.log(`Found ${snapshot.docs.length} metrics\n`);

  console.log('ConversationID   | Audio (m) | Stored Compute (s) | Ratio | Gemini In/Out | Stored Cost');
  console.log('─'.repeat(95));

  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (!data.llmUsage || !data.durationMs) continue;

    const audioDurationSec = data.durationMs / 1000;
    const storedComputeSec = data.llmUsage.whisperx?.computeTimeSeconds || 0;
    const ratio = storedComputeSec / audioDurationSec;
    const geminiIn = (data.llmUsage.geminiAnalysis?.inputTokens || 0) + (data.llmUsage.geminiSpeakerCorrection?.inputTokens || 0);
    const geminiOut = (data.llmUsage.geminiAnalysis?.outputTokens || 0) + (data.llmUsage.geminiSpeakerCorrection?.outputTokens || 0);
    const storedCost = data.estimatedCost?.totalUsd || 0;

    console.log(
      `${data.conversationId.slice(0, 16).padEnd(16)} | ` +
      `${(audioDurationSec/60).toFixed(1).padStart(9)} | ` +
      `${storedComputeSec.toFixed(1).padStart(18)} | ` +
      `${ratio.toFixed(2).padStart(5)} | ` +
      `${(geminiIn/1000).toFixed(0).padStart(5)}k/${(geminiOut/1000).toFixed(0).padStart(4)}k | ` +
      `$${storedCost.toFixed(4)}`
    );
  }

  console.log(`\n💡 If "Ratio" is > 1.0, the stored compute time exceeds audio duration (likely wall-clock time bug)`);
  console.log(`   If "Ratio" is ~0.1-0.3, it's probably actual Replicate compute time`);
}

async function recalculateCosts(dryRun) {
  console.log(`\n${dryRun ? '🔍 DRY RUN - ' : ''}Recalculating costs with Firestore pricing...\n`);

  // Fetch pricing from Firestore
  const pricing = await fetchPricingFromFirestore();

  const snapshot = await db.collection('_metrics').get();
  console.log(`Found ${snapshot.docs.length} metrics to process\n`);

  let updated = 0;
  let skipped = 0;
  let totalOldCost = 0;
  let totalNewCost = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();

    if (!data.llmUsage || !data.durationMs) {
      skipped++;
      continue;
    }

    const audioDurationSec = data.durationMs / 1000;
    const storedComputeSec = data.llmUsage.whisperx?.computeTimeSeconds || 0;

    // Check if stored compute time looks like wall-clock (ratio > 0.5 is suspicious)
    // Real GPU compute should be ~10-20% of audio duration
    const ratio = storedComputeSec / audioDurationSec;
    const likelyWallClock = ratio > 0.5;

    // If wall-clock bug detected, estimate actual compute as 15% of audio duration
    // Otherwise keep the stored value (it's probably correct)
    const computeSecToUse = likelyWallClock
      ? audioDurationSec * 0.15  // Estimate: ~15% of audio duration
      : storedComputeSec;

    // Recalculate with Firestore pricing (WhisperX includes diarization)
    const newWhisperxCost = computeSecToUse * pricing.whisperx.perSecond;

    // Recalculate Gemini with Firestore pricing (audio vs text breakdown)
    // Check if metric has the new audio/text breakdown
    const analysisAudioTokens = data.llmUsage.geminiAnalysis?.audioInputTokens || 0;
    const analysisTextTokens = data.llmUsage.geminiAnalysis?.textInputTokens || 0;
    const correctionTextTokens = data.llmUsage.geminiSpeakerCorrection?.textInputTokens ||
      data.llmUsage.geminiSpeakerCorrection?.inputTokens || 0;

    // If no breakdown available, treat all input as text (conservative - cheaper rate)
    const hasBreakdown = analysisAudioTokens > 0 || analysisTextTokens > 0;
    const fallbackInputTokens = hasBreakdown ? 0 :
      (data.llmUsage.geminiAnalysis?.inputTokens || 0);

    const totalAudioTokens = analysisAudioTokens;
    const totalTextTokens = analysisTextTokens + correctionTextTokens + fallbackInputTokens;
    const totalOutputTokens =
      (data.llmUsage.geminiAnalysis?.outputTokens || 0) +
      (data.llmUsage.geminiSpeakerCorrection?.outputTokens || 0);

    const geminiAudioCost = (totalAudioTokens / 1_000_000) * pricing.gemini.audioInputPerMillion;
    const geminiTextCost = (totalTextTokens / 1_000_000) * pricing.gemini.textInputPerMillion;
    const geminiOutputCost = (totalOutputTokens / 1_000_000) * pricing.gemini.outputPerMillion;
    const geminiCost = geminiAudioCost + geminiTextCost + geminiOutputCost;

    const oldTotal = data.estimatedCost?.totalUsd || 0;
    const newTotal = geminiCost + newWhisperxCost;

    totalOldCost += oldTotal;
    totalNewCost += newTotal;

    const changePercent = oldTotal > 0 ? ((newTotal/oldTotal - 1) * 100).toFixed(0) : 'N/A';
    const bugIndicator = likelyWallClock ? ' ⚠️' : '';
    const breakdownIndicator = hasBreakdown ? '' : ' (no audio/text breakdown)';
    console.log(`${data.conversationId.slice(0, 12)}... | Audio: ${(audioDurationSec/60).toFixed(1)}m | Old: $${oldTotal.toFixed(4)} → New: $${newTotal.toFixed(4)} (${changePercent}%)${bugIndicator}${breakdownIndicator}`);

    if (!dryRun) {
      const updateData = {
        'estimatedCost': {
          geminiUsd: Math.round(geminiCost * 1000000) / 1000000,
          geminiAudioInputUsd: Math.round(geminiAudioCost * 1000000) / 1000000,
          geminiTextInputUsd: Math.round(geminiTextCost * 1000000) / 1000000,
          geminiOutputUsd: Math.round(geminiOutputCost * 1000000) / 1000000,
          whisperxUsd: Math.round(newWhisperxCost * 1000000) / 1000000,
          totalUsd: Math.round(newTotal * 1000000) / 1000000
        }
      };
      // Only update compute time if we detected the wall-clock bug
      if (likelyWallClock) {
        updateData['llmUsage.whisperx.computeTimeSeconds'] = computeSecToUse;
      }
      await doc.ref.update(updateData);
    }

    updated++;
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Summary:`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Old total: $${totalOldCost.toFixed(4)}`);
  console.log(`  New total: $${totalNewCost.toFixed(4)}`);
  if (totalOldCost > 0) {
    console.log(`  Savings:   $${(totalOldCost - totalNewCost).toFixed(4)} (${((1 - totalNewCost/totalOldCost) * 100).toFixed(0)}% reduction)`);
  }

  if (dryRun) {
    console.log(`\n⚠️  This was a dry run. Run with --mode=recalculate to apply changes.`);
  } else {
    console.log(`\n✅ Done! Metrics have been updated.`);
  }
}

async function fixMissingDuration(dryRun) {
  console.log(`\n${dryRun ? '🔍 DRY RUN - ' : ''}Fixing metrics with missing durationMs...\n`);

  const snapshot = await db.collection('_metrics').get();
  console.log(`Found ${snapshot.docs.length} total metrics\n`);

  let fixed = 0;
  let skipped = 0;
  let notFound = 0;
  let alreadyValid = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();

    // Check if durationMs is missing or invalid (NaN, undefined, null, 0)
    const hasMissingDuration = !data.durationMs ||
      isNaN(data.durationMs) ||
      data.durationMs === 0;

    if (!hasMissingDuration) {
      alreadyValid++;
      continue;
    }

    // Try to look up the conversation to get the actual duration
    const conversationId = data.conversationId;
    if (!conversationId) {
      console.log(`  ⚠️  ${doc.id}: No conversationId, skipping`);
      skipped++;
      continue;
    }

    // Find the conversation document (could be in any user's subcollection)
    // Search across all users' conversations
    const usersSnapshot = await db.collectionGroup('conversations')
      .where('id', '==', conversationId)
      .limit(1)
      .get();

    if (usersSnapshot.empty) {
      console.log(`  ⚠️  ${conversationId.slice(0, 12)}... No conversation found`);
      notFound++;
      continue;
    }

    const conversation = usersSnapshot.docs[0].data();
    const convDurationMs = conversation.durationMs;

    if (!convDurationMs || isNaN(convDurationMs) || convDurationMs === 0) {
      console.log(`  ⚠️  ${conversationId.slice(0, 12)}... Conversation has no valid durationMs`);
      notFound++;
      continue;
    }

    console.log(`  ✓  ${conversationId.slice(0, 12)}... Setting durationMs: ${(convDurationMs/1000/60).toFixed(1)}m`);

    if (!dryRun) {
      await doc.ref.update({ durationMs: convDurationMs });
    }

    fixed++;
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Summary:`);
  console.log(`  Already valid: ${alreadyValid}`);
  console.log(`  Fixed:         ${fixed}`);
  console.log(`  Not found:     ${notFound}`);
  console.log(`  Skipped:       ${skipped}`);

  if (dryRun) {
    console.log(`\n⚠️  This was a dry run. Run with --mode=fix-missing to apply changes.`);
  } else {
    console.log(`\n✅ Done! ${fixed} metrics have been updated.`);
  }
}

async function deleteAllMetrics(dryRun) {
  console.log(`\n${dryRun ? '🔍 DRY RUN - ' : ''}Deleting all metrics...\n`);

  const snapshot = await db.collection('_metrics').get();
  console.log(`Found ${snapshot.docs.length} metrics to delete`);

  if (dryRun) {
    console.log(`\n⚠️  This was a dry run. Run with --mode=delete to actually delete.`);
    return;
  }

  // Delete in batches of 500
  const batchSize = 500;
  let deleted = 0;

  while (deleted < snapshot.docs.length) {
    const batch = db.batch();
    const docs = snapshot.docs.slice(deleted, deleted + batchSize);

    for (const doc of docs) {
      batch.delete(doc.ref);
    }

    await batch.commit();
    deleted += docs.length;
    console.log(`Deleted ${deleted}/${snapshot.docs.length}`);
  }

  console.log(`\n✅ Done! All metrics have been deleted.`);
}

async function main() {
  const args = process.argv.slice(2);
  const modeArg = args.find(a => a.startsWith('--mode='));
  const mode = modeArg?.split('=')[1] || 'dry-run';

  console.log('╔════════════════════════════════════════╗');
  console.log('║       Metrics Reset Script             ║');
  console.log('╚════════════════════════════════════════╝');

  switch (mode) {
    case 'analyze':
      await analyzeMetrics();
      break;
    case 'recalculate':
      await recalculateCosts(false);
      break;
    case 'fix-missing':
      await fixMissingDuration(false);
      break;
    case 'fix-missing-dry':
      await fixMissingDuration(true);
      break;
    case 'delete':
      await deleteAllMetrics(false);
      break;
    case 'dry-run':
    default:
      await recalculateCosts(true);
      break;
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
