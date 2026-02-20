#!/bin/bash
# =============================================================================
# Whisper GPU Service Deployment Script
#
# Builds and deploys the WhisperX transcription container to Cloud Run
# with NVIDIA L4 GPU. The service handles audio transcription and speaker
# diarization, called by Cloud Functions via IAM-authenticated HTTPS.
#
# Usage:
#   ./scripts/deploy-whisper.sh                # Build, push, and deploy
#   ./scripts/deploy-whisper.sh --build-only   # Build and push only (no deploy)
#   ./scripts/deploy-whisper.sh --deploy-only  # Deploy existing image (no build)
#   ./scripts/deploy-whisper.sh --no-cache     # Build without Docker cache
#
# Prerequisites:
#   - Docker installed and running
#   - gcloud CLI authenticated
#   - Artifact Registry repo created (run gcp-setup.sh first)
#
# =============================================================================

set -euo pipefail

# Colors (disabled in CI or non-interactive)
if [ -t 1 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    NC='\033[0m'
else
    RED=''
    GREEN=''
    YELLOW=''
    BLUE=''
    NC=''
fi

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

# Load from .env if present
if [ -f ".env" ]; then
    set -a
    source .env
    set +a
fi

PROJECT_ID="${GCP_PROJECT_ID:-}"
REGION="${WHISPER_REGION:-us-east4}"
SERVICE_NAME="${WHISPER_SERVICE_NAME:-whisperx-service}"
AR_REPO="${WHISPER_AR_REPO:-whisper-gpu}"
IMAGE_TAG="${WHISPER_IMAGE_TAG:-latest}"

# HuggingFace token — needed at build time for gated pyannote models.
# Accepts either name so you don't have to remember which one you set.
HF_TOKEN="${HF_TOKEN:-${HUGGINGFACE_ACCESS_TOKEN:-}}"

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/whisperx:${IMAGE_TAG}"

# Script directory (for finding cloud-run-whisper/ relative to repo root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_CONTEXT="${REPO_ROOT}/cloud-run-whisper"

# -----------------------------------------------------------------------------
# Parse Arguments
# -----------------------------------------------------------------------------

DO_BUILD=true
DO_DEPLOY=true
DOCKER_EXTRA_ARGS=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --build-only)
            DO_DEPLOY=false
            shift
            ;;
        --deploy-only)
            DO_BUILD=false
            shift
            ;;
        --no-cache)
            DOCKER_EXTRA_ARGS="--no-cache"
            shift
            ;;
        --tag)
            IMAGE_TAG="$2"
            IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/whisperx:${IMAGE_TAG}"
            shift 2
            ;;
        --help)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --build-only   Build and push image only (skip deploy)"
            echo "  --deploy-only  Deploy existing image only (skip build)"
            echo "  --no-cache     Build without Docker layer cache"
            echo "  --tag TAG      Image tag (default: latest)"
            echo "  --help         Show this help message"
            echo ""
            echo "Environment variables (set in .env or export):"
            echo "  GCP_PROJECT_ID         GCP project ID (required)"
            echo "  WHISPER_REGION         Cloud Run region (default: us-east4)"
            echo "  WHISPER_SERVICE_NAME   Service name (default: whisperx-service)"
            echo "  WHISPER_AR_REPO        Artifact Registry repo (default: whisper-gpu)"
            echo "  WHISPER_IMAGE_TAG      Image tag (default: latest)"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1 (use --help for usage)"
            exit 1
            ;;
    esac
done

# -----------------------------------------------------------------------------
# Validation
# -----------------------------------------------------------------------------

if [ -z "$PROJECT_ID" ]; then
    log_error "GCP_PROJECT_ID is not set. Set it in .env or export it."
    exit 1
fi

if [ "$DO_BUILD" = true ] && [ ! -d "$BUILD_CONTEXT" ]; then
    log_error "Build context not found: $BUILD_CONTEXT"
    log_error "Expected cloud-run-whisper/ directory at repo root."
    exit 1
fi

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Whisper GPU Service Deployment${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Project:  $PROJECT_ID"
echo "  Region:   $REGION"
echo "  Service:  $SERVICE_NAME"
echo "  Image:    $IMAGE"
echo "  Build:    $DO_BUILD"
echo "  Deploy:   $DO_DEPLOY"
echo ""

# -----------------------------------------------------------------------------
# Preflight Checks
# -----------------------------------------------------------------------------

log_info "Running preflight checks..."

if ! command -v gcloud &> /dev/null; then
    log_error "gcloud CLI not found. Install: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

if ! gcloud auth print-identity-token &> /dev/null; then
    log_error "Not authenticated. Run: gcloud auth login"
    exit 1
fi

if [ "$DO_BUILD" = true ]; then
    if ! command -v docker &> /dev/null; then
        log_error "Docker not found. Install: https://docs.docker.com/get-docker/"
        exit 1
    fi

    if ! docker info &> /dev/null; then
        log_error "Docker daemon not running. Start Docker and try again."
        exit 1
    fi

    if [ -z "$HF_TOKEN" ]; then
        log_error "HF_TOKEN is required for building (pyannote models are gated)."
        log_error "Set HF_TOKEN in .env or export it:"
        log_error "  export HF_TOKEN=hf_..."
        log_error "Get a token at: https://huggingface.co/settings/tokens"
        exit 1
    fi
fi

# Verify Artifact Registry repo exists
if ! gcloud artifacts repositories describe "$AR_REPO" \
    --location="$REGION" \
    --project="$PROJECT_ID" &>/dev/null; then
    log_error "Artifact Registry repo '$AR_REPO' not found in $REGION."
    log_error "Run ./scripts/gcp-setup.sh to create it."
    exit 1
fi

log_success "Preflight checks passed"

# -----------------------------------------------------------------------------
# Build and Push
# -----------------------------------------------------------------------------

if [ "$DO_BUILD" = true ]; then
    log_info "Configuring Docker for Artifact Registry..."
    gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

    log_info "Building image from $BUILD_CONTEXT..."
    log_warning "This may take a while — the Whisper image is ~20GB with cached models."
    DOCKER_BUILDKIT=1 docker build --platform linux/amd64 \
        --secret id=hf_token,env=HF_TOKEN \
        $DOCKER_EXTRA_ARGS -t "$IMAGE" "$BUILD_CONTEXT"
    log_success "Image built: $IMAGE"

    log_info "Pushing image to Artifact Registry..."
    docker push "$IMAGE"
    log_success "Image pushed: $IMAGE"
fi

# -----------------------------------------------------------------------------
# Deploy to Cloud Run
# -----------------------------------------------------------------------------

if [ "$DO_DEPLOY" = true ]; then
    log_info "Deploying to Cloud Run with GPU..."

    gcloud run deploy "$SERVICE_NAME" \
        --project="$PROJECT_ID" \
        --region="$REGION" \
        --image="$IMAGE" \
        --gpu=1 \
        --gpu-type=nvidia-l4 \
        --no-gpu-zonal-redundancy \
        --memory=16Gi \
        --timeout=300 \
        --concurrency=1 \
        --min-instances=0 \
        --max-instances=3 \
        --no-allow-unauthenticated \
        --quiet

    log_success "Deployed $SERVICE_NAME to Cloud Run"

    # -------------------------------------------------------------------------
    # Store service URL in Secret Manager
    # -------------------------------------------------------------------------
    # Cloud Functions reference this via defineSecret('WHISPER_SERVICE_URL').
    # If the secret doesn't exist, `firebase deploy` prompts interactively —
    # which breaks CI/CD. So we store it automatically after every deploy.

    SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
        --project="$PROJECT_ID" \
        --region="$REGION" \
        --format="value(status.url)")

    SECRET_NAME="WHISPER_SERVICE_URL"  # pragma: allowlist secret

    # Check current value — only update if it actually changed
    CURRENT_SECRET=$(gcloud secrets versions access latest \
        --secret="$SECRET_NAME" \
        --project="$PROJECT_ID" 2>/dev/null) || CURRENT_SECRET=""

    if [ "$CURRENT_SECRET" = "$SERVICE_URL" ]; then
        log_success "Secret $SECRET_NAME already up to date"
    elif [ -z "$CURRENT_SECRET" ] && ! gcloud secrets describe "$SECRET_NAME" \
            --project="$PROJECT_ID" &>/dev/null; then
        # Secret doesn't exist yet — create it
        echo -n "$SERVICE_URL" | gcloud secrets create "$SECRET_NAME" \
            --data-file=- \
            --project="$PROJECT_ID" \
            --replication-policy="automatic"
        log_success "Created secret $SECRET_NAME"
    else
        # Secret exists but value changed (or first version)
        echo -n "$SERVICE_URL" | gcloud secrets versions add "$SECRET_NAME" \
            --data-file=- \
            --project="$PROJECT_ID"
        log_success "Updated secret $SECRET_NAME"
    fi

    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}  Deployment Complete${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo "  Service URL: $SERVICE_URL"
    echo "  Secret:      $SECRET_NAME (stored in Secret Manager)"
    echo ""
    echo "  Health check:"
    echo "    TOKEN=\$(gcloud auth print-identity-token)"
    echo "    curl -H \"Authorization: Bearer \$TOKEN\" ${SERVICE_URL}/health"
    echo ""
fi
