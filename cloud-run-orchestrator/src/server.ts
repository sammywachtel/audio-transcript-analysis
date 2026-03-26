/**
 * Cloud Run Orchestrator — HTTP Server
 *
 * Lightweight Express server that accepts transcription requests from the
 * Cloud Function dispatcher, runs the Gemini hybrid pipeline, and writes
 * results directly to Firestore. The dispatcher fires-and-forgets, so
 * this server's response is mainly useful for monitoring and debugging.
 *
 * Endpoints:
 *   POST /transcribe  — run the full pipeline for one conversation
 *   GET  /health      — liveness + version metadata for deploy verification
 */

import express from 'express';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { BUILD_VERSION, BUILD_BRANCH, IS_DIRTY_BUILD } from './version';
import { TranscribeRequest, TranscribeAccepted, HealthResponse, StructuredError } from './contracts';
import { runPipeline } from './pipeline';

// =============================================================================
// Firebase Admin — initialized once at module load (cold start)
// =============================================================================

// GOOGLE_CLOUD_PROJECT is auto-set by Cloud Run. Passing projectId explicitly
// avoids a ~2 minute metadata-server discovery delay on the first Firestore call.
const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID;
const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
initializeApp({
  ...(projectId && { projectId }),
  ...(storageBucket && { storageBucket }),
});
export const db = getFirestore();

// =============================================================================
// Firestore warm-up
// =============================================================================
// The first Firestore call on a cold Cloud Run instance triggers ADC token
// fetch + gRPC channel establishment. Measured at ~177 seconds in production.
// We fire this immediately at module load so it runs during container startup,
// overlapping with Cloud Run's startup probe window. The /transcribe endpoint
// waits for it before accepting work.

let firestoreReady = false;
const firestoreWarmup: Promise<void> = (async () => {
  const t0 = Date.now();
  console.log('[Orchestrator] Warming Firestore connection...');
  try {
    await db.collection('_warmup').doc('ping').get();
    console.log(`[Orchestrator] Firestore warm-up complete (${Date.now() - t0}ms)`);
  } catch (err) {
    // Warm-up failure is non-fatal — the first real call will just be slow
    console.warn(`[Orchestrator] Firestore warm-up failed (${Date.now() - t0}ms):`, err);
  }
  firestoreReady = true;
})();

// =============================================================================
// Express App
// =============================================================================

const app = express();
app.use(express.json());

const startTime = Date.now();

// ---------------------------------------------------------------------------
// GET /health — deploy verification and liveness probe
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  const response: HealthResponse = {
    status: 'ok',
    version: `${BUILD_VERSION} (${BUILD_BRANCH}${IS_DIRTY_BUILD ? ', dirty' : ''})`,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
  res.json(response);
});

// ---------------------------------------------------------------------------
// POST /transcribe — run the full Gemini hybrid pipeline
// ---------------------------------------------------------------------------

app.post('/transcribe', async (req, res) => {
  const body = req.body as Partial<TranscribeRequest>;

  // Validate request shape — reject fast if the dispatcher sent garbage
  if (!body.conversationId || !body.audioStoragePath || !body.userId) {
    const error: StructuredError = {
      code: 'UNKNOWN',
      stage: 'download',
      message: 'Missing required fields: conversationId, audioStoragePath, userId',
      retryable: false,
    };
    res.status(400).json({ status: 'failed', error });
    return;
  }

  const { conversationId, audioStoragePath, userId } = body as TranscribeRequest;

  // Wait for Firestore warm-up before accepting. On a warm instance this
  // resolves immediately. On a cold start it blocks until the gRPC channel
  // is ready — but the pipeline would block there anyway, and this way the
  // dispatcher knows the delay is happening (30s dispatch timeout).
  if (!firestoreReady) {
    console.log('[Orchestrator] Waiting for Firestore warm-up before accepting...');
    await firestoreWarmup;
  }

  // Firestore-based dedup: Cloud Storage fires 3 triggers per upload, each
  // dispatching to the orchestrator. Cloud Run may spin up separate instances
  // for each, so in-memory Sets don't work. Use a Firestore transaction to
  // ensure only one orchestrator instance runs the pipeline.
  const claimed = await db.runTransaction(async (txn) => {
    const doc = await txn.get(db.collection('conversations').doc(conversationId));
    const data = doc.data();
    if (data?.orchestratorClaimed) {
      return false;
    }
    txn.update(db.collection('conversations').doc(conversationId), {
      orchestratorClaimed: true,
    });
    return true;
  }).catch((err) => {
    console.warn('[Orchestrator] Dedup transaction failed, proceeding anyway:', err);
    return true; // fail open — better to run than to silently drop
  });

  if (!claimed) {
    console.log('[Orchestrator] Rejecting duplicate — already claimed by another instance:', { conversationId });
    res.status(409).json({ status: 'duplicate', conversationId });
    return;
  }

  console.log('[Orchestrator] Accepted transcription request:', {
    conversationId,
    audioStoragePath,
    userId,
    version: BUILD_VERSION,
  });

  // Acknowledge immediately — the dispatcher just needs to know we got it.
  // Pipeline runs independently; results go straight to Firestore.
  const accepted: TranscribeAccepted = { status: 'accepted', conversationId };
  res.status(202).json(accepted);

  // Fire-and-forget: run the pipeline outside the request lifecycle.
  // Errors are written to Firestore by runPipeline itself, so we just log here.
  runPipeline(conversationId, audioStoragePath, userId)
    .then((result) => {
      db.collection('conversations').doc(conversationId).update({ orchestratorClaimed: false }).catch(() => {});
      console.log('[Orchestrator] Pipeline complete:', {
        conversationId,
        segments: result.segments,
        speakers: result.speakers,
      });
    })
    .catch((err) => {
      db.collection('conversations').doc(conversationId).update({ orchestratorClaimed: false }).catch(() => {});
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[Orchestrator] Pipeline failed:', { conversationId, error: errMsg });
      // No HTTP response to send — the dispatcher is long gone.
      // Firestore already has the failure state (written by runPipeline's catch block).
    });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '8080', 10);

app.listen(PORT, () => {
  console.log(`[Orchestrator] Listening on port ${PORT}`);
  console.log(`[Orchestrator] Version: ${BUILD_VERSION} (${BUILD_BRANCH})`);
});
