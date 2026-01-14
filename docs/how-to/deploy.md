# Deployment Guide

Deploy the Audio Transcript Analysis App to production.

## Architecture Overview

| Component | Platform | Trigger |
|-----------|----------|---------|
| Frontend | Cloud Run | Push to `main` (parallel) |
| Cloud Functions | Firebase | Push to `main` (parallel) |
| Security Rules | Firebase | Manual deployment |

**Note:** Frontend and Firebase Functions deploy in parallel on merge to main (~3-4 min total).

## Single Project Architecture

This app uses a **single GCP/Firebase project** for all components:

- **Frontend**: Cloud Run (static React app served via nginx)
- **Backend**: Firebase Cloud Functions (transcription processing)
- **Database**: Cloud Firestore
- **Storage**: Firebase Storage (audio files)
- **Auth**: Firebase Authentication

Using one project simplifies billing, IAM, and service integration. The same project ID is used for both `gcloud` (Cloud Run) and `firebase` (Functions, Firestore, Storage) commands.

## Prerequisites

- Firebase project set up ([Firebase Setup Guide](firebase-setup.md))
- GitHub repository with Actions enabled
- Required secrets configured

### Quick Setup with Automated Script

The easiest way to set up everything (including Workload Identity for Cloud Run) is the automated script:

```bash
# Full setup with GitHub CI/CD integration
./scripts/gcp-setup.sh <project-id> <billing-account-id> <github-org/repo>

# Example:
./scripts/gcp-setup.sh my-app-12345 01A2B3-C4D5E6-F7G8H9 myorg/my-repo
```

This configures both Firebase and Cloud Run deployment in a single project. See [Firebase Setup Guide](firebase-setup.md) for details.

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

The workflow automatically configures required service agent IAM bindings before each deployment, so you don't need to manually run any setup scripts after the initial project creation.

## GitHub Secrets Required

Configure in **Settings → Secrets and variables → Actions**:

### Project Configuration

| Secret | Description |
|--------|-------------|
| `GCP_PROJECT_ID` | Your Firebase/GCP project ID (same for frontend and backend) |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Workload Identity Federation provider (see setup below) |
| `GCP_SERVICE_ACCOUNT` | Service account email for GitHub Actions |

> **Important**: `GCP_PROJECT_ID` must be the **same project** as your Firebase project. This ensures Cloud Run, Cloud Functions, Firestore, and Storage all share the same billing and IAM configuration.

### Firebase Config (Frontend Build)

| Secret | Description |
|--------|-------------|
| `VITE_FIREBASE_API_KEY` | Firebase API key (from `firebase apps:sdkconfig`) |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase auth domain (e.g., `project-id.firebaseapp.com`) |
| `VITE_FIREBASE_PROJECT_ID` | Firebase project ID (same as `GCP_PROJECT_ID`) |
| `VITE_FIREBASE_STORAGE_BUCKET` | Storage bucket (e.g., `project-id.firebasestorage.app`) |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Messaging sender ID (project number) |
| `VITE_FIREBASE_APP_ID` | Firebase app ID |

> **Note**: The `VITE_` prefix is required - Vite only exposes environment variables with this prefix to client-side code.

### Firebase Secrets (One-Time Setup)

These secrets are stored in Firebase Secret Manager, not GitHub:

| Secret | Description | Setup Command |
|--------|-------------|---------------|
| `GEMINI_API_KEY` | Gemini API key (create in GCP project) | `npx firebase functions:secrets:set GEMINI_API_KEY` |
| `REPLICATE_API_TOKEN` | Replicate API token for WhisperX | `npx firebase functions:secrets:set REPLICATE_API_TOKEN` |
| `HUGGINGFACE_ACCESS_TOKEN` | HuggingFace token for diarization | `npx firebase functions:secrets:set HUGGINGFACE_ACCESS_TOKEN` |

**Important:** The setup script (`gcp-setup.sh`) can create the Gemini API key automatically within your project. If setting manually:

```bash
PROJECT_ID="your-project-id"

# Create Gemini API key in your project
gcloud services api-keys create \
  --project=$PROJECT_ID \
  --display-name="gemini-api-key" \
  --api-target=service=generativelanguage.googleapis.com

# Store in Firebase secrets
npx firebase functions:secrets:set GEMINI_API_KEY
npx firebase functions:secrets:set REPLICATE_API_TOKEN
```

To get Firebase config values:
```bash
firebase apps:sdkconfig WEB --project=your-project-id
```

### For Firebase Deployment

| Secret | Description |
|--------|-------------|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase service account JSON |

## Pricing Configuration (Required)

As of v2.2.0, pricing configuration in the `_pricing` Firestore collection is **required** for cost calculation. Without it, costs will show as $0 with warnings.

### Required Pricing Records

Create these documents in the `_pricing` collection:

1. **`gemini-2.5-flash`** (audio input pricing):
   ```json
   {
     "model": "gemini-2.5-flash",
     "service": "gemini",
     "inputPricePerMillion": 1.00,
     "outputPricePerMillion": 2.50,
     "effectiveFrom": "2026-01-01T00:00:00Z"
   }
   ```

2. **`gemini-2.5-flash-text`** (text input pricing):
   ```json
   {
     "model": "gemini-2.5-flash-text",
     "service": "gemini",
     "inputPricePerMillion": 0.30,
     "effectiveFrom": "2026-01-01T00:00:00Z"
   }
   ```

3. **`whisperx`** (transcription + diarization):
   ```json
   {
     "model": "whisperx",
     "service": "replicate",
     "pricePerSecond": 0.0023,
     "effectiveFrom": "2026-01-01T00:00:00Z"
   }
   ```

You can add these via the Admin Dashboard → Pricing Manager or directly in Firebase Console.

## BigQuery Billing Sync Setup (Optional)

The `syncBillingCosts` function syncs actual Gemini costs from BigQuery billing exports for cost reconciliation. This requires:

1. **BigQuery billing export** enabled in your billing project
2. **IAM permissions** for the Cloud Functions service account

### Grant BigQuery Access

```bash
PROJECT_ID="your-project-id"
BILLING_PROJECT="wachtel-ops"  # or your billing export project

# Get the Cloud Functions service account
CF_SA="${PROJECT_ID}@appspot.gserviceaccount.com"

# Grant BigQuery Data Viewer on the billing project
gcloud projects add-iam-policy-binding $BILLING_PROJECT \
  --member="serviceAccount:$CF_SA" \
  --role="roles/bigquery.dataViewer"
```

The `gcp-setup.sh` script handles this automatically when run with the billing project configured.

## Cloud Tasks Queue Setup (One-Time)

The app uses Cloud Tasks to handle long-running audio transcription jobs. The `transcribeAudio` storage trigger enqueues tasks, and the `processTranscription` HTTP function processes them with a 60-minute timeout.

### Create the Queue

```bash
PROJECT_ID="your-project-id"

# Create the transcription queue
gcloud tasks queues create transcription-queue \
  --location=us-central1 \
  --max-dispatches-per-second=10 \
  --max-concurrent-dispatches=5 \
  --max-attempts=3 \
  --min-backoff=60s \
  --max-backoff=600s \
  --project=$PROJECT_ID
```

**Queue Configuration Explained:**
- `max-dispatches-per-second=10`: Rate limit to avoid overwhelming the processing function
- `max-concurrent-dispatches=5`: Max parallel transcriptions (balance resource usage)
- `max-attempts=3`: Retry failed tasks up to 3 times
- `min-backoff=60s`: Wait at least 1 minute before first retry
- `max-backoff=600s`: Wait at most 10 minutes between retries

### Verify Queue IAM

The App Engine default service account needs permission to create tasks and invoke the HTTP function:

```bash
PROJECT_ID="your-project-id"

# Grant Cloud Tasks Enqueuer role (usually automatic)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${PROJECT_ID}@appspot.gserviceaccount.com" \
  --role="roles/cloudtasks.enqueuer"

# Grant Cloud Functions Invoker role for processTranscription
gcloud functions add-iam-policy-binding processTranscription \
  --project=$PROJECT_ID \
  --region=us-central1 \
  --member="serviceAccount:${PROJECT_ID}@appspot.gserviceaccount.com" \
  --role="roles/cloudfunctions.invoker"
```

### Monitor Queue Status

```bash
# List queues
gcloud tasks queues list --location=us-central1 --project=$PROJECT_ID

# Describe queue (shows config and stats)
gcloud tasks queues describe transcription-queue \
  --location=us-central1 \
  --project=$PROJECT_ID

# List tasks in queue (if any are pending)
gcloud tasks list \
  --queue=transcription-queue \
  --location=us-central1 \
  --project=$PROJECT_ID
```

## Workload Identity Federation Setup

Cloud Run deployment uses Workload Identity Federation for secure, keyless authentication from GitHub Actions. This must be configured in the **same project** as your Firebase backend.

> **Tip**: The automated setup script handles all of this:
> ```bash
> ./scripts/gcp-setup.sh <project-id> <billing-account-id> <github-org/repo>
> ```
> Only follow the manual steps below if you need to set up Workload Identity separately.

### Enable Required APIs

```bash
PROJECT_ID="your-project-id"

gcloud services enable run.googleapis.com --project=$PROJECT_ID
gcloud services enable cloudbuild.googleapis.com --project=$PROJECT_ID
gcloud services enable containerregistry.googleapis.com --project=$PROJECT_ID
gcloud services enable artifactregistry.googleapis.com --project=$PROJECT_ID
gcloud services enable iamcredentials.googleapis.com --project=$PROJECT_ID
```

### Create Workload Identity Pool

```bash
PROJECT_ID="your-project-id"

# Create the identity pool
gcloud iam workload-identity-pools create "github-pool" \
  --project=$PROJECT_ID \
  --location="global" \
  --display-name="GitHub Actions Pool"

# Create OIDC provider for GitHub
# GITHUB_ORG should be your GitHub organization or username (e.g., "myorg" from "myorg/repo")
GITHUB_ORG="your-github-org"

gcloud iam workload-identity-pools providers create-oidc "github-provider" \
  --project=$PROJECT_ID \
  --location="global" \
  --workload-identity-pool="github-pool" \
  --display-name="GitHub Provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition="assertion.repository_owner=='${GITHUB_ORG}'" \
  --issuer-uri="https://token.actions.githubusercontent.com"
```

> **Security Note**: The `--attribute-condition` restricts which GitHub repositories can authenticate. Only repos owned by `GITHUB_ORG` can use this Workload Identity Pool.

### Create Service Account for GitHub Actions

```bash
PROJECT_ID="your-project-id"

# Create service account
gcloud iam service-accounts create github-actions \
  --project=$PROJECT_ID \
  --display-name="GitHub Actions CI/CD"

SA_EMAIL="github-actions@${PROJECT_ID}.iam.gserviceaccount.com"

# Grant Cloud Run deployment permissions
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/run.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/cloudbuild.builds.builder"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/storage.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/iam.serviceAccountUser"
```

### Allow GitHub to Impersonate Service Account

```bash
PROJECT_ID="your-project-id"
GITHUB_REPO="your-org/your-repo"

PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")
SA_EMAIL="github-actions@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL \
  --project=$PROJECT_ID \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/${GITHUB_REPO}"
```

### Get Values for GitHub Secrets

```bash
PROJECT_ID="your-project-id"
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")

echo "GCP_PROJECT_ID: $PROJECT_ID"
echo "GCP_SERVICE_ACCOUNT: github-actions@${PROJECT_ID}.iam.gserviceaccount.com"
echo "GCP_WORKLOAD_IDENTITY_PROVIDER: projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/providers/github-provider"
```

## Manual Deployment

### Deploy Everything

```bash
PROJECT_ID="your-project-id"

# Deploy Firebase (rules + functions)
npx firebase deploy --project=$PROJECT_ID

# Deploy frontend to Cloud Run
./deploy.sh
```

### Deploy Specific Components

```bash
PROJECT_ID="your-project-id"
REGION="us-west1"

# Security rules only
npx firebase deploy --only firestore:rules,storage:rules --project=$PROJECT_ID

# Cloud Functions only
npx firebase deploy --only functions --project=$PROJECT_ID

# Frontend only (to the same project as Firebase)
gcloud run deploy audio-transcript-app \
  --project=$PROJECT_ID \
  --region=$REGION \
  --source . \
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
PROJECT_ID="your-project-id"
REGION="us-west1"

# List services
gcloud run services list --project=$PROJECT_ID

# Get service URL
gcloud run services describe audio-transcript-app \
  --project=$PROJECT_ID \
  --region=$REGION \
  --format="value(status.url)"
```

### Check Firebase Functions

```bash
PROJECT_ID="your-project-id"

# List deployed functions
npx firebase functions:list --project=$PROJECT_ID

# View function logs
npx firebase functions:log --project=$PROJECT_ID
```

### Health Checks

```bash
PROJECT_ID="your-project-id"

# Frontend
curl https://your-app-url.run.app/health

# Functions (check logs after upload)
npx firebase functions:log --only transcribeAudio --project=$PROJECT_ID
```

## Rollback

### Cloud Run

```bash
PROJECT_ID="your-project-id"
REGION="us-west1"

# List revisions
gcloud run revisions list \
  --service audio-transcript-app \
  --project=$PROJECT_ID \
  --region=$REGION

# Rollback to previous revision
gcloud run services update-traffic audio-transcript-app \
  --project=$PROJECT_ID \
  --region=$REGION \
  --to-revisions=REVISION_NAME=100
```

### Firebase Functions

Firebase keeps previous versions. Redeploy from a previous commit:

```bash
PROJECT_ID="your-project-id"

git checkout <previous-commit>
npx firebase deploy --only functions --project=$PROJECT_ID
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

## Debug Logging

Cloud Functions include comprehensive debug logging for troubleshooting transcription and alignment.

### Cloud Functions (Firebase)

Debug logs are always written. To view them:

1. Go to **Cloud Console** → **Logging** → **Logs Explorer**
2. Filter by resource: `Cloud Function` → `transcribeAudio`
3. Set severity to include **Debug**

**Log prefixes to look for:**
- `[Transcribe]` - File processing, timing, status updates
- `[Gemini]` - API calls, response parsing
- `[Transform]` - Data model transformation
- `[Alignment]` - Alignment request preparation, timing
- `[WhisperX]` - Replicate API calls, word timestamps
- `[HARDY]` - Alignment algorithm, anchor detection, region alignment
- `[Anchors]` - Anchor point matching, skip statistics

### Frontend (Browser Console)

The `useAudioPlayer` hook logs drift correction details to the browser console:
- `[Drift Analysis]` - Audio vs transcript duration comparison
- `[Auto-Sync]` - Timestamp scaling when drift correction is applied

Open browser DevTools (F12) → Console to view these logs.

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

Firebase Auth only allows sign-in from pre-approved domains. After deploying to Cloud Run, add the new domain:

1. Go to [Firebase Console](https://console.firebase.google.com/) → Your Project
2. **Authentication** → **Settings** → **Authorized domains**
3. Click **Add domain**
4. Add your Cloud Run domain (e.g., `audio-transcript-app-xxxxx-uw.a.run.app`)
5. Add any custom domains (e.g., `ata.wachtel.us`) once the Cloud Run mapping is complete

> **Tip**: Get your Cloud Run URL with:
> ```bash
> PROJECT_ID="your-project-id"
> REGION="us-west1"
>
> gcloud run services describe audio-transcript-app \
>   --project=$PROJECT_ID \
>   --region=$REGION \
>   --format="value(status.url)"
> ```

### Adding Custom Domains (ata.wachtel.us, etc.)

If you expose `audio-transcript-app` via a custom domain such as `ata.wachtel.us`, map the domain before adding it to Firebase Auth's authorized domains list.

1. Create the domain mapping:
   ```bash
   gcloud run domain-mappings create ata.wachtel.us \
     --service=audio-transcript-app \
     --project=$PROJECT_ID \
     --region=$REGION
   ```
2. Verify the DNS records are live and the mapping shows as ready in Cloud Run.
3. After the mapping is active, add `ata.wachtel.us` (or your custom hostname) under Firebase Console → Authentication → Settings → Authorized domains.
