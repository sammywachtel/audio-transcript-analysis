# Alignment Service Dockerfile
# Thin Python service that orchestrates WhisperX via Replicate API
# No GPU needed - the heavy lifting happens on Replicate's infrastructure

FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY main.py .
COPY aligner.py .

# Cloud Run sets PORT env var
ENV PORT=8080

# Health check for Cloud Run
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import httpx; httpx.get('http://localhost:8080/health')" || exit 1

# Run with uvicorn
CMD ["python", "main.py"]
