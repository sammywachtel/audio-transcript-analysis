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
export { getSignedAudioUrl } from './getAudioUrl';

// Export stats tracking triggers
export { onConversationCreated, onConversationDeleted } from './statsTriggers';

// Export scheduled stats aggregation
export { computeDailyStats } from './statsAggregator';
