# Firebase Setup Guide

Complete guide to setting up Firebase for the Audio Transcript Analysis App.

## Quick Start: Automated Setup

For a fresh project setup, use the automated script that handles everything:

```bash
# Prerequisites: gcloud, firebase, jq, gsutil must be installed

# Find your billing account ID
gcloud billing accounts list

# Run the setup script
./scripts/gcp-setup.sh <project-id> <billing-account-id>

# Example:
./scripts/gcp-setup.sh audio-transcript-app-67465 01A2B3-C4D5E6-F7G8H9
```

The script is **idempotent** - safe to rerun if it fails partway through. It will skip steps that are already complete.

**What the script does:**
1. Creates GCP project (or uses existing)
2. Links billing account
3. Adds Firebase to the project
4. Enables all required APIs
5. Configures all IAM bindings (deployment SA, runtime SA, service agents)
6. Initializes Firestore
7. Configures Storage bucket permissions
8. Optionally creates service account key for CI/CD
9. Optionally sets API secrets (GEMINI_API_KEY, REPLICATE_API_TOKEN, HUGGINGFACE_ACCESS_TOKEN)

**After running the script:**
1. Enable Google Auth manually (link provided in output)
2. Get Firebase web config: `firebase apps:sdkconfig WEB --project=PROJECT_ID`
3. Update `.env` with Firebase config values
4. Add service account key to GitHub Secrets: `FIREBASE_SERVICE_ACCOUNT` <!-- pragma: allowlist secret -->
5. Add Firebase config to GitHub Secrets (for Cloud Run builds):
   - `VITE_FIREBASE_API_KEY`
   - `VITE_FIREBASE_AUTH_DOMAIN`
   - `VITE_FIREBASE_PROJECT_ID`
   - `VITE_FIREBASE_STORAGE_BUCKET`
   - `VITE_FIREBASE_MESSAGING_SENDER_ID`
   - `VITE_FIREBASE_APP_ID`
6. After first Cloud Run deployment, add the Cloud Run domain to Firebase Auth authorized domains

---

## Manual Setup (Reference)

If you prefer manual setup or need to understand each step, follow the sections below.

## Prerequisites

- Google account
- [Firebase CLI](https://firebase.google.com/docs/cli): `npm install -g firebase-tools`
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (required for full setup)
- `jq` for JSON parsing: `brew install jq` (macOS) or `apt install jq` (Linux)

## Step 1: Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click **Add project**
3. Enter project name (e.g., `audio-transcript-app`)
4. Disable Google Analytics (optional)
5. Click **Create project**

**Note your Project ID** - you'll need it throughout setup.

## Step 2: Enable Required Google Cloud APIs

> **Critical**: These APIs must be enabled before deployment will work.

### Via Console (Recommended)

Enable each API by clicking the links below:

| API | Purpose | Link |
|-----|---------|------|
| **Cloud Functions** | Run server-side transcription | [Enable](https://console.cloud.google.com/apis/library/cloudfunctions.googleapis.com) |
| **Cloud Build** | Build container images | [Enable](https://console.cloud.google.com/apis/library/cloudbuild.googleapis.com) |
| **Artifact Registry** | Store container images | [Enable](https://console.cloud.google.com/apis/library/artifactregistry.googleapis.com) |
| **Secret Manager** | Store API keys securely | [Enable](https://console.cloud.google.com/apis/library/secretmanager.googleapis.com) |
| **Firestore** | Database | [Enable](https://console.cloud.google.com/apis/library/firestore.googleapis.com) |
| **Cloud Run** | Cloud Functions v2 runtime + frontend hosting | [Enable](https://console.cloud.google.com/apis/library/run.googleapis.com) |
| **IAM Credentials** | Workload Identity | [Enable](https://console.cloud.google.com/apis/library/iamcredentials.googleapis.com) |
| **Eventarc** | Cloud Functions v2 event triggers | [Enable](https://console.cloud.google.com/apis/library/eventarc.googleapis.com) |
| **Cloud Billing** | Verify project billing status | [Enable](https://console.cloud.google.com/apis/library/cloudbilling.googleapis.com) |
| **Firebase Extensions** | Firebase deployment features | [Enable](https://console.cloud.google.com/apis/library/firebaseextensions.googleapis.com) |

### Via CLI

```bash
PROJECT_ID="your-project-id"

gcloud services enable \
  cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com \
  run.googleapis.com \
  iamcredentials.googleapis.com \
  eventarc.googleapis.com \
  cloudbilling.googleapis.com \
  firebaseextensions.googleapis.com \
  --project=$PROJECT_ID
```

## Step 3: Enable Authentication

1. In Firebase Console → **Authentication** → **Get started**
2. Click **Sign-in method** tab
3. Click **Google** provider
4. Toggle **Enable** to ON
5. Set support email (your email)
6. Click **Save**

### Add Authorized Domains (for production)

> **Critical**: Firebase Auth rejects sign-in requests from unauthorized domains. You MUST add your Cloud Run domain after deployment.

1. **Authentication** → **Settings** → **Authorized domains**
2. Click **Add domain**
3. Add your Cloud Run domain (e.g., `audio-transcript-app-xxxxx-uw.a.run.app`)

Get your Cloud Run URL:
```bash
gcloud run services describe audio-transcript-app --region=us-west1 --format="value(status.url)"
```

Common domains to add:
- `localhost` (enabled by default)
- `your-project.firebaseapp.com` (enabled by default)
- `your-cloud-run-service-xxxxx-uw.a.run.app` (must add manually)
- Custom domain if you have one

## Step 4: Create Firestore Database

1. Firebase Console → **Firestore Database** → **Create database**
2. Select **Start in production mode**
3. Choose location (e.g., `us-central1`)
4. Click **Enable**

## Step 5: Enable Cloud Storage

1. Firebase Console → **Storage** → **Get started**
2. Select **Start in production mode**
3. Choose location (same as Firestore)
4. Click **Done**

### Configure CORS for Storage

The app needs to fetch audio files from Firebase Storage for timestamp alignment. This requires CORS configuration.

**Apply CORS configuration:**
```bash
# From project root (cors.json is already included)
gsutil cors set cors.json gs://YOUR_PROJECT_ID.firebasestorage.app

# Example:
gsutil cors set cors.json gs://audio-transcript-app-67465.firebasestorage.app
```

**Verify CORS is configured:**
```bash
gsutil cors get gs://YOUR_PROJECT_ID.firebasestorage.app
```

The `cors.json` file allows requests from:
- `http://localhost:3000` (Vite dev server)
- `http://localhost:5173` (alternate Vite port)
- `https://*.run.app` (Cloud Run deployments)

## Step 6: Register Web App

1. Project Settings (gear icon) → **Your apps**
2. Click Web icon (`</>`)
3. Enter nickname: `Audio Transcript Web App`
4. **Do NOT** enable Firebase Hosting
5. Click **Register app**
6. Copy the `firebaseConfig` object

## Step 7: Configure Environment Variables

Create `.env` from template:

```bash
cp .env.example .env
```

Add your Firebase config:

```bash
# Firebase Configuration
VITE_FIREBASE_API_KEY=AIza...
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789012
VITE_FIREBASE_APP_ID=1:123456789012:web:abc123
```

## Step 8: Set API Secrets

API keys are stored securely in Firebase Secrets (Google Cloud Secret Manager).

### For CI/CD Deployments (Recommended)

Secrets are **automatically set during deployment** from GitHub Secrets. Add these to your repository:

| GitHub Secret | Description | Get it from |
|---------------|-------------|-------------|
| `GEMINI_API_KEY` | Transcription analysis | [Google AI Studio](https://makersuite.google.com/app/apikey) |
| `REPLICATE_API_TOKEN` | WhisperX transcription | [Replicate Account](https://replicate.com/account/api-tokens) |
| `HUGGINGFACE_ACCESS_TOKEN` | Speaker diarization | [Hugging Face Settings](https://huggingface.co/settings/tokens) |

The deploy workflows automatically sync these to Firebase Secrets before deploying functions.

### For Local Development Only

If you need to set secrets locally for testing:

```bash
# Login to Firebase
npx firebase login

# Set the project
npx firebase use your-project-id

# Set secrets (you'll be prompted for each value)
npx firebase functions:secrets:set GEMINI_API_KEY
npx firebase functions:secrets:set REPLICATE_API_TOKEN
npx firebase functions:secrets:set HUGGINGFACE_ACCESS_TOKEN
```

### Hugging Face Setup for Speaker Diarization

Speaker diarization (detecting multiple speakers) requires a Hugging Face token because WhisperX uses [pyannote/speaker-diarization](https://huggingface.co/pyannote/speaker-diarization-3.1), which is a gated model.

**Required steps:**

1. Create a [Hugging Face account](https://huggingface.co/join) if you don't have one

2. **Accept terms for ALL required pyannote models** (this is critical):
   - https://huggingface.co/pyannote/speaker-diarization-3.1 — Main diarization model
   - https://huggingface.co/pyannote/segmentation — Required dependency (used internally)
   - https://huggingface.co/pyannote/segmentation-3.0 — Alternative segmentation version

   > ⚠️ **Common Error**: If you see `'NoneType' object has no attribute 'eval'` in Cloud Function logs, it means you haven't accepted terms for all required models. The error is cryptic but it's just a model access issue.

3. Generate an access token at: https://huggingface.co/settings/tokens (select "Read" access)

4. Add the token to GitHub Secrets as `HUGGINGFACE_ACCESS_TOKEN`

> **Note**: Without the Hugging Face token, transcription will still work but all audio will be attributed to a single speaker (SPEAKER_00).

**Verify secrets are configured:**
```bash
npx firebase functions:secrets:access GEMINI_API_KEY
npx firebase functions:secrets:access REPLICATE_API_TOKEN
npx firebase functions:secrets:access HUGGINGFACE_ACCESS_TOKEN
```

## Step 9: Deploy Security Rules

```bash
# Deploy Firestore and Storage rules
npx firebase deploy --only firestore:rules,storage:rules
```

## Step 10: Deploy Cloud Functions

```bash
# Install function dependencies
cd functions && npm install && cd ..

# Deploy functions
npx firebase deploy --only functions
```

## CI/CD Setup

For automated deployments via GitHub Actions:

### 1. Create Service Account

1. Firebase Console → Project Settings → **Service accounts**
2. Click **Generate new private key**
3. Download the JSON file

### 2. Configure IAM Roles

The service account needs these roles in [Google Cloud IAM](https://console.cloud.google.com/iam-admin/iam):

| Role | Purpose |
|------|---------|
| **Firebase Rules Admin** | Deploy Firestore and Storage security rules |
| **Cloud Functions Admin** | Deploy Cloud Functions |
| **Service Account User** | Allow functions to run as service account |
| **Cloud Datastore User** | Read/write Firestore data |
| **Storage Admin** | Manage Firebase Storage |
| **Firebase Admin** | Access Firebase Extensions API (required for deployments) |
| **Secret Manager Admin** | Manage secrets and grant runtime SA access during deployment |

Via CLI:

```bash
SA_EMAIL="firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com"
PROJECT="your-project-id"

gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/firebaserules.admin"

gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/cloudfunctions.admin"

gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/iam.serviceAccountUser"

gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/datastore.user"

gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/storage.admin"

gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/firebase.admin"

gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/secretmanager.admin"
```

### 3. Grant Secret Access to Cloud Functions Runtime

> **Important**: Cloud Functions run under a *different* service account than the one used for deployment. The runtime service account also needs secret access.

The default runtime service account is the **App Engine default service account**:
```
your-project-id@appspot.gserviceaccount.com
```

Grant secret access to the runtime service account:
```bash
gcloud projects add-iam-policy-binding your-project-id \
  --member="serviceAccount:your-project-id@appspot.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 4. Configure Service Agent IAM Bindings

> **Important**: Cloud Functions v2 with Storage triggers requires Google-managed service agents to have specific roles for the event pipeline (Storage → Pub/Sub → Eventarc → Cloud Run).

Find your project number in [Project Settings](https://console.cloud.google.com/iam-admin/settings) or:
```bash
PROJECT_NUMBER=$(gcloud projects describe your-project-id --format="value(projectNumber)")
```

Grant the required roles:
```bash
PROJECT_NUMBER="your-project-number"
PROJECT_ID="your-project-id"

# Storage service agent → can publish to Pub/Sub
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gs-project-accounts.iam.gserviceaccount.com" \
  --role="roles/pubsub.publisher"

# Pub/Sub service agent → can create auth tokens
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"

# Compute service agent → can invoke Cloud Run and receive events
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/run.invoker"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/eventarc.eventReceiver"

# Eventarc service agent → can read storage bucket for triggers
gsutil iam ch serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-eventarc.iam.gserviceaccount.com:objectViewer \
  gs://${PROJECT_ID}.firebasestorage.app
```

### 5. Add GitHub Secrets

In your repository: **Settings** → **Secrets and variables** → **Actions**

| Secret | Value |
|--------|-------|
| `FIREBASE_SERVICE_ACCOUNT` | Contents of the service account JSON file |
| `GEMINI_API_KEY` | Gemini API key from [Google AI Studio](https://makersuite.google.com/app/apikey) |
| `REPLICATE_API_TOKEN` | Replicate API token from [Replicate Account](https://replicate.com/account/api-tokens) |
| `HUGGINGFACE_ACCESS_TOKEN` | Hugging Face token from [HF Settings](https://huggingface.co/settings/tokens) |

> **Note**: The API secrets are automatically synced to Firebase Secrets during deployment. You don't need to set them manually via `firebase functions:secrets:set`.

## Troubleshooting

### "Permission denied enabling artifactregistry.googleapis.com"

**Cause**: Required APIs are not enabled.

**Solution**: Enable APIs manually via console links in Step 2 above.

### "Missing or insufficient permissions" in Firestore

**Cause**: Security rules not deployed.

**Solution**:
```bash
npx firebase deploy --only firestore:rules
```

### "Firebase Rules Admin" permission denied in CI/CD

**Cause**: Service account missing IAM roles.

**Solution**: Add roles as described in CI/CD Setup section above.

### Functions deployment fails

**Cause**: Cloud Functions or Cloud Build API not enabled.

**Solution**: Enable both APIs via console or CLI (Step 2).

### WhisperX fails with "'NoneType' object has no attribute 'eval'"

**Cause**: The Hugging Face token doesn't have access to all required pyannote models. The pyannote speaker diarization model internally depends on the segmentation model, which is also gated.

**Solution**: Accept terms for ALL pyannote models:
1. https://huggingface.co/pyannote/speaker-diarization-3.1
2. https://huggingface.co/pyannote/segmentation
3. https://huggingface.co/pyannote/segmentation-3.0

Then retry the upload. No redeployment needed - the existing HF token will now work.

### "secretmanager.secrets.get" or "setIamPolicy" permission denied

**Cause**: One of these issues:
1. The secret doesn't exist
2. The deployment service account is missing **Secret Manager Admin** role

**Solution**:

1. **Ensure the secret exists** (run locally):
   ```bash
   npx firebase login
   npx firebase use your-project-id
   npx firebase functions:secrets:set GEMINI_API_KEY
   ```

2. **Grant Secret Manager Admin to the deployment service account**:
   ```bash
   gcloud projects add-iam-policy-binding your-project-id \
     --member="serviceAccount:firebase-adminsdk-xxxxx@your-project-id.iam.gserviceaccount.com" \
     --role="roles/secretmanager.admin"
   ```

3. **Verify the role is assigned**:
   ```bash
   gcloud projects get-iam-policy your-project-id \
     --flatten="bindings[].members" \
     --filter="bindings.role:secretmanager" \
     --format="table(bindings.role, bindings.members)"
   ```

> **Note**: Firebase CLI needs Admin (not just Viewer/Accessor) because it automatically grants the runtime service account access to secrets during deployment via `setIamPolicy`.

## Verification

After setup, verify everything works:

```bash
# Check Firebase CLI is authenticated
npx firebase projects:list

# Check the project is selected
npx firebase use

# Run locally
npm run dev
```

## Related Documentation

- [Deployment Guide](deploy.md) - Deploy to Cloud Run
- [Local Development](local-development.md) - Run locally
- [Architecture](../reference/architecture.md) - System design
