# CI/CD Pipeline: Firebase Functions Deployment

This document explains the CI/CD pipeline for deploying the application, including the integrated alignment functionality.

## Architecture Overview

### Current: Consolidated Deployment
```
Push to main
    ├─► Build & Deploy Frontend (~2.5-3 min)     [Cloud Run]
    └─► Build & Deploy Functions (~2-3 min)       [Firebase]
                                                      │
                                                      ├─ transcribeAudio
                                                      ├─ processTranscription
                                                      └─ alignment.ts (HARDY)
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

**Decision:** Store `REPLICATE_API_TOKEN` as a Firebase secret (same as `GEMINI_API_KEY`).

**Implementation:**
```bash
# Set the secret (one-time)
npx firebase functions:secrets:set REPLICATE_API_TOKEN

# Verify it exists
npx firebase functions:secrets:access REPLICATE_API_TOKEN
```

Firebase automatically grants the runtime service account access to secrets during deployment.

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
    "fuzzball": "^2.0.0",
    "replicate": "^0.29.0"
  }
}
```

- `fuzzball` - JavaScript port of Python's fuzzywuzzy for fuzzy string matching
- `replicate` - Replicate SDK for WhisperX API calls

## One-Time Setup

### Prerequisites

1. Firebase project configured (see [Firebase Setup](../how-to/firebase-setup.md))
2. Replicate account with API token

### Set REPLICATE_API_TOKEN Secret

```bash
# Get your token from https://replicate.com/account/api-tokens

# Set the secret
npx firebase functions:secrets:set REPLICATE_API_TOKEN

# Verify
npx firebase functions:secrets:access REPLICATE_API_TOKEN
```

This must be done before the first deployment with alignment functionality.

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
Error: Failed to load function definition from source: Failed to lookup secret value for "REPLICATE_API_TOKEN"
```

**Solution:**
```bash
npx firebase functions:secrets:set REPLICATE_API_TOKEN
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
- Replicate API token expired or invalid
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

### Replicate (WhisperX)

- ~$0.02 per 10-minute audio file
- Billed by Replicate, not Google Cloud

### Total Per Upload

| Component | Cost |
|-----------|------|
| Firebase Function | ~$0.001 |
| Replicate WhisperX | ~$0.02 |
| **Total** | ~$0.021 |

## Migration Notes

### From Separate Alignment Service

If you previously deployed the standalone alignment-service on Cloud Run:

1. **Keep it running** until you verify the new Functions-based alignment works
2. **Test the new deployment** with a few audio uploads
3. **Verify alignment quality** (check `alignmentStatus: 'aligned'` in Firestore)
4. **Delete the old service**:
   ```bash
   gcloud run services delete alignment-service --region=us-west1
   ```
5. **Remove old secret** (optional):
   ```bash
   # Only if you were using Secret Manager for the old service
   gcloud secrets delete REPLICATE_API_TOKEN
   ```

### Environment Variables to Remove

If you have these in GitHub Secrets, they're no longer needed:
- `ALIGNMENT_SERVICE_URL` - Functions call alignment directly
- `VITE_ALIGNMENT_SERVICE_URL` - Frontend doesn't call alignment

## Related Documentation

- [Architecture](architecture.md) - System architecture
- [Alignment Architecture](alignment-architecture.md) - HARDY algorithm details
- [Firebase Setup](../how-to/firebase-setup.md) - Project configuration
- [Deployment](../how-to/deploy.md) - Deployment guide
