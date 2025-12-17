#!/bin/bash
# =============================================================================
# Local Deployment Script for Audio Transcript Analysis App
# Deploys to Google Cloud Run using gcloud CLI
# =============================================================================

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# -----------------------------------------------------------------------------
# Helper Functions
# -----------------------------------------------------------------------------
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# -----------------------------------------------------------------------------
# Configuration (set these in .env.local or export as environment variables)
# -----------------------------------------------------------------------------

# Try to load from .env.local first
if [ -f ".env.local" ]; then
    log_info "Loading environment from .env.local..."
    set -a  # automatically export all variables
    source .env.local
    set +a
fi

PROJECT_ID="${GCP_PROJECT_ID:-}"
REGION="${GCP_REGION:-us-west1}"
SERVICE_NAME="${GCP_SERVICE_NAME:-audio-transcript-app}"

# Validate required configuration
if [ -z "$PROJECT_ID" ]; then
    log_error "GCP_PROJECT_ID is not set. Set it in .env.local or export it."
    exit 1
fi

IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

# -----------------------------------------------------------------------------
# Pre-flight Checks
# -----------------------------------------------------------------------------
preflight_checks() {
    log_info "Running pre-flight checks..."

    # Check gcloud is installed
    if ! command -v gcloud &> /dev/null; then
        log_error "gcloud CLI is not installed. Install from: https://cloud.google.com/sdk/docs/install"
        exit 1
    fi

    # Check user is authenticated
    if ! gcloud auth print-identity-token &> /dev/null; then
        log_error "Not authenticated with gcloud. Run: gcloud auth login"
        exit 1
    fi

    # Check project is set
    CURRENT_PROJECT=$(gcloud config get-value project 2>/dev/null)
    if [ "$CURRENT_PROJECT" != "$PROJECT_ID" ]; then
        log_warning "Current project ($CURRENT_PROJECT) differs from target ($PROJECT_ID)"
        log_info "Setting project to $PROJECT_ID..."
        gcloud config set project "$PROJECT_ID"
    fi

    # Check for Gemini API key (should be loaded from .env.local or exported)
    # Support both GEMINI_API_KEY and VITE_GEMINI_API_KEY
    if [ -z "$VITE_GEMINI_API_KEY" ] && [ -n "$GEMINI_API_KEY" ]; then
        VITE_GEMINI_API_KEY="${GEMINI_API_KEY}"
        export VITE_GEMINI_API_KEY
    fi

    if [ -z "$VITE_GEMINI_API_KEY" ]; then
        log_error "GEMINI_API_KEY or VITE_GEMINI_API_KEY is not set. Set it in .env.local or export it."
        exit 1
    fi

    log_success "Pre-flight checks passed"
}

# -----------------------------------------------------------------------------
# Build Container Image
# -----------------------------------------------------------------------------
build_image() {
    log_info "Building container image..."
    log_info "Image: ${IMAGE_NAME}"

    # Build using Cloud Build (no local Docker required)
    gcloud builds submit \
        --tag "${IMAGE_NAME}" \
        --build-arg "VITE_GEMINI_API_KEY=${VITE_GEMINI_API_KEY}" \
        --quiet

    log_success "Container image built successfully"
}

# -----------------------------------------------------------------------------
# Deploy to Cloud Run
# -----------------------------------------------------------------------------
deploy_to_cloud_run() {
    log_info "Deploying to Cloud Run..."
    log_info "Service: ${SERVICE_NAME}"
    log_info "Region: ${REGION}"

    gcloud run deploy "${SERVICE_NAME}" \
        --image "${IMAGE_NAME}" \
        --platform managed \
        --region "${REGION}" \
        --allow-unauthenticated \
        --memory 256Mi \
        --cpu 1 \
        --min-instances 0 \
        --max-instances 10 \
        --port 8080 \
        --quiet

    log_success "Deployment complete!"
}

# -----------------------------------------------------------------------------
# Get Service URL
# -----------------------------------------------------------------------------
get_service_url() {
    SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
        --platform managed \
        --region "${REGION}" \
        --format "value(status.url)")

    echo ""
    log_success "🚀 Application deployed successfully!"
    echo ""
    echo -e "${GREEN}Service URL:${NC} ${SERVICE_URL}"
    echo ""
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
    echo ""
    echo "=============================================="
    echo "  Audio Transcript Analysis App - Deployment"
    echo "=============================================="
    echo ""

    preflight_checks
    build_image
    deploy_to_cloud_run
    get_service_url
}

# Run main function
main "$@"
