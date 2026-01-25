#!/usr/bin/env node
/**
 * Initialize feature flags document in Firestore
 *
 * Idempotent: Only creates if doesn't exist, preserves existing values.
 * Uses Application Default Credentials (ADC) from gcloud auth or service account.
 *
 * Usage: node scripts/init-feature-flags.js [project-id]
 *
 * Exit codes:
 *   0 - Success (created or already exists)
 *   1 - Error (no project ID, auth failure, etc.)
 */
import admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';

const projectId =
  process.argv[2] ||
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GCP_PROJECT_ID;

if (!projectId) {
  console.error('✗ No project ID provided');
  console.error('  Usage: node scripts/init-feature-flags.js <project-id>');
  console.error(
    '  Or set FIREBASE_PROJECT_ID or GCP_PROJECT_ID environment variable'
  );
  process.exit(1);
}

admin.initializeApp({ projectId });
const db = admin.firestore();

// Default values for speaker reconciliation feature flags
const DEFAULTS = {
  enableContextAwareReconciliation: true,
  contextAwareRolloutPercentage: 100,
  forceEmbeddingOnlyConversationIds: [],
};

async function initFeatureFlags() {
  const docRef = db.collection('system').doc('feature_flags');
  const doc = await docRef.get();

  if (doc.exists) {
    console.log('✓ Feature flags already initialized');
    console.log('  Current values:', JSON.stringify(doc.data(), null, 2));
    return;
  }

  await docRef.set({
    ...DEFAULTS,
    createdAt: FieldValue.serverTimestamp(),
    initializedBy: 'ci-cd-init',
  });

  console.log('✓ Feature flags initialized with defaults');
  console.log('  Values:', JSON.stringify(DEFAULTS, null, 2));
}

initFeatureFlags()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('✗ Failed to initialize feature flags:', e.message);
    process.exit(1);
  });
