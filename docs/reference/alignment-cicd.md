# CI/CD Pipeline: Firebase Functions Deployment

This document explains the CI/CD pipeline for deploying the application, including the integrated alignment functionality.

## Architecture Overview

### Current: Consolidated Deployment
```
Push to main
    ├─► Build & Deploy Frontend (~2.5-3 min)     [Cloud Run]
    ├─► Build & Deploy Functions (~2-3 min)       [Firebase]
    │                                                 │
    │                                                 ├─ transcribeAudio
    │                                                 └─ alignment.ts (HARDY)
    └─► Build & Deploy WhisperX (on change)      [Cloud Run GPU]
Total: ~3-4 minutes (parallel execution)
```

The alignment functionality is now integrated directly into Firebase Cloud Functions, eliminating the need for a separate alignment service.

## Architecture Decisions

### Why Consolidate into Functions?

**Decision:** Move alignment logic from a separate Cloud Run service into Firebase Cloud Functions.

**Rationale:**
1. **Reduced latency** - No HTTP overhead between transcription and alignment
2. **Simplified deployment** - One fewer service to manage
3. **Cost savings** - Eliminated separate Cloud Run container
4. **Better error handling** - Alignment failures handled in same process
5. **Single timeout budget** - 9 minutes for entire transcription+alignment pipeline

**Trade-offs:**
- Functions have 9-minute timeout (was unlimited for Cloud Run)
- Node.js instead of Python (required porting HARDY algorithm)
- Slightly larger function bundle size

### Secrets Strategy

**Decision:** Store `WHISPER_SERVICE_URL` and `HF_TOKEN` alongside `GEMINI_API_KEY` using Firebase/GCP Secret Manager.

**Implementation:**
```bash
# Set the WhisperX Cloud Run service URL (one-time, auto-detected by gcp-setup.sh)
npx firebase functions:secrets:set WHISPER_SERVICE_URL

# HF_TOKEN is stored in GCP Secret Manager for Cloud Build (WhisperX image builds)
# Created automatically by gcp-setup.sh Step 10e
```

Firebase automatically grants the runtime service account access to secrets during deployment. The `WHISPER_SERVICE_URL` is read by `alignment.ts` to call the Cloud Run GPU WhisperX service via IAM-authenticated HTTP.

## Pipeline Configuration

### `.github/workflows/deploy.yml`

The workflow has two parallel jobs:

| Job | Purpose | Duration |
|-----|---------|----------|
| `deploy-frontend` | Build Docker image, deploy to Cloud Run | ~2.5-3 min |
| `deploy-firebase-functions` | Build TypeScript, deploy to Firebase | ~2-3 min |

**Key steps in `deploy-firebase-functions`:**
```yaml
- name: Install functions dependencies
  run: cd functions && npm ci

- name: Build functions
  run: cd functions && npm run build

- name: Deploy to Firebase Functions
  run: npx firebase deploy --only functions --project ${{ secrets.GCP_PROJECT_ID }}
```

### Function Dependencies

The alignment module requires these npm packages in `functions/package.json`:
```json
{
  "dependencies": {
    "fuzzball": "^2.0.0"
  }
}
```

- `fuzzball` - JavaScript port of Python's fuzzywuzzy for fuzzy string matching (used by HARDY alignment)

WhisperX is called via IAM-authenticated HTTP to the Cloud Run GPU service — no SDK dependency needed.

## One-Time Setup

### Prerequisites

1. Firebase project configured (see [Firebase Setup](../how-to/firebase-setup.md))
2. WhisperX Cloud Run GPU service deployed (see [Deployment Guide](../how-to/deploy.md#whisper-gpu-service-cloud-run))
3. HuggingFace token for gated WhisperX models

### Set WHISPER_SERVICE_URL Secret

```bash
# After deploying the WhisperX Cloud Run service, store its URL:
npx firebase functions:secrets:set WHISPER_SERVICE_URL
# Value: https://whisperx-service-XXXXX-XX.a.run.app

# The gcp-setup.sh script auto-detects and sets this automatically.
```

This must be done before the first deployment with alignment functionality. The Cloud Functions service account must also have `roles/run.invoker` on the WhisperX service for IAM authentication.

## Performance Metrics

| Metric | Target | Current | Status |
|--------|--------|---------|--------|
| **Total Pipeline Time** | <5 min | 3-4 min | ✅ Excellent |
| **Frontend Build** | <3 min | ~2.5 min | ✅ Good |
| **Functions Build** | <3 min | ~2 min | ✅ Excellent |
| **Parallel Efficiency** | >90% | ~100% | ✅ Optimal |

## Troubleshooting

### Functions Deploy Fails: "Secret not found"

**Error:**
```
Error: Failed to load function definition from source: Failed to lookup secret value for "WHISPER_SERVICE_URL"
```

**Solution:**
```bash
npx firebase functions:secrets:set WHISPER_SERVICE_URL
```

### Functions Deploy Fails: TypeScript Errors

**Error:**
```
error TS2307: Cannot find module 'fuzzball'
```

**Solution:**
```bash
cd functions && npm install && npm run build
```

### Alignment Returns "fallback" Status

**Cause:** WhisperX API call failed (timeout, quota, invalid audio).

**Debug:**
```bash
npx firebase functions:log --only transcribeAudio

# Look for:
# [Alignment] Error: ...
# [WhisperX] Failed to ...
```

**Common issues:**
- WhisperX Cloud Run service not deployed or URL misconfigured
- Cloud Functions service account missing `roles/run.invoker` on WhisperX service
- Audio file too long (>30 min may timeout)
- Audio format not supported

### Pipeline Takes >6 Minutes

**Potential causes:**
1. Cold start (first deployment, no npm cache)
2. Large `node_modules` in functions directory
3. Network issues with npm or Firebase

**Debugging:**
```bash
# Check functions bundle size
cd functions && du -sh node_modules/
# Should be <100MB
```

## Cost Analysis

### Firebase Functions

| Resource | Usage | Cost |
|----------|-------|------|
| Invocations | Per audio upload | Free tier: 2M/month |
| Compute | ~30-60s per file | Free tier: 400K GB-s/month |
| Memory | 256MB-1GB | Included in compute |

### WhisperX (Cloud Run GPU)

- NVIDIA L4 GPU on Cloud Run, billed per second of compute
- ~$0.0023/sec compute time
- Scales to zero when idle (no cost between uploads)

### Total Per Upload

| Component | Cost |
|-----------|------|
| Firebase Function | ~$0.001 |
| WhisperX Cloud Run GPU | ~$0.02 |
| **Total** | ~$0.021 |

## Related Documentation

- [Architecture](architecture.md) - System architecture
- [Alignment Architecture](alignment-architecture.md) - HARDY algorithm details
- [Firebase Setup](../how-to/firebase-setup.md) - Project configuration
- [Deployment](../how-to/deploy.md) - Deployment guide
