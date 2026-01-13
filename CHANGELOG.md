# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.4] - 2026-01-13

### Fixed
- **Single-Chunk Audio Processing Failure** - Audio files that don't require chunking (< 30 minutes) no longer fail with false "low confidence" errors
  - Speaker reconciliation is now skipped for single-chunk files since there's nothing to reconcile across chunks
  - Previously, these files would get stuck in a retry loop because the confidence calculation was meaningless for single speakers
- **Graceful Degradation for Low-Confidence Reconciliation** - Multi-chunk files with uncertain speaker matching now complete with warnings instead of failing entirely
  - A transcript with potentially misidentified speakers is vastly more useful than no transcript at all
  - Warning banner appears in transcript viewer explaining potential speaker identification issues
  - Warning badge shown in Library list for affected conversations

### Added
- **Quality Warning System** - New warning infrastructure to surface processing issues without blocking delivery
  - `TranscriptWarning` type with categories: `speaker_confidence`, `audio_quality`, `alignment_fallback`, `processing_partial`
  - Dismissible warning banner in Viewer showing quality notices
  - Warning count badge in Library conversation list

## [2.0.3] - 2026-01-13

### Added
- **Job Control for Long-Running Transcriptions** - Cancel active jobs and retry failed ones
  - Cancel button now works during all active statuses (`processing`, `chunking`, `merging`, `reprocessing`)
  - Retry button appears for `failed` and `aborted` jobs with up to 3 retry attempts
  - Smart resume: chunked jobs resume only incomplete chunks instead of restarting entirely
  - Task generation mechanism prevents stale Cloud Tasks from interfering with retries

### Fixed
- **Stale Task Interference** - Retried jobs no longer corrupted by orphaned Cloud Tasks from previous attempts
  - Each retry increments a task generation counter; tasks from older generations are ignored
  - Prevents progress thrashing and status confusion during parallel chunk processing
- **Memory Limits for Large Files** - Increased Cloud Function memory to 2GiB for reliable large file processing

## [2.0.2] - 2026-01-13

### Changed
- **File Upload Limit** - Increased maximum audio file size from 100MB to 500MB
  - Handles ~45 minute stereo WAV files at 44.1kHz
  - Client-side validation now prevents upload attempts before hitting server limit
  - Clear error message shows file size vs limit when exceeded

## [2.0.1] - 2026-01-13

### Fixed
- **CI Version Detection** - GitHub Actions workflow now fetches git tags for accurate version identification
  - Added `fetch-depth: 0` and `fetch-tags: true` to checkout step
  - Deployed functions now correctly report their release tag (e.g., `v2.0.0`) instead of commit hash
- **Build Number Tracking** - Deployments now include `build/N` tag number for artifact correlation
  - `processedByBuildNumber` field stored in conversation and chunk documents
  - Cloud Function logs display build number alongside version

## [2.0.0] - 2026-01-13

### Added
- **Audio Playback Optimization** - Re-encoding ensures accurate seeking when clicking transcript segments
  - Original audio files re-encoded to CBR (constant bitrate) MP3 for predictable byte-to-time mapping
  - Fixes 3-10 second seeking drift in VBR files (especially YouTube downloads)
  - New "Optimizing Audio" progress step shows re-encoding status during upload
  - Processing time: ~2 minutes for 45-minute files (22x realtime)
- **Build Version Tracking** - Function deployments now tagged with git version for debugging
  - `processedByVersion` field stored in conversation documents
  - Version logged on Cloud Function cold start
  - Format: `{commit}` or `{commit}-dirty-{timestamp}` for uncommitted changes
- **Conversation ID Display** - Click-to-copy conversation ID in viewer header for debugging
- **Voice Embedding Speaker Reconciliation** - Acoustic-based speaker matching across chunks using 256-dimensional voice embeddings
  - Replaces content-based reconciliation (which produced 23 speakers from 2-speaker audio) with voice-signature matching
  - Uses forked Replicate model `sammywachtel/whisper-diarization-embeddings-01` with pyannote/wespeaker-voxceleb-resnet34-LM
  - Agglomerative clustering groups speakers by voice similarity (cosine threshold: 0.70) without assuming speaker count
  - Falls back to content-based reconciliation if embeddings unavailable (backward compatible with existing transcripts)
  - Speaker embeddings stored in `ChunkArtifact.speakerEmbeddings` for downstream reconciliation
  - Expected improvement: 23 clusters → 2-3 clusters for 2-speaker audio
- **Speaker Reconciliation for Parallel Processing** - Automatic speaker identity matching across independently-processed chunks
  - Uses multi-signal similarity algorithm: name matching (50%), topic overlap (25%), term overlap (25%)
  - Greedy clustering identifies same speaker appearing in different chunks
  - Generates canonical speaker IDs (`speaker_canonical_0`, etc.) for unified transcript
  - Stores `reconciliationConfidence` and `reconciliationDetails` metadata for transparency
  - Throws `ReconciliationLowConfidenceError` when confidence below 0.6 threshold
  - Seamlessly integrated into chunk merge pipeline before segment deduplication
- **Parallel Chunk Processing Mode** - New Fast/Legacy toggle for large file uploads
  - Fast mode (default): Chunks process independently in parallel for faster results
  - Legacy mode: Chunks process sequentially, maintaining speaker ID continuity across chunks
  - Upload modal includes explanatory copy about trade-offs between speed and accuracy
  - `processingMode` persists through Storage metadata, Firestore, and Cloud Task payloads
  - Speaker signatures (`chunkSpeakerSignatures`) captured per chunk for downstream reconciliation
  - Backward compatible: existing uploads without mode default to appropriate behavior
- **Audio Chunking for Large Files** - Files over 30 minutes are now automatically split into 10-15 minute chunks
  - FFmpeg-based silence detection finds natural break points (using `-af silencedetect=n=-30dB:d=0.5`)
  - Chunks include 5-10 second overlap to prevent word truncation at boundaries
  - Each chunk processed as separate Cloud Task, staying within Cloud Function time limits
  - Chunk metadata stored in Firestore for downstream merge/deduplication (Scope 5c)
  - New `ProcessingStep.CHUNKING` shows chunking progress in UI
- **Chunk Context Propagation** - Speaker identity and metadata maintained across chunk boundaries
  - Each chunk emits a `ChunkContext` with speaker mappings, summary, and extracted IDs
  - Next chunk loads previous context to maintain diarization continuity
  - Firestore transactions ensure atomic status updates even with concurrent chunk tasks
  - Resumable execution: failed/pending chunks can be retried with correct state bootstrap
- **Chunk Merge System** - Automatic reassembly of chunked transcripts into a unified document
  - Segments deduplicated in overlap regions using "later chunk wins" strategy
  - Timestamps normalized from chunk-local to original audio timeline for accurate playback sync
  - Speakers, terms, topics, and people merged deterministically across all chunks
  - Cloud Task-based merge job with `mergeTaskEnqueued` guard to prevent duplicate merges
  - Conversation status transitions: `chunking` → `merging` → `complete`

### Changed
- **Queue-Driven Transcription Architecture** - Large audio files (46MB+) now process reliably without timeouts
  - Storage trigger (`transcribeAudio`) now acts as lightweight enqueuer (< 5 seconds), setting status to `queued`
  - New HTTP function (`processTranscription`) handles heavy processing with 60-minute timeout
  - Cloud Tasks provides automatic retry with exponential backoff on failures
  - Emulator bypass allows local development without Cloud Tasks infrastructure
  - **Breaking:** Requires one-time Cloud Tasks queue setup (`transcription-queue`) - see `docs/how-to/deploy.md`

### Fixed
- **Audio Playback Seeking Drift** - Clicking transcript segments now plays correct audio position
  - Root cause: MP3 VBR container timestamps differ from byte-position playback
  - Chunk extraction changed from stream copy to re-encoding for clean timestamps
  - Playback file re-encoded separately to preserve original quality for transcription
- **Large File Upload Timeouts** - Root cause addressed via queue architecture (above)
  - Node.js undici `headersTimeout` extended to 25 minutes (fixes `HeadersTimeoutError`)
  - Gemini API calls configured with 20-minute SDK-level timeout
  - Replicate API calls configured with 3-minute timeout via custom fetch wrapper
  - Gateway errors (502/503/504) now trigger automatic retries in WhisperX transcription
- **Firestore Race Condition** - Storage trigger now uses `set()` with merge instead of `update()`, preventing errors when file upload completes before frontend creates document
- **Chunk Processing Retry Errors** - Fixed Firestore error when retrying failed chunks
  - Chunk status updates now properly omit error field instead of setting it to `undefined`
  - Prevents "Cannot use undefined as a Firestore value" errors during chunk retry operations
- **WhisperX JSON Parsing Failures** - Large audio files now chunk based on file size, not just duration
  - Added 20MB file size threshold for chunking (in addition to 30-minute duration threshold)
  - Prevents WhisperX from returning massive JSON responses that exceed parser buffer limits
  - High-quality short audio (e.g., 46MB / 15 minutes) now properly chunks before processing
- **Chunk Cascade Failure** - Chunks no longer fail in cascade when predecessor is still processing
  - Chunks waiting on a processing predecessor now return 500 without marking themselves as failed
  - Prevents "Chunk N cannot proceed - previous chunk N-1 failed" cascade when chunks race ahead
  - Cloud Tasks retries chunks cleanly without poisoning the chunk status chain
- **Chunk Context Firestore Write Error** - Fixed undefined value error when saving chunk emitted context
  - Added `sanitizeForFirestore()` utility that recursively strips undefined values from objects
  - Fixes "Cannot use undefined as a Firestore value" error in `emittedContext.speakerMap.voiceSignature`
  - Optional fields like `voiceSignature` and `displayName` in speaker mappings now properly omitted when undefined
- **Progress Regression in Parallel Processing** - Fixed progress percentage jumping backwards when chunks complete out of order
  - Each chunk instance now reads existing Firestore `processingProgress.percentComplete` before updating
  - Progress floor = `max(existingFirestoreProgress, lastLocalProgress)` prevents regression
  - Example: chunk 7 finishes at 75%, chunk 5 later finishes with calculated 60% → clamped to 75%

## [1.8.0-beta] - 2026-01-05

### Added
- **Admin Cost Visibility Dashboard** - Comprehensive cost transparency tools for finance and operations
  - Job Detail view at `/admin/jobs/:metricId` with timing breakdowns, token usage, pricing snapshots, and Replicate prediction links
  - Chat metrics tab aggregating conversational queries by conversation with token usage and response time analytics
  - Cost Reconciliation report at `/admin/reports/cost-reconciliation` with weekly/monthly summaries, variance detection (>5% highlighted), and CSV export
  - Cost verification badges showing estimated vs. current pricing with ✓/⚠️/❌ status indicators
- **User Cost Visibility** - Pricing accuracy indicator on My Stats page
  - Shows whether stored costs match current configured rates (✓ match / ⚠️ minor / ❌ significant variance)
  - Displays timestamp when rates were captured
  - Includes disclaimer about configured vs actual billing rates
  - Admin users see "View cost breakdown" link to admin dashboard

### Changed
- **Vertex AI SDK Migration** - Replaced `@google/generative-ai` with `@google-cloud/vertexai` for billing label support
  - All 6 Gemini API calls now include billing labels (`conversation_id`, `user_id`, `call_type`, `environment`)
  - Enables cost tracking and reconciliation via GCP billing reports
  - Updated `transcribeWithWhisperX()` to return `predictionId` for all successful transcriptions
  - Authentication changed from API key to service account credentials
- **Cost Display Centralization** - Removed inline cost estimates from modals
  - Delete and abort confirmation modals no longer show dollar amounts
  - Users directed to My Stats page for accurate cost information
  - Prevents displaying ad-hoc cost guesses during active processing

### Fixed
- Admin dashboard URL routing now properly handles `/admin`, `/admin/jobs/:id`, and `/admin/reports/cost-reconciliation` paths
- Job detail views now correctly load metric data using Firestore document IDs
- Cost Reconciliation report period dates now use local timezone instead of UTC to prevent off-by-one date errors
- Pricing accuracy indicator now correctly shows "No pricing configured" when `_pricing` collection is empty (previously showed false "match" status)

---

## [1.7.0-beta] - 2026-01-02

### Added
- **Timestamp Citations** - Clickable `[MM:SS]` links in AI chat responses
  - Auto-play audio at timestamp
  - Scroll transcript and highlight segment
  - Error recovery UI for missing segments
- **Question Suggestions** - Rotating prompts in chat interface
  - 44px touch targets with haptic feedback on mobile
  - Suggestions refresh after each query
- **Analytics Service** - Track chat interactions and costs
  - Message sent/received events
  - Timestamp click tracking
  - Cost warning events at $0.50 and $1.25 thresholds
- **Long-press Speaker Reassignment** - Touch-friendly gesture for mobile
  - 500ms long-press or right-click shows context menu
  - Keyboard navigation (Arrow keys, Enter, Escape)
  - Haptic feedback on mobile devices
- New components: `TimestampLink`, `QuestionSuggestions`, `SpeakerContextMenu`, `useLongPress` hook

### Changed
- **Transcript Segment Redesign** - Cleaner, more consistent layout
  - Removed left-side per-segment controls
  - Pill-shaped timestamp buttons with proper touch targets
  - Tight vertical spacing (py-1.5) for better density
- **Mobile Responsiveness Improvements**
  - Fixed chat FAB positioning with `calc(4rem + 1rem)`
  - Safe area support for notched devices (`env(safe-area-inset-*)`)
  - Dynamic viewport height (`100dvh`) for mobile browser chrome
  - Fixed header button overflow on Viewer and Library pages

---

## [1.6.0-beta] - 2025-12-31

### Added
- **Chat History Persistence** - Chat conversations now persist to Firestore
  - Messages survive page reloads and work across devices
  - Pagination with "Load older messages" (10 at a time)
  - 50 message limit per conversation with visual warnings
  - Export chat as JSON with full metadata
  - Clear history with confirmation modal
- New `useChatHistory` hook for real-time Firestore sync
- New `ChatHistory` component for message display
- How-to guide: `docs/how-to/using-chat.md`

### Changed
- **Project restructure** - All source files moved into `src/` directory
  - `components/`, `hooks/`, `pages/`, `services/`, `contexts/` → `src/`
  - `types.ts`, `constants.ts`, `firebase-config.ts` → `src/config/`
  - `utils.ts` → `src/utils/index.ts`
  - `index.tsx` → `src/main.tsx`
- Updated all import paths to use `@/` alias
- Updated Vite, TypeScript, and Vitest configs for new structure

---

## [1.5.0-beta] - 2025-12-29

### Fixed
- **Speaker Label Reversal Bug** - Fixed critical issue where speaker names were reversed in interview-style audio. Pre-analysis was assigning SPEAKER_XX IDs arbitrarily before WhisperX ran.

### Changed
- Speaker identification now runs AFTER WhisperX transcription completes
- New `identifySpeakersFromContent` function analyzes actual transcript
- Content-based speaker mapping overrides pre-analysis guesses
- Added `speakerIdentificationSource` logging for debugging

---

## [1.4.0-beta] - 2025-12-28

### Added
- **Gemini-first Pipeline** - Improved diarization by running Gemini analysis first
- **Abort and Retry** - Processing jobs can now be aborted and retried
- **Comprehensive Observability** - Admin dashboard with user stats
- Switched to `thomasmol/whisper-diarization` model for better accuracy

### Fixed
- Deduplicated repeated words from WhisperX output
- Handled broken WhisperX diarization with sentence-based grouping
- Cloud Scheduler IAM role for scheduled functions

---

## [1.3.0-beta] - 2025-12-25

### Added
- **Admin Dashboard** - Observability metrics and monitoring
- Metrics collection wired to Firestore `_metrics` collection
- Timing metrics for Gemini processing

### Fixed
- Admin dashboard timestamp display and added user ID column
- Removed obsolete Timestamp Fallback stat card
- Excluded test files from functions build

---

## [1.2.0-beta] - 2025-12-23

### Added
- **Gemini Speaker Reassignment** - AI-powered speaker correction without timestamp manipulation

---

## [1.1.0-beta] - 2025-12-23

### Added
- **Single-project Architecture** - Self-healing CI/CD pipeline
- Multi-method Firebase Storage bucket creation
- Custom domain mappings support for Cloud Run
- Improved whisper diarization with new model and boundary fixes

### Fixed
- Firebase Storage rules path and `.firebaserc` setup
- Service agent IAM bindings were being skipped
- Removed hardcoded storage bucket from firebase.json

---

## [1.0.0-beta] - 2025-12-23

**Detailed changelog tracking begins with this version.**

For historical context, see the summary below and the [full git history](https://github.com/sammywachtel/audio-transcript-analysis-app/commits/main).

### Added
- Audio upload and transcription via Gemini API
- WhisperX alignment for precise timestamps
- Speaker diarization
- Topic segmentation
- Term extraction with definitions
- Person detection
- Real-time Firestore sync
- Google Auth integration
- Cloud Run deployment infrastructure

---

## Historical Summary

### Initial Development (2025-12-16 to 2025-12-23)

The foundational development phase, from initial commit to first beta release.

**Highlights:**
- Built React + TypeScript frontend with real-time Firestore integration
- Implemented Gemini API integration for transcription and analysis
- Added WhisperX timestamp alignment service for precise audio sync
- Created Cloud Run deployment infrastructure with CI/CD
- Established Firebase Auth with Google sign-in

**Key commits:**
- `3e9f664` Initial commit: Audio Transcript Analysis App (2025-12-16)
- `848f8bc` Add Cloud Run deployment infrastructure and refactor architecture (2025-12-17)
- `ec8d1f9` Add WhisperX timestamp alignment service (Phase 2) (2025-12-18)
- `c75abd2` Implement HARDY alignment algorithm for robust timestamp matching (2025-12-18)

---

*For complete historical details, see the [commit history](https://github.com/sammywachtel/audio-transcript-analysis-app/commits/main).*
