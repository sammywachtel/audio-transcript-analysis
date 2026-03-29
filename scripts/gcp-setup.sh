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

# Whisper GPU region — separate from main region because GPU quota
# may only be available in specific regions (us-east4 as of Feb 2026)
WHISPER_GPU_REGION="${WHISPER_GPU_REGION:-us-east4}"

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

# Add IAM binding for service agent
# Note: Service agents (like @gs-project-accounts, @gcp-sa-pubsub) are Google-managed
# and don't appear in `gcloud iam service-accounts list`. We add bindings unconditionally
# and let gcloud handle any errors - the binding will take effect when the agent is created.
add_service_agent_binding() {
    local sa_email="$1"
    local role="$2"
    local description="$3"

    # Just try to add the binding - service agents are created lazily by GCP
    # and the binding will work once they exist
    if gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:$sa_email" \
        --role="$role" \
        --condition=None \
        --quiet > /dev/null 2>&1; then
        log_success "$description"
    else
        # Binding might fail if agent truly doesn't exist yet, that's ok
        log_info "$description - will be configured on first deploy"
    fi
}

# Create a service identity to ensure the service agent exists
# Wrapped to handle set -e properly
ensure_service_identity() {
    local service="$1"
    local description="$2"
    local output=""
    local exit_code=0

    # Run gcloud command, capturing output and exit code without triggering set -e
    # The '|| true' prevents set -e from killing the script on failure
    output=$(gcloud beta services identity create \
        --service="$service" \
        --project="$PROJECT_ID" \
        --quiet 2>&1) || exit_code=$?

    # Success
    if [[ $exit_code -eq 0 ]]; then
        log_success "$description"
        return 0
    fi

    # Check if it's just "already exists" (not a real error)
    if echo "$output" | grep -qi "already exists\|already created\|Service identity already exists"; then
        log_skip "$description"
        return 0
    fi

    # Other error - just log and continue (non-fatal for service identities)
    log_info "$description - skipped: $output"
    return 0
}

# Manage a secret in Secret Manager (idempotent, with version cleanup)
# - Creates secret if it doesn't exist
# - Only adds new version if value has changed
# - Deletes old versions (keeps latest + previous for rollback safety)
# Usage: manage_secret "SECRET_NAME" "secret_value"
# Returns: 0 on success/skip, 1 on error
manage_secret() {
    local secret_name="$1"
    local secret_value="$2"
    local keep_versions=2  # Keep current + previous

    # Check if secret exists
    if ! gcloud secrets describe "$secret_name" --project="$PROJECT_ID" &>/dev/null; then
        # Create new secret
        echo -n "$secret_value" | gcloud secrets create "$secret_name" \
            --data-file=- \
            --project="$PROJECT_ID" \
            --replication-policy="automatic" 2>/dev/null
        log_success "Created secret: $secret_name"
        return 0
    fi

    # Secret exists - check if value has changed
    local current_value
    current_value=$(gcloud secrets versions access latest \
        --secret="$secret_name" \
        --project="$PROJECT_ID" 2>/dev/null) || current_value=""

    if [[ "$current_value" == "$secret_value" ]]; then
        log_skip "Secret $secret_name unchanged"
        return 0
    fi

    # Value changed - add new version
    echo -n "$secret_value" | gcloud secrets versions add "$secret_name" \
        --data-file=- \
        --project="$PROJECT_ID" 2>/dev/null
    log_success "Updated secret: $secret_name (new version)"

    # Delete old versions (keep latest + previous)
    local versions
    versions=$(gcloud secrets versions list "$secret_name" \
        --project="$PROJECT_ID" \
        --filter="state:ENABLED" \
        --format="value(name)" \
        --sort-by="~createTime" 2>/dev/null | tail -n +$((keep_versions + 1)))  # Skip the first N

    if [[ -n "$versions" ]]; then
        local count=0
        while IFS= read -r version; do
            gcloud secrets versions destroy "$version" \
                --secret="$secret_name" \
                --project="$PROJECT_ID" \
                --quiet 2>/dev/null && ((count++)) || true
        done <<< "$versions"
        if [[ $count -gt 0 ]]; then
            log_info "Cleaned up $count old version(s) of $secret_name (keeping $keep_versions)"
        fi
    fi

    return 0
}

# Prompt for and manage a secret interactively
# Usage: prompt_and_manage_secret "SECRET_NAME" "Human readable name" "instructions"
prompt_and_manage_secret() {
    local secret_name="$1"
    local display_name="$2"
    local instructions="$3"

    # Check if secret already has a value
    if gcloud secrets versions access latest --secret="$secret_name" --project="$PROJECT_ID" &>/dev/null; then
        read -p "  $display_name already set. Update it? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_skip "$display_name"
            return 0
        fi
    fi

    echo "  $instructions"
    read -sp "  Enter $display_name (input hidden): " secret_value
    echo

    if [[ -z "$secret_value" ]]; then
        log_info "Skipped $display_name (no value provided)"
        return 0
    fi

    manage_secret "$secret_name" "$secret_value"
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
echo "  Whisper GPU:     $WHISPER_GPU_REGION (GPU quota region)"
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
    "cloudscheduler.googleapis.com"
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
    # AI/ML - Gemini & Vertex AI
    "generativelanguage.googleapis.com"
    "aiplatform.googleapis.com"  # Required for Vertex AI SDK (Gemini with billing labels)
    "apikeys.googleapis.com"
    # Speech-to-Text v2 (Chirp-3 diarization benchmark)
    "speech.googleapis.com"
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
    "roles/cloudscheduler.admin"  # Required for scheduled functions
    "roles/firebaserules.admin"
    "roles/firebase.admin"
    "roles/storage.admin"
    "roles/datastore.user"
    "roles/iam.serviceAccountUser"
    "roles/secretmanager.admin"
    "roles/serviceusage.serviceUsageConsumer"  # Required for Firebase to check/enable APIs during deploy
    "roles/speech.client"  # Chirp-3 BatchRecognize (PoC scripts use this SA via firebase-sa-key.json)
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
    log_info "Skipping runtime bindings (will be configured during deployment)"
else
    add_iam_binding "serviceAccount:$RUNTIME_SA" "roles/secretmanager.secretAccessor" "$RUNTIME_SA → Secret Accessor"
    add_iam_binding "serviceAccount:$RUNTIME_SA" "roles/aiplatform.user" "$RUNTIME_SA → Vertex AI User"
    add_iam_binding "serviceAccount:$RUNTIME_SA" "roles/speech.client" "$RUNTIME_SA → Speech-to-Text Client (Chirp-3)"
fi

# -----------------------------------------------------------------------------
# Step 8: Configure Service Agent IAM Bindings
# -----------------------------------------------------------------------------

log_step "Configuring Google-managed service agents..."

log_info "Note: Service agents are created when you first use each service."
log_info "Skipped bindings will be configured automatically on first deployment."

# Force-create service identities so bindings don't race first deploys
log_info "Ensuring service identities exist..."
ensure_service_identity "eventarc.googleapis.com" "Eventarc service identity"
ensure_service_identity "pubsub.googleapis.com" "Pub/Sub service identity"
ensure_service_identity "storage.googleapis.com" "Storage service identity"

# Eventarc service agent → Eventarc Service Agent role (required for triggers)
EVENTARC_SA="service-${PROJECT_NUMBER}@gcp-sa-eventarc.iam.gserviceaccount.com"
add_service_agent_binding "$EVENTARC_SA" "roles/eventarc.serviceAgent" "Eventarc Agent → Eventarc Service Agent"

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
# Step 10: Grant BigQuery Access for Billing Sync (Cross-Project)
# -----------------------------------------------------------------------------

log_step "BigQuery billing sync access (cross-project)..."

# The billingSync Cloud Function needs to read from BigQuery billing exports
# which are stored in a separate ops project (wachtel-ops).
# This requires cross-project IAM bindings on the ops project:
#   - roles/bigquery.dataViewer: Read billing export tables
#   - roles/bigquery.jobUser: Run queries (create BigQuery jobs)
#
# Cloud Functions v2 uses the Compute Engine default service account by default,
# so we grant permissions to both App Engine and Compute Engine service accounts.

BILLING_OPS_PROJECT="wachtel-ops"
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

log_info "Granting BigQuery access on $BILLING_OPS_PROJECT for billing sync..."
log_info "This allows Cloud Functions to read actual costs from billing exports."

BQ_ERRORS=""

# Grant to Compute Engine default SA (used by Cloud Functions v2)
for role in "roles/bigquery.dataViewer" "roles/bigquery.jobUser"; do
    log_info "Running: gcloud projects add-iam-policy-binding $BILLING_OPS_PROJECT --member=serviceAccount:$COMPUTE_SA --role=$role"
    if OUTPUT=$(gcloud projects add-iam-policy-binding "$BILLING_OPS_PROJECT" \
        --member="serviceAccount:$COMPUTE_SA" \
        --role="$role" 2>&1); then
        log_success "$COMPUTE_SA → $role on $BILLING_OPS_PROJECT"
    else
        log_error "$COMPUTE_SA → $role on $BILLING_OPS_PROJECT - FAILED"
        log_info "  Error: $OUTPUT"
        BQ_ERRORS="yes"
    fi
done

# Also grant to App Engine default SA (for completeness)
if sa_exists "$RUNTIME_SA"; then
    for role in "roles/bigquery.dataViewer" "roles/bigquery.jobUser"; do
        log_info "Running: gcloud projects add-iam-policy-binding $BILLING_OPS_PROJECT --member=serviceAccount:$RUNTIME_SA --role=$role"
        if OUTPUT=$(gcloud projects add-iam-policy-binding "$BILLING_OPS_PROJECT" \
            --member="serviceAccount:$RUNTIME_SA" \
            --role="$role" 2>&1); then
            log_success "$RUNTIME_SA → $role on $BILLING_OPS_PROJECT"
        else
            log_error "$RUNTIME_SA → $role on $BILLING_OPS_PROJECT - FAILED"
            log_info "  Error: $OUTPUT"
            BQ_ERRORS="yes"
        fi
    done
fi

# If any failed, show manual commands
if [[ -n "$BQ_ERRORS" ]]; then
    log_info ""
    log_info "To fix manually, run these commands (requires admin access to $BILLING_OPS_PROJECT):"
    log_info "  gcloud projects add-iam-policy-binding $BILLING_OPS_PROJECT \\"
    log_info "    --member=\"serviceAccount:$COMPUTE_SA\" \\"
    log_info "    --role=\"roles/bigquery.dataViewer\""
    log_info "  gcloud projects add-iam-policy-binding $BILLING_OPS_PROJECT \\"
    log_info "    --member=\"serviceAccount:$COMPUTE_SA\" \\"
    log_info "    --role=\"roles/bigquery.jobUser\""
fi

# -----------------------------------------------------------------------------
# Step 10c: Create Artifact Registry Repository for Whisper GPU Images
# -----------------------------------------------------------------------------

log_step "Artifact Registry repository for Whisper GPU images..."

WHISPER_AR_REPO="whisper-gpu"

log_info "Whisper GPU region: $WHISPER_GPU_REGION (override with WHISPER_GPU_REGION env var)"

if gcloud artifacts repositories describe "$WHISPER_AR_REPO" \
    --location="$WHISPER_GPU_REGION" \
    --project="$PROJECT_ID" &>/dev/null; then
    log_skip "Artifact Registry repo '$WHISPER_AR_REPO' already exists in $WHISPER_GPU_REGION"
else
    gcloud artifacts repositories create "$WHISPER_AR_REPO" \
        --repository-format=docker \
        --location="$WHISPER_GPU_REGION" \
        --description="WhisperX GPU transcription service images" \
        --project="$PROJECT_ID"
    log_success "Created Artifact Registry repo: $WHISPER_AR_REPO ($WHISPER_GPU_REGION)"
fi

# Grant the current gcloud user write access so local `docker push` works.
# Without this, only the Cloud Build SA can push — which doesn't help
# when you're building and pushing from your own machine.
CURRENT_USER=$(gcloud config get-value account 2>/dev/null)
if [ -n "$CURRENT_USER" ]; then
    add_iam_binding "user:$CURRENT_USER" "roles/artifactregistry.writer" "$CURRENT_USER → Artifact Registry Writer"
fi

# -----------------------------------------------------------------------------
# Step 10d: IAM Grants for Whisper Cloud Run GPU Service
# -----------------------------------------------------------------------------

log_step "IAM grants for Whisper Cloud Run GPU service..."

# Runtime SA needs roles/run.invoker so Cloud Functions can call the
# Whisper Cloud Run service and the transcription orchestrator with IAM auth
if sa_exists "$RUNTIME_SA"; then
    add_iam_binding "serviceAccount:$RUNTIME_SA" "roles/run.invoker" "$RUNTIME_SA → Cloud Run Invoker"
    # Token Creator lets the orchestrator generate signed URLs for Storage downloads.
    # The SDK's file.download() hangs on Cloud Run; signed URL + fetch is the workaround.
    add_iam_binding "serviceAccount:$RUNTIME_SA" "roles/iam.serviceAccountTokenCreator" "$RUNTIME_SA → Token Creator (signed URLs)"
else
    log_info "Cloud Run Invoker binding - skipped (runtime SA not yet created)"
fi

# Cloud Build SA needs permission to push images to Artifact Registry
# and deploy to Cloud Run with GPU. The default Cloud Build SA is
# PROJECT_NUMBER@cloudbuild.gserviceaccount.com
CLOUDBUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

add_service_agent_binding "$CLOUDBUILD_SA" "roles/artifactregistry.writer" "Cloud Build → Artifact Registry Writer"
add_service_agent_binding "$CLOUDBUILD_SA" "roles/run.admin" "Cloud Build → Cloud Run Admin"
add_service_agent_binding "$CLOUDBUILD_SA" "roles/iam.serviceAccountUser" "Cloud Build → Service Account User"
add_service_agent_binding "$CLOUDBUILD_SA" "roles/secretmanager.secretAccessor" "Cloud Build → Secret Manager (HF_TOKEN for model downloads)"

# -----------------------------------------------------------------------------
# Step 10e: HuggingFace Token for WhisperX Builds
# -----------------------------------------------------------------------------
# Pyannote diarization models are gated on HuggingFace and require a token
# during Docker build. Cloud Build reads this from Secret Manager via the
# cloudbuild.yaml availableSecrets config. Not needed at runtime (models
# are pre-cached in the image), only at build time.

log_step "HuggingFace token for WhisperX builds..."

HF_SECRET_NAME="HF_TOKEN"  # pragma: allowlist secret

if gcloud secrets describe "$HF_SECRET_NAME" --project="$PROJECT_ID" &>/dev/null; then
    log_skip "Secret '$HF_SECRET_NAME' already exists in Secret Manager"
else
    HF_TOKEN_VALUE="${HF_TOKEN:-}"
    if [[ -z "$HF_TOKEN_VALUE" ]]; then
        log_info "HF_TOKEN not set in environment."
        log_info "Get a token at: https://huggingface.co/settings/tokens"
        log_info "Accept the pyannote model licenses:"
        log_info "  https://huggingface.co/pyannote/speaker-diarization-3.1"
        log_info "  https://huggingface.co/pyannote/wespeaker-voxceleb-resnet34-LM"
        read -p "  Enter HuggingFace token (hf_...): " HF_TOKEN_VALUE </dev/tty
    fi

    if [[ -n "$HF_TOKEN_VALUE" ]]; then
        printf '%s' "$HF_TOKEN_VALUE" | gcloud secrets create "$HF_SECRET_NAME" \
            --data-file=- \
            --project="$PROJECT_ID" \
            --replication-policy="automatic"
        log_success "Created secret $HF_SECRET_NAME"
    else
        log_info "⚠️  Skipped HF_TOKEN — WhisperX builds will fail without it"
    fi
fi

# Grant GitHub Actions SA access to HF_TOKEN for Cloud Build runs.
# Cloud Build's availableSecrets requires the build's --service-account SA to have
# secret access, not just the default Cloud Build SA.
# Use fixed naming convention since GITHUB_SA_EMAIL isn't defined until Step 13.
GH_SA_FOR_SECRETS="github-actions@${PROJECT_ID}.iam.gserviceaccount.com"  # pragma: allowlist secret
if gcloud secrets describe "$HF_SECRET_NAME" --project="$PROJECT_ID" &>/dev/null && \
   gcloud iam service-accounts describe "$GH_SA_FOR_SECRETS" --project="$PROJECT_ID" &>/dev/null; then
    gcloud secrets add-iam-policy-binding "$HF_SECRET_NAME" \
        --project="$PROJECT_ID" \
        --member="serviceAccount:$GH_SA_FOR_SECRETS" \
        --role="roles/secretmanager.secretAccessor" \
        --quiet > /dev/null 2>&1 || true
    log_info "GitHub Actions SA → HF_TOKEN secret accessor"
fi

# -----------------------------------------------------------------------------
# Step 10f: Artifact Registry Repository for Orchestrator Images
# (used by Cloud Run service: transcription-orchestrator)
# -----------------------------------------------------------------------------

log_step "Artifact Registry repository for Orchestrator images (transcription-orchestrator)..."

ORCHESTRATOR_AR_REPO="orchestrator"

if gcloud artifacts repositories describe "$ORCHESTRATOR_AR_REPO" \
    --location="$REGION" \
    --project="$PROJECT_ID" &>/dev/null; then
    log_skip "Artifact Registry repo '$ORCHESTRATOR_AR_REPO' already exists in $REGION"
else
    gcloud artifacts repositories create "$ORCHESTRATOR_AR_REPO" \
        --repository-format=docker \
        --location="$REGION" \
        --description="Transcription orchestrator service images" \
        --project="$PROJECT_ID"
    log_success "Created Artifact Registry repo: $ORCHESTRATOR_AR_REPO ($REGION)"
fi

# Cloud Build SA needs AR write access to push orchestrator images.
# Reuse same CLOUDBUILD_SA already set in Step 10d.
add_service_agent_binding "$CLOUDBUILD_SA" "roles/artifactregistry.writer" "Cloud Build → Artifact Registry Writer (orchestrator)"

# -----------------------------------------------------------------------------
# Step 10g: Orchestrator Runtime Service Account
# -----------------------------------------------------------------------------

log_step "Orchestrator runtime service account..."

ORCHESTRATOR_RUNTIME_SA_NAME="orchestrator-runtime"
ORCHESTRATOR_RUNTIME_SA="orchestrator-runtime@${PROJECT_ID}.iam.gserviceaccount.com"

if gcloud iam service-accounts describe "$ORCHESTRATOR_RUNTIME_SA" --project="$PROJECT_ID" &>/dev/null; then
    log_skip "Orchestrator runtime service account exists"
else
    gcloud iam service-accounts create "$ORCHESTRATOR_RUNTIME_SA_NAME" \
        --project="$PROJECT_ID" \
        --display-name="Transcription Orchestrator Runtime"
    log_success "Created orchestrator runtime service account: $ORCHESTRATOR_RUNTIME_SA"
fi

# Runtime permissions: Firestore, Storage, WhisperX invocation, Gemini secret access
if sa_exists "$ORCHESTRATOR_RUNTIME_SA"; then
    add_iam_binding "serviceAccount:$ORCHESTRATOR_RUNTIME_SA" "roles/run.invoker" \
        "$ORCHESTRATOR_RUNTIME_SA → Cloud Run Invoker (WhisperX calls)"
    add_iam_binding "serviceAccount:$ORCHESTRATOR_RUNTIME_SA" "roles/secretmanager.secretAccessor" \
        "$ORCHESTRATOR_RUNTIME_SA → Secret Accessor (GEMINI_API_KEY, WHISPER_SERVICE_URL)"
    add_iam_binding "serviceAccount:$ORCHESTRATOR_RUNTIME_SA" "roles/datastore.user" \
        "$ORCHESTRATOR_RUNTIME_SA → Firestore User"
    add_iam_binding "serviceAccount:$ORCHESTRATOR_RUNTIME_SA" "roles/storage.objectAdmin" \
        "$ORCHESTRATOR_RUNTIME_SA → Storage Object Admin (audio downloads)"
    # Token Creator lets the orchestrator generate signed URLs for Storage downloads.
    # node-fetch v2 hangs on large Cloud Storage downloads; signed URL + curl is the fix.
    add_iam_binding "serviceAccount:$ORCHESTRATOR_RUNTIME_SA" "roles/iam.serviceAccountTokenCreator" \
        "$ORCHESTRATOR_RUNTIME_SA → Token Creator (signed URLs)"
else
    log_info "Orchestrator runtime SA permissions - skipped (SA not yet created, retry after SA propagates)"
fi

# -----------------------------------------------------------------------------
# Step 10h: ORCHESTRATOR_URL Secret + GitHub Actions Deploy Permissions
# -----------------------------------------------------------------------------

log_step "ORCHESTRATOR_URL secret and GitHub Actions deploy permissions..."

# Placeholder URL — the deploy workflow overwrites this on first successful deploy.
# An empty string would cause gcloud secrets create to fail, so we seed it with
# a recognizable placeholder that makes broken state obvious in logs.
manage_secret "ORCHESTRATOR_URL" ""

# GitHub Actions SA deploy permissions for the orchestrator.
# roles/run.admin + roles/iam.serviceAccountUser are the minimum to deploy a
# Cloud Run service with --service-account. roles/secretmanager.secretVersionManager
# lets the workflow update ORCHESTRATOR_URL after each deploy (same pattern as
# WHISPER_SERVICE_URL in the Whisper workflow).
GH_SA_ORCHESTRATOR="github-actions@${PROJECT_ID}.iam.gserviceaccount.com"  # pragma: allowlist secret

if gcloud iam service-accounts describe "$GH_SA_ORCHESTRATOR" --project="$PROJECT_ID" &>/dev/null; then
    add_iam_binding "serviceAccount:$GH_SA_ORCHESTRATOR" "roles/run.admin" \
        "GitHub Actions SA → Cloud Run Admin (orchestrator deploy)"
    add_iam_binding "serviceAccount:$GH_SA_ORCHESTRATOR" "roles/iam.serviceAccountUser" \
        "GitHub Actions SA → Service Account User (orchestrator runtime SA)"

    # Allow the deploy workflow to update ORCHESTRATOR_URL secret version.
    # secretVersionManager covers both add and destroy; secretVersionAdder is read-only add.
    # We want the compare-before-update pattern to work, so we need both add and access.
    if gcloud secrets describe "ORCHESTRATOR_URL" --project="$PROJECT_ID" &>/dev/null; then
        gcloud secrets add-iam-policy-binding "ORCHESTRATOR_URL" \
            --project="$PROJECT_ID" \
            --member="serviceAccount:$GH_SA_ORCHESTRATOR" \
            --role="roles/secretmanager.secretVersionManager" \
            --quiet > /dev/null 2>&1 || true
        log_success "GitHub Actions SA → ORCHESTRATOR_URL secret version manager"
        # secretAccessor is required for the compare-before-update step in the deploy workflow
        # (gcloud secrets versions access latest --secret=ORCHESTRATOR_URL). Without it the
        # read fails with permission denied even though secretVersionManager covers writes.
        gcloud secrets add-iam-policy-binding "ORCHESTRATOR_URL" \
            --project="$PROJECT_ID" \
            --member="serviceAccount:$GH_SA_ORCHESTRATOR" \
            --role="roles/secretmanager.secretAccessor" \
            --quiet > /dev/null 2>&1 || true
        log_success "GitHub Actions SA → ORCHESTRATOR_URL secret accessor (compare-before-update read)"
    fi
else
    log_info "GitHub Actions SA permissions for orchestrator - skipped (SA not yet created, run Step 13 first)"
fi

# -----------------------------------------------------------------------------
# Step 11: Initialize Firebase Storage and Configure Bucket Access
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
    # Firebase Storage bucket does not exist yet
    # Firebase Storage provisioning MUST be done via Firebase Console for new projects.
    # This is a Firebase platform limitation - there is no CLI or API to create the initial bucket.
    BUCKET=""
    echo ""
    echo "╔══════════════════════════════════════════════════════════════════════════════╗"
    echo "║  Firebase Storage requires one-time setup via Firebase Console               ║"
    echo "╚══════════════════════════════════════════════════════════════════════════════╝"
    echo ""
    echo "  Please complete these steps:"
    echo ""
    echo "  1. Open: https://console.firebase.google.com/project/$PROJECT_ID/storage"
    echo "  2. Click 'Get started'"
    echo "  3. Select 'Start in production mode'"
    echo "  4. Choose location: $STORAGE_REGION"
    echo "  5. Click 'Done'"
    echo ""
    read -p "  Press ENTER when you've completed the Firebase Storage setup... " </dev/tty
    echo ""

    # Re-check for bucket after user confirms setup
    log_info "Checking for Storage bucket..."
    if gsutil ls "$BUCKET_FIREBASE" &>/dev/null; then
        BUCKET="$BUCKET_FIREBASE"
        log_success "Storage bucket found: $BUCKET"
    elif gsutil ls "$BUCKET_APPSPOT" &>/dev/null; then
        BUCKET="$BUCKET_APPSPOT"
        log_success "Storage bucket found: $BUCKET"
    else
        log_error "Storage bucket still not found. Please verify setup completed successfully."
        log_info "You can re-run this script after confirming Storage is enabled in Firebase Console."
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
# Step 12: Configure Functions Artifact Cleanup Policy
# -----------------------------------------------------------------------------

log_step "Configuring Functions artifact cleanup policy..."

# Avoid Firebase deploy warnings and keep Artifact Registry tidy
if firebase --project "$PROJECT_ID" functions:artifacts:setpolicy \
    --location "$REGION" \
    --force > /dev/null 2>&1; then
    log_success "Functions artifact cleanup policy set for $REGION"
else
    log_info "Functions artifact cleanup policy - skipped (check Firebase auth/permissions)"
fi

# -----------------------------------------------------------------------------
# Step 13: Set Up Workload Identity Federation for Cloud Run (GitHub Actions)
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
        "roles/secretmanager.secretVersionManager"  # Deploy workflow updates WHISPER_SERVICE_URL after Cloud Run deploy
        "roles/iam.serviceAccountTokenCreator"      # Health check mints ID tokens via --impersonate-service-account
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
# Step 14: Create Service Account Key for Firebase Deployment
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
# Step 15: API Keys and Secrets
# -----------------------------------------------------------------------------
# Uses manage_secret() helper which:
#   - Creates secret if it doesn't exist
#   - Only adds new version if value changed
#   - Deletes old versions (keeps only latest)

log_step "Gemini API key and secret..."

# Check if we need to create/update the Gemini API key
GEMINI_KEY=""
API_KEY_NAME="gemini-api-key"  # pragma: allowlist secret

# Check if API key already exists in GCP
EXISTING_KEY=$(gcloud services api-keys list \
    --project="$PROJECT_ID" \
    --filter="displayName='$API_KEY_NAME'" \
    --format="value(name)" 2>/dev/null | head -1)

if [[ -n "$EXISTING_KEY" ]]; then
    GEMINI_KEY=$(gcloud services api-keys get-key-string "$EXISTING_KEY" \
        --format="value(keyString)" 2>/dev/null)
    log_info "Using existing Gemini API key"
else
    read -p "  Create Gemini API key now? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        log_info "Creating API key for Gemini..."
        KEY_RESULT=$(gcloud services api-keys create \
            --project="$PROJECT_ID" \
            --display-name="$API_KEY_NAME" \
            --api-target=service=generativelanguage.googleapis.com \
            --format=json 2>/dev/null)

        KEY_NAME=$(echo "$KEY_RESULT" | jq -r '.response.name // .name // empty')
        if [[ -n "$KEY_NAME" ]]; then
            GEMINI_KEY=$(gcloud services api-keys get-key-string "$KEY_NAME" \
                --format="value(keyString)" 2>/dev/null)
            log_success "Created Gemini API key"
        else
            GEMINI_KEY=$(echo "$KEY_RESULT" | jq -r '.response.keyString // .keyString // empty')
            if [[ -z "$GEMINI_KEY" ]]; then
                log_error "Failed to create API key. Create manually at:"
                log_info "https://console.cloud.google.com/apis/credentials?project=$PROJECT_ID"
            fi
        fi
    fi
fi

# Store in Secret Manager (idempotent - only updates if changed)
if [[ -n "$GEMINI_KEY" ]]; then
    manage_secret "GEMINI_API_KEY" "$GEMINI_KEY"
else
    log_info "Skipped GEMINI_API_KEY - create manually:"
    log_info "  npx firebase functions:secrets:set GEMINI_API_KEY"
fi

# -----------------------------------------------------------------------------
# Step 15b: Whisper Service URL (Cloud Run WhisperX)
# -----------------------------------------------------------------------------
# Diarization models (pyannote) are bundled in the Cloud Run container
# at runtime, but HF_TOKEN is needed at BUILD time to download gated models.
# See Step 10e above for HF_TOKEN setup.

log_step "Whisper Cloud Run service URL..."

WHISPER_SERVICE_NAME="whisperx-service"
WHISPER_SERVICE_URL=""

# Try to auto-detect the service URL from Cloud Run
WHISPER_SERVICE_URL=$(gcloud run services describe "$WHISPER_SERVICE_NAME" \
    --region="$WHISPER_GPU_REGION" \
    --project="$PROJECT_ID" \
    --format="value(status.url)" 2>/dev/null || echo "")

if [[ -n "$WHISPER_SERVICE_URL" ]]; then
    log_info "Auto-detected Whisper service: $WHISPER_SERVICE_URL"
    manage_secret "WHISPER_SERVICE_URL" "$WHISPER_SERVICE_URL"
else
    log_info "Whisper Cloud Run service not yet deployed in $WHISPER_GPU_REGION"
    log_info "Deploy the WhisperX container first, then rerun this script or set manually:"
    log_info "  npx firebase functions:secrets:set WHISPER_SERVICE_URL"
    prompt_and_manage_secret "WHISPER_SERVICE_URL" "Whisper Service URL" \
        "Cloud Run WhisperX service URL (e.g. https://whisperx-service-XXXXX.us-east4.run.app)"
fi

# -----------------------------------------------------------------------------
# Step 16: Enable Firebase Authentication
# -----------------------------------------------------------------------------

log_step "Firebase Authentication..."

log_info "Google Sign-In must be enabled manually:"
log_info "https://console.firebase.google.com/project/$PROJECT_ID/authentication/providers"
log_info "Enable Google provider and set support email"
log_info ""
log_info "After Google Sign-In is enabled, add these domains to Firebase Auth authorized domains:"
log_info "  • ${PROJECT_ID}.firebaseapp.com (Firebase adds it automatically)"
log_info "  • Cloud Run URL (obtain after deploying the frontend):"
log_info "      gcloud run services describe audio-transcript-app \\"
log_info "        --project=$PROJECT_ID --region=$REGION --format=\"value(status.url)\""
log_info "    Copy the host (e.g., audio-transcript-app‑xxxx-uc.a.run.app) and add it as an authorized domain."
log_info "  • Any custom domains you map to Cloud Run (e.g., ata.wachtel.us) once the domain mapping exists."
log_info "    Use Firebase Console → Authentication → Settings → Authorized domains → Add domain."
log_info ""

# -----------------------------------------------------------------------------
# Step 17: Register Web App
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
echo "    2. Add Firebase Auth authorized domains: ${PROJECT_ID}.firebaseapp.com, your Cloud Run URL, and any custom domains (e.g., ata.wachtel.us) once mapped."
echo "    3. Get web config:     firebase apps:sdkconfig WEB --project=$PROJECT_ID"
echo "    4. Update .env with Firebase config values (GCP_PROJECT_ID = $PROJECT_ID)"
echo "    5. Configure GitHub Secrets (see below)"
echo "    6. Deploy:             firebase deploy --project=$PROJECT_ID"
echo ""
echo "  ┌─────────────────────────────────────────────────────────────────────────┐"
echo "  │  Required GitHub Secrets for CI/CD (Single Project)                     │"
echo "  ├─────────────────────────────────────────────────────────────────────────┤"
echo "  │  Firebase Deploy Workflow (.github/workflows/firebase-deploy.yml):      │"
echo "  │    • FIREBASE_SERVICE_ACCOUNT     - Contents of $KEY_FILE               │"
echo "  │    • GEMINI_API_KEY               - From Secret Manager or AI Studio    │"
echo "  │    • WHISPER_SERVICE_URL          - Cloud Run WhisperX service URL      │"
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
