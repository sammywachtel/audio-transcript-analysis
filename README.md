# Audio Transcript Analysis App

Transform audio recordings into interactive, navigable transcripts with AI-powered analysis.

## Features

- **AI Transcription** - Powered by Google Gemini 2.5 Flash
- **Speaker Diarization** - Automatic speaker identification and labeling
- **Term Extraction** - Key terms highlighted with AI-generated definitions
- **Topic Segmentation** - Automatic topic/tangent detection
- **Person Detection** - Named entity recognition for people mentioned
- **Synchronized Playback** - Click any segment to jump to that point in audio
- **WhisperX Timestamp Alignment** - Precision timestamps via forced alignment (~50ms accuracy)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     React Frontend (Vite)                        │
│  - Upload audio files                                            │
│  - Interactive transcript viewer                                 │
│  - Synchronized audio playback                                   │
└─────────────────────────────────────────────────────────────────┘
          │                                    │
          │ 1. Transcribe                      │ 2. Align timestamps
          ▼                                    ▼
┌──────────────────────┐           ┌──────────────────────────────┐
│   Gemini 2.5 Flash   │           │   Alignment Service (FastAPI) │
│   - Text extraction  │           │   - WhisperX via Replicate    │
│   - Speakers         │           │   - Word-level timestamps     │
│   - Terms & topics   │           │   - Forced alignment (~50ms)  │
│   - People           │           │   - Fuzzy segment matching    │
└──────────────────────┘           └──────────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- Docker (for alignment service)
- API Keys:
  - [Gemini API Key](https://makersuite.google.com/app/apikey)
  - [Replicate API Token](https://replicate.com/account/api-tokens) (for timestamp alignment)

### Option 1: Run Locally with npm

```bash
# Install dependencies
npm install

# Copy environment template and add your API keys
cp .env.example .env.local
# Edit .env.local and add:
#   GEMINI_API_KEY=your_key
#   REPLICATE_API_TOKEN=your_token

# Start frontend (without alignment service)
npm run dev
```

Frontend runs at http://localhost:3000

### Option 2: Run Full Stack with Docker

```bash
# Copy environment template and add your API keys
cp .env.example .env.local
# Edit .env.local with your API keys

# Start both frontend and alignment service
docker compose up

# Or run in background
docker compose up -d
docker compose logs -f
```

- Frontend: http://localhost:3000
- Alignment Service: http://localhost:8080

### Option 3: Run Alignment Service Standalone

```bash
# Run only the alignment service (for frontend running via npm)
cd alignment-service
pip install -r requirements.txt
REPLICATE_API_TOKEN=your_token python main.py

# Service runs at http://localhost:8080
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Google Gemini API key for transcription |
| `REPLICATE_API_TOKEN` | For alignment | Replicate API token for WhisperX |
| `ALIGNMENT_SERVICE_URL` | No | Custom alignment service URL (default: localhost:8080) |

## Usage

1. **Upload Audio** - Drag & drop or click to select audio file
2. **Wait for Transcription** - Gemini processes audio (30s-2min depending on length)
3. **View Transcript** - Interactive viewer with speaker labels, timestamps, and highlights
4. **Improve Timestamps** - Click "Improve Timestamps" button for precision alignment
5. **Navigate** - Click any segment to jump to that point in audio
6. **Explore** - Use sidebar to browse terms, topics, and people mentioned

## Project Structure

```
├── alignment-service/         # WhisperX timestamp alignment backend
│   ├── main.py               # FastAPI endpoints
│   ├── aligner.py            # Replicate API + fuzzy matching
│   ├── Dockerfile            # Container config
│   └── requirements.txt      # Python dependencies
│
├── components/               # React components
│   ├── viewer/               # Transcript viewer components
│   └── Button.tsx            # Reusable button
│
├── contexts/                 # React contexts
│   └── ConversationContext.tsx
│
├── hooks/                    # Custom React hooks
│   ├── useAudioPlayer.ts     # Audio playback & sync
│   ├── usePersonMentions.ts  # Person name detection
│   └── useTranscriptSelection.ts
│
├── pages/                    # Page components
│   ├── Library.tsx           # Conversation list & upload
│   └── Viewer.tsx            # Main transcript viewer
│
├── services/                 # API clients
│   ├── alignmentService.ts   # WhisperX alignment client
│   ├── conversationStorage.ts # IndexedDB storage
│   └── transcriptionService.ts # Gemini API client
│
├── docs/                     # Documentation
│   ├── ARCHITECTURE.md       # Architecture overview
│   ├── TIMESTAMP_ALIGNMENT_ARCHITECTURE.md # Alignment system design
│   └── LOCAL_DEVELOPMENT.md  # Local dev guide
│
├── docker-compose.yml        # Full stack local development
├── Dockerfile.frontend       # Frontend container
└── .github/workflows/        # CI/CD pipelines
```

## Timestamp Alignment

Gemini produces excellent transcription content but timestamps can drift 8-10+ seconds on longer recordings. The alignment service fixes this using WhisperX forced alignment:

1. **Phase 1: Auto Drift Correction** - Client-side linear scaling (always active)
2. **Phase 2: WhisperX Alignment** - Word-level forced alignment via Replicate (~$0.02/10min)
3. **Phase 3: Manual Offset** - Fine-tune with +/- offset slider

See [docs/TIMESTAMP_ALIGNMENT_ARCHITECTURE.md](docs/TIMESTAMP_ALIGNMENT_ARCHITECTURE.md) for details.

## Deployment

### Cloud Run (Production)

```bash
# Deploy frontend
./deploy.sh

# Deploy alignment service
cd alignment-service
gcloud builds submit --tag gcr.io/$PROJECT_ID/alignment-service
gcloud run deploy alignment-service \
  --image gcr.io/$PROJECT_ID/alignment-service \
  --platform managed \
  --region us-west1 \
  --set-env-vars "REPLICATE_API_TOKEN=$REPLICATE_API_TOKEN"
```

See [docs/CLOUD_RUN_DEPLOYMENT.md](docs/CLOUD_RUN_DEPLOYMENT.md) for full deployment guide.

### GitHub Actions (CI/CD)

Push to `main` branch triggers parallel deployment of both services. See [docs/CICD_ALIGNMENT_SERVICE.md](docs/CICD_ALIGNMENT_SERVICE.md).

## Development

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS
- **Storage**: IndexedDB (client-side)
- **AI**: Google Gemini 2.5 Flash
- **Alignment**: WhisperX via Replicate API
- **Backend**: FastAPI (Python 3.11)
- **Infrastructure**: Google Cloud Run, GitHub Actions

## License

MIT
