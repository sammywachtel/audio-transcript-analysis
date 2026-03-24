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

### Firebase/GCP Secrets (One-Time Setup)

These secrets are stored in GCP Secret Manager and accessed by Cloud Functions and Cloud Build:

| Secret | Description | Setup |
|--------|-------------|-------|
| `GEMINI_API_KEY` | Gemini API key for transcription + analysis | `gcp-setup.sh` creates automatically, or `npx firebase functions:secrets:set GEMINI_API_KEY` |
| `WHISPER_SERVICE_URL` | Cloud Run URL for WhisperX timestamps service | `gcp-setup.sh` auto-detects, or `npx firebase functions:secrets:set WHISPER_SERVICE_URL` |
| `HF_TOKEN` | HuggingFace token for WhisperX model downloads | `gcp-setup.sh` Step 10e, or set via Secret Manager directly |

**Important:** The setup script (`gcp-setup.sh`) handles all three secrets. If setting manually:

```bash
PROJECT_ID="your-project-id"

# Create Gemini API key in your project
gcloud services api-keys create \
  --project=$PROJECT_ID \
  --display-name="gemini-api-key" \
  --api-target=service=generativelanguage.googleapis.com

# Store in Firebase secrets
npx firebase functions:secrets:set GEMINI_API_KEY
npx firebase functions:secrets:set WHISPER_SERVICE_URL
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

1. **`gemini-3-flash`** (audio input pricing):
   ```json
   {
     "model": "gemini-3-flash",
     "service": "gemini",
     "inputPricePerMillion": 1.00,
     "outputPricePerMillion": 2.50,
     "effectiveFrom": "2026-01-01T00:00:00Z"
   }
   ```

2. **`gemini-3-flash-text`** (text input pricing):
   ```json
   {
     "model": "gemini-3-flash-text",
     "service": "gemini",
     "inputPricePerMillion": 0.30,
     "effectiveFrom": "2026-01-01T00:00:00Z"
   }
   ```

3. **`whisperx`** (timestamp alignment via Cloud Run GPU):
   ```json
   {
     "model": "whisperx",
     "service": "cloud-run-gpu",
     "pricePerSecond": 0.0023,
     "effectiveFrom": "2026-01-01T00:00:00Z"
   }
   ```

You can add these via the Admin Dashboard → Pricing Manager or directly in Firebase Console.

## BigQuery Billing Sync Setup (Optional)

The `syncBillingCosts` function syncs actual Gemini costs from BigQuery billing exports for cost comparison. This requires:

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

## Cloud Tasks Queue (Retired)

> The `transcription-queue` was part of the legacy chunked pipeline and is no longer used.
> The current hybrid pipeline (Gemini 3 Flash + WhisperX timestamps) processes everything
> directly within `transcribeAudio` without Cloud Tasks. The queue may still exist in your
> GCP project but can be safely paused or deleted.

## Whisper GPU Service (Cloud Run)

The WhisperX service runs on Cloud Run with an NVIDIA L4 GPU. It provides **word-level timestamps only** — speaker diarization is handled by Gemini 3 Flash.

### Deployment Options

There are two ways to deploy WhisperX:

| Method | When to Use | Requirements |
|--------|-------------|--------------|
| **GitHub Actions** | Automated CI/CD, no local Docker | Push to `main` or manual workflow dispatch |
| **Local Script** | Manual deploys, development | Docker installed (or use `--cloud-build` flag) |

### GitHub Actions Deployment (Recommended)

The `deploy-whisper.yml` workflow handles building and deploying without requiring local Docker.

**Automatic triggers:**
- Push to `main` when `cloud-run-whisper/**` files change
- Push to `main` when `.github/workflows/deploy-whisper.yml` changes

**Manual trigger:**
1. Go to **Actions** → **Deploy WhisperX** → **Run workflow**
2. Options:
   - `deploy_only`: Skip build, deploy existing image
   - `image_tag`: Custom tag (default: git SHA)

**Required GitHub Secrets:**

| Secret | Description |
|--------|-------------|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Workload Identity Federation provider path |
| `GCP_SERVICE_ACCOUNT` | Service account email (e.g., `github-actions@PROJECT.iam.gserviceaccount.com`) |
| `GCP_PROJECT_ID` | Your GCP project ID |

**Required GCP Secret Manager Secrets:**

| Secret | Description | Setup |
|--------|-------------|-------|
| `HF_TOKEN` | HuggingFace token for gated WhisperX models | Created by `gcp-setup.sh` Step 10e |

The HF_TOKEN secret must be accessible to the Cloud Build service account. The `gcp-setup.sh` script grants the necessary `secretAccessor` role.

### Quick Deploy (Local Script)

```bash
# Full build + deploy (reads GCP_PROJECT_ID from .env)
./scripts/deploy-whisper.sh

# Build via Cloud Build (no local Docker needed)
./scripts/deploy-whisper.sh --cloud-build

# Build and push image only (no deploy)
./scripts/deploy-whisper.sh --build-only

# Deploy an already-pushed image (no build)
./scripts/deploy-whisper.sh --deploy-only

# Rebuild without Docker cache (after Dockerfile changes)
./scripts/deploy-whisper.sh --no-cache

# Deploy with a specific image tag
./scripts/deploy-whisper.sh --tag v1.2.3
```

### Evaluation Deploys (GPU/Model/Beam Experiments)

The deploy script supports isolated evaluation services for testing alternative GPU, model, and beam size configurations without affecting production. Use the `--eval` flag to deploy a separate Cloud Run service:

```bash
# Test with reduced beam size (no rebuild — runtime env var)
./scripts/deploy-whisper.sh --deploy-only --beam-size 2 --eval beam2

# Test with Whisper medium model (requires rebuild — different HF repo)
./scripts/deploy-whisper.sh --cloud-build --model-size medium --hf-repo Systran/faster-whisper-medium --eval medium-model

# Combine multiple knobs
./scripts/deploy-whisper.sh --cloud-build --model-size medium --hf-repo Systran/faster-whisper-medium --beam-size 2 --eval medium-beam2
```

**Available evaluation knobs:**

| Flag | Default | Effect | Rebuild Required? |
|------|---------|--------|-------------------|
| `--gpu-type TYPE` | `nvidia-l4` | Cloud Run GPU type (only `nvidia-l4` and `nvidia-rtx-pro-6000` supported) | No |
| `--model-size SIZE` | `large-v3-turbo` | Whisper model baked into image | **Yes** |
| `--hf-repo REPO` | Auto-detected | HuggingFace repo for model download | **Yes** |
| `--beam-size N` | `5` | Decoding beam width (runtime env var) | No |
| `--eval TAG` | _(none)_ | Deploy as `whisperx-service-eval-TAG` | No |

> **Model repos:** The default HF repo pattern (`deepdml/faster-whisper-{SIZE}-ct2`) only works for `large-v3-turbo`. Other sizes use different repos — e.g., `Systran/faster-whisper-medium` for the medium model. Use `--hf-repo` to override when testing non-default models.

> **Important:** `--eval` deploys to a separate service name, so production is never touched. Clean up eval services when done to avoid idle GPU costs:
> ```bash
> gcloud run services delete whisperx-service-eval-t4-test --region=us-east4
> ```

#### Docker-Free Deployment

If Docker is not installed locally, use the `--cloud-build` flag:

```bash
# Build via Cloud Build, then deploy
./scripts/deploy-whisper.sh --cloud-build

# With a specific tag
./scripts/deploy-whisper.sh --cloud-build --tag timestamps-only-v2
```

This submits the build to Cloud Build, which:
1. Reads `HF_TOKEN` from GCP Secret Manager
2. Builds the image using BuildKit secret mounts
3. Pushes to Artifact Registry
4. Takes ~20-40 minutes (models are ~20GB)

The script uses `--service-account` to run the build as the `github-actions` service account, which has the necessary Secret Manager permissions.

The script reads configuration from `.env` (or environment variables):
- `GCP_PROJECT_ID` (required)
- `WHISPER_REGION` (default: `us-east4`)
- `WHISPER_SERVICE_NAME` (default: `whisperx-service`)

### Manual Build and Push

```bash
PROJECT_ID="your-project-id"
REGION="us-east4"  # GPU quota region — may differ from main project region
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/whisper-gpu/whisperx:latest"

# Authenticate Docker with Artifact Registry
gcloud auth configure-docker ${REGION}-docker.pkg.dev --quiet

# Build for linux/amd64 (required by Cloud Run, even if building on ARM Mac)
# HF_TOKEN needed for gated WhisperX models — passed via BuildKit secret (not baked into layers)
export HF_TOKEN="hf_..."  # your HuggingFace access token
DOCKER_BUILDKIT=1 docker build --platform linux/amd64 \
  --secret id=hf_token,env=HF_TOKEN \
  -t "$IMAGE" cloud-run-whisper/

# Push to Artifact Registry
docker push "$IMAGE"
```

> **Note:** The Artifact Registry repository `whisper-gpu` is created automatically by `gcp-setup.sh`. If it doesn't exist, run the setup script first.

### Deploy to Cloud Run with GPU

```bash
PROJECT_ID="your-project-id"
REGION="us-east4"  # GPU quota region — may differ from main project region
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/whisper-gpu/whisperx:latest"

gcloud run deploy whisperx-service \
  --project=$PROJECT_ID \
  --region=$REGION \
  --image=$IMAGE \
  --gpu=1 \
  --gpu-type=nvidia-l4 \
  --no-gpu-zonal-redundancy \
  --memory=16Gi \
  --timeout=300 \
  --concurrency=1 \
  --min-instances=0 \
  --max-instances=3 \
  --no-allow-unauthenticated
```

**Flag Breakdown:**

| Flag | Value | Why |
|------|-------|-----|
| `--gpu=1` | 1 GPU | WhisperX needs GPU for inference |
| `--gpu-type=nvidia-l4` | NVIDIA L4 | Cost-effective inference GPU |
| `--no-gpu-zonal-redundancy` | Single zone | Lower quota requirement, fine for batch workloads |
| `--memory=16Gi` | 16 GiB | WhisperX models need headroom |
| `--timeout=300` | 5 min | Hard limit per request (Cloud Run backstop) |
| `--concurrency=1` | 1 req/instance | GPU can't safely share across concurrent requests |
| `--min-instances=0` | Scale to zero | No cost when idle |
| `--max-instances=3` | Max 3 instances | Cost safeguard — caps GPU spend |
| `--no-allow-unauthenticated` | IAM auth | Only Cloud Functions runtime SA can invoke |

### Verify the Deployment

```bash
PROJECT_ID="your-project-id"
REGION="us-central1"

# Check service status
gcloud run services describe whisperx-service \
  --project=$PROJECT_ID \
  --region=$REGION \
  --format="value(status.url)"

# Check revisions
gcloud run revisions list \
  --service=whisperx-service \
  --project=$PROJECT_ID \
  --region=$REGION
```

### Set Up Monitoring Alert (Request Duration > 120s)

Create a Cloud Monitoring alert policy that fires when Whisper Cloud Run requests exceed 120 seconds. This provides an early warning before the 300s hard timeout:

```bash
PROJECT_ID="your-project-id"

gcloud alpha monitoring policies create \
  --project=$PROJECT_ID \
  --display-name="Whisper Cloud Run: Request duration > 120s" \
  --condition-display-name="Request latency exceeds 120s" \
  --condition-filter='resource.type="cloud_run_revision" AND resource.labels.service_name="whisperx-service" AND metric.type="run.googleapis.com/request_latencies"' \
  --condition-threshold-value=120000 \
  --condition-threshold-duration=0s \
  --condition-threshold-comparison=COMPARISON_GT \
  --aggregation-alignment-period=60s \
  --aggregation-per-series-aligner=ALIGN_PERCENTILE_99 \
  --notification-channels=[] \
  --documentation="Whisper Cloud Run p99 request latency exceeded 120s. Investigate whether audio files are unusually large or if GPU performance has degraded. The hard timeout is 300s."
```

> **Note:** Replace `--notification-channels=[]` with your notification channel ID to receive alerts. Create a notification channel in the [Cloud Console](https://console.cloud.google.com/monitoring/alerting/notifications) first, then reference it by ID.

Alternatively, create the alert via the Cloud Console:

1. Go to **Cloud Console** → **Monitoring** → **Alerting** → **Create Policy**
2. **Add Condition:**
   - Resource type: `Cloud Run Revision`
   - Metric: `Request Latencies` (`run.googleapis.com/request_latencies`)
   - Filter: `service_name = "whisperx-service"`
   - Aggregation: 99th percentile, 1-minute alignment
   - Threshold: Above 120,000 ms
3. **Add Notification Channel** (email, Slack, PagerDuty, etc.)
4. **Name:** "Whisper Cloud Run: Request duration > 120s"

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
- `[WhisperX]` - Cloud Run GPU service calls, word timestamps
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
