#!/bin/bash
# =============================================================================
# Whisper GPU Service Deployment Script
#
# Builds and deploys the WhisperX transcription container to Cloud Run
# with GPU. The service handles audio transcription and (optionally) speaker
# diarization, called by Cloud Functions via IAM-authenticated HTTPS.
#
# Usage:
#   ./scripts/deploy-whisper.sh                # Build, push, and deploy (L4, large-v3-turbo, beam 5)
#   ./scripts/deploy-whisper.sh --build-only   # Build and push only (no deploy)
#   ./scripts/deploy-whisper.sh --deploy-only  # Deploy existing image (no deploy)
#   ./scripts/deploy-whisper.sh --no-cache     # Build without Docker cache
#   ./scripts/deploy-whisper.sh --cloud-build  # Build via Cloud Build (no local Docker needed)
#   ./scripts/deploy-whisper.sh --gpu-type nvidia-rtx-pro-6000  # RTX Pro 6000 (only other option on Cloud Run)
#   ./scripts/deploy-whisper.sh --model-size medium              # Smaller model (spoiler: it's slower)
#   ./scripts/deploy-whisper.sh --beam-size 2                # Faster decoding
#   ./scripts/deploy-whisper.sh --eval t4-test               # Isolated eval service (no prod impact)
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

# Tunable knobs for GPU/model/beam cost evaluation.
# Override via env var or CLI flags (--gpu-type, --model-size, --beam-size).
WHISPER_GPU_TYPE="${WHISPER_GPU_TYPE:-nvidia-l4}"
WHISPER_MODEL_SIZE="${WHISPER_MODEL_SIZE:-large-v3-turbo}"
WHISPER_BEAM_SIZE="${WHISPER_BEAM_SIZE:-5}"

# HuggingFace repo for the Whisper model. The default pattern works for the
# large-v3-turbo model from deepdml. Other sizes use different orgs — e.g.,
# Systran publishes standard CTranslate2 conversions (medium, small, etc.).
# Override with --hf-repo or WHISPER_HF_REPO env var.
WHISPER_HF_REPO="${WHISPER_HF_REPO:-deepdml/faster-whisper-${WHISPER_MODEL_SIZE}-ct2}"

# Eval mode — when set, deploys an isolated service that won't touch production.
EVAL_TAG=""

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
USE_CLOUD_BUILD=false
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
        --cloud-build)
            USE_CLOUD_BUILD=true
            shift
            ;;
        --tag)
            IMAGE_TAG="$2"
            IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/whisperx:${IMAGE_TAG}"
            shift 2
            ;;
        --gpu-type)
            WHISPER_GPU_TYPE="$2"
            shift 2
            ;;
        --model-size)
            WHISPER_MODEL_SIZE="$2"
            # Update HF repo default when model changes (can still be overridden by --hf-repo)
            WHISPER_HF_REPO="${WHISPER_HF_REPO_EXPLICIT:-deepdml/faster-whisper-${WHISPER_MODEL_SIZE}-ct2}"
            shift 2
            ;;
        --hf-repo)
            WHISPER_HF_REPO="$2"
            WHISPER_HF_REPO_EXPLICIT="$2"
            shift 2
            ;;
        --beam-size)
            WHISPER_BEAM_SIZE="$2"
            shift 2
            ;;
        --eval)
            EVAL_TAG="$2"
            shift 2
            ;;
        --help)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --build-only        Build and push image only (skip deploy)"
            echo "  --deploy-only       Deploy existing image only (skip build)"
            echo "  --no-cache          Build without Docker layer cache"
            echo "  --cloud-build       Build via Cloud Build instead of local Docker"
            echo "  --tag TAG           Image tag (default: latest)"
            echo "  --gpu-type TYPE     GPU type for Cloud Run (default: nvidia-l4)"
            echo "  --model-size SIZE   Whisper model (default: large-v3-turbo)"
            echo "  --hf-repo REPO      HuggingFace repo for model (auto-detected from model-size)"
            echo "  --beam-size N       Beam size for decoding (default: 5)"
            echo "  --eval TAG          Deploy as isolated eval service (e.g., --eval t4-test)"
            echo "  --help              Show this help message"
            echo ""
            echo "Environment variables (set in .env or export):"
            echo "  GCP_PROJECT_ID         GCP project ID (required)"
            echo "  WHISPER_REGION         Cloud Run region (default: us-east4)"
            echo "  WHISPER_SERVICE_NAME   Service name (default: whisperx-service)"
            echo "  WHISPER_AR_REPO        Artifact Registry repo (default: whisper-gpu)"
            echo "  WHISPER_IMAGE_TAG      Image tag (default: latest)"
            echo "  WHISPER_GPU_TYPE       GPU type (default: nvidia-l4)"
            echo "  WHISPER_MODEL_SIZE     Whisper model size (default: large-v3-turbo)"
            echo "  WHISPER_BEAM_SIZE      Beam size (default: 5)"
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

# --- Eval mode adjustments ---
# When --eval is used, we deploy a separate service that can't accidentally
# stomp on production. Think of it as a parallel universe for GPU experiments.
if [ -n "$EVAL_TAG" ]; then
    SERVICE_NAME="${SERVICE_NAME}-eval-${EVAL_TAG}"
    log_info "Eval mode: deploying as isolated service '${SERVICE_NAME}'"
fi

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Whisper GPU Service Deployment${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Project:    $PROJECT_ID"
echo "  Region:     $REGION"
echo "  Service:    $SERVICE_NAME"
echo "  Image:      $IMAGE"
echo "  GPU:        $WHISPER_GPU_TYPE"
echo "  Model:      $WHISPER_MODEL_SIZE ($WHISPER_HF_REPO)"
echo "  Beam size:  $WHISPER_BEAM_SIZE"
echo "  Build:      $DO_BUILD"
echo "  Deploy:     $DO_DEPLOY"
if [ -n "$EVAL_TAG" ]; then
echo "  Eval tag:   $EVAL_TAG (isolated — production untouched)"
fi
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
    if [ "$USE_CLOUD_BUILD" = true ]; then
        log_info "Cloud Build mode — skipping local Docker checks"
        log_info "HF_TOKEN will be read from GCP Secret Manager during build"
    else
        if ! command -v docker &> /dev/null; then
            log_error "Docker not found. Install Docker or use --cloud-build flag."
            exit 1
        fi

        if ! docker info &> /dev/null; then
            log_error "Docker daemon not running. Start Docker or use --cloud-build flag."
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
    if [ "$USE_CLOUD_BUILD" = true ]; then
        # Cloud Build path — no local Docker needed. The cloudbuild.yaml handles
        # BuildKit secret mounts and pulls HF_TOKEN from Secret Manager.
        # Must use --service-account so the build runs as a SA with secret access.
        log_info "Submitting build to Cloud Build..."
        log_warning "This takes 20-40 minutes — Cloud Build downloads and caches ~20GB of models."

        IMAGE_NAME="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/whisperx"
        BUILD_SA="github-actions@${PROJECT_ID}.iam.gserviceaccount.com"

        gcloud builds submit \
            --config="${REPO_ROOT}/cloud-run-whisper/cloudbuild.yaml" \
            --substitutions="_IMAGE_NAME=${IMAGE_NAME},_TAG=${IMAGE_TAG},_WHISPER_MODEL=${WHISPER_MODEL_SIZE},_WHISPER_HF_REPO=${WHISPER_HF_REPO}" \
            --service-account="projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA}" \
            --project="$PROJECT_ID" \
            --quiet \
            "$BUILD_CONTEXT"

        log_success "Image built and pushed via Cloud Build: $IMAGE"
    else
        # Local Docker path — requires Docker daemon and HF_TOKEN env var
        log_info "Configuring Docker for Artifact Registry..."
        gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

        log_info "Building image from $BUILD_CONTEXT (model: $WHISPER_MODEL_SIZE)..."
        log_warning "This may take a while — the Whisper image is ~20GB with cached models."
        DOCKER_BUILDKIT=1 docker build --platform linux/amd64 \
            --secret id=hf_token,env=HF_TOKEN \
            --build-arg WHISPER_MODEL="$WHISPER_MODEL_SIZE" \
            --build-arg WHISPER_HF_REPO="$WHISPER_HF_REPO" \
            $DOCKER_EXTRA_ARGS -t "$IMAGE" "$BUILD_CONTEXT"
        log_success "Image built: $IMAGE"

        log_info "Pushing image to Artifact Registry..."
        docker push "$IMAGE"
        log_success "Image pushed: $IMAGE"
    fi
fi

# -----------------------------------------------------------------------------
# Deploy to Cloud Run
# -----------------------------------------------------------------------------

if [ "$DO_DEPLOY" = true ]; then
    log_info "Deploying to Cloud Run with GPU..."

    # 16Gi host RAM is plenty — the model only uses ~2.5GB VRAM in timestamps-only
    # mode. L4 has 24GB VRAM but we're nowhere near that limit.
    gcloud run deploy "$SERVICE_NAME" \
        --project="$PROJECT_ID" \
        --region="$REGION" \
        --image="$IMAGE" \
        --gpu=1 \
        --gpu-type="$WHISPER_GPU_TYPE" \
        --no-gpu-zonal-redundancy \
        --memory=16Gi \
        --timeout=300 \
        --concurrency=1 \
        --min-instances=0 \
        --max-instances=3 \
        --no-allow-unauthenticated \
        --set-env-vars="WHISPER_BEAM_SIZE=$WHISPER_BEAM_SIZE" \
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
