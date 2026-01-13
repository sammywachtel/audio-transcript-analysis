/**
 * Cloud Functions for Audio Transcript Analysis App
 *
 * These functions handle server-side operations that require:
 * 1. Secure API key access (Gemini API)
 * 2. Large file processing (>10MB audio files)
 * 3. Background processing (don't block the UI)
 *
 * Functions are triggered by:
 * - Storage events (audio file upload)
 * - Direct HTTPS calls from the client
 */

// =============================================================================
// CRITICAL: Configure undici BEFORE any other imports that use fetch
// =============================================================================
// Node.js uses undici as the default fetch implementation. Its default
// headersTimeout (5 minutes) is too short for large audio files sent to
// Gemini API - Google may take >5 min to start responding for 46MB+ files.
// We extend this to 25 minutes to prevent HeadersTimeoutError.
import { Agent, setGlobalDispatcher } from 'undici';

const UNDICI_HEADERS_TIMEOUT_MS = 1_500_000;  // 25 minutes
const UNDICI_BODY_TIMEOUT_MS = 1_500_000;     // 25 minutes

const agent = new Agent({
  headersTimeout: UNDICI_HEADERS_TIMEOUT_MS,
  bodyTimeout: UNDICI_BODY_TIMEOUT_MS,
  // Keep connections alive for efficiency
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 120_000,
});

setGlobalDispatcher(agent);

// Import build version info (generated at build time from git)
import { BUILD_VERSION, BUILD_BRANCH, IS_DIRTY_BUILD, BUILD_NUMBER } from './version';

console.log('[Undici] Global dispatcher configured:', {
  headersTimeout: `${UNDICI_HEADERS_TIMEOUT_MS / 60_000} minutes`,
  bodyTimeout: `${UNDICI_BODY_TIMEOUT_MS / 60_000} minutes`,
});

// Log build version on cold start - helps identify which deployment processed a conversation
const buildNumStr = BUILD_NUMBER !== null ? `, build #${BUILD_NUMBER}` : '';
console.log(`[Functions] Build version: ${BUILD_VERSION} (branch: ${BUILD_BRANCH}${IS_DIRTY_BUILD ? ', DIRTY' : ''}${buildNumStr})`);

// =============================================================================

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

// Initialize Firebase Admin (uses default service account)
initializeApp();

// Export Firestore and Storage for use in other modules
export const db = getFirestore();
export const bucket = getStorage().bucket();

// Export cloud functions
export { transcribeAudio } from './transcribe';
export { processTranscription } from './processTranscription';
export { processMerge, processReprocessing } from './chunkMerge';
export { chatWithConversation } from './chat';
export { retryTranscription } from './retry';

// Export stats tracking triggers
export { onConversationCreated, onConversationDeleted } from './statsTriggers';

// Export scheduled stats aggregation and manual trigger
export { computeDailyStats, triggerStatsComputation } from './statsAggregator';
