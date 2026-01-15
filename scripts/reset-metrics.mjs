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
 *   node scripts/reset-metrics.mjs --mode=dry-run             # Preview cost recalculation
 *   node scripts/reset-metrics.mjs --mode=recalculate         # Recalculate costs
 *   node scripts/reset-metrics.mjs --mode=analyze             # Analyze existing metrics
 *   node scripts/reset-metrics.mjs --mode=fix-missing-dry     # Preview missing durationMs fixes
 *   node scripts/reset-metrics.mjs --mode=fix-missing         # Fix missing durationMs fields
 *   node scripts/reset-metrics.mjs --mode=fix-status-dry      # Preview status fixes (failed → success)
 *   node scripts/reset-metrics.mjs --mode=fix-status          # Fix incorrect failed status
 *   node scripts/reset-metrics.mjs --mode=fix-type-dry        # Preview type fixes (remove incorrect chat type)
 *   node scripts/reset-metrics.mjs --mode=fix-type            # Remove incorrect type='chat' from processing metrics
 *   node scripts/reset-metrics.mjs --mode=delete-orphaned-dry # Preview orphaned metrics deletion
 *   node scripts/reset-metrics.mjs --mode=delete-orphaned     # Delete metrics with no conversation
 *   node scripts/reset-metrics.mjs --mode=delete              # Delete ALL metrics (danger!)
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
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
    const userId = data.userId;

    if (!conversationId || !userId) {
      console.log(`  ⚠️  ${doc.id}: Missing conversationId or userId, skipping`);
      skipped++;
      continue;
    }

    // Look up conversation directly at root level
    // Structure: conversations/{conversationId}
    const convDoc = await db
      .collection('conversations')
      .doc(conversationId)
      .get();

    if (!convDoc.exists) {
      console.log(`  ⚠️  ${conversationId.slice(0, 12)}... No conversation found`);
      notFound++;
      continue;
    }

    const conversation = convDoc.data();
    const convDurationMs = conversation.durationMs;
    const convStatus = conversation.status;

    if (!convDurationMs || isNaN(convDurationMs) || convDurationMs === 0) {
      console.log(`  ⚠️  ${conversationId.slice(0, 12)}... Conversation has no valid durationMs`);
      notFound++;
      continue;
    }

    // Build update object
    const updateData = { durationMs: convDurationMs };

    // If conversation is complete but metric says failed, fix the status
    const metricStatus = data.status;
    const shouldFixStatus = convStatus === 'complete' && metricStatus === 'failed';

    if (shouldFixStatus) {
      updateData.status = 'success';
      console.log(`  ✓  ${conversationId.slice(0, 12)}... Setting durationMs: ${(convDurationMs/1000/60).toFixed(1)}m, status: failed → success`);
    } else {
      console.log(`  ✓  ${conversationId.slice(0, 12)}... Setting durationMs: ${(convDurationMs/1000/60).toFixed(1)}m`);
    }

    if (!dryRun) {
      await doc.ref.update(updateData);
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

async function fixIncorrectStatus(dryRun) {
  console.log(`\n${dryRun ? '🔍 DRY RUN - ' : ''}Fixing metrics with incorrect status...\n`);

  const snapshot = await db.collection('_metrics').get();
  console.log(`Found ${snapshot.docs.length} total metrics\n`);

  // Show status and type breakdown
  const statusCounts = {};
  const typeCounts = {};
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const status = data.status || 'undefined';
    const type = data.type || 'processing';  // processing metrics don't have type field
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  }
  console.log('Status breakdown:', statusCounts);
  console.log('Type breakdown:', typeCounts, '\n');

  // First pass: calculate average processing ratio from successful metrics
  let totalRatio = 0;
  let ratioCount = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (data.status === 'success' &&
        data.durationMs > 0 &&
        data.timingMs?.total > 0) {
      const ratio = data.timingMs.total / data.durationMs;
      // Only include reasonable ratios (5% to 100% of audio duration)
      if (ratio > 0.05 && ratio < 1.0) {
        totalRatio += ratio;
        ratioCount++;
      }
    }
  }

  const avgRatio = ratioCount > 0 ? totalRatio / ratioCount : 0.3; // Default 30% if no data
  console.log(`Average processing ratio: ${(avgRatio * 100).toFixed(1)}% of audio duration (from ${ratioCount} successful jobs)\n`);

  let fixed = 0;
  let skipped = 0;
  let alreadyCorrect = 0;
  let orphaned = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();

    // Skip chat metrics - they have different schema
    if (data.type === 'chat') {
      alreadyCorrect++;
      continue;
    }

    const metricStatus = data.status;

    // Only check metrics that need fixing (failed, undefined, or missing)
    if (metricStatus === 'success') {
      alreadyCorrect++;
      continue;
    }

    const conversationId = data.conversationId;
    if (!conversationId) {
      console.log(`  ⚠️  ${doc.id}: No conversationId, skipping`);
      skipped++;
      continue;
    }

    // Look up conversation
    const convDoc = await db
      .collection('conversations')
      .doc(conversationId)
      .get();

    if (!convDoc.exists) {
      orphaned++;
      continue;
    }

    const conversation = convDoc.data();
    const convStatus = conversation.status;

    // If conversation is complete, the metric should be success
    if (convStatus === 'complete') {
      const updateData = { status: 'success' };

      // Estimate processing time if we have audio duration
      const audioDurationMs = data.durationMs || conversation.durationMs;
      let estimatedProcessingMs = 0;

      if (audioDurationMs > 0 && (!data.timingMs?.total || data.timingMs.total === 0)) {
        estimatedProcessingMs = Math.round(audioDurationMs * avgRatio);
        updateData['timingMs.total'] = estimatedProcessingMs;
      }

      const processingStr = estimatedProcessingMs > 0
        ? `, processing: ~${(estimatedProcessingMs/1000/60).toFixed(1)}m (estimated)`
        : '';

      const oldStatus = metricStatus || 'undefined';
      console.log(`  ✓  ${conversationId.slice(0, 12)}... status: ${oldStatus} → success${processingStr}`);

      if (!dryRun) {
        await doc.ref.update(updateData);
      }

      fixed++;
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Summary:`);
  console.log(`  Already correct: ${alreadyCorrect}`);
  console.log(`  Fixed:           ${fixed}`);
  console.log(`  Orphaned:        ${orphaned}`);
  console.log(`  Skipped:         ${skipped}`);

  if (dryRun) {
    console.log(`\n⚠️  This was a dry run. Run with --mode=fix-status to apply changes.`);
  } else {
    console.log(`\n✅ Done! ${fixed} metrics have been updated.`);
  }
}

async function fixBrokenChatMetrics(dryRun) {
  console.log(`\n${dryRun ? '🔍 DRY RUN - ' : ''}Fixing broken chat metrics (removing fields we incorrectly added)...\n`);

  const snapshot = await db.collection('_metrics').get();
  console.log(`Found ${snapshot.docs.length} total metrics\n`);

  const toFix = [];

  for (const doc of snapshot.docs) {
    const data = doc.data();

    // Find chat metrics that we broke by adding status/timingMs/durationMs
    // Real chat metrics have type='chat' but should NOT have these processing-related fields
    const isChatMetric = data.type === 'chat';
    const wasIncorrectlyModified = isChatMetric && (
      data.status !== undefined ||
      data.timingMs !== undefined ||
      data.durationMs !== undefined
    );

    if (wasIncorrectlyModified) {
      const conversationId = data.conversationId || 'unknown';
      console.log(`  🔧  ${conversationId.slice(0, 12)}... will remove status/timingMs/durationMs`);
      toFix.push(doc);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Found ${toFix.length} broken chat metrics to fix`);

  if (dryRun) {
    console.log(`\n⚠️  This was a dry run. Run with --mode=fix-broken-chats to actually fix.`);
    return;
  }

  if (toFix.length === 0) {
    console.log(`\n✅ No broken chat metrics to fix.`);
    return;
  }

  // Fix in batches - remove the fields we incorrectly added
  const batchSize = 500;
  let fixed = 0;

  while (fixed < toFix.length) {
    const batch = db.batch();
    const docs = toFix.slice(fixed, fixed + batchSize);

    for (const doc of docs) {
      // Use FieldValue.delete() to remove the fields we incorrectly added
      batch.update(doc.ref, {
        status: FieldValue.delete(),
        timingMs: FieldValue.delete(),
        durationMs: FieldValue.delete(),
      });
    }

    await batch.commit();
    fixed += docs.length;
    console.log(`Fixed ${fixed}/${toFix.length}`);
  }

  console.log(`\n✅ Done! Fixed ${toFix.length} broken chat metrics (removed status/timingMs/durationMs fields).`);
}

async function fixIncorrectType(dryRun) {
  console.log(`\n${dryRun ? '🔍 DRY RUN - ' : ''}Fixing metrics with incorrect type field...\n`);

  const snapshot = await db.collection('_metrics').get();
  console.log(`Found ${snapshot.docs.length} total metrics\n`);

  let fixed = 0;
  let alreadyCorrect = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();

    // Check if it has type='chat' but looks like a processing metric
    // Processing metrics have durationMs, timingMs, etc. but NOT queryType
    const hasType = 'type' in data && data.type === 'chat';
    const looksLikeProcessing = 'durationMs' in data || 'timingMs' in data || 'audioSizeMB' in data;
    const looksLikeChat = 'queryType' in data || 'tokenUsage' in data;

    if (hasType && looksLikeProcessing && !looksLikeChat) {
      const conversationId = data.conversationId || 'unknown';
      console.log(`  ✓  ${conversationId.slice(0, 12)}... removing incorrect type='chat' field`);

      if (!dryRun) {
        // Use FieldValue.delete() to remove the field
        const { FieldValue } = await import('firebase-admin/firestore');
        await doc.ref.update({ type: FieldValue.delete() });
      }

      fixed++;
    } else {
      alreadyCorrect++;
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Summary:`);
  console.log(`  Already correct: ${alreadyCorrect}`);
  console.log(`  Fixed:           ${fixed}`);

  if (dryRun) {
    console.log(`\n⚠️  This was a dry run. Run with --mode=fix-type to apply changes.`);
  } else {
    console.log(`\n✅ Done! ${fixed} metrics have been updated.`);
  }
}

async function deleteOrphanedMetrics(dryRun) {
  console.log(`\n${dryRun ? '🔍 DRY RUN - ' : ''}Deleting orphaned metrics (no conversation exists)...\n`);

  const snapshot = await db.collection('_metrics').get();
  console.log(`Found ${snapshot.docs.length} total metrics\n`);

  const orphanedDocs = [];

  for (const doc of snapshot.docs) {
    const data = doc.data();

    // Skip chat metrics - they have different schema and lifecycle
    if (data.type === 'chat') {
      continue;
    }

    const conversationId = data.conversationId;
    const userId = data.userId;

    if (!conversationId || !userId) {
      console.log(`  🗑️  ${doc.id}: Missing conversationId or userId`);
      orphanedDocs.push(doc);
      continue;
    }

    // Check if conversation exists at root level
    const convDoc = await db
      .collection('conversations')
      .doc(conversationId)
      .get();

    if (!convDoc.exists) {
      console.log(`  🗑️  ${conversationId.slice(0, 12)}... Orphaned (conversation deleted)`);
      orphanedDocs.push(doc);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Found ${orphanedDocs.length} orphaned metrics to delete`);

  if (dryRun) {
    console.log(`\n⚠️  This was a dry run. Run with --mode=delete-orphaned to actually delete.`);
    return;
  }

  if (orphanedDocs.length === 0) {
    console.log(`\n✅ No orphaned metrics to delete.`);
    return;
  }

  // Delete in batches of 500
  const batchSize = 500;
  let deleted = 0;

  while (deleted < orphanedDocs.length) {
    const batch = db.batch();
    const docs = orphanedDocs.slice(deleted, deleted + batchSize);

    for (const doc of docs) {
      batch.delete(doc.ref);
    }

    await batch.commit();
    deleted += docs.length;
    console.log(`Deleted ${deleted}/${orphanedDocs.length}`);
  }

  console.log(`\n✅ Done! Deleted ${orphanedDocs.length} orphaned metrics.`);
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
    case 'fix-status':
      await fixIncorrectStatus(false);
      break;
    case 'fix-status-dry':
      await fixIncorrectStatus(true);
      break;
    case 'fix-type':
      await fixIncorrectType(false);
      break;
    case 'fix-type-dry':
      await fixIncorrectType(true);
      break;
    case 'fix-broken-chats-dry':
      await fixBrokenChatMetrics(true);
      break;
    case 'fix-broken-chats':
      await fixBrokenChatMetrics(false);
      break;
    case 'delete-orphaned-dry':
      await deleteOrphanedMetrics(true);
      break;
    case 'delete-orphaned':
      await deleteOrphanedMetrics(false);
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
