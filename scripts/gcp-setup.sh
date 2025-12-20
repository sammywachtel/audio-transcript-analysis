#!/bin/bash
# =============================================================================
# GCP/Firebase Project Setup Script
#
# Creates and configures a complete Firebase project with all required APIs,
# service accounts, and IAM bindings for the Audio Transcript Analysis App.
#
# This script is IDEMPOTENT - safe to rerun after partial failures.
# Each step checks existing state and skips if already configured.
#
# Usage:
#   ./scripts/gcp-setup.sh <project-id> <billing-account-id>
#
# Example:
#   ./scripts/gcp-setup.sh audio-transcript-app-67465 01A2B3-C4D5E6-F7G8H9
#
# To find your billing account ID:
#   gcloud billing accounts list
#
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

PROJECT_ID="${1:?❌ Usage: $0 <project-id> <billing-account-id>}"
BILLING_ACCOUNT="${2:?❌ Usage: $0 <project-id> <billing-account-id>}"
REGION="${3:-us-central1}"

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

# -----------------------------------------------------------------------------
# Preflight Checks
# -----------------------------------------------------------------------------

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Audio Transcript App - GCP/Firebase Setup${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Project ID:      $PROJECT_ID"
echo "  Billing Account: $BILLING_ACCOUNT"
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
    "cloudfunctions.googleapis.com"
    "cloudbuild.googleapis.com"
    "artifactregistry.googleapis.com"
    "run.googleapis.com"
    "eventarc.googleapis.com"
    "pubsub.googleapis.com"
    "secretmanager.googleapis.com"
    "firestore.googleapis.com"
    "storage.googleapis.com"
    "iamcredentials.googleapis.com"
    "cloudbilling.googleapis.com"
    "firebaseextensions.googleapis.com"
    "firebase.googleapis.com"
    "firebasestorage.googleapis.com"
    "identitytoolkit.googleapis.com"
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
# Step 6: Configure Firebase Admin SDK Service Account
# -----------------------------------------------------------------------------

log_step "Configuring Firebase Admin SDK service account..."

# Find the firebase-adminsdk service account
SA_EMAIL=$(gcloud iam service-accounts list \
    --filter="email:firebase-adminsdk" \
    --format="value(email)" \
    --project="$PROJECT_ID" | head -1)

if [[ -z "$SA_EMAIL" ]]; then
    log_info "Waiting for Firebase Admin SDK service account to be created..."
    sleep 10
    SA_EMAIL=$(gcloud iam service-accounts list \
        --filter="email:firebase-adminsdk" \
        --format="value(email)" \
        --project="$PROJECT_ID" | head -1)
fi

if [[ -z "$SA_EMAIL" ]]; then
    log_error "Firebase Admin SDK service account not found. This should have been created automatically."
    exit 1
fi

log_info "Firebase Admin SA: $SA_EMAIL"

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

# Wait for App Engine default SA to exist (created when enabling certain APIs)
if ! gcloud iam service-accounts describe "$RUNTIME_SA" --project="$PROJECT_ID" &>/dev/null; then
    log_info "Waiting for App Engine default service account..."
    sleep 15
fi

add_iam_binding "serviceAccount:$RUNTIME_SA" "roles/secretmanager.secretAccessor" "$RUNTIME_SA → Secret Accessor"

# -----------------------------------------------------------------------------
# Step 8: Configure Service Agent IAM Bindings
# -----------------------------------------------------------------------------

log_step "Configuring Google-managed service agents..."

# Storage service agent → Pub/Sub publisher
STORAGE_SA="service-${PROJECT_NUMBER}@gs-project-accounts.iam.gserviceaccount.com"
add_iam_binding "serviceAccount:$STORAGE_SA" "roles/pubsub.publisher" "Storage Agent → Pub/Sub Publisher"

# Pub/Sub service agent → Token creator
PUBSUB_SA="service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"
add_iam_binding "serviceAccount:$PUBSUB_SA" "roles/iam.serviceAccountTokenCreator" "Pub/Sub Agent → Token Creator"

# Compute service agent → Cloud Run invoker + event receiver
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
add_iam_binding "serviceAccount:$COMPUTE_SA" "roles/run.invoker" "Compute Agent → Run Invoker"
add_iam_binding "serviceAccount:$COMPUTE_SA" "roles/eventarc.eventReceiver" "Compute Agent → Event Receiver"

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
# Step 10: Initialize Storage and Configure Bucket Access
# -----------------------------------------------------------------------------

log_step "Configuring Storage bucket..."

# Firebase Storage bucket (might be .appspot.com or .firebasestorage.app)
BUCKET_APPSPOT="gs://${PROJECT_ID}.appspot.com"
BUCKET_FIREBASE="gs://${PROJECT_ID}.firebasestorage.app"

EVENTARC_SA="service-${PROJECT_NUMBER}@gcp-sa-eventarc.iam.gserviceaccount.com"

# Try the firebasestorage.app bucket first (newer projects)
if gsutil ls "$BUCKET_FIREBASE" &>/dev/null; then
    BUCKET="$BUCKET_FIREBASE"
    log_info "Using bucket: $BUCKET"
elif gsutil ls "$BUCKET_APPSPOT" &>/dev/null; then
    BUCKET="$BUCKET_APPSPOT"
    log_info "Using bucket: $BUCKET"
else
    log_info "Storage bucket not yet created - will be created on first upload"
    BUCKET=""
fi

if [[ -n "$BUCKET" ]]; then
    # Check if Eventarc SA already has access
    if gsutil iam get "$BUCKET" 2>/dev/null | grep -q "$EVENTARC_SA"; then
        log_skip "Eventarc agent bucket access"
    else
        gsutil iam ch "serviceAccount:${EVENTARC_SA}:objectViewer" "$BUCKET"
        log_success "Granted Eventarc agent bucket access"
    fi
fi

# -----------------------------------------------------------------------------
# Step 11: Create Service Account Key for GitHub Actions
# -----------------------------------------------------------------------------

log_step "Service account key for CI/CD..."

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
# Step 12: Set Gemini API Secret
# -----------------------------------------------------------------------------

log_step "Gemini API secret..."

# Check if secret exists
if gcloud secrets describe GEMINI_API_KEY --project="$PROJECT_ID" &>/dev/null; then
    log_skip "GEMINI_API_KEY secret already exists"
else
    read -p "  Set GEMINI_API_KEY now? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "  Enter your Gemini API key (get one at https://makersuite.google.com/app/apikey):"
        read -s GEMINI_KEY
        echo
        echo -n "$GEMINI_KEY" | gcloud secrets create GEMINI_API_KEY \
            --data-file=- \
            --project="$PROJECT_ID"
        log_success "Created GEMINI_API_KEY secret"
    else
        log_info "Skipped - set manually with:"
        log_info "npx firebase functions:secrets:set GEMINI_API_KEY"
    fi
fi

# -----------------------------------------------------------------------------
# Step 13: Enable Firebase Authentication
# -----------------------------------------------------------------------------

log_step "Firebase Authentication..."

log_info "Google Sign-In must be enabled manually:"
log_info "https://console.firebase.google.com/project/$PROJECT_ID/authentication/providers"
log_info "Enable Google provider and set support email"

# -----------------------------------------------------------------------------
# Step 14: Register Web App
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
echo -e "${GREEN}  Setup Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Project ID:     $PROJECT_ID"
echo "  Project Number: $PROJECT_NUMBER"
echo "  Region:         $REGION"
echo ""
echo "  Service Accounts:"
echo "    Deployment: $SA_EMAIL"
echo "    Runtime:    $RUNTIME_SA"
echo ""
echo "  Next Steps:"
echo "    1. Enable Google Auth: https://console.firebase.google.com/project/$PROJECT_ID/authentication/providers"
echo "    2. Get web config:     firebase apps:sdkconfig WEB --project=$PROJECT_ID"
echo "    3. Update .env with Firebase config values"
echo "    4. Configure GitHub Secrets (see below)"
echo "    5. Deploy:             firebase deploy --project=$PROJECT_ID"
echo ""
echo "  ┌─────────────────────────────────────────────────────────────────────┐"
echo "  │  Required GitHub Secrets for CI/CD                                  │"
echo "  ├─────────────────────────────────────────────────────────────────────┤"
echo "  │  Firebase Deploy Workflow (.github/workflows/firebase-deploy.yml):  │"
echo "  │    • FIREBASE_SERVICE_ACCOUNT     - Contents of $KEY_FILE           │"
echo "  │                                                                     │"
echo "  │  Cloud Run Deploy Workflow (.github/workflows/deploy.yml):          │"
echo "  │    • GCP_PROJECT_ID               - $PROJECT_ID                     │"
echo "  │    • GCP_WORKLOAD_IDENTITY_PROVIDER - Workload Identity pool        │"
echo "  │    • GCP_SERVICE_ACCOUNT          - Service account email           │"
echo "  │    • VITE_FIREBASE_API_KEY        - From firebase apps:sdkconfig    │"
echo "  │    • VITE_FIREBASE_AUTH_DOMAIN    - ${PROJECT_ID}.firebaseapp.com   │"
echo "  │    • VITE_FIREBASE_PROJECT_ID     - $PROJECT_ID                     │"
echo "  │    • VITE_FIREBASE_STORAGE_BUCKET - From firebase apps:sdkconfig    │"
echo "  │    • VITE_FIREBASE_MESSAGING_SENDER_ID - From sdkconfig             │"
echo "  │    • VITE_FIREBASE_APP_ID         - From firebase apps:sdkconfig    │"
echo "  │    • ALIGNMENT_SERVICE_URL        - Cloud Run alignment service URL │"
echo "  └─────────────────────────────────────────────────────────────────────┘"
echo ""
echo "  To get Firebase config values, run:"
echo "    firebase apps:sdkconfig WEB --project=$PROJECT_ID"
echo ""
echo "  Useful Links:"
echo "    Firebase Console: https://console.firebase.google.com/project/$PROJECT_ID"
echo "    GCP Console:      https://console.cloud.google.com/home/dashboard?project=$PROJECT_ID"
echo "    Billing:          https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT_ID"
echo "    GitHub Secrets:   https://github.com/<owner>/<repo>/settings/secrets/actions"
echo ""
