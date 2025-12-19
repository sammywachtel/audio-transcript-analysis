# Deployment Guide

Deploy the Audio Transcript Analysis App to production.

## Architecture Overview

| Component | Platform | Trigger |
|-----------|----------|---------|
| Frontend | Cloud Run | Push to `main` |
| Cloud Functions | Firebase | Push to `main` (when `functions/` changes) |
| Security Rules | Firebase | Push to `main` (when rules change) |

## Prerequisites

- Firebase project set up ([Firebase Setup Guide](firebase-setup.md))
- GitHub repository with Actions enabled
- Required secrets configured

## Automatic Deployment (CI/CD)

Deployments happen automatically when you push to `main`:

### Frontend (Cloud Run)

Triggered when any frontend files change:
- React components, pages, hooks
- TypeScript/CSS files
- Package.json, Dockerfile

### Firebase (Functions + Rules)

Triggered when Firebase files change:
- `functions/**`
- `firestore.rules`, `storage.rules`
- `firestore.indexes.json`
- `firebase.json`

## GitHub Secrets Required

Configure in **Settings → Secrets and variables → Actions**:

### For Cloud Run Deployment

| Secret | Description |
|--------|-------------|
| `GCP_PROJECT_ID` | Your GCP project ID |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Workload Identity provider |
| `GCP_SERVICE_ACCOUNT` | Service account email |

### For Firebase Deployment

| Secret | Description |
|--------|-------------|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase service account JSON |

## Manual Deployment

### Deploy Everything

```bash
# Deploy Firebase (rules + functions)
npx firebase deploy

# Deploy frontend to Cloud Run
./deploy.sh
```

### Deploy Specific Components

```bash
# Security rules only
npx firebase deploy --only firestore:rules,storage:rules

# Cloud Functions only
npx firebase deploy --only functions

# Frontend only
gcloud run deploy audio-transcript-app \
  --source . \
  --region us-west1 \
  --allow-unauthenticated
```

## Deployment Scripts

### Firebase Deployment Script

```bash
./scripts/deploy-firebase.sh

# Options:
./scripts/deploy-firebase.sh --rules-only    # Deploy rules only
./scripts/deploy-firebase.sh --functions     # Deploy functions only
./scripts/deploy-firebase.sh --dry-run       # Preview changes
```

### First-Time Setup Script

```bash
./scripts/setup-firebase.sh
```

## Verifying Deployment

### Check Cloud Run

```bash
# List services
gcloud run services list

# Get service URL
gcloud run services describe audio-transcript-app \
  --region us-west1 \
  --format="value(status.url)"
```

### Check Firebase Functions

```bash
# List deployed functions
npx firebase functions:list

# View function logs
npx firebase functions:log
```

### Health Checks

```bash
# Frontend
curl https://your-app-url.run.app/health

# Alignment service (if deployed)
curl https://alignment-service-url.run.app/health
```

## Rollback

### Cloud Run

```bash
# List revisions
gcloud run revisions list --service audio-transcript-app

# Rollback to previous revision
gcloud run services update-traffic audio-transcript-app \
  --to-revisions=REVISION_NAME=100
```

### Firebase Functions

Firebase keeps previous versions. Redeploy from a previous commit:

```bash
git checkout <previous-commit>
npx firebase deploy --only functions
```

## Cost Optimization

### Cloud Run

- **Min instances**: 0 (scales to zero when idle)
- **Max instances**: 10 (adjust based on traffic)
- **CPU**: 1 (sufficient for SPA serving)
- **Memory**: 256Mi

### Firebase

- **Firestore**: Pay per read/write (optimize queries)
- **Storage**: Pay per GB stored + bandwidth
- **Functions**: Pay per invocation + compute time

### Tips

1. Use Firebase caching headers for static assets
2. Minimize Firestore reads with real-time listeners (not polling)
3. Compress audio before upload (client-side)
4. Monitor usage in Firebase Console

## Monitoring

### Firebase Console

- **Functions**: Invocations, errors, latency
- **Firestore**: Read/write counts, storage
- **Storage**: Bandwidth, storage size

### Cloud Run Console

- **Requests**: Count, latency, error rate
- **Instances**: Active, memory usage
- **Logs**: Request and application logs

### Alerts

Set up alerts in Google Cloud Console:
- Function error rate > 5%
- Storage > 80% of quota
- Unusual traffic spikes

## Troubleshooting

### Deployment fails with permission error

Check IAM roles for service account. See [Firebase Setup](firebase-setup.md#cicd-setup).

### Functions not updating

1. Check function logs: `npx firebase functions:log`
2. Verify build succeeded: `cd functions && npm run build`
3. Force redeploy: `npx firebase deploy --only functions --force`

### Cloud Run returns 503

1. Check container logs in Cloud Console
2. Verify health check endpoint works locally
3. Check memory limits aren't exceeded

### Domain not authorized for sign-in

Add domain to Firebase Console → Authentication → Settings → Authorized domains.
