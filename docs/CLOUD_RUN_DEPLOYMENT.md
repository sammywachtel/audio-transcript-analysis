# Cloud Run Deployment Guide

This document covers the complete setup for deploying the Audio Transcript Analysis App to Google Cloud Run with GitHub Actions CI/CD.

## Overview

**Deployment Architecture:**
- **Platform**: Google Cloud Run (serverless containers)
- **Services**:
  - Frontend (`audio-transcript-app`) - React SPA with Nginx
  - Alignment Service (`alignment-service`) - Python FastAPI backend
- **CI/CD**: GitHub Actions (parallel deployment pipeline, ~3-4 min)
- **Authentication**: Workload Identity Federation (keyless, secure)
- **Container Registry**: Google Container Registry (GCR)
- **Local Deployment**: `deploy.sh` script using gcloud CLI

**Deployment Flow:**
```
Feature Branch → Pull Request → Review → Merge to main → Auto-deploy Both Services to Cloud Run (Parallel)
```

**Pipeline Architecture:**
```
Push to main
     ├─► Frontend Build & Deploy (~2.5-3 min)
     └─► Alignment Service Build & Deploy (~2-2.5 min)
Total Pipeline Time: ~3-4 minutes (parallel execution)
```

## Prerequisites

Before starting, you'll need:
- A Google Cloud Platform account with billing enabled
- A GCP project (create one at [console.cloud.google.com](https://console.cloud.google.com))
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) installed (for local deployment)
- A GitHub repository for your code

## GCP Project Configuration

Replace these placeholder values with your own:

| Setting | Placeholder | Description |
|---------|-------------|-------------|
| **Project ID** | `your-gcp-project-id` | Your GCP project ID |
| **Project Number** | `123456789012` | Found in GCP Console > Project Settings |
| **Region** | `us-west1` | Choose a region close to your users |
| **Service Name** | `audio-transcript-app` | Name for your Cloud Run service |

## Step 1: Enable Required APIs

**IMPORTANT**: These APIs must be enabled before deployment will work. The Cloud Build API in particular is required for building container images.

```bash
gcloud services enable \
  iamcredentials.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  --project=your-gcp-project-id
```

Or enable APIs individually:

```bash
gcloud services enable cloudbuild.googleapis.com --project=your-gcp-project-id
gcloud services enable run.googleapis.com --project=your-gcp-project-id
gcloud services enable iamcredentials.googleapis.com --project=your-gcp-project-id
gcloud services enable artifactregistry.googleapis.com --project=your-gcp-project-id
gcloud services enable secretmanager.googleapis.com --project=your-gcp-project-id
```

Console links (alternative):
- [Cloud Build API](https://console.developers.google.com/apis/api/cloudbuild.googleapis.com/overview)
- [Cloud Run API](https://console.developers.google.com/apis/api/run.googleapis.com/overview)
- [IAM Credentials API](https://console.developers.google.com/apis/api/iamcredentials.googleapis.com/overview)
- [Artifact Registry API](https://console.developers.google.com/apis/api/artifactregistry.googleapis.com/overview)
- [Secret Manager API](https://console.developers.google.com/apis/api/secretmanager.googleapis.com/overview)

## Step 2: Create Workload Identity Pool

Workload Identity Federation allows GitHub Actions to authenticate with GCP without storing service account keys.

**Console**: [IAM > Workload Identity Federation](https://console.cloud.google.com/iam-admin/workload-identity-pools)

1. Click **"Create Pool"**
2. Configure:
   | Setting | Value |
   |---------|-------|
   | **Pool Name** | `github-actions` |
   | **Pool ID** | `github-actions` |
   | **Description** | Pool for GitHub Actions CI/CD |
3. Click **Continue**

## Step 3: Add OIDC Provider for GitHub

1. Select provider type: **OpenID Connect (OIDC)**
2. Configure:
   | Setting | Value |
   |---------|-------|
   | **Provider Name** | `github` |
   | **Provider ID** | `github` |
   | **Issuer URL** | `https://token.actions.githubusercontent.com` |
   | **Audience** | Default (uses provider resource name) |
3. Click **Continue**

## Step 4: Configure Attribute Mappings

Add these mappings:

| Google Attribute | OIDC Attribute |
|------------------|----------------|
| `google.subject` | `assertion.sub` |
| `attribute.repository` | `assertion.repository` |
| `attribute.repository_owner` | `assertion.repository_owner` |

## Step 5: Set Attribute Condition

Restricts authentication to only your repository:

```cel
attribute.repository == "your-github-username/your-repo-name"
```

Save the provider.

**Note your Provider Resource Name** (format):
```
projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions/providers/github
```

## Step 6: Create Service Account

**Console**: [IAM > Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)

1. Click **"Create Service Account"**
2. Configure:
   | Setting | Value |
   |---------|-------|
   | **Name** | `github-actions-deployer` |
   | **ID** | `github-actions-deployer` |
3. Click **Create and Continue**
4. Grant these roles (click "Add Another Role" between each):
   - `Cloud Run Admin` - Deploy and manage Cloud Run services
   - `Service Account User` - Act as service accounts (required for Cloud Run)
5. Click **Done**

### Grant Additional Project-Level Permissions

The service account needs additional project-level IAM bindings for Cloud Build and Storage access. These are best granted via gcloud CLI:

```bash
# Grant Cloud Build Editor role (required to submit builds)
gcloud projects add-iam-policy-binding your-gcp-project-id \
  --member="serviceAccount:github-actions-deployer@your-gcp-project-id.iam.gserviceaccount.com" \
  --role="roles/cloudbuild.builds.editor"

# Grant Storage Admin role (required to upload build source and artifacts)
gcloud projects add-iam-policy-binding your-gcp-project-id \
  --member="serviceAccount:github-actions-deployer@your-gcp-project-id.iam.gserviceaccount.com" \
  --role="roles/storage.admin"

# Grant Artifact Registry Writer role (required to push container images)
gcloud projects add-iam-policy-binding your-gcp-project-id \
  --member="serviceAccount:github-actions-deployer@your-gcp-project-id.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
```

> **Note**: These roles can also be granted via the console under IAM & Admin > IAM, but the gcloud CLI approach is more reliable and easier to verify.

**Note your Service Account Email** (format):
```
github-actions-deployer@your-gcp-project-id.iam.gserviceaccount.com
```

> **Important**: Double-check the service account ID matches exactly what you entered. A typo here will cause authentication failures later.

## Step 7: Grant Workload Identity Access to Service Account

This connects the Workload Identity Pool to the service account, allowing GitHub Actions to impersonate it.

### Option A: Using gcloud CLI (Recommended)

This method is more reliable than the console:

```bash
gcloud iam service-accounts add-iam-policy-binding \
  github-actions-deployer@your-gcp-project-id.iam.gserviceaccount.com \
  --project=your-gcp-project-id \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions/attribute.repository/your-github-username/your-repo-name"
```

Replace:
- `your-gcp-project-id` with your GCP project ID
- `PROJECT_NUMBER` with your GCP project number (found in Project Settings)
- `your-github-username/your-repo-name` with your full GitHub repository path

### Option B: Using Console

1. Go to [Workload Identity Pools](https://console.cloud.google.com/iam-admin/workload-identity-pools)
2. Click on `github-actions` pool
3. Click **"Grant Access"**
4. Select: **"Grant access using service account impersonation"**
5. Configure:
   | Field | Value |
   |-------|-------|
   | **Service account** | `github-actions-deployer` |
   | **Attribute name** | `repository` |
   | **Attribute value** | `your-github-username/your-repo-name` |

   > **Important**: Include the full `owner/repo` format

6. Click **"Save"**
7. Dismiss the "Configure your application" popup (not needed for GitHub Actions)

### Verify the Binding

Confirm the binding was created correctly:

```bash
gcloud iam service-accounts get-iam-policy \
  github-actions-deployer@your-gcp-project-id.iam.gserviceaccount.com \
  --project=your-gcp-project-id
```

You should see a binding with `roles/iam.workloadIdentityUser` for the Workload Identity Pool.

## Step 8: Configure GitHub Secrets

Go to your GitHub repository: **Settings > Secrets and variables > Actions**

Add these repository secrets:

| Secret Name | Value | Example | Required For |
|-------------|-------|---------|--------------|
| `GCP_PROJECT_ID` | Your GCP project ID | `my-project-123` | Both services |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Provider resource name | `projects/123.../providers/github` | Both services |
| `GCP_SERVICE_ACCOUNT` | Service account email | `github-actions-deployer@...` | Both services |
| `GEMINI_API_KEY` | Your Gemini API key | `AIza...` | Frontend (build-time) |

**Note:** `REPLICATE_API_TOKEN` is NOT stored in GitHub secrets - it's stored in Google Secret Manager and injected into the alignment service at runtime for security.

## Step 9: Configure Replicate API Token in Secret Manager

The alignment service requires a Replicate API token to use WhisperX for timestamp alignment. This is stored securely in Google Secret Manager.

> **Prerequisite**: Secret Manager API must be enabled (included in Step 1). If you skipped it:
> ```bash
> gcloud services enable secretmanager.googleapis.com --project=your-gcp-project-id
> ```

### Create the Secret

```bash
# Get your Replicate API token from https://replicate.com/account/api-tokens
echo -n "your-replicate-api-token" | \
  gcloud secrets create REPLICATE_API_TOKEN \
  --data-file=- \
  --project=your-gcp-project-id
```

### Grant Access to Cloud Run

Cloud Run uses the default Compute Engine service account to access secrets at runtime:

```bash
# Grant the Compute Engine service account access to the secret
# Replace PROJECT_NUMBER with your GCP project number (found in Project Settings)
gcloud secrets add-iam-policy-binding REPLICATE_API_TOKEN \
  --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=your-gcp-project-id
```

> **Note**: The project number (e.g., `477045828994`) is different from the project ID. Find it in GCP Console > Project Settings or run `gcloud projects describe your-gcp-project-id --format='value(projectNumber)'`

### Verify Setup

```bash
# Check secret exists
gcloud secrets describe REPLICATE_API_TOKEN --project=your-gcp-project-id

# Check access permissions
gcloud secrets get-iam-policy REPLICATE_API_TOKEN --project=your-gcp-project-id
```

**Important:** The GitHub Actions workflow automatically injects this secret into the alignment-service at deployment time using the `--set-secrets` flag. No manual intervention needed after initial setup.

## Deployment

### Automatic Deployment (CI/CD)

Deployments happen automatically when:
1. You create a Pull Request to `main`
2. The PR is reviewed and approved
3. The PR is merged to `main`
4. GitHub Actions builds and deploys **both services** to Cloud Run **in parallel**

**Pipeline stages:**
- **Frontend job**: Builds `audio-transcript-app` and deploys to Cloud Run (~2.5-3 min)
- **Alignment service job**: Builds `alignment-service` and deploys to Cloud Run (~2-2.5 min)
- **Total time**: ~3-4 minutes (jobs run in parallel)

Both deployments include:
- Docker image build via Cloud Build
- Push to Google Container Registry
- Deploy to Cloud Run with health checks

### Manual Deployment (Local)

For local deployment using `deploy.sh`:

1. Install [Google Cloud SDK](https://cloud.google.com/sdk/docs/install)
2. Authenticate: `gcloud auth login`
3. Copy `.env.example` to `.env.local` and fill in your values
4. Run: `./deploy.sh`

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        GitHub Actions                            │
│  (Triggered on merge to main)                                   │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      │ 1. Request OIDC token
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│              GitHub OIDC Token Provider                          │
│  (https://token.actions.githubusercontent.com)                  │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      │ 2. Exchange token for GCP credentials
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│              Workload Identity Federation                        │
│  Pool: github-actions                                           │
│  Provider: github                                               │
│  Condition: repository == "owner/repo"                          │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      │ 3. Impersonate service account
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│              Service Account                                     │
│  github-actions-deployer@project.iam.gserviceaccount.com       │
│  Roles: Cloud Run Admin, Artifact Registry Writer, SA User     │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      │ 4. Build & Deploy
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│              Google Cloud Run                                    │
│  Service: audio-transcript-app                                  │
│  Region: us-west1                                               │
└─────────────────────────────────────────────────────────────────┘
```

## Troubleshooting

### "Gaia id not found for email" (404 Not Found)

This means the service account email in your GitHub secrets doesn't exist:

1. Verify the service account exists:
   ```bash
   gcloud iam service-accounts list --project=your-gcp-project-id --filter="displayName:github"
   ```
2. Check for typos in the service account ID (e.g., `deployer` vs `developer`)
3. Update the `GCP_SERVICE_ACCOUNT` GitHub secret with the correct email

### "Permission 'iam.serviceAccounts.getAccessToken' denied" (403 Forbidden)

The service account exists but Workload Identity can't impersonate it:

1. The Workload Identity binding is missing or malformed
2. Run the gcloud command from Step 7 to add the binding:
   ```bash
   gcloud iam service-accounts add-iam-policy-binding \
     github-actions-deployer@your-gcp-project-id.iam.gserviceaccount.com \
     --project=your-gcp-project-id \
     --role="roles/iam.workloadIdentityUser" \
     --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions/attribute.repository/your-github-username/your-repo-name"
   ```
3. Verify the binding exists:
   ```bash
   gcloud iam service-accounts get-iam-policy \
     github-actions-deployer@your-gcp-project-id.iam.gserviceaccount.com
   ```

### "Unable to authenticate" errors

1. Check the issuer URL is exactly `https://token.actions.githubusercontent.com`
2. Verify attribute mappings are correct in the Workload Identity provider
3. Ensure `id-token: write` permission is set in the workflow
4. Check the attribute condition in the provider matches your repo exactly (case-sensitive)

### "Secret Manager API has not been used in project" (PERMISSION_DENIED)

The alignment service deployment requires Secret Manager API:

1. Enable the API via CLI:
   ```bash
   gcloud services enable secretmanager.googleapis.com --project=your-gcp-project-id
   ```
2. Or enable via console: [Secret Manager API](https://console.developers.google.com/apis/api/secretmanager.googleapis.com/overview)
3. Wait 1-2 minutes for the API to propagate, then re-run the workflow:
   ```bash
   gh run rerun <run-id>
   ```

### "Cloud Build API has not been used in project" (PERMISSION_DENIED)

The Cloud Build API needs to be enabled before you can submit builds:

1. Enable the API via CLI:
   ```bash
   gcloud services enable cloudbuild.googleapis.com --project=your-gcp-project-id
   ```
2. Or enable via console: [Cloud Build API](https://console.developers.google.com/apis/api/cloudbuild.googleapis.com/overview?project=your-project-number)
3. Wait 1-2 minutes for the API to propagate, then retry the build

### "Forbidden from accessing the bucket" or Cloud Build storage errors

This means the service account lacks Storage Admin permissions:

1. Grant Storage Admin role:
   ```bash
   gcloud projects add-iam-policy-binding your-gcp-project-id \
     --member="serviceAccount:github-actions-deployer@your-gcp-project-id.iam.gserviceaccount.com" \
     --role="roles/storage.admin"
   ```

### Cloud Build fails with other errors

1. Verify the service account has these roles:
   - `Cloud Build Editor` - to submit builds
   - `Storage Admin` - to upload source and store artifacts
   - `Artifact Registry Writer` - to push container images
2. Grant missing roles:
   ```bash
   gcloud projects add-iam-policy-binding your-gcp-project-id \
     --member="serviceAccount:github-actions-deployer@your-gcp-project-id.iam.gserviceaccount.com" \
     --role="roles/cloudbuild.builds.editor"

   gcloud projects add-iam-policy-binding your-gcp-project-id \
     --member="serviceAccount:github-actions-deployer@your-gcp-project-id.iam.gserviceaccount.com" \
     --role="roles/storage.admin"

   gcloud projects add-iam-policy-binding your-gcp-project-id \
     --member="serviceAccount:github-actions-deployer@your-gcp-project-id.iam.gserviceaccount.com" \
     --role="roles/artifactregistry.writer"
   ```

### Cloud Run deployment fails

1. Check Cloud Run API is enabled
2. Verify the service account has `Cloud Run Admin` role
3. Review Cloud Build logs for container build errors
4. Check the Dockerfile builds successfully locally:
   ```bash
   docker build -t test-build .
   ```

### Health check fails

1. Verify nginx is configured correctly
2. Check the `/health` endpoint returns 200
3. Review Cloud Run logs for startup errors
4. The container might be crashing - check Cloud Run logs in GCP Console

## Security Notes

- **No service account keys**: Workload Identity Federation eliminates the need for long-lived credentials
- **Repository-scoped access**: Only your specific repository can deploy
- **Minimal permissions**: Service account has only the roles needed for deployment
- **Audit logging**: All authentication and deployment actions are logged in Cloud Audit Logs
- **PR-based workflow**: All changes go through code review before deployment

## Files Reference

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage build for production container |
| `nginx.conf` | Nginx configuration for SPA routing |
| `.dockerignore` | Files excluded from container build |
| `deploy.sh` | Local deployment script |
| `.github/workflows/deploy.yml` | CI/CD pipeline definition |
| `.env.example` | Environment variables template |

## References

- [Workload Identity Federation for GitHub](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines#github-actions)
- [google-github-actions/auth](https://github.com/google-github-actions/auth)
- [Cloud Run Documentation](https://cloud.google.com/run/docs)
- [GitHub Actions OIDC](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
