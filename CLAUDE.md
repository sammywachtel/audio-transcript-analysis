# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Audio Transcript Analysis App - A React application that transforms audio recordings into interactive, navigable transcripts with AI-powered analysis. Uses Google's Gemini API for transcription, speaker diarization, term extraction, topic segmentation, and person detection.

**Current Status:** Local prototype using IndexedDB for persistence and client-side Gemini API calls (no backend/auth).

## Commands

```bash
npm install        # Install dependencies
npm run dev        # Start dev server on http://localhost:3000
npm run build      # Production build
npm run preview    # Preview production build
```

## Architecture

### Core Data Flow
1. User uploads audio file via Library page
2. `processAudioWithGemini()` in `utils.ts` sends audio to Gemini 2.5 Flash with structured output schema
3. AI returns: title, speakers, segments (with timestamps), terms, topics, and people
4. Response is transformed into `Conversation` type and stored in IndexedDB via `db.ts`
5. Viewer page renders transcript with synchronized audio playback

### Key Files
- **`types.ts`** - All TypeScript interfaces (`Conversation`, `Segment`, `Speaker`, `Term`, `Topic`, `Person`, etc.)
- **`utils.ts`** - Gemini API integration, audio processing, helper functions (`formatTime`, `cn`)
- **`db.ts`** - IndexedDB persistence layer using `idb` library (stores conversations with audio blobs)
- **`constants.ts`** - Mock data for demo, speaker color palette

### Pages
- **`pages/Library.tsx`** - Conversation list with upload modal (drag-drop or file picker)
- **`pages/Viewer.tsx`** - Main transcript viewer with audio player, two-way sync, drift correction

### Components (in `components/`)
- **`Button.tsx`** - Reusable button with variants
- **`viewer/AudioPlayer.tsx`** - Bottom playback controls with scrubber
- **`viewer/Sidebar.tsx`** - Terms and People tabs with selection sync
- **`viewer/TranscriptSegment.tsx`** - Individual segment with term/person highlighting
- **`viewer/TopicMarker.tsx`** - Topic boundary indicators

### State Management
- App-level state in `App.tsx` manages conversations and navigation
- Viewer maintains local state for playback, selection, and editing
- Two-way sync: clicking transcript term selects sidebar card and vice versa
- Auto-drift correction: if audio duration differs >5% from transcript timestamps, segments are linearly scaled

## Environment Variables

Set `GEMINI_API_KEY` in `.env.local` for Gemini API access:
```
GEMINI_API_KEY=your_key_here
```

Vite exposes this as `process.env.API_KEY` and `process.env.GEMINI_API_KEY`.

## Styling

Uses Tailwind CSS (loaded via CDN in `index.html`). No build-time CSS processing. The `cn()` utility in `utils.ts` handles conditional class composition.

## Key Technical Details

- **Audio Storage:** Blob URLs are ephemeral; `db.ts` fetches the blob from URL before storing, then recreates URL on load
- **Timestamp Handling:** All timestamps are in milliseconds (`startMs`, `endMs`)
- **Term Occurrences:** Stored separately from terms with character positions for inline highlighting
- **Person Mentions:** Computed at runtime via regex matching in Viewer's `useMemo`
- **Path Alias:** `@/*` maps to project root via `tsconfig.json` and `vite.config.ts`

## PRD Reference

Full product requirements in `docs/conversation-transcript-context-prd.md`. Key features:
- Transcript with speaker labels and timestamps
- Inline term highlighting with definitions
- Topic/tangent segmentation
- People detection with editable notes
- Click-to-play audio sync
