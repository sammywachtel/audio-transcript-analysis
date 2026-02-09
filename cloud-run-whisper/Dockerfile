# Cloud Run GPU Whisper Diarization Service
#
# Mirrors the Cog container environment: CUDA 12 + cuDNN 9, Python 3.10,
# Whisper Large v3 Turbo + pyannote 3.1. Models pre-cached at build time
# so the container never phones home to HuggingFace.
#
# Build:   docker build -t whisper-diarization .
# Run:     docker run --gpus all -p 8080:8080 whisper-diarization

FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

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

# Whisper Large v3 Turbo (CTranslate2 format)
RUN mkdir -p /models && \
    python3 -c "\
from huggingface_hub import snapshot_download; \
path = snapshot_download( \
    'deepdml/faster-whisper-large-v3-turbo-ct2', \
    local_dir='/models/faster-whisper-large-v3-turbo', \
    local_dir_use_symlinks=False, \
); \
print(f'Whisper cached to {path}')" && \
    ls -la /models/faster-whisper-large-v3-turbo/ && \
    test -f /models/faster-whisper-large-v3-turbo/model.bin

# pyannote diarization + speaker embedding models
# HF_TOKEN needed at build time to access gated models
ARG HF_TOKEN
RUN HF_HOME=/models HF_TOKEN=${HF_TOKEN} python3 -c "\
from pyannote.audio import Pipeline, Model; \
Pipeline.from_pretrained('pyannote/speaker-diarization-3.1', use_auth_token='${HF_TOKEN}'); \
Model.from_pretrained('pyannote/wespeaker-voxceleb-resnet34-LM', use_auth_token='${HF_TOKEN}'); \
print('Pyannote models cached')" && \
    echo "=== Model cache contents ===" && \
    ls -la /models/ && \
    du -sh /models/*

# -----------------------------------------------------------------------
# Application code
# -----------------------------------------------------------------------

COPY app.py predict.py ./

# Runtime env — offline mode so we never try to download at runtime
ENV HF_HOME=/models \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    PORT=8080

EXPOSE 8080

# Health check for Cloud Run readiness
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')" || exit 1

# Uvicorn with 1 worker — we want exactly one model instance per container
CMD ["python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
