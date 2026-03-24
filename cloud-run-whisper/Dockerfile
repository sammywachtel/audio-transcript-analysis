# Cloud Run GPU WhisperX Timestamps Service
#
# CUDA 12 + cuDNN 9, Python 3.10, faster-whisper (configurable model size).
# Timestamps-only mode uses just the Whisper ASR model; pyannote diarization
# models are still cached for full-diarization requests but lazy-loaded.
# Models pre-cached at build time so the container never phones home to HF.
#
# Build:   docker build -t whisperx-service .
# Build (medium model): docker build --build-arg WHISPER_MODEL=medium-v3-turbo -t whisperx-service .
# Run:     docker run --gpus all -p 8080:8080 whisperx-service

FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

# Which Whisper model to bake into the image. Override at build time:
#   docker build --build-arg WHISPER_MODEL=large-v3-turbo ...     (default)
#   docker build --build-arg WHISPER_MODEL=medium \
#                --build-arg WHISPER_HF_REPO=Systran/faster-whisper-medium ...
#
# WHISPER_HF_REPO controls the HuggingFace download path. The default pattern
# (deepdml/faster-whisper-{MODEL}-ct2) works for large-v3-turbo. Other model
# sizes live under different orgs — Systran publishes the standard CTranslate2
# conversions (medium, small, base, tiny).
ARG WHISPER_MODEL=large-v3-turbo
ARG WHISPER_HF_REPO=deepdml/faster-whisper-${WHISPER_MODEL}-ct2

# No interactive prompts during build
ENV DEBIAN_FRONTEND=noninteractive

# System deps — same as cog.yaml
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.10 \
    python3.10-dev \
    python3-pip \
    ffmpeg \
    libmagic1 \
    git \
    && rm -rf /var/lib/apt/lists/*

# Make python3.10 the default
RUN ln -sf /usr/bin/python3.10 /usr/bin/python3 && \
    ln -sf /usr/bin/python3.10 /usr/bin/python

WORKDIR /app

# Install Python deps first (better layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# -----------------------------------------------------------------------
# Pre-cache models at build time (~20GB, so grab a coffee)
# -----------------------------------------------------------------------

# Whisper model (CTranslate2 format) — repo controlled by WHISPER_HF_REPO build arg
RUN mkdir -p /models && \
    python3 -c "\
from huggingface_hub import snapshot_download; \
path = snapshot_download( \
    '${WHISPER_HF_REPO}', \
    local_dir='/models/faster-whisper-${WHISPER_MODEL}', \
    local_dir_use_symlinks=False, \
); \
print(f'Whisper cached to {path}')" && \
    ls -la /models/faster-whisper-${WHISPER_MODEL}/ && \
    test -f /models/faster-whisper-${WHISPER_MODEL}/model.bin

# pyannote diarization + speaker embedding models
# Token passed via BuildKit secret mount — never baked into image layers.
# Build with: docker build --secret id=hf_token,env=HF_TOKEN ...
#
# Skip with --build-arg CACHE_PYANNOTE=false for timestamps-only images.
# Saves ~3GB image size and avoids CUDA version issues at build time.
ARG CACHE_PYANNOTE=true
RUN --mount=type=secret,id=hf_token \
    if [ "$CACHE_PYANNOTE" = "true" ]; then \
    HF_HOME=/models \
    HF_TOKEN=$(cat /run/secrets/hf_token) \
    python3 -c "\
import os; token = os.environ['HF_TOKEN']; \
from pyannote.audio import Pipeline, Model; \
Pipeline.from_pretrained('pyannote/speaker-diarization-3.1', use_auth_token=token); \
Model.from_pretrained('pyannote/wespeaker-voxceleb-resnet34-LM', use_auth_token=token); \
print('Pyannote models cached')" && \
    echo "=== Model cache contents ===" && \
    ls -la /models/ && \
    du -sh /models/* ; \
    else \
    echo "Skipping pyannote cache (CACHE_PYANNOTE=false)" ; \
    fi

# -----------------------------------------------------------------------
# Application code
# -----------------------------------------------------------------------

COPY app.py predict.py ./

# Runtime env — offline mode so we never try to download at runtime.
# WHISPER_MODEL_PATH tells predict.py where the model lives; defaults to
# whatever we just downloaded. WHISPER_BEAM_SIZE is tunable at deploy time.
ENV HF_HOME=/models \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    WHISPER_MODEL_PATH=/models/faster-whisper-${WHISPER_MODEL} \
    WHISPER_BEAM_SIZE=5 \
    PORT=8080

EXPOSE 8080

# Health check for Cloud Run readiness
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')" || exit 1

# Uvicorn with 1 worker — we want exactly one model instance per container
CMD ["python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
