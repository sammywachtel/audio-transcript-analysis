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
ARG VITE_GEMINI_API_KEY
ARG VITE_ALIGNMENT_SERVICE_URL

# Create .env file for Vite's loadEnv() to read
# vite.config.ts expects GEMINI_API_KEY (without VITE_ prefix)
RUN echo "GEMINI_API_KEY=${VITE_GEMINI_API_KEY}" > .env && \
    echo "ALIGNMENT_SERVICE_URL=${VITE_ALIGNMENT_SERVICE_URL}" >> .env

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
