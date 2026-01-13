# Multi-stage Dockerfile for Audio Transcript Analysis App
# Stage 1: Build the React application
# Stage 2: Serve with nginx (lightweight production server)

# =============================================================================
# Stage 1: Build
# =============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build arguments (injected at build time)
# Firebase configuration
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_STORAGE_BUCKET
ARG VITE_FIREBASE_MESSAGING_SENDER_ID
ARG VITE_FIREBASE_APP_ID
# Other services
ARG VITE_ALIGNMENT_SERVICE_URL
# Build metadata (from git tags via GitHub Actions)
ARG APP_VERSION=dev
ARG BUILD_NUM=0

# Create .env file for Vite to read during build
# Vite automatically exposes VITE_* prefixed vars to the client
# IMPORTANT: All client-accessible vars MUST have VITE_ prefix
# APP_VERSION and BUILD_COMMIT are read by vite.config.ts (not VITE_ prefixed since they're build-time only)
RUN echo "VITE_FIREBASE_API_KEY=${VITE_FIREBASE_API_KEY}" > .env && \
    echo "VITE_FIREBASE_AUTH_DOMAIN=${VITE_FIREBASE_AUTH_DOMAIN}" >> .env && \
    echo "VITE_FIREBASE_PROJECT_ID=${VITE_FIREBASE_PROJECT_ID}" >> .env && \
    echo "VITE_FIREBASE_STORAGE_BUCKET=${VITE_FIREBASE_STORAGE_BUCKET}" >> .env && \
    echo "VITE_FIREBASE_MESSAGING_SENDER_ID=${VITE_FIREBASE_MESSAGING_SENDER_ID}" >> .env && \
    echo "VITE_FIREBASE_APP_ID=${VITE_FIREBASE_APP_ID}" >> .env && \
    echo "VITE_ALIGNMENT_SERVICE_URL=${VITE_ALIGNMENT_SERVICE_URL}" >> .env && \
    echo "APP_VERSION=${APP_VERSION}" >> .env && \
    echo "BUILD_NUM=${BUILD_NUM}" >> .env

# Build the application
RUN npm run build

# =============================================================================
# Stage 2: Production
# =============================================================================
FROM nginx:alpine AS production

# Copy custom nginx config for SPA routing
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Cloud Run uses port 8080 by default
EXPOSE 8080

# nginx runs as non-root by default in alpine image
CMD ["nginx", "-g", "daemon off;"]
