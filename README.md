# Audio Transcript Analysis App

Transform audio recordings into interactive, navigable transcripts with AI-powered analysis.

**Status:** Beta (v1.0.0-beta)

## Features

- **AI Transcription** - Powered by Google Gemini 2.5 Flash
- **Speaker Diarization** - WhisperX + pyannote for speaker identification
- **Gemini Speaker Corrections** - AI-detected mid-segment speaker changes
- **Manual Speaker Reassignment** - Click any segment to change speaker attribution
- **Precision Timestamps** - WhisperX forced alignment (~50ms accuracy)
- **Term Extraction** - Key terms highlighted with AI-generated definitions
- **Topic Segmentation** - Automatic topic/tangent detection
- **Person Detection** - Named entity recognition for people mentioned
- **Synchronized Playback** - Click any segment to jump to that point in audio
- **Real-time Updates** - Live UI updates via Firestore listeners

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
        │  (Google AI) │         │   WhisperX via Replicate │
        └──────────────┘         │   pyannote diarization   │
                                 └──────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- Firebase project ([Firebase Setup Guide](docs/how-to/firebase-setup.md))
- API Keys:
  - [Gemini API Key](https://makersuite.google.com/app/apikey)
  - [Replicate API Token](https://replicate.com/account/api-tokens) (for WhisperX alignment)

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
npx firebase functions:secrets:set REPLICATE_API_TOKEN
npx firebase functions:secrets:set ALIGNMENT_SERVICE_URL
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
| `REPLICATE_API_TOKEN` | Replicate API token for WhisperX |
| `ALIGNMENT_SERVICE_URL` | WhisperX alignment service URL |

## Usage

1. **Sign In** - Click "Sign in with Google"
2. **Upload Audio** - Click "Upload Audio" and select a file (MP3, M4A, WAV)
3. **Wait for Processing** - Cloud Function processes audio (1-3 min depending on length)
4. **View Transcript** - Interactive viewer with speaker labels and timestamps
5. **Navigate** - Click any segment to jump to that point in audio
6. **Fix Speakers** - Click speaker badge to reassign segment to different speaker
7. **Explore** - Use sidebar to browse terms, topics, and people mentioned

## Project Structure

```
audio-transcript-analysis-app/
├── components/              # React components
│   ├── auth/               # SignInButton, UserMenu, ProtectedRoute
│   └── viewer/             # TranscriptSegment, AudioPlayer, Sidebar, etc.
├── contexts/               # React contexts
│   ├── AuthContext.tsx     # Firebase Auth state
│   └── ConversationContext.tsx  # Real-time Firestore subscription
├── hooks/                  # Custom React hooks
│   ├── useAudioPlayer.ts   # Playback, seeking, drift correction
│   ├── useAutoScroll.ts    # Auto-scroll to active segment
│   ├── usePersonMentions.ts # Person name detection
│   └── useTranscriptSelection.ts # Two-way transcript/sidebar sync
├── pages/                  # Page components
│   ├── Library.tsx         # Conversation list + upload
│   └── Viewer.tsx          # Main transcript viewer
├── services/               # Firebase services
│   ├── firestoreService.ts # Firestore CRUD + real-time listeners
│   └── storageService.ts   # Audio upload/download
├── functions/              # Cloud Functions (Node.js)
│   └── src/
│       ├── index.ts        # Function exports
│       ├── transcribe.ts   # Gemini + WhisperX + speaker corrections
│       └── alignment.ts    # HARDY timestamp alignment algorithm
├── docs/                   # Documentation (Diátaxis structure)
│   ├── tutorials/          # Getting started guides
│   ├── how-to/             # Task-oriented guides
│   ├── reference/          # Technical reference
│   └── explanation/        # Design decisions
├── types.ts                # TypeScript types
├── utils.ts                # Helper functions
└── firebase-config.ts      # Firebase initialization
```

## Timestamp Alignment

The app uses a "WhisperX-first" architecture for precise timestamps:

1. **WhisperX Alignment (Primary)** - Word-level forced alignment via Replicate + pyannote speaker diarization (~$0.02/10min)
2. **Gemini Fallback** - If WhisperX fails, uses Gemini's timestamps (may be ~5-10s off)
3. **Client Drift Correction** - For legacy data without server alignment, applies linear timestamp scaling

The `alignmentStatus` field indicates timestamp quality:
- `aligned` - WhisperX succeeded (precise timestamps)
- `fallback` - WhisperX failed, using Gemini timestamps
- `pending` - Processing not yet complete

See [docs/reference/alignment-architecture.md](docs/reference/alignment-architecture.md) for details.

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
- **AI**: Google Gemini 2.5 Flash
- **Alignment**: WhisperX via Replicate, pyannote for diarization
- **Deployment**: Cloud Run (frontend), Firebase Functions (backend)
- **CI/CD**: GitHub Actions

## Documentation

Documentation follows the [Diátaxis framework](https://diataxis.fr/):

- [Getting Started](docs/tutorials/getting-started.md) - Complete setup tutorial
- [Firebase Setup](docs/how-to/firebase-setup.md) - Firebase configuration guide
- [Architecture](docs/reference/architecture.md) - System design reference
- [Data Model](docs/reference/data-model.md) - Firestore schema

## License

MIT
