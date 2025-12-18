# Deployment Guide

This document covers the CI/CD pipeline and deployment configuration for the Audio Transcript Analysis App.

## Architecture Overview

The application consists of two services deployed to Google Cloud Run:

1. **Frontend Service** (`audio-transcript-app`) - React SPA with Nginx
2. **Alignment Service** (`alignment-service`) - Python FastAPI backend for transcript timestamp alignment

Both services deploy **in parallel** for optimal pipeline performance (~3-4 minutes total).

## Pipeline Architecture

### Critical Path Analysis

```
┌─────────────────────────────────────────────────────────────┐
│                    Push to main branch                      │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
        ▼                         ▼
┌───────────────────┐    ┌───────────────────┐
│ deploy-frontend   │    │ deploy-alignment  │
│                   │    │    -service       │
│ 1. Checkout       │    │ 1. Checkout       │
│ 2. Auth GCP       │    │ 2. Auth GCP       │
│ 3. Build Image    │    │ 3. Build Image    │
│ 4. Deploy         │    │ 4. Deploy         │
│ 5. Health Check   │    │ 5. Health Check   │
└───────────────────┘    └───────────────────┘
        │                         │
        └────────────┬────────────┘
                     │
                     ▼
              Both Complete
```

### Caching Strategy

- **Docker Layer Cache**: GCR automatically caches layers tagged with `:latest`
- **No Cross-Job Dependencies**: Parallel jobs can't share artifacts, but Docker layer cache eliminates need
- **Build Optimization**: Cloud Build reuses layers from previous builds (~30% build time reduction)

### Deployment Stages

| Stage | Frontend | Alignment Service |
|-------|----------|-------------------|
| **Checkout** | ~5s | ~5s |
| **Auth** | ~10s | ~10s |
| **Build** | ~90s | ~60s |
| **Deploy** | ~30s | ~30s |
| **Health Check** | ~10-50s | ~10-50s |
| **Total** | ~2.5-3min | ~2-2.5min |

**Pipeline Critical Path**: ~3-4 minutes (limited by slowest job)

## Required Secrets

Configure these in **GitHub Repository Settings → Secrets and variables → Actions**:

### Google Cloud Platform Secrets

| Secret Name | Description | How to Obtain |
|-------------|-------------|---------------|
| `GCP_PROJECT_ID` | Your GCP project ID | `gcloud config get-value project` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Workload Identity Provider for keyless auth | See [Workload Identity Setup](#workload-identity-setup) |
| `GCP_SERVICE_ACCOUNT` | Service account email for deployments | `[SA_NAME]@[PROJECT_ID].iam.gserviceaccount.com` |

### Application Secrets

| Secret Name | Description | Used By |
|-------------|-------------|---------|
| `GEMINI_API_KEY` | Google Gemini API key for transcription | Frontend (build-time) |
| `REPLICATE_API_TOKEN` | Replicate API token for WhisperX alignment | Alignment Service (runtime) |

### Secret Storage Strategy

- **Build-time secrets** (GEMINI_API_KEY): Passed as build args, baked into Docker image
- **Runtime secrets** (REPLICATE_API_TOKEN): Stored in Google Secret Manager, injected at runtime

## Setting Up Secrets

### 1. Workload Identity Setup

Workload Identity Federation enables keyless authentication from GitHub Actions to GCP (recommended approach).

```bash
# Set variables
PROJECT_ID="your-project-id"
SERVICE_ACCOUNT_NAME="github-actions-deployer"
REPO_OWNER="your-github-username"
REPO_NAME="audio-transcript-analysis-app"

# Create service account
gcloud iam service-accounts create $SERVICE_ACCOUNT_NAME \
  --display-name="GitHub Actions Deployer"

# Grant necessary permissions
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/run.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"

# Create Workload Identity Pool
gcloud iam workload-identity-pools create "github-pool" \
  --location="global" \
  --display-name="GitHub Actions Pool"

# Create Workload Identity Provider
gcloud iam workload-identity-pools providers create-oidc "github-provider" \
  --location="global" \
  --workload-identity-pool="github-pool" \
  --display-name="GitHub Provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" \
  --issuer-uri="https://token.actions.githubusercontent.com"

# Get Workload Identity Provider name (for GitHub secret)
gcloud iam workload-identity-pools providers describe "github-provider" \
  --location="global" \
  --workload-identity-pool="github-pool" \
  --format="value(name)"

# Allow GitHub repo to impersonate service account
gcloud iam service-accounts add-iam-policy-binding \
  "$SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/attribute.repository/$REPO_OWNER/$REPO_NAME"
```

### 2. Replicate API Token in Secret Manager

The alignment service needs the Replicate API token at runtime (not build time).

```bash
# Create secret in Secret Manager
echo -n "your-replicate-api-token" | \
  gcloud secrets create REPLICATE_API_TOKEN --data-file=-

# Grant Cloud Run service account access to the secret
gcloud secrets add-iam-policy-binding REPLICATE_API_TOKEN \
  --member="serviceAccount:$SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 3. Add Secrets to GitHub

Go to **GitHub Repository → Settings → Secrets and variables → Actions → New repository secret**:

1. **GCP_PROJECT_ID**: Your GCP project ID
2. **GCP_WORKLOAD_IDENTITY_PROVIDER**: Full provider name from step 1
3. **GCP_SERVICE_ACCOUNT**: `$SERVICE_ACCOUNT_NAME@$PROJECT_ID.iam.gserviceaccount.com`
4. **GEMINI_API_KEY**: Your Google Gemini API key
5. **REPLICATE_API_TOKEN**: (Optional in GitHub - it's in Secret Manager)

## Manual Deployment

### Deploy Frontend Only

```bash
# Build and deploy frontend
gcloud builds submit \
  --config=cloudbuild.yaml \
  --substitutions="_IMAGE_NAME=gcr.io/PROJECT_ID/audio-transcript-app,_TAG=$(git rev-parse HEAD),_VITE_GEMINI_API_KEY=your-key"

gcloud run deploy audio-transcript-app \
  --image=gcr.io/PROJECT_ID/audio-transcript-app:$(git rev-parse HEAD) \
  --region=us-west1 \
  --allow-unauthenticated \
  --memory=256Mi \
  --cpu=1 \
  --port=8080
```

### Deploy Alignment Service Only

```bash
# Build and deploy alignment service
cd alignment-service
gcloud builds submit \
  --config=cloudbuild.yaml \
  --substitutions="_IMAGE_NAME=gcr.io/PROJECT_ID/alignment-service,_TAG=$(git rev-parse HEAD)"

gcloud run deploy alignment-service \
  --image=gcr.io/PROJECT_ID/alignment-service:$(git rev-parse HEAD) \
  --region=us-west1 \
  --allow-unauthenticated \
  --set-secrets=REPLICATE_API_TOKEN=REPLICATE_API_TOKEN:latest \
  --memory=512Mi \
  --cpu=1 \
  --timeout=300s \
  --port=8080
```

## Health Checks

Both services expose `/health` endpoints:

### Frontend Health Check

```bash
curl https://your-frontend-url.run.app/health
# Expected: 200 OK
```

### Alignment Service Health Check

```bash
curl https://your-alignment-service-url.run.app/health
# Expected: {"status":"ok","replicate_configured":true}
```

The alignment service health check verifies:
- Service is running
- Replicate API token is configured

## Troubleshooting

### Build Failures

**Issue**: `ERROR: failed to solve: failed to fetch oauth token`

**Solution**: Re-authenticate Docker with GCR:
```bash
gcloud auth configure-docker
```

**Issue**: `cloudbuild.yaml: substitution variable _IMAGE_NAME not provided`

**Solution**: Pass substitutions via `--substitutions` flag:
```bash
--substitutions="_IMAGE_NAME=gcr.io/PROJECT/SERVICE,_TAG=TAG"
```

### Deployment Failures

**Issue**: `ERROR: (gcloud.run.deploy) PERMISSION_DENIED`

**Solution**: Verify service account has `roles/run.admin`:
```bash
gcloud projects get-iam-policy PROJECT_ID \
  --flatten="bindings[].members" \
  --filter="bindings.members:serviceAccount:SA_EMAIL"
```

**Issue**: Alignment service health check fails with Replicate not configured

**Solution**: Verify secret is created and accessible:
```bash
# Check secret exists
gcloud secrets describe REPLICATE_API_TOKEN

# Check service account has access
gcloud secrets get-iam-policy REPLICATE_API_TOKEN
```

### Pipeline Optimization Issues

**Issue**: Deployments taking >5 minutes

**Potential causes**:
1. Cold start on Cloud Build workers (first build after long idle)
2. Large Docker image layers not cached
3. Network latency to GCR

**Solutions**:
- Use `--quiet` flag to reduce log verbosity
- Optimize Dockerfile layer ordering (least-changing layers first)
- Consider using Artifact Registry (faster than GCR)

## Pipeline Metrics

Monitor these metrics to ensure pipeline health:

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| **Total Pipeline Duration** | <4 min | >6 min |
| **Frontend Build Time** | <90s | >120s |
| **Backend Build Time** | <60s | >90s |
| **Health Check Duration** | <20s | >60s |
| **Deployment Success Rate** | >95% | <90% |

## Cost Optimization

### Cloud Run Pricing

Both services use **min-instances=0** for cost optimization:
- **No traffic**: $0 (scales to zero)
- **Active requests**: Pay per 100ms of CPU time + memory

### Cloud Build Pricing

- **Free tier**: 120 build-minutes/day
- **Current usage**: ~5-6 build-minutes per deployment
- **Estimated cost**: $0 for most projects (well within free tier)

### Optimization Tips

1. **Use `--quiet` flag**: Reduces Cloud Build logging costs
2. **Leverage layer caching**: Push `:latest` tags to enable cache
3. **Minimize build context**: Use `.dockerignore` to exclude unnecessary files
4. **Scale to zero**: Keep `min-instances=0` for low-traffic periods

## Next Steps

1. **Set up monitoring**: Configure Cloud Run metrics and alerts
2. **Enable continuous deployment**: Merge to `main` automatically deploys
3. **Configure custom domain**: Map Cloud Run URLs to your domain
4. **Set up staging environment**: Deploy to separate Cloud Run service for testing
