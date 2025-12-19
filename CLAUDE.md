# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Audio Transcript Analysis App - A React application that transforms audio recordings into interactive, navigable transcripts with AI-powered analysis. Uses Google's Gemini API (server-side) for transcription, speaker diarization, term extraction, topic segmentation, and person detection.

**Current Status:** Production-ready with Firebase backend (Firestore, Storage, Cloud Functions, Auth).

## Commands

```bash
npm install              # Install frontend dependencies
npm run dev              # Start dev server on http://localhost:3000
npm run build            # Production build
npm run test             # Run tests in watch mode
npm run test:run         # Run tests once (CI)
npx firebase deploy      # Deploy to Firebase
```

## Architecture

### Core Data Flow
1. User signs in with Google via Firebase Auth
2. User uploads audio file via Library page
3. Audio uploads to Firebase Storage, creates Firestore doc with `status: 'processing'`
4. Cloud Function triggers on upload, calls Gemini API server-side
5. Function writes results to Firestore with `status: 'complete'`
6. Real-time Firestore listener updates UI automatically
7. Viewer page renders transcript with synchronized audio playback

### Key Files
- **`types.ts`** - All TypeScript interfaces (`Conversation`, `Segment`, `Speaker`, `Term`, `Topic`, `Person`, etc.)
- **`firebase-config.ts`** - Firebase initialization (Auth, Firestore, Storage, Functions)
- **`services/firestoreService.ts`** - Firestore CRUD with real-time listeners
- **`services/storageService.ts`** - Audio upload/download
- **`functions/src/transcribe.ts`** - Cloud Function for Gemini processing

### Pages
- **`pages/Library.tsx`** - Conversation list with upload modal and sync status
- **`pages/Viewer.tsx`** - Main transcript viewer with audio player, two-way sync, drift correction

### Contexts
- **`contexts/AuthContext.tsx`** - Firebase Auth state, Google sign-in/out
- **`contexts/ConversationContext.tsx`** - Real-time Firestore subscription, CRUD operations

### Components (in `components/`)
- **`auth/`** - SignInButton, UserMenu, ProtectedRoute
- **`viewer/`** - AudioPlayer, Sidebar, TranscriptSegment, TopicMarker, ViewerHeader

### Hooks (in `hooks/`)
- **`useAudioPlayer.ts`** - Audio playback, seeking, drift correction
- **`usePersonMentions.ts`** - Regex-based person detection
- **`useTranscriptSelection.ts`** - Two-way sync between transcript and sidebar

## Environment Variables

Firebase configuration in `.env`:
```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

Gemini API key is stored as Firebase Secret (not in `.env`):
```bash
npx firebase functions:secrets:set GEMINI_API_KEY
```

## Documentation

Documentation is organized using the [Diátaxis framework](https://diataxis.fr/) in [`/docs/`](docs/):

- **[tutorials/](docs/tutorials/)** - Learning-oriented guides (getting started)
- **[how-to/](docs/how-to/)** - Task-oriented guides (Firebase setup, deployment, testing)
- **[reference/](docs/reference/)** - Technical reference (architecture, data model)
- **[explanation/](docs/explanation/)** - Background and design decisions

When updating documentation:
1. Place content in the appropriate Diátaxis category
2. Update `docs/README.md` if adding new files
3. Keep docs in sync with code changes

## Key Technical Details

- **Storage:** Audio files in Firebase Storage, metadata in Firestore
- **Real-time Updates:** Firestore `onSnapshot` listeners for instant UI updates
- **Offline Support:** Firebase automatic offline persistence
- **Timestamp Handling:** All timestamps in milliseconds (`startMs`, `endMs`)
- **Drift Correction:** If audio duration differs >5% from transcript, segments are linearly scaled
- **Security:** Firestore rules enforce user isolation (`userId` field)

## Testing

```bash
npm test                 # Watch mode
npm run test:run         # Run once
npm run test:coverage    # Coverage report
```

Test files in `src/__tests__/` with mocks for Firebase services.

## Deployment

- **Frontend:** Cloud Run (auto-deploys on push to main)
- **Backend:** Firebase (Cloud Functions, Firestore rules, Storage rules)
- **CI/CD:** GitHub Actions

See [docs/how-to/deploy.md](docs/how-to/deploy.md) for details.
