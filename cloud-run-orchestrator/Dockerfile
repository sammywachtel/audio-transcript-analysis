# Cloud Run Orchestrator — Gemini Hybrid Pipeline
#
# Runs the full transcription pipeline (Gemini 3 Flash + WhisperX + HARDY)
# with a 900s timeout budget, well beyond what Cloud Functions allows.
#
# Build context must be the REPO ROOT so we can copy functions/src/ for
# the prebuild step. Run from repo root:
#   docker build -f cloud-run-orchestrator/Dockerfile -t orchestrator .
#
# Or with pre-built JS (CI):
#   docker build -f cloud-run-orchestrator/Dockerfile --target runtime -t orchestrator .

# ---------- build stage ----------
FROM node:20-slim AS build

WORKDIR /build

# Copy orchestrator source + package files
COPY cloud-run-orchestrator/package.json cloud-run-orchestrator/package-lock.json* ./
RUN npm ci

# Copy functions source (needed by prebuild copy script)
COPY functions/src/ /build/functions-src/

# Copy orchestrator source and scripts
COPY cloud-run-orchestrator/src/ ./src/
COPY cloud-run-orchestrator/scripts/ ./scripts/
COPY cloud-run-orchestrator/tsconfig.json ./

# Prebuild (generate version + copy functions modules) and compile
# Point the copy script at our /build/functions-src/ instead of ../functions/src/
RUN node scripts/generate-version.js \
    && mkdir -p src/_functions \
    && cp functions-src/gemini3Pipeline.ts functions-src/alignment.ts \
       functions-src/audioUtils.ts functions-src/speakerAssignment.ts \
       functions-src/logger.ts functions-src/types.ts \
       functions-src/firestoreUtils.ts \
       src/_functions/ \
    && npx tsc && npx tsc-alias

# ---------- runtime stage ----------
FROM node:20-slim AS runtime

# ca-certificates: TLS root certs — node:20-slim strips these, causing HTTPS
#   downloads to hang (node-fetch) or fail (curl error 77). This was the root
#   cause of every Storage download hang we've seen on Cloud Run.
# ffmpeg: audio chunking + WAV conversion
# curl: Storage downloads — bypasses Node's HTTP stack (node-fetch v2 has no
#   socket timeout and hangs indefinitely on large downloads)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY cloud-run-orchestrator/package.json cloud-run-orchestrator/package-lock.json* ./
RUN npm ci --omit=dev

# Copy compiled JS — fully self-contained, no sibling directory deps
COPY --from=build /build/lib/ ./lib/

ENV PORT=8080
EXPOSE 8080

CMD ["node", "lib/server.js"]
