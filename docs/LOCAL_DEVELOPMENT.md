# Local Development Guide

This guide covers running the Audio Transcript Analysis App locally for development.

## Prerequisites

- **Node.js 18+** - Frontend runtime
- **Docker** - For running the alignment service
- **Python 3.11+** - Optional, for running alignment service without Docker

## API Keys Required

| Key | Where to Get | Used For |
|-----|--------------|----------|
| `GEMINI_API_KEY` | [Google AI Studio](https://makersuite.google.com/app/apikey) | Transcription, speaker detection, term extraction |
| `REPLICATE_API_TOKEN` | [Replicate](https://replicate.com/account/api-tokens) | WhisperX timestamp alignment |

## Quick Start

### 1. Setup Environment

```bash
# Clone and install
git clone <repo-url>
cd audio-transcript-analysis-app
npm install

# Setup environment variables
cp .env.example .env.local
```

Edit `.env.local`:
```
GEMINI_API_KEY=your_gemini_key_here
REPLICATE_API_TOKEN=your_replicate_token_here
ALIGNMENT_SERVICE_URL=
```

### 2. Choose Your Setup

#### Option A: Full Stack with Docker (Recommended)

Runs both frontend and alignment service with one command:

```bash
docker compose up
```

- **Frontend**: http://localhost:3000 (hot-reload enabled)
- **Alignment Service**: http://localhost:8080

```bash
# Useful commands
docker compose up -d          # Run in background
docker compose logs -f        # Follow logs
docker compose down           # Stop all services
docker compose build --no-cache  # Rebuild images
```

#### Option B: Frontend Only (npm)

For quick frontend development without alignment:

```bash
npm run dev
```

Frontend runs at http://localhost:3000. The "Improve Timestamps" button will be hidden without the alignment service.

#### Option C: Frontend (npm) + Alignment Service (Docker)

Best of both worlds - fast frontend iteration with alignment available:

```bash
# Terminal 1: Start alignment service
docker compose up alignment-service

# Terminal 2: Start frontend with hot-reload
npm run dev
```

#### Option D: Frontend (npm) + Alignment Service (Python)

Run everything natively without Docker:

```bash
# Terminal 1: Start alignment service
cd alignment-service
pip install -r requirements.txt
REPLICATE_API_TOKEN=your_token python main.py

# Terminal 2: Start frontend
npm run dev
```

## Service Details

### Frontend (React + Vite)

| Property | Value |
|----------|-------|
| Port | 3000 |
| Hot Reload | Yes |
| Source | `./` (root directory) |
| Entry | `src/main.tsx` |

**Key Environment Variables:**
- `VITE_GEMINI_API_KEY` - Gemini API for transcription
- `VITE_ALIGNMENT_SERVICE_URL` - Alignment service URL (default: http://localhost:8080)

### Alignment Service (FastAPI)

| Property | Value |
|----------|-------|
| Port | 8080 |
| Hot Reload | No (restart container to update) |
| Source | `./alignment-service/` |
| Entry | `main.py` |

**Endpoints:**
- `GET /health` - Health check
- `POST /align` - Align timestamps for a transcript

**Environment Variables:**
- `REPLICATE_API_TOKEN` - Required for WhisperX API calls
- `PORT` - Server port (default: 8080)

## Testing the Alignment Service

```bash
# Health check
curl http://localhost:8080/health

# Expected response:
# {"status":"ok","replicate_configured":true}
```

To test alignment, use the "Improve Timestamps" button in the UI after uploading an audio file.

## Troubleshooting

### "Improve Timestamps" button not showing

1. Check alignment service is running: `curl http://localhost:8080/health`
2. Check `ALIGNMENT_SERVICE_URL` in `.env.local` (leave empty for localhost:8080)
3. Check browser console for CORS errors

### Alignment service fails with 401

Your `REPLICATE_API_TOKEN` is missing or invalid:
1. Get token from https://replicate.com/account/api-tokens
2. Add to `.env.local`: `REPLICATE_API_TOKEN=your_token`
3. Restart the alignment service

### Docker build fails

```bash
# Clean rebuild
docker compose down
docker compose build --no-cache
docker compose up
```

### Port already in use

Change ports in `docker-compose.yml` or stop conflicting services:
```bash
# Find what's using port 3000
lsof -i :3000

# Or change ports in docker-compose.yml
```

### Hot reload not working in Docker

The frontend volume mount should enable hot reload. If not:
1. Check volume mounts in `docker-compose.yml`
2. Try: `docker compose down && docker compose up --build`

## Development Workflow

### Making Frontend Changes

1. Edit files in `components/`, `pages/`, `hooks/`, etc.
2. Changes hot-reload automatically
3. Check browser console for errors

### Making Alignment Service Changes

1. Edit files in `alignment-service/`
2. Restart the service:
   - Docker: `docker compose restart alignment-service`
   - Python: Ctrl+C and re-run `python main.py`

### Adding New Dependencies

**Frontend (npm):**
```bash
npm install <package>
# If using Docker, rebuild:
docker compose build frontend
```

**Alignment Service (pip):**
```bash
cd alignment-service
pip install <package>
pip freeze > requirements.txt
# Rebuild Docker:
docker compose build alignment-service
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser (localhost:3000)                  │
└─────────────────────────────────────────────────────────────┘
                    │                    │
         1. Upload  │                    │ 4. Align
            Audio   │                    │    Timestamps
                    ▼                    ▼
┌─────────────────────────┐   ┌─────────────────────────────┐
│     Gemini API          │   │  Alignment Service (:8080)  │
│  (makersuite.google.com)│   │  └─▶ Replicate API          │
│                         │   │      └─▶ WhisperX Model     │
└─────────────────────────┘   └─────────────────────────────┘
         │                                │
         │ 2. Transcript                  │ 5. Aligned
         │    (text, speakers,            │    Segments
         │     terms, topics)             │
         ▼                                ▼
┌─────────────────────────────────────────────────────────────┐
│                      IndexedDB (Browser)                     │
│                    (conversations, audio blobs)              │
└─────────────────────────────────────────────────────────────┘
```

## File Locations

| What | Where |
|------|-------|
| Frontend source | `./components/`, `./pages/`, `./hooks/`, `./services/` |
| Alignment service | `./alignment-service/` |
| Environment config | `.env.local` |
| Docker config | `docker-compose.yml`, `Dockerfile.frontend` |
| Documentation | `./docs/` |
