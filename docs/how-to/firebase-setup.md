# Firebase Setup Guide

Complete guide to setting up Firebase for the Audio Transcript Analysis App.

## Single Project Architecture

This app uses a **single GCP/Firebase project** for all components:

| Component | Service | Purpose |
|-----------|---------|---------|
| Frontend | Cloud Run | Static React app (nginx) |
| Backend | Cloud Functions | Transcription processing |
| Database | Firestore | Conversation and transcript storage |
| Files | Firebase Storage | Audio file storage |
| Auth | Firebase Authentication | Google Sign-In |

Using one project simplifies billing, IAM permissions, and service integration.

## Quick Start: Automated Setup

For a fresh project setup, use the automated script that handles everything:

```bash
# Prerequisites: gcloud, firebase, jq, gsutil must be installed

# Find your billing account ID
gcloud billing accounts list

# Run the setup script (includes Workload Identity for Cloud Run)
./scripts/gcp-setup.sh <project-id> <billing-account-id> [github-repo]

# Example (with GitHub repo for full CI/CD setup):
./scripts/gcp-setup.sh my-app-12345 01A2B3-C4D5E6-F7G8H9 myorg/my-repo

# Example (without GitHub repo - set up Workload Identity later):
./scripts/gcp-setup.sh my-app-12345 01A2B3-C4D5E6-F7G8H9
```

The script is **idempotent** - safe to rerun if it fails partway through. It will skip steps that are already complete.

**What the script does:**
1. Creates GCP project (or uses existing)
2. Links billing account
3. Adds Firebase to the project
4. Enables all required APIs (including Generative Language API for Gemini)
5. Configures IAM bindings (deployment SA, runtime SA)
6. Initializes Firestore database
7. Creates Cloud Tasks queue for transcription
8. Creates Artifact Registry repository for Whisper GPU container images
9. Grants IAM roles for Whisper Cloud Run GPU service (runtime SA → `roles/run.invoker`, Cloud Build SA → Artifact Registry + Cloud Run permissions)
10. Detects Firebase Storage bucket (provides setup instructions if not found)
11. Configures Storage bucket permissions for Eventarc triggers (if bucket exists)
12. Configures CORS for audio file access (if bucket exists)
13. Sets up Workload Identity Federation for GitHub Actions (if `github-repo` provided)
14. Creates GitHub Actions service account with Cloud Run permissions
15. Optionally creates service account key for Firebase CI/CD (interactive prompt)
16. Optionally creates Gemini API key in-project and stores in Secret Manager (interactive prompt)
17. Optionally registers Firebase Web App (interactive prompt)

> **Note:** The Gemini API key is created within your GCP project (not via AI Studio), keeping all resources in one place. Service agent IAM bindings are configured automatically by the GitHub Actions workflow on each deployment.

**After running the script:**
1. Enable Google Auth manually (link provided in output)
2. Add Firebase Auth authorized domains:
   - `${PROJECT_ID}.firebaseapp.com` (Firebase adds it automatically)
   - The Cloud Run service URL you deploy (use `gcloud run services describe audio-transcript-app --project=$PROJECT_ID --region=$REGION --format="value(status.url)"` to grab the hostname for the authorized domain)
   - Any custom domains you map to Cloud Run (e.g., `ata.wachtel.us`) after the domain mapping is created
   Add domains under Firebase Console → Authentication → Settings → Authorized domains.
3. Get Firebase web config: `firebase apps:sdkconfig WEB --project=PROJECT_ID`
4. Update `.env` with Firebase config values
5. Add service account key to GitHub Secrets: `FIREBASE_SERVICE_ACCOUNT` <!-- pragma: allowlist secret -->
6. Add Firebase config to GitHub Secrets (for Cloud Run builds):
   - `VITE_FIREBASE_API_KEY`
   - `VITE_FIREBASE_AUTH_DOMAIN`
   - `VITE_FIREBASE_PROJECT_ID`
   - `VITE_FIREBASE_STORAGE_BUCKET`
   - `VITE_FIREBASE_MESSAGING_SENDER_ID`
   - `VITE_FIREBASE_APP_ID`

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
| **Cloud Scheduler** | Scheduled functions (daily stats aggregation) | [Enable](https://console.cloud.google.com/apis/library/cloudscheduler.googleapis.com) |
| **Cloud Build** | Build container images | [Enable](https://console.cloud.google.com/apis/library/cloudbuild.googleapis.com) |
| **Artifact Registry** | Store container images | [Enable](https://console.cloud.google.com/apis/library/artifactregistry.googleapis.com) |
| **Secret Manager** | Store API keys securely | [Enable](https://console.cloud.google.com/apis/library/secretmanager.googleapis.com) |
| **Firestore** | Database | [Enable](https://console.cloud.google.com/apis/library/firestore.googleapis.com) |
| **Cloud Run** | Cloud Functions v2 runtime + frontend hosting | [Enable](https://console.cloud.google.com/apis/library/run.googleapis.com) |
| **IAM Credentials** | Workload Identity | [Enable](https://console.cloud.google.com/apis/library/iamcredentials.googleapis.com) |
| **Eventarc** | Cloud Functions v2 event triggers | [Enable](https://console.cloud.google.com/apis/library/eventarc.googleapis.com) |
| **Cloud Billing** | Verify project billing status | [Enable](https://console.cloud.google.com/apis/library/cloudbilling.googleapis.com) |
| **Firebase Extensions** | Firebase deployment features | [Enable](https://console.cloud.google.com/apis/library/firebaseextensions.googleapis.com) |
| **Generative Language** | Gemini AI for transcription analysis | [Enable](https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com) |
| **API Keys** | Create API keys for Gemini | [Enable](https://console.cloud.google.com/apis/library/apikeys.googleapis.com) |

### Via CLI

```bash
PROJECT_ID="your-project-id"

# Enable all required APIs in a single command
gcloud services enable \
  cloudfunctions.googleapis.com \
  cloudscheduler.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com \
  run.googleapis.com \
  iamcredentials.googleapis.com \
  eventarc.googleapis.com \
  cloudbilling.googleapis.com \
  firebaseextensions.googleapis.com \
  containerregistry.googleapis.com \
  generativelanguage.googleapis.com \
  apikeys.googleapis.com \
  --project=$PROJECT_ID
```

> **Note**: `generativelanguage.googleapis.com` enables Gemini AI. `apikeys.googleapis.com` allows creating API keys via CLI.

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
PROJECT_ID="your-project-id"
REGION="us-west1"

gcloud run services describe audio-transcript-app \
  --project=$PROJECT_ID \
  --region=$REGION \
  --format="value(status.url)"
```

Common domains to add:
- `localhost` (enabled by default)
- `your-project.firebaseapp.com` (enabled by default)
- `your-cloud-run-service-xxxxx-uw.a.run.app` (must add manually)
- Custom domain if you have one
### Custom Domains (ata.wachtel.us, etc.)
If you map a custom domain such as `ata.wachtel.us` to Cloud Run, add it to the authorized domains list as soon as the mapping is active.

1. Map the domain to Cloud Run:
   ```bash
   gcloud run domain-mappings create ata.wachtel.us \
     --service=audio-transcript-app \
     --project=$PROJECT_ID \
     --region=$REGION
   ```
2. Verify the mapping (Console or `gcloud run domain-mappings describe ata.wachtel.us ...`).
3. Add `ata.wachtel.us` (or the custom hostname you configured) under Firebase Console → Authentication → Settings → Authorized domains.

> Tip: The setup script prints the Cloud Run URL and authorized domains reminder in its final summary, so rerun it if you forget these steps.

## Step 4: Create Firestore Database

1. Firebase Console → **Firestore Database** → **Create database**
2. Select **Start in production mode**
3. Choose location (e.g., `us-central1`)
4. Click **Enable**

## Step 5: Enable Cloud Storage

> **Note:** Storage must be enabled via Firebase Console (requires location selection). After enabling, run `gcp-setup.sh` again to configure bucket permissions and CORS automatically.

1. Firebase Console → **Storage** → **Get started**
2. Select **Start in production mode**
3. Choose location (same as Firestore)
4. Click **Done**

### Configure CORS for Storage

The app needs to fetch audio files from Firebase Storage for timestamp alignment. This requires CORS configuration.

**Apply CORS configuration:**
```bash
PROJECT_ID="your-project-id"

# From project root (cors.json is already included)
gsutil cors set cors.json gs://${PROJECT_ID}.firebasestorage.app
```

**Verify CORS is configured:**
```bash
PROJECT_ID="your-project-id"

gsutil cors get gs://${PROJECT_ID}.firebasestorage.app
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
| `GEMINI_API_KEY` | Transcription analysis | [GCP Credentials](https://console.cloud.google.com/apis/credentials) (same project) |
| `WHISPER_SERVICE_URL` | WhisperX transcription | Cloud Run service URL (deployed from scope 05-02-01) |

The deploy workflows automatically sync these to Firebase Secrets before deploying functions.

### Creating the Gemini API Key (In-Project)

Create the Gemini API key within your GCP project to keep everything consolidated:

```bash
PROJECT_ID="your-project-id"

# Create API key restricted to Generative Language API
gcloud services api-keys create \
  --project=$PROJECT_ID \
  --display-name="gemini-api-key" \
  --api-target=service=generativelanguage.googleapis.com
```

Or via Console:
1. Go to [APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
2. Click **+ CREATE CREDENTIALS** → **API key**
3. Click **Edit API key** to restrict it to **Generative Language API** only
4. Copy the key and add to GitHub Secrets as `GEMINI_API_KEY`

> **Note**: The setup script (`gcp-setup.sh`) can create this key automatically if you select "y" when prompted.

### For Local Development Only

If you need to set secrets locally for testing:

```bash
# Login to Firebase
npx firebase login

# Set the project
npx firebase use your-project-id

# Set secrets (you'll be prompted for each value)
npx firebase functions:secrets:set GEMINI_API_KEY
npx firebase functions:secrets:set WHISPER_SERVICE_URL
```

### Speaker Diarization (Cloud Run WhisperX)

Speaker diarization (detecting multiple speakers) is handled by the Cloud Run WhisperX service. The pyannote diarization models are bundled directly in the container — no separate Hugging Face token is required.

The Cloud Run service URL is configured via the `WHISPER_SERVICE_URL` secret (see table above).

**Verify secrets are configured:**
```bash
npx firebase functions:secrets:access GEMINI_API_KEY
npx firebase functions:secrets:access WHISPER_SERVICE_URL
```

## Step 9: Deploy Security Rules

```bash
PROJECT_ID="your-project-id"

# Deploy Firestore and Storage rules
npx firebase deploy --only firestore:rules,storage:rules --project=$PROJECT_ID
```

## Step 10: Deploy Cloud Functions

```bash
PROJECT_ID="your-project-id"

# Install function dependencies
cd functions && npm install && cd ..

# Deploy functions
npx firebase deploy --only functions --project=$PROJECT_ID
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
| **Cloud Scheduler Admin** | Manage scheduled functions (daily stats, etc.) |
| **Service Account User** | Allow functions to run as service account |
| **Cloud Datastore User** | Read/write Firestore data |
| **Storage Admin** | Manage Firebase Storage |
| **Firebase Admin** | Access Firebase Extensions API (required for deployments) |
| **Secret Manager Admin** | Manage secrets and grant runtime SA access during deployment |

Via CLI:

```bash
PROJECT_ID="your-project-id"
SA_EMAIL="firebase-adminsdk-xxxxx@${PROJECT_ID}.iam.gserviceaccount.com"

# Grant all required roles
for ROLE in \
  roles/firebaserules.admin \
  roles/cloudfunctions.admin \
  roles/cloudscheduler.admin \
  roles/iam.serviceAccountUser \
  roles/datastore.user \
  roles/storage.admin \
  roles/firebase.admin \
  roles/secretmanager.admin
do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$SA_EMAIL" \
    --role="$ROLE"
done
```

Or individually:

```bash
PROJECT_ID="your-project-id"
SA_EMAIL="firebase-adminsdk-xxxxx@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/firebaserules.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/cloudfunctions.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/cloudscheduler.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/iam.serviceAccountUser"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/datastore.user"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/storage.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/firebase.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/secretmanager.admin"
```

### 3. Grant Secret Access to Cloud Functions Runtime

> **Important**: Cloud Functions run under a *different* service account than the one used for deployment. The runtime service account also needs secret access.

The default runtime service account is the **App Engine default service account**:
```
${PROJECT_ID}@appspot.gserviceaccount.com
```

Grant secret access to the runtime service account:
```bash
PROJECT_ID="your-project-id"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${PROJECT_ID}@appspot.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 4. Configure Service Agent IAM Bindings

> **Important**: Cloud Functions v2 with Storage triggers requires Google-managed service agents to have specific roles for the event pipeline (Storage → Pub/Sub → Eventarc → Cloud Run).

Get your project number:
```bash
PROJECT_ID="your-project-id"
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")
echo "Project number: $PROJECT_NUMBER"
```

Grant the required roles:
```bash
PROJECT_ID="your-project-id"
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")

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
| `WHISPER_SERVICE_URL` | Cloud Run WhisperX service URL (deployed from scope 05-02-01) |

> **Note**: The API secrets are automatically synced to Firebase Secrets during deployment. You don't need to set them manually via `firebase functions:secrets:set`.

## Troubleshooting

### "Permission denied enabling artifactregistry.googleapis.com"

**Cause**: Required APIs are not enabled.

**Solution**: Enable APIs manually via console links in Step 2 above.

### "Missing or insufficient permissions" in Firestore

**Cause**: Security rules not deployed.

**Solution**:
```bash
PROJECT_ID="your-project-id"
npx firebase deploy --only firestore:rules --project=$PROJECT_ID
```

### "Firebase Rules Admin" permission denied in CI/CD

**Cause**: Service account missing IAM roles.

**Solution**: Add roles as described in CI/CD Setup section above.

### Functions deployment fails

**Cause**: Cloud Functions or Cloud Build API not enabled.

**Solution**: Enable both APIs via console or CLI (Step 2).

### WhisperX fails with "'NoneType' object has no attribute 'eval'"

**Cause**: The Cloud Run WhisperX container's pyannote models failed to load. This typically indicates a container build issue.

**Solution**: Verify the Cloud Run WhisperX service is healthy:
```bash
# Check service status
gcloud run services describe whisperx-service --region=REGION --format="value(status.conditions)"
```
If the service is unhealthy, redeploy the WhisperX container (see infrastructure scope 05-02-01).

### "secretmanager.secrets.get" or "setIamPolicy" permission denied

**Cause**: One of these issues:
1. The secret doesn't exist
2. The deployment service account is missing **Secret Manager Admin** role

**Solution**:

1. **Ensure the secret exists** (run locally):
   ```bash
   PROJECT_ID="your-project-id"
   npx firebase login
   npx firebase use $PROJECT_ID
   npx firebase functions:secrets:set GEMINI_API_KEY
   ```

2. **Grant Secret Manager Admin to the deployment service account**:
   ```bash
   PROJECT_ID="your-project-id"
   SA_EMAIL="firebase-adminsdk-xxxxx@${PROJECT_ID}.iam.gserviceaccount.com"

   gcloud projects add-iam-policy-binding $PROJECT_ID \
     --member="serviceAccount:$SA_EMAIL" \
     --role="roles/secretmanager.admin"
   ```

3. **Verify the role is assigned**:
   ```bash
   PROJECT_ID="your-project-id"

   gcloud projects get-iam-policy $PROJECT_ID \
     --flatten="bindings[].members" \
     --filter="bindings.role:secretmanager" \
     --format="table(bindings.role, bindings.members)"
   ```

> **Note**: Firebase CLI needs Admin (not just Viewer/Accessor) because it automatically grants the runtime service account access to secrets during deployment via `setIamPolicy`.

## Verification

After setup, verify everything works:

```bash
PROJECT_ID="your-project-id"

# Check Firebase CLI is authenticated
npx firebase projects:list

# Set and verify the project
npx firebase use $PROJECT_ID

# Check project is configured correctly
npx firebase apps:list --project=$PROJECT_ID

# Run locally
npm run dev
```

## Related Documentation

- [Deployment Guide](deploy.md) - Deploy to Cloud Run
- [Local Development](local-development.md) - Run locally
- [Architecture](../reference/architecture.md) - System design
