# Cloud Run Deployment Guide

This document covers the complete setup for deploying the Audio Transcript Analysis App to Google Cloud Run with GitHub Actions CI/CD.

## Overview

**Deployment Architecture:**
- **Platform**: Google Cloud Run (serverless containers)
- **CI/CD**: GitHub Actions (triggered on merge to main)
- **Authentication**: Workload Identity Federation (keyless, secure)
- **Container Registry**: Google Container Registry (GCR)
- **Local Deployment**: `deploy.sh` script using gcloud CLI

**Deployment Flow:**
```
Feature Branch → Pull Request → Review → Merge to main → Auto-deploy to Cloud Run
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

```bash
gcloud services enable \
  iamcredentials.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  --project=your-gcp-project-id
```

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
4. Grant these roles:
   - `Cloud Run Admin`
   - `Artifact Registry Writer`
   - `Service Account User`
   - `Cloud Build Editor`
5. Click **Done**

**Note your Service Account Email** (format):
```
github-actions-deployer@your-gcp-project-id.iam.gserviceaccount.com
```

## Step 7: Grant Workload Identity Access to Service Account

This connects the Workload Identity Pool to the service account.

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

## Step 8: Configure GitHub Secrets

Go to your GitHub repository: **Settings > Secrets and variables > Actions**

Add these repository secrets:

| Secret Name | Value | Example |
|-------------|-------|---------|
| `GCP_PROJECT_ID` | Your GCP project ID | `my-project-123` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Provider resource name | `projects/123.../providers/github` |
| `GCP_SERVICE_ACCOUNT` | Service account email | `github-actions-deployer@...` |
| `GEMINI_API_KEY` | Your Gemini API key | `AIza...` |

## Deployment

### Automatic Deployment (CI/CD)

Deployments happen automatically when:
1. You create a Pull Request to `main`
2. The PR is reviewed and approved
3. The PR is merged to `main`
4. GitHub Actions builds and deploys to Cloud Run

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

### "Permission denied" errors in GitHub Actions

1. Verify the Workload Identity Provider resource name is correct in GitHub Secrets
2. Check the attribute condition matches your repository exactly (case-sensitive)
3. Ensure the service account has all required roles
4. Verify the service account was granted access to the Workload Identity Pool

### "Unable to authenticate" errors

1. Check the issuer URL is exactly `https://token.actions.githubusercontent.com`
2. Verify attribute mappings are correct
3. Ensure `id-token: write` permission is set in the workflow

### Cloud Run deployment fails

1. Check Cloud Build API is enabled
2. Verify the service account has `Cloud Build Editor` role
3. Check Cloud Run API is enabled
4. Review Cloud Build logs for container build errors

### Health check fails

1. Verify nginx is configured correctly
2. Check the `/health` endpoint returns 200
3. Review Cloud Run logs for startup errors

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
