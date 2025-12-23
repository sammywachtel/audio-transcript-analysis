#!/bin/bash
# =============================================================================
# GCP/Firebase Project Setup Script
#
# Creates and configures a complete Firebase project with all required APIs,
# service accounts, and IAM bindings for the Audio Transcript Analysis App.
#
# SINGLE PROJECT ARCHITECTURE:
# This script sets up ONE project for all components:
#   - Cloud Run (frontend)
#   - Cloud Functions (backend)
#   - Firestore (database)
#   - Firebase Storage (audio files)
#   - Firebase Authentication
#
# This script is IDEMPOTENT - safe to rerun after partial failures.
# Each step checks existing state and skips if already configured.
#
# Usage:
#   ./scripts/gcp-setup.sh <project-id> <billing-account-id> [github-repo]
#
# Example:
#   ./scripts/gcp-setup.sh my-app-12345 01A2B3-C4D5E6-F7G8H9 myorg/my-repo
#
# To find your billing account ID:
#   gcloud billing accounts list
#
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

PROJECT_ID="${1:?❌ Usage: $0 <project-id> <billing-account-id> [github-repo]}"
BILLING_ACCOUNT="${2:?❌ Usage: $0 <project-id> <billing-account-id> [github-repo]}"
GITHUB_REPO="${3:-}"  # Optional: org/repo for Workload Identity Federation
REGION="${4:-us-central1}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# -----------------------------------------------------------------------------
# Helper Functions
# -----------------------------------------------------------------------------

log_step() {
    echo -e "\n${BLUE}▶ $1${NC}"
}

log_success() {
    echo -e "${GREEN}  ✓ $1${NC}"
}

log_skip() {
    echo -e "${YELLOW}  ⊘ $1 (already configured)${NC}"
}

log_error() {
    echo -e "${RED}  ✗ $1${NC}"
}

log_info() {
    echo -e "  ℹ $1"
}

# Check if a command exists
require_command() {
    if ! command -v "$1" &> /dev/null; then
        log_error "Required command not found: $1"
        exit 1
    fi
}

# Check if an API is enabled
is_api_enabled() {
    local api="$1"
    gcloud services list --enabled --filter="name:$api" --format="value(name)" --project="$PROJECT_ID" 2>/dev/null | grep -q "$api"
}

# Check if IAM binding exists
has_iam_binding() {
    local member="$1"
    local role="$2"
    gcloud projects get-iam-policy "$PROJECT_ID" --format=json 2>/dev/null | \
        jq -e ".bindings[] | select(.role==\"$role\") | .members[] | select(.==\"$member\")" &>/dev/null
}

# Add IAM binding if not exists (idempotent)
add_iam_binding() {
    local member="$1"
    local role="$2"
    local description="$3"

    if has_iam_binding "$member" "$role"; then
        log_skip "$description"
    else
        gcloud projects add-iam-policy-binding "$PROJECT_ID" \
            --member="$member" \
            --role="$role" \
            --quiet > /dev/null
        log_success "$description"
    fi
}

# Check if a service account exists
sa_exists() {
    local sa_email="$1"
    gcloud iam service-accounts describe "$sa_email" --project="$PROJECT_ID" &>/dev/null
}

# Add IAM binding for service agent (skip if SA doesn't exist yet)
add_service_agent_binding() {
    local sa_email="$1"
    local role="$2"
    local description="$3"

    if ! sa_exists "$sa_email"; then
        log_info "$description - skipped (service agent not yet created)"
        return 0
    fi

    add_iam_binding "serviceAccount:$sa_email" "$role" "$description"
}

# -----------------------------------------------------------------------------
# Preflight Checks
# -----------------------------------------------------------------------------

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Audio Transcript App - GCP/Firebase Setup (Single Project)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Project ID:      $PROJECT_ID"
echo "  Billing Account: $BILLING_ACCOUNT"
echo "  GitHub Repo:     ${GITHUB_REPO:-<not specified - skipping Workload Identity>}"
echo "  Region:          $REGION"
echo ""

log_step "Checking prerequisites..."

require_command gcloud
require_command firebase
require_command jq
require_command gsutil

# Check gcloud auth
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -1 | grep -q "@"; then
    log_error "Not authenticated with gcloud. Run: gcloud auth login"
    exit 1
fi
log_success "gcloud authenticated"

# Check firebase auth
if ! firebase login:list 2>/dev/null | grep -q "@"; then
    log_error "Not authenticated with Firebase. Run: firebase login"
    exit 1
fi
log_success "Firebase CLI authenticated"

# Verify billing account exists and is accessible
if ! gcloud billing accounts list --format="value(name)" | grep -q "$BILLING_ACCOUNT"; then
    log_error "Billing account $BILLING_ACCOUNT not found or not accessible"
    echo "  Available billing accounts:"
    gcloud billing accounts list
    exit 1
fi
log_success "Billing account verified"

# -----------------------------------------------------------------------------
# Step 1: Create or Verify GCP Project
# -----------------------------------------------------------------------------

log_step "Setting up GCP project..."

if gcloud projects describe "$PROJECT_ID" &>/dev/null; then
    log_skip "Project $PROJECT_ID exists"
else
    gcloud projects create "$PROJECT_ID" --name="Audio Transcript App"
    log_success "Created project $PROJECT_ID"
fi

# Set as active project for subsequent commands
gcloud config set project "$PROJECT_ID" --quiet

# -----------------------------------------------------------------------------
# Step 2: Link Billing Account
# -----------------------------------------------------------------------------

log_step "Linking billing account..."

CURRENT_BILLING=$(gcloud billing projects describe "$PROJECT_ID" --format="value(billingAccountName)" 2>/dev/null || echo "")
EXPECTED_BILLING="billingAccounts/$BILLING_ACCOUNT"

if [[ "$CURRENT_BILLING" == "$EXPECTED_BILLING" ]]; then
    log_skip "Billing account already linked"
else
    gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
    log_success "Linked billing account $BILLING_ACCOUNT"
fi

# -----------------------------------------------------------------------------
# Step 3: Add Firebase to Project
# -----------------------------------------------------------------------------

log_step "Adding Firebase to project..."

# Check if Firebase is already added by looking for the firebase API
if is_api_enabled "firebase.googleapis.com"; then
    log_skip "Firebase already added to project"
else
    firebase projects:addfirebase "$PROJECT_ID" --non-interactive || {
        # If it fails, it might already be a Firebase project
        log_skip "Firebase may already be configured"
    }
    log_success "Added Firebase to project"
fi

# -----------------------------------------------------------------------------
# Step 4: Enable Required APIs
# -----------------------------------------------------------------------------

log_step "Enabling required APIs..."

APIS=(
    # Firebase services
    "firebase.googleapis.com"
    "firestore.googleapis.com"
    "firebasestorage.googleapis.com"
    "firebaseextensions.googleapis.com"
    "identitytoolkit.googleapis.com"
    # Cloud Functions
    "cloudfunctions.googleapis.com"
    "eventarc.googleapis.com"
    "pubsub.googleapis.com"
    # Cloud Run (frontend)
    "run.googleapis.com"
    "containerregistry.googleapis.com"
    # Build & Deploy
    "cloudbuild.googleapis.com"
    "artifactregistry.googleapis.com"
    # IAM & Secrets
    "secretmanager.googleapis.com"
    "iamcredentials.googleapis.com"
    # Storage & Billing
    "storage.googleapis.com"
    "cloudbilling.googleapis.com"
    # AI/ML - Gemini
    "generativelanguage.googleapis.com"
    "apikeys.googleapis.com"
)

APIS_TO_ENABLE=()

for api in "${APIS[@]}"; do
    if is_api_enabled "$api"; then
        log_skip "$api"
    else
        APIS_TO_ENABLE+=("$api")
    fi
done

if [[ ${#APIS_TO_ENABLE[@]} -gt 0 ]]; then
    log_info "Enabling ${#APIS_TO_ENABLE[@]} APIs (this may take a minute)..."
    gcloud services enable "${APIS_TO_ENABLE[@]}" --project="$PROJECT_ID"
    for api in "${APIS_TO_ENABLE[@]}"; do
        log_success "$api"
    done
fi

# -----------------------------------------------------------------------------
# Step 5: Get Project Number (needed for service agents)
# -----------------------------------------------------------------------------

log_step "Getting project number..."

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")
log_info "Project number: $PROJECT_NUMBER"

# -----------------------------------------------------------------------------
# Step 6: Configure Firebase Deployment Service Account
# -----------------------------------------------------------------------------

log_step "Configuring Firebase deployment service account..."

# Try to find existing firebase-adminsdk service account
SA_EMAIL=$(gcloud iam service-accounts list \
    --filter="email:firebase-adminsdk" \
    --format="value(email)" \
    --project="$PROJECT_ID" | head -1)

if [[ -z "$SA_EMAIL" ]]; then
    # Firebase Admin SDK SA not found - this is normal for new projects
    # Create a dedicated deployment service account instead
    DEPLOY_SA_NAME="firebase-deployer"
    SA_EMAIL="${DEPLOY_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

    if gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" &>/dev/null; then
        log_skip "Deployment service account already exists"
    else
        log_info "Creating dedicated deployment service account..."
        gcloud iam service-accounts create "$DEPLOY_SA_NAME" \
            --project="$PROJECT_ID" \
            --display-name="Firebase Deployer (CI/CD)"
        log_success "Created $SA_EMAIL"

        # Wait for service account to propagate (GCP eventual consistency)
        log_info "Waiting for service account to propagate..."
        for i in {1..12}; do
            if gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" &>/dev/null; then
                break
            fi
            sleep 5
        done
    fi
else
    log_skip "Using existing Firebase Admin SDK service account"
fi

log_info "Deployment SA: $SA_EMAIL"

# Deployment service account roles
DEPLOYMENT_ROLES=(
    "roles/cloudfunctions.admin"
    "roles/firebaserules.admin"
    "roles/firebase.admin"
    "roles/storage.admin"
    "roles/datastore.user"
    "roles/iam.serviceAccountUser"
    "roles/secretmanager.admin"
)

for role in "${DEPLOYMENT_ROLES[@]}"; do
    add_iam_binding "serviceAccount:$SA_EMAIL" "$role" "$SA_EMAIL → $role"
done

# -----------------------------------------------------------------------------
# Step 7: Configure Runtime Service Account
# -----------------------------------------------------------------------------

log_step "Configuring runtime service account..."

RUNTIME_SA="${PROJECT_ID}@appspot.gserviceaccount.com"

# Check if App Engine default SA exists (created when enabling certain APIs)
if ! sa_exists "$RUNTIME_SA"; then
    log_info "App Engine default SA not yet created - will be created on first function deploy"
    log_info "Skipping secret accessor binding (will be configured during deployment)"
else
    add_iam_binding "serviceAccount:$RUNTIME_SA" "roles/secretmanager.secretAccessor" "$RUNTIME_SA → Secret Accessor"
fi

# -----------------------------------------------------------------------------
# Step 8: Configure Service Agent IAM Bindings
# -----------------------------------------------------------------------------

log_step "Configuring Google-managed service agents..."

log_info "Note: Service agents are created when you first use each service."
log_info "Skipped bindings will be configured automatically on first deployment."

# Storage service agent → Pub/Sub publisher (for Cloud Functions storage triggers)
STORAGE_SA="service-${PROJECT_NUMBER}@gs-project-accounts.iam.gserviceaccount.com"
add_service_agent_binding "$STORAGE_SA" "roles/pubsub.publisher" "Storage Agent → Pub/Sub Publisher"

# Pub/Sub service agent → Token creator (for authenticated push)
PUBSUB_SA="service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"
add_service_agent_binding "$PUBSUB_SA" "roles/iam.serviceAccountTokenCreator" "Pub/Sub Agent → Token Creator"

# Compute service agent → Cloud Run invoker + event receiver
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
add_service_agent_binding "$COMPUTE_SA" "roles/run.invoker" "Compute Agent → Run Invoker"
add_service_agent_binding "$COMPUTE_SA" "roles/eventarc.eventReceiver" "Compute Agent → Event Receiver"

# -----------------------------------------------------------------------------
# Step 9: Initialize Firestore
# -----------------------------------------------------------------------------

log_step "Initializing Firestore..."

# Check if Firestore database exists
if gcloud firestore databases describe --project="$PROJECT_ID" &>/dev/null; then
    log_skip "Firestore database already exists"
else
    gcloud firestore databases create \
        --project="$PROJECT_ID" \
        --location="$REGION" \
        --type=firestore-native
    log_success "Created Firestore database in $REGION"
fi

# -----------------------------------------------------------------------------
# Step 10: Initialize Firebase Storage and Configure Bucket Access
# -----------------------------------------------------------------------------

log_step "Initializing Firebase Storage..."

# Firebase Storage bucket (might be .appspot.com or .firebasestorage.app)
BUCKET_APPSPOT="gs://${PROJECT_ID}.appspot.com"
BUCKET_FIREBASE="gs://${PROJECT_ID}.firebasestorage.app"
STORAGE_REGION="${REGION:-us-central1}"

EVENTARC_SA="service-${PROJECT_NUMBER}@gcp-sa-eventarc.iam.gserviceaccount.com"

# Check if bucket already exists
if gsutil ls "$BUCKET_FIREBASE" &>/dev/null; then
    BUCKET="$BUCKET_FIREBASE"
    log_skip "Storage bucket exists: $BUCKET"
elif gsutil ls "$BUCKET_APPSPOT" &>/dev/null; then
    BUCKET="$BUCKET_APPSPOT"
    log_skip "Storage bucket exists: $BUCKET"
else
    # Storage not initialized - try to provision via Firebase
    # NOTE: The .firebasestorage.app domain is owned by Google - you cannot create buckets
    # with that suffix directly. Firebase must provision them through their system.
    # The .appspot.com bucket is tied to App Engine and can be created that way.
    log_info "Firebase Storage not found, attempting to create..."
    BUCKET=""

    # Method 1: Create App Engine app (auto-creates appspot.com bucket)
    # This is the most reliable method - App Engine's default bucket is Firebase-enabled
    if [[ -z "$BUCKET" ]]; then
        log_info "Trying: gcloud app create (provisions default bucket)..."
        if gcloud app describe --project="$PROJECT_ID" &>/dev/null; then
            log_info "App Engine already exists, checking for bucket..."
        else
            log_info "Creating App Engine app in $STORAGE_REGION..."
            if gcloud app create --project="$PROJECT_ID" --region="$STORAGE_REGION" 2>&1; then
                log_info "App Engine created, waiting for bucket provisioning..."
                sleep 10  # App Engine bucket provisioning can take a moment
            fi
        fi
        # Check if bucket now exists
        if gsutil ls "$BUCKET_APPSPOT" &>/dev/null; then
            BUCKET="$BUCKET_APPSPOT"
            log_success "Storage bucket ready: $BUCKET"
        fi
    fi

    # Method 2: REST API - get default bucket (triggers provisioning if needed)
    # Firebase projects have a default bucket that may need to be "activated"
    if [[ -z "$BUCKET" ]]; then
        log_info "Trying: Firebase Storage API (getDefaultBucket)..."
        ACCESS_TOKEN=$(gcloud auth print-access-token 2>/dev/null)
        if [[ -n "$ACCESS_TOKEN" ]]; then
            # Try to get/provision default bucket
            RESPONSE=$(curl -s \
                "https://firebasestorage.googleapis.com/v1beta/projects/${PROJECT_ID}/defaultBucket" \
                -H "Authorization: Bearer ${ACCESS_TOKEN}" \
                2>/dev/null)

            # Check if we got a bucket name back
            if echo "$RESPONSE" | grep -q "name"; then
                BUCKET_NAME=$(echo "$RESPONSE" | grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)
                if [[ -n "$BUCKET_NAME" ]]; then
                    BUCKET="gs://${BUCKET_NAME}"
                    log_success "Default bucket found: $BUCKET"
                fi
            fi

            # If that didn't work, check both bucket formats
            if [[ -z "$BUCKET" ]]; then
                sleep 3
                if gsutil ls "$BUCKET_FIREBASE" &>/dev/null; then
                    BUCKET="$BUCKET_FIREBASE"
                    log_success "Storage bucket found: $BUCKET"
                elif gsutil ls "$BUCKET_APPSPOT" &>/dev/null; then
                    BUCKET="$BUCKET_APPSPOT"
                    log_success "Storage bucket found: $BUCKET"
                fi
            fi
        fi
    fi

    # All methods failed - provide manual instructions
    # This is expected for brand new Firebase projects - Console setup is required
    if [[ -z "$BUCKET" ]]; then
        log_info ""
        log_info "Firebase Storage requires manual setup for new projects."
        log_info "This is a one-time setup that must be done in the Firebase Console."
        log_info ""
        log_info "Please enable Firebase Storage:"
        log_info "  1. Go to: https://console.firebase.google.com/project/$PROJECT_ID/storage"
        log_info "  2. Click 'Get started'"
        log_info "  3. Select 'Start in production mode'"
        log_info "  4. Choose location: $STORAGE_REGION (must match your Firestore region)"
        log_info "  5. Click 'Done'"
        log_info ""
        log_info "After setup, re-run this script to configure bucket permissions and CORS."
    fi
fi

if [[ -n "$BUCKET" ]]; then
    # Check if Eventarc service agent exists
    if ! sa_exists "$EVENTARC_SA"; then
        log_info "Eventarc agent bucket access - skipped (service agent not yet created)"
    elif gsutil iam get "$BUCKET" 2>/dev/null | grep -q "$EVENTARC_SA"; then
        log_skip "Eventarc agent bucket access"
    else
        if gsutil iam ch "serviceAccount:${EVENTARC_SA}:objectViewer" "$BUCKET" 2>/dev/null; then
            log_success "Granted Eventarc agent bucket access"
        else
            log_info "Eventarc agent bucket access - skipped (will be configured on first deploy)"
        fi
    fi

    # Configure CORS for audio file access
    CORS_FILE="$(dirname "$0")/../cors.json"
    if [[ -f "$CORS_FILE" ]]; then
        if gsutil cors set "$CORS_FILE" "$BUCKET" 2>/dev/null; then
            log_success "Configured CORS for Storage bucket"
        else
            log_info "CORS configuration skipped - apply manually with: gsutil cors set cors.json $BUCKET"
        fi
    else
        log_info "cors.json not found - CORS configuration skipped"
    fi
fi

# -----------------------------------------------------------------------------
# Step 11: Set Up Workload Identity Federation for Cloud Run (GitHub Actions)
# -----------------------------------------------------------------------------

log_step "Workload Identity Federation for Cloud Run..."

if [[ -z "$GITHUB_REPO" ]]; then
    log_info "GitHub repo not specified - skipping Workload Identity setup"
    log_info "To set up later, rerun with: $0 $PROJECT_ID $BILLING_ACCOUNT org/repo"
    WIF_PROVIDER=""
    GITHUB_SA_EMAIL=""
else
    # Check if workload identity pool exists
    POOL_NAME="github-pool"
    PROVIDER_NAME="github-provider"

    if gcloud iam workload-identity-pools describe "$POOL_NAME" \
        --location="global" \
        --project="$PROJECT_ID" &>/dev/null; then
        log_skip "Workload Identity Pool '$POOL_NAME' exists"
    else
        gcloud iam workload-identity-pools create "$POOL_NAME" \
            --project="$PROJECT_ID" \
            --location="global" \
            --display-name="GitHub Actions Pool"
        log_success "Created Workload Identity Pool"
    fi

    # Check if provider exists
    if gcloud iam workload-identity-pools providers describe "$PROVIDER_NAME" \
        --workload-identity-pool="$POOL_NAME" \
        --location="global" \
        --project="$PROJECT_ID" &>/dev/null; then
        log_skip "Workload Identity Provider '$PROVIDER_NAME' exists"
    else
        # Extract owner from GITHUB_REPO (e.g., "owner/repo" -> "owner")
        GITHUB_OWNER="${GITHUB_REPO%%/*}"

        gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_NAME" \
            --project="$PROJECT_ID" \
            --location="global" \
            --workload-identity-pool="$POOL_NAME" \
            --display-name="GitHub Provider" \
            --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
            --attribute-condition="assertion.repository_owner=='${GITHUB_OWNER}'" \
            --issuer-uri="https://token.actions.githubusercontent.com"
        log_success "Created Workload Identity Provider"
    fi

    # Create service account for GitHub Actions (Cloud Run deployment)
    GITHUB_SA_NAME="github-actions"
    GITHUB_SA_EMAIL="${GITHUB_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

    if gcloud iam service-accounts describe "$GITHUB_SA_EMAIL" --project="$PROJECT_ID" &>/dev/null; then
        log_skip "GitHub Actions service account exists"
    else
        gcloud iam service-accounts create "$GITHUB_SA_NAME" \
            --project="$PROJECT_ID" \
            --display-name="GitHub Actions CI/CD"
        log_success "Created GitHub Actions service account"

        # Wait for service account to propagate (GCP eventual consistency)
        log_info "Waiting for service account to propagate..."
        for i in {1..12}; do
            if gcloud iam service-accounts describe "$GITHUB_SA_EMAIL" --project="$PROJECT_ID" &>/dev/null; then
                break
            fi
            sleep 5
        done
    fi

    # Grant Cloud Run deployment permissions
    GITHUB_SA_ROLES=(
        "roles/run.admin"
        "roles/cloudbuild.builds.builder"
        "roles/storage.admin"
        "roles/iam.serviceAccountUser"
    )

    for role in "${GITHUB_SA_ROLES[@]}"; do
        add_iam_binding "serviceAccount:$GITHUB_SA_EMAIL" "$role" "GitHub Actions SA → $role"
    done

    # Allow GitHub to impersonate the service account
    WIF_MEMBER="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_NAME}/attribute.repository/${GITHUB_REPO}"

    if gcloud iam service-accounts get-iam-policy "$GITHUB_SA_EMAIL" \
        --project="$PROJECT_ID" --format=json 2>/dev/null | \
        jq -e ".bindings[] | select(.role==\"roles/iam.workloadIdentityUser\") | .members[] | select(.==\"$WIF_MEMBER\")" &>/dev/null; then
        log_skip "GitHub repo can impersonate service account"
    else
        gcloud iam service-accounts add-iam-policy-binding "$GITHUB_SA_EMAIL" \
            --project="$PROJECT_ID" \
            --role="roles/iam.workloadIdentityUser" \
            --member="$WIF_MEMBER" \
            --quiet > /dev/null
        log_success "Granted GitHub repo impersonation rights"
    fi

    WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_NAME}/providers/${PROVIDER_NAME}"
    log_info "Workload Identity Provider: $WIF_PROVIDER"
fi

# -----------------------------------------------------------------------------
# Step 12: Create Service Account Key for Firebase Deployment
# -----------------------------------------------------------------------------

log_step "Service account key for Firebase CI/CD..."

KEY_FILE="firebase-sa-key.json"

if [[ -f "$KEY_FILE" ]]; then
    log_skip "Key file $KEY_FILE already exists"
    log_info "To regenerate, delete $KEY_FILE and rerun"
else
    read -p "  Generate service account key for GitHub Actions? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        gcloud iam service-accounts keys create "$KEY_FILE" \
            --iam-account="$SA_EMAIL" \
            --project="$PROJECT_ID"
        log_success "Created $KEY_FILE"
        log_info "Add contents to GitHub Secret: FIREBASE_SERVICE_ACCOUNT"
        log_info "⚠️  Keep this file secure and don't commit to git!"
    else
        log_info "Skipped - generate manually with:"
        log_info "gcloud iam service-accounts keys create $KEY_FILE --iam-account=$SA_EMAIL"
    fi
fi

# -----------------------------------------------------------------------------
# Step 13: Create Gemini API Key and Secret
# -----------------------------------------------------------------------------

log_step "Gemini API key and secret..."

# Check if secret already exists
if gcloud secrets describe GEMINI_API_KEY --project="$PROJECT_ID" &>/dev/null; then
    log_skip "GEMINI_API_KEY secret already exists"
else
    read -p "  Create Gemini API key now? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        # Create API key restricted to Generative Language API
        log_info "Creating API key for Gemini..."
        API_KEY_NAME="gemini-api-key"  # pragma: allowlist secret

        # Check if API key already exists
        EXISTING_KEY=$(gcloud services api-keys list \
            --project="$PROJECT_ID" \
            --filter="displayName='$API_KEY_NAME'" \
            --format="value(name)" 2>/dev/null | head -1)

        if [[ -n "$EXISTING_KEY" ]]; then
            log_info "API key '$API_KEY_NAME' already exists, retrieving..."
            GEMINI_KEY=$(gcloud services api-keys get-key-string "$EXISTING_KEY" \
                --format="value(keyString)" 2>/dev/null)
        else
            # Create new API key restricted to Generative Language API
            KEY_RESULT=$(gcloud services api-keys create \
                --project="$PROJECT_ID" \
                --display-name="$API_KEY_NAME" \
                --api-target=service=generativelanguage.googleapis.com \
                --format=json 2>/dev/null)

            # Extract the key name from the operation result
            KEY_NAME=$(echo "$KEY_RESULT" | jq -r '.response.name // .name // empty')

            if [[ -z "$KEY_NAME" ]]; then
                # Sometimes the create command returns the key directly
                GEMINI_KEY=$(echo "$KEY_RESULT" | jq -r '.response.keyString // .keyString // empty')
                if [[ -z "$GEMINI_KEY" ]]; then
                    log_error "Failed to create API key. Create manually at:"
                    log_info "https://console.cloud.google.com/apis/credentials?project=$PROJECT_ID"
                    GEMINI_KEY=""
                fi
            else
                # Get the key string from the created key
                GEMINI_KEY=$(gcloud services api-keys get-key-string "$KEY_NAME" \
                    --format="value(keyString)" 2>/dev/null)
            fi
            log_success "Created Gemini API key"
        fi

        # Store in Secret Manager
        if [[ -n "$GEMINI_KEY" ]]; then
            echo -n "$GEMINI_KEY" | gcloud secrets create GEMINI_API_KEY \
                --data-file=- \
                --project="$PROJECT_ID"
            log_success "Stored GEMINI_API_KEY in Secret Manager"
        fi
    else
        log_info "Skipped - create manually:"
        log_info "1. Enable API: gcloud services enable generativelanguage.googleapis.com --project=$PROJECT_ID"
        log_info "2. Create key: https://console.cloud.google.com/apis/credentials?project=$PROJECT_ID"
        log_info "3. Store secret: npx firebase functions:secrets:set GEMINI_API_KEY"
    fi
fi

# -----------------------------------------------------------------------------
# Step 14: Enable Firebase Authentication
# -----------------------------------------------------------------------------

log_step "Firebase Authentication..."

log_info "Google Sign-In must be enabled manually:"
log_info "https://console.firebase.google.com/project/$PROJECT_ID/authentication/providers"
log_info "Enable Google provider and set support email"

# -----------------------------------------------------------------------------
# Step 15: Register Web App
# -----------------------------------------------------------------------------

log_step "Firebase Web App..."

# Check if web app exists
WEB_APPS=$(firebase apps:list --project="$PROJECT_ID" 2>/dev/null | grep -c "WEB" || echo "0")

if [[ "$WEB_APPS" -gt 0 ]]; then
    log_skip "Web app already registered"
else
    read -p "  Register Firebase Web App? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        firebase apps:create WEB "Audio Transcript Web" --project="$PROJECT_ID"
        log_success "Created web app"
    fi
fi

# Get web app config
log_info "Get your Firebase config with:"
log_info "firebase apps:sdkconfig WEB --project=$PROJECT_ID"

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Setup Complete! (Single Project Architecture)${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Project ID:     $PROJECT_ID"
echo "  Project Number: $PROJECT_NUMBER"
echo "  Region:         $REGION"
echo ""
echo "  Service Accounts:"
echo "    Firebase Deployment: $SA_EMAIL"
echo "    Functions Runtime:   $RUNTIME_SA"
if [[ -n "$GITHUB_SA_EMAIL" ]]; then
echo "    GitHub Actions:      $GITHUB_SA_EMAIL"
fi
echo ""
if [[ -n "$WIF_PROVIDER" ]]; then
echo "  Workload Identity Federation (for Cloud Run):"
echo "    Provider: $WIF_PROVIDER"
echo ""
fi
echo "  Next Steps:"
echo "    1. Enable Google Auth: https://console.firebase.google.com/project/$PROJECT_ID/authentication/providers"
echo "    2. Get web config:     firebase apps:sdkconfig WEB --project=$PROJECT_ID"
echo "    3. Update .env with Firebase config values (GCP_PROJECT_ID = $PROJECT_ID)"
echo "    4. Configure GitHub Secrets (see below)"
echo "    5. Deploy:             firebase deploy --project=$PROJECT_ID"
echo ""
echo "  ┌─────────────────────────────────────────────────────────────────────────┐"
echo "  │  Required GitHub Secrets for CI/CD (Single Project)                     │"
echo "  ├─────────────────────────────────────────────────────────────────────────┤"
echo "  │  Firebase Deploy Workflow (.github/workflows/firebase-deploy.yml):      │"
echo "  │    • FIREBASE_SERVICE_ACCOUNT     - Contents of $KEY_FILE               │"
echo "  │                                                                         │"
echo "  │  Cloud Run Deploy Workflow (.github/workflows/deploy.yml):              │"
echo "  │    • GCP_PROJECT_ID               - $PROJECT_ID"
if [[ -n "$WIF_PROVIDER" ]]; then
echo "  │    • GCP_WORKLOAD_IDENTITY_PROVIDER - $WIF_PROVIDER"
echo "  │    • GCP_SERVICE_ACCOUNT          - $GITHUB_SA_EMAIL"
else
echo "  │    • GCP_WORKLOAD_IDENTITY_PROVIDER - (run script with github-repo arg) │"
echo "  │    • GCP_SERVICE_ACCOUNT          - (run script with github-repo arg)   │"
fi
echo "  │    • VITE_FIREBASE_API_KEY        - From firebase apps:sdkconfig        │"
echo "  │    • VITE_FIREBASE_AUTH_DOMAIN    - ${PROJECT_ID}.firebaseapp.com       │"
echo "  │    • VITE_FIREBASE_PROJECT_ID     - $PROJECT_ID"
echo "  │    • VITE_FIREBASE_STORAGE_BUCKET - From firebase apps:sdkconfig        │"
echo "  │    • VITE_FIREBASE_MESSAGING_SENDER_ID - From sdkconfig                 │"
echo "  │    • VITE_FIREBASE_APP_ID         - From firebase apps:sdkconfig        │"
echo "  └─────────────────────────────────────────────────────────────────────────┘"
echo ""
echo "  ⚠️  IMPORTANT: Use the SAME project ($PROJECT_ID) for both Cloud Run and Firebase!"
echo "      This ensures unified billing, simpler IAM, and seamless integration."
echo ""
echo "  ℹ️  NOTE: Some service agent bindings may have been skipped because the agents"
echo "      don't exist yet. Don't worry - the GitHub Actions workflow will configure"
echo "      them automatically on each deployment."
echo ""
echo "  To get Firebase config values, run:"
echo "    firebase apps:sdkconfig WEB --project=$PROJECT_ID"
echo ""
echo "  Useful Links:"
echo "    Firebase Console: https://console.firebase.google.com/project/$PROJECT_ID"
echo "    GCP Console:      https://console.cloud.google.com/home/dashboard?project=$PROJECT_ID"
echo "    Billing:          https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT_ID"
if [[ -n "$GITHUB_REPO" ]]; then
echo "    GitHub Secrets:   https://github.com/$GITHUB_REPO/settings/secrets/actions"
else
echo "    GitHub Secrets:   https://github.com/<owner>/<repo>/settings/secrets/actions"
fi
echo ""
