# Audio Transcript Analysis App

Transform audio recordings into interactive, navigable transcripts with AI-powered analysis.

**Status:** Beta (v1.3.0-beta)

## Features

- **AI Transcription** - Powered by Google Gemini 3 Flash (no-text diarization prompt)
- **Speaker Diarization** - Gemini 3 Flash full-audio analysis (6/6 speakers by name)
- **Gemini Speaker Corrections** - AI-detected mid-segment speaker changes
- **Manual Speaker Reassignment** - Click any segment to change speaker attribution
- **Precision Timestamps** - WhisperX forced alignment (~50ms accuracy)
- **Term Extraction** - Key terms highlighted with AI-generated definitions
- **Topic Segmentation** - Automatic topic/tangent detection
- **Person Detection** - Named entity recognition for people mentioned
- **Synchronized Playback** - Click any segment to jump to that point in audio
- **Real-time Updates** - Live UI updates via Firestore listeners
- **Admin Dashboard** - Observability metrics for processing jobs (admin-only)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     React Frontend (Vite)                        │
│  - Upload audio files                                            │
│  - Interactive transcript viewer                                 │
│  - Synchronized audio playback                                   │
│  - Manual speaker reassignment                                   │
└─────────────────────────────────────────────────────────────────┘
          │                                    │
          │ Firebase SDK                       │ Real-time listeners
          ▼                                    ▼
┌──────────────────────────────────────────────────────────────────┐
│                        Firebase                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐    │
│  │  Firebase    │  │  Firestore   │  │  Firebase Storage    │    │
│  │  Auth        │  │  Database    │  │  (Audio Files)       │    │
│  └──────────────┘  └──────────────┘  └──────────────────────┘    │
│                                              │                    │
│                                              │ onObjectFinalized  │
│                                              ▼                    │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │                   Cloud Functions                          │   │
│  │  transcribeAudio (Storage trigger)                         │   │
│  │  - Gemini: transcription + analysis                        │   │
│  │  - WhisperX: precision timestamps + speaker diarization    │   │
│  │  - Gemini: speaker corrections                             │   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
                │                        │
                ▼                        ▼
        ┌──────────────┐         ┌──────────────────────────┐
        │  Gemini API  │         │   Alignment Service      │
        │  (Google AI) │         │   WhisperX via Cloud Run │
        └──────────────┘         │   GPU (pyannote built-in)│
                                 └──────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- Firebase project ([Firebase Setup Guide](docs/how-to/firebase-setup.md))
- API Keys:
  - [Gemini API Key](https://makersuite.google.com/app/apikey)
  - Cloud Run Whisper Service URL (deployed from scope 05-02-01)

### Installation

```bash
# Clone repository
git clone https://github.com/sammywachtel/audio-transcript-analysis-app.git
cd audio-transcript-analysis-app

# Install frontend dependencies
npm install

# Install Cloud Functions dependencies
cd functions && npm install && cd ..

# Copy environment template
cp .env.example .env
# Edit .env with your Firebase config (see docs/how-to/firebase-setup.md)
```

### Configure Firebase Secrets

```bash
npx firebase login
npx firebase use your-project-id

# Set API keys as Firebase secrets
npx firebase functions:secrets:set GEMINI_API_KEY
npx firebase functions:secrets:set WHISPER_SERVICE_URL
```

### Deploy Backend

```bash
# Deploy security rules
npx firebase deploy --only firestore:rules,storage:rules

# Deploy Cloud Functions
npx firebase deploy --only functions
```

### Start Development Server

```bash
npm run dev
```

Open http://localhost:3000 in your browser.

## Environment Variables

Frontend configuration in `.env`:

| Variable | Description |
|----------|-------------|
| `VITE_FIREBASE_API_KEY` | Firebase API key |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase auth domain |
| `VITE_FIREBASE_PROJECT_ID` | Firebase project ID |
| `VITE_FIREBASE_STORAGE_BUCKET` | Firebase storage bucket |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Firebase sender ID |
| `VITE_FIREBASE_APP_ID` | Firebase app ID |

Firebase secrets (stored via Firebase Secret Manager):

| Secret | Description |
|--------|-------------|
| `GEMINI_API_KEY` | Google AI Studio API key |
| `WHISPER_SERVICE_URL` | Cloud Run WhisperX service URL (deployed separately) |

## Usage

1. **Sign In** - Click "Sign in with Google"
2. **Upload Audio** - Click "Upload Audio" and select a file (MP3, M4A, WAV)
3. **Wait for Processing** - Cloud Function processes audio (1-3 min depending on length)
4. **View Transcript** - Interactive viewer with speaker labels and timestamps
5. **Navigate** - Click any segment to jump to that point in audio
6. **Fix Speakers** - Press `S` to enter selection mode, click/Shift+Click segments, then reassign via the floating bar. Default clicks always seek audio.
7. **Explore** - Use sidebar to browse terms, topics, and people mentioned

## Project Structure

```
audio-transcript-analysis-app/
├── src/                    # React frontend source
│   ├── components/         # React components
│   │   ├── auth/          # SignInButton, UserMenu, ProtectedRoute, AdminRoute
│   │   ├── viewer/        # TranscriptSegment, AudioPlayer, Sidebar, etc.
│   │   ├── search/        # Search results components
│   │   ├── library/       # Library page components
│   │   └── admin/         # Admin dashboard components
│   ├── contexts/          # React contexts
│   │   ├── AuthContext.tsx            # Firebase Auth state + isAdmin role
│   │   └── ConversationContext.tsx    # Real-time Firestore subscription
│   ├── hooks/             # Custom React hooks
│   │   ├── useAudioPlayer.ts          # Playback, seeking, drift correction
│   │   ├── useAutoScroll.ts           # Auto-scroll to active segment
│   │   ├── usePersonMentions.ts       # Person name detection
│   │   └── useTranscriptSelection.ts  # Two-way transcript/sidebar sync
│   ├── pages/             # Page components
│   │   ├── Library.tsx    # Conversation list + upload
│   │   ├── Viewer.tsx     # Main transcript viewer
│   │   ├── Search.tsx     # Full-text search
│   │   ├── AdminDashboard.tsx  # Processing metrics (admin-only)
│   │   └── UserStats.tsx  # User usage statistics
│   ├── services/          # Firebase services
│   │   ├── firestoreService.ts  # Firestore CRUD + real-time listeners
│   │   ├── storageService.ts    # Audio upload/download
│   │   ├── searchService.ts     # Client-side search
│   │   └── chatService.ts       # Chat integration
│   ├── utils/             # Helper functions
│   ├── config/            # Configuration files
│   │   ├── firebase-config.ts  # Firebase initialization
│   │   ├── types.ts            # TypeScript types
│   │   └── constants.ts        # App constants
│   ├── styles/            # CSS styles
│   │   └── globals.css    # Global styles
│   ├── App.tsx            # Main app component
│   └── main.tsx           # Entry point
├── functions/             # Cloud Functions (Node.js)
│   └── src/
│       ├── index.ts       # Function exports
│       ├── transcribe.ts  # WhisperX + Gemini analysis + speaker corrections
│       ├── alignment.ts   # WhisperX integration via Cloud Run
│       ├── metrics.ts     # Processing metrics recording
│       └── logger.ts      # Structured logging utility
├── docs/                  # Documentation (Diátaxis structure)
│   ├── tutorials/         # Getting started guides
│   ├── how-to/            # Task-oriented guides
│   ├── reference/         # Technical reference
│   └── explanation/       # Design decisions
└── ...config files
```

## Pipeline Architecture

The app uses a no-text Gemini + WhisperX timestamp-overlap pipeline:

1. **Gemini 3 Flash (WAV, no-text prompt)** - Full-audio diarization with speaker names, plus content analysis (terms, topics, persons). The no-text prompt yields better speaker detection (6/6 vs 5/6) and lower token usage (~9-15% vs ~31%).
2. **WhisperX Timestamps** - Word-level timestamps via Cloud Run GPU. Speaker assignment overlays Gemini's diarization windows onto WhisperX words by timestamp overlap.
3. **Text Quality Trade-off** - Transcript text comes from WhisperX (raw ASR) rather than Gemini's cleaned-up version, since Gemini no longer returns transcript text in the no-text prompt mode.
4. **Client Drift Correction** - For legacy data without server alignment, applies linear timestamp scaling.

WhisperX is mandatory - if it fails, the entire job fails (no fallback to less precise timestamps).

See [docs/reference/pipeline-flow.md](docs/reference/pipeline-flow.md) for details.

## Deployment

- **Frontend**: Cloud Run (auto-deploys on push to main)
- **Backend**: Firebase (Cloud Functions, Firestore rules, Storage rules)
- **CI/CD**: GitHub Actions (parallel deployment)

```bash
# Manual deployment
npx firebase deploy                    # Deploy Firebase (rules + functions)
./deploy.sh                            # Deploy frontend to Cloud Run
```

See [docs/how-to/deploy.md](docs/how-to/deploy.md) for full deployment guide.

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS
- **Backend**: Firebase (Firestore, Storage, Cloud Functions, Auth)
- **AI**: Google Gemini 3 Flash (no-text diarization + content analysis)
- **Timestamps**: WhisperX via Cloud Run GPU with NVIDIA L4 (word-level timestamps, speaker assignment by timestamp overlap)
- **Deployment**: Cloud Run (frontend + WhisperX), Firebase Functions (backend)
- **CI/CD**: GitHub Actions

## Documentation

Documentation follows the [Diátaxis framework](https://diataxis.fr/):

- [Getting Started](docs/tutorials/getting-started.md) - Complete setup tutorial
- [Firebase Setup](docs/how-to/firebase-setup.md) - Firebase configuration guide
- [Architecture](docs/reference/architecture.md) - System design reference
- [Data Model](docs/reference/data-model.md) - Firestore schema

## License

MIT
