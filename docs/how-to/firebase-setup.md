# Firebase Setup Guide

Complete guide to setting up Firebase for the Audio Transcript Analysis App.

## Prerequisites

- Google account
- [Firebase CLI](https://firebase.google.com/docs/cli): `npm install -g firebase-tools`
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (optional, for advanced configuration)

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
| **Cloud Run** | Host frontend | [Enable](https://console.cloud.google.com/apis/library/run.googleapis.com) |
| **IAM Credentials** | Workload Identity | [Enable](https://console.cloud.google.com/apis/library/iamcredentials.googleapis.com) |
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

1. **Authentication** → **Settings** → **Authorized domains**
2. Click **Add domain**
3. Add your production domain

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

## Step 8: Set Gemini API Secret

The Gemini API key is stored securely in Firebase Secrets (not in client code):

```bash
# Login to Firebase
npx firebase login

# Set the project
npx firebase use your-project-id

# Set the secret (you'll be prompted to enter the key)
npx firebase functions:secrets:set GEMINI_API_KEY
```

Get a Gemini API key from [Google AI Studio](https://makersuite.google.com/app/apikey).

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
| **Secret Manager Secret Accessor** | Read secrets (like GEMINI_API_KEY) during deployment |

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
  --role="roles/secretmanager.secretAccessor"
```

### 3. Add GitHub Secrets

In your repository: **Settings** → **Secrets and variables** → **Actions**

| Secret | Value |
|--------|-------|
| `FIREBASE_SERVICE_ACCOUNT` | Contents of the service account JSON file |

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
