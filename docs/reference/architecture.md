# Architecture Reference

Technical architecture of the Audio Transcript Analysis App.

## System Overview

```
┌───────────────────────────────────────────────────────────────────┐
│                          User Browser                             │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │                     React Application                        │ │
│  │  ┌───────────┐  ┌───────────────────┐  ┌───────────────────┐ │ │
│  │  │   Auth    │  │   Conversation    │  │      Pages        │ │ │
│  │  │  Context  │  │     Context       │  │ Library/Viewer/   │ │ │
│  │  │           │  │                   │  │ Search            │ │ │
│  │  └─────┬─────┘  └─────────┬─────────┘  └─────────┬─────────┘ │ │
│  │        │                  │                      │           │ │
│  │        └──────────────────┼──────────────────────┘           │ │
│  │                           │                                  │ │
│  │  ┌────────────────────────┴────────────────────────────────┐ │ │
│  │  │                    Firebase SDK                         │ │ │
│  │  │  Auth │ Firestore (real-time) │ Storage │ Functions     │ │ │
│  │  └─────────────────────────────────────────────────────────┘ │ │
│  └──────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
                               │
                               │ HTTPS
                               ▼
┌───────────────────────────────────────────────────────────────────┐
│                          Firebase                                 │
│                                                                   │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────┐   │
│  │  Firebase      │  │  Firestore     │  │  Firebase Storage  │   │
│  │  Auth          │  │  Database      │  │  (Audio Blobs)     │   │
│  └────────────────┘  └────────────────┘  └─────────┬──────────┘   │
│                                                    │              │
│                                                    │ onFinalized  │
│                                                    ▼              │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │                Cloud Functions                               │ │
│  │                                                              │ │
│  │  ┌──────────────────────┐  ┌──────────────────────────────┐  │ │
│  │  │  transcribeAudio     │  │  Callables (HTTPS)           │  │ │
│  │  │  (Storage trigger)   │  │  ┌────────────────────────┐  │  │ │
│  │  │  - validates file    │  │  │ chatWithConversation   │  │  │ │
│  │  │  - dispatches to     │  │  │ mergeSpeakers          │  │  │ │
│  │  │    orchestrator      │  │  │ reassignSegments       │  │  │ │
│  │  │  - 60s timeout       │  │  │ renameSpeaker          │  │  │ │
│  │  └──────────┬───────────┘  │  │ undoCorrection         │  │  │ │
│  │             │              │  └────────────────────────┘  │  │ │
│  │             │ IAM-auth     └──────────────────────────────┘  │ │
│  │             │ HTTP POST                                      │ │
│  │             │              ┌──────────────────────────────┐  │ │
│  │             │              │  Background                  │  │ │
│  │  See pipeline-flow.md     │  ┌────────────────────────┐  │  │ │
│  │  for detailed pipeline    │  │ onConversation*        │  │  │ │
│  │  flow diagrams.           │  │ computeDailyStats      │  │  │ │
│  │                            │  │ syncBillingCosts       │  │  │ │
│  │                            │  └────────────────────────┘  │  │ │
│  │                            └──────────────────────────────┘  │ │
│  │                                                              │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│  transcription-orchestrator             │
│  (Cloud Run — 2 CPU / 2Gi / 900s)      │
│                                         │
│  Two-pass Gemini + WhisperX pipeline:   │
│  ├── WhisperX (timestamps + text)       │
│  ├── Gemini Pass 1 (text-only)          │
│  │     speaker intelligence extraction  │
│  ├── Gemini Pass 2 (audio + context)    │
│  │     diarization with injected intel  │
│  ├── Gemini Pass 3 (audio)              │
│  │     content analysis (terms/topics)  │
│  ├── speakerAssignment (overlap)        │
│  └── Writes results to Firestore        │
└──────────────┬──────────────────────────┘
               │
       ┌───────┴───────┐
       ▼               ▼
┌────────────────┐  ┌────────────────┐
│  Gemini API    │  │  Cloud Run GPU │
│  (Gemini 3)    │  │  (WhisperX)    │
└────────────────┘  └────────────────┘
```

**Production flow**: Upload triggers `transcribeAudio` (Cloud Function) which acts as a thin dispatcher — it validates the upload, writes initial processing state, and fires an IAM-authenticated HTTP POST to the `transcription-orchestrator` Cloud Run service. The orchestrator runs the full Gemini hybrid pipeline (15-minute budget) and writes results directly to Firestore.

**Emulator exception**: Under `FUNCTIONS_EMULATOR=true`, the dispatcher runs the pipeline inline via `processWithNewPipeline()` because Cloud Run is not available locally.

## Component Architecture

### Frontend Layers

```
Pages (Library, Viewer, Search)
        │
        ├── use contexts ────┐
        │                    │
        ▼                    ▼
    Hooks              Contexts
    ├── useAudioPlayer      ├── AuthContext
    ├── useChat             └── ConversationContext
    ├── usePersonMentions
    ├── useTranscriptSelection
    ├── useSearch           (search orchestration)
    ├── useSearchFilters    (filter state + URL sync)
    └── useDebounce         (input debouncing)
        │
        └── use services ────┐
                             │
                             ▼
                        Services
                        ├── chatService     (Firebase callable wrapper)
                        ├── firestoreService
                        ├── storageService
                        └── searchService   (search + filter logic)
                             │
                             ▼
                      Firebase SDK
```

### Directory Structure

```
audio-transcript-analysis-app/
├── components/              # React components
│   ├── auth/               # Authentication components
│   │   ├── SignInButton.tsx
│   │   ├── UserMenu.tsx
│   │   ├── ProtectedRoute.tsx
│   │   └── AdminRoute.tsx  # Admin-only content gating
│   ├── search/             # Search result and filter components
│   │   ├── SearchResults.tsx        # Results container + pagination
│   │   ├── ConversationResultCard.tsx # Grouped results per conversation
│   │   ├── SegmentResult.tsx        # Individual segment match
│   │   ├── ZeroResultsState.tsx     # Empty state with suggestions
│   │   ├── FilterSidebar.tsx        # Desktop 300px filter sidebar
│   │   ├── FilterBottomSheet.tsx    # Mobile bottom sheet with drag-to-dismiss
│   │   ├── DateRangeFilter.tsx      # Date range preset/custom selector
│   │   ├── SpeakerFilter.tsx        # Speaker checkbox filter with counts
│   │   └── TopicFilter.tsx          # Topic checkbox filter with counts
│   ├── shared/             # Shared components
│   │   └── CostIndicator.tsx        # Per-message cost display
│   └── viewer/             # Transcript viewer components
│       ├── AudioPlayer.tsx
│       ├── ChatInput.tsx            # Chat message input
│       ├── ChatMessage.tsx          # User/assistant message display
│       ├── ChatSidebar.tsx          # Chat panel with messages
│       ├── Sidebar.tsx              # Three-tab sidebar (Context/People/Chat)
│       ├── TranscriptSegment.tsx
│       ├── TranscriptView.tsx
│       ├── TopicMarker.tsx
│       └── ViewerHeader.tsx
├── contexts/               # React contexts
│   ├── AuthContext.tsx     # Authentication state + isAdmin role
│   └── ConversationContext.tsx
├── hooks/                  # Custom React hooks
│   ├── useAudioPlayer.ts
│   ├── useAutoScroll.ts
│   ├── useChat.ts          # Chat message state management
│   ├── useDebounce.ts      # Generic debounce for inputs
│   ├── useMetrics.ts       # Observability data hooks
│   ├── usePersonMentions.ts
│   ├── useSearch.ts        # Search state + pagination + filter integration
│   ├── useSearchFilters.ts # Filter state with URL/sessionStorage sync
│   └── useTranscriptSelection.ts
├── pages/                  # Page components
│   ├── Library.tsx         # Conversation list + upload
│   ├── Search.tsx          # Full-text search across transcripts
│   ├── Viewer.tsx          # Transcript viewer
│   ├── AdminDashboard.tsx  # Admin dashboard with metrics, users, pricing
│   └── UserStats.tsx       # Personal usage statistics
├── services/               # Firebase + app services
│   ├── chatService.ts      # Chat Firebase callable wrapper
│   ├── firestoreService.ts
│   ├── storageService.ts
│   ├── metricsService.ts   # Observability queries
│   └── searchService.ts    # Client-side search logic
├── utils/                  # Utility functions
│   └── textHighlight.ts    # Snippet extraction + highlighting
├── components/
│   ├── admin/              # Admin dashboard components
│   │   └── PricingManager.tsx  # LLM pricing configuration
│   └── metrics/            # Metrics visualization
│       ├── StatCard.tsx
│       ├── TimeSeriesChart.tsx
│       ├── LLMUsageBreakdown.tsx
│       └── MetricsTable.tsx
├── functions/              # Cloud Functions (Node.js)
│   └── src/
│       ├── index.ts                    # Function exports + Firebase Admin init
│       ├── transcribe.ts               # transcribeAudio (Storage trigger) — thin dispatcher
│       ├── newPipeline.ts              # processWithNewPipeline — emulator-only inline pipeline
│       ├── gemini3Pipeline.ts          # Gemini 3 Flash API client + Firestore data assembly
│       ├── alignment.ts                # WhisperX Cloud Run GPU calls + timestamp-overlap speaker assignment
│       ├── audioUtils.ts               # Audio duration detection + shared helpers
│       ├── firestoreUtils.ts           # Firestore write utilities
│       ├── chat.ts                     # chatWithConversation (HTTPS callable)
│       ├── speakerCorrections.ts       # merge/reassign/rename/undo (HTTPS callables)
│       ├── statsTriggers.ts            # onConversation* (Firestore triggers)
│       ├── statsAggregator.ts          # computeDailyStats + triggerStatsComputation
│       ├── billingSync.ts              # syncBillingCosts + triggerBillingSync + diagnose
│       ├── metrics.ts                  # Processing metrics recording
│       ├── userEvents.ts               # User activity event tracking
│       ├── pricing.ts                  # Pricing lookup and cost calculation
│       └── logger.ts                   # Structured logging utility
├── types.ts                # TypeScript types
├── utils.ts                # Helper functions
└── firebase-config.ts      # Firebase initialization
```

## Data Flow

### Upload Flow (Gemini 3 Flash Hybrid Pipeline)

```
1. User selects audio file
        ↓
2. Frontend uploads to Firebase Storage
   storageService.uploadAudio(file)
        ↓
3. Frontend creates Firestore doc (status: 'processing', alignmentStatus: 'pending')
   firestoreService.save(conversation)
        ↓
4. Storage trigger fires transcribeAudio (thin dispatcher)
   onObjectFinalized → transcribeAudio()
   ├── Firestore transaction deduplicates (Cloud Storage fires 3+ triggers per upload)
   ├── Updates Firestore: status='processing'
   └── Dispatches IAM-auth HTTP POST to transcription-orchestrator
        ↓
5. transcription-orchestrator (Cloud Run) accepts and returns 202
   ├── Firestore transaction deduplication (orchestratorClaimed)
   └── Runs pipeline asynchronously — dispatcher is already done
        ↓
6. Gemini 3 Flash — two-pass speaker intelligence + diarization + content
   ├── Pass 1 (text-only, no audio): extractSpeakerIntelligence()
   │   ├── Parses WhisperX transcript for speaker names and anchor points
   │   ├── Encodes direct-address inversion rule (e.g. "Hey Chris" → NOT Chris speaking)
   │   ├── Produces compact SpeakerIntelligence context (capped at 20 anchor points)
   │   └── On failure → degrades silently to truncated transcript fallback
   ├── Pass 2 (audio + context): diarization with injected speaker intelligence
   │   ├── Full-audio diarization (speakers by name, with time windows)
   │   ├── No transcript text returned (better speaker detection, lower tokens)
   │   └── Returns speaker diarization windows with approximate timestamps
   └── Pass 3 (audio): content analysis (terms, topics, persons)
        ↓
7. WhisperX timestamps + speaker assignment (per 10-min chunk)
   ├── Download MP3 from Storage
   ├── Split into 10-minute chunks if needed
   ├── For each chunk:
   │   ├── Call Cloud Run GPU WhisperX service (IAM-auth HTTP)
   │   ├── WhisperX returns word-level timestamps + transcript text
   │   ├── speakerAssignment.ts overlays Gemini diarization windows
   │   │   onto WhisperX words by any-overlap matching
   │   └── Offset assigned timestamps back to global time
   └── Merge assigned results across chunks
        ↓
8. Assembly + quality gates
   ├── assembleFirestoreData() converts to Firestore schema
   ├── Quality gates check segment coverage + speaker counts
   └── alignmentStatus: 'aligned' (no fallback — WhisperX failure = hard failure)
        ↓
9. Write to Firestore (status: 'complete',
   processingPipeline: 'gemini_hybrid', pipelineVersion: 'gemini_hybrid')
        ↓
10. Real-time listener updates UI
    onSnapshot → setConversations()
```

**Why Cloud Run Orchestrator?**

The old architecture ran the entire pipeline inside a Cloud Function with a 9-minute Storage trigger timeout. This worked for most files but left no headroom for long audio or transient slowdowns. The `transcription-orchestrator` Cloud Run service gets a 15-minute budget (900s Cloud Run timeout), and the dispatcher Cloud Function finishes in under 60 seconds. The dispatcher is purely a validation + dispatch layer — all heavy lifting happens in Cloud Run, which writes results directly to Firestore.

**Emulator path**: When `FUNCTIONS_EMULATOR=true`, the dispatcher runs `processWithNewPipeline()` inline because Cloud Run is not available locally. This is the only code path that still runs the pipeline inside a Cloud Function.

### Job Control (Cancel)

The system allows users to cancel active processing jobs.

**Cancel/Abort Flow:**

```
1. User clicks "Cancel" on processing job in Library
        ↓
2. Frontend calls firestoreService.abortProcessing(conversationId)
   ├── Validates status is abortable: 'processing'
   └── Sets abortRequested: true flag in Firestore
        ↓
3. Pipeline checks abort flag at strategic checkpoints
        ↓
4. When abort detected, function throws AbortRequestedError
   ├── Updates status to 'aborted'
   └── Sets processingError: 'Cancelled by user'
        ↓
5. Real-time listener updates UI to show "Cancelled" status
```

**Implementation Files:**

- `src/services/firestoreService.ts` - `abortProcessing()` client-side abort request
- `functions/src/transcribe.ts` - `checkAbort()` function and abort checkpoints
- `src/pages/Library.tsx` - Cancel UI controls

### WhisperX Timestamp Chunking

For the WhisperX timestamp step, audio is split into 10-minute MP3 chunks. This is purely for WhisperX request sizing, not for the transcription pipeline (Gemini processes the full audio in one call).

**Key Points:**

- Audio shorter than 10 minutes is sent to WhisperX as a single chunk (no splitting)
- Splitting uses ffmpeg to create non-overlapping chunks
- Each chunk gets independent WhisperX timestamps and transcript text, then `speakerAssignment.ts` overlays Gemini's diarization windows onto WhisperX words by timestamp overlap
- Assigned timestamps are offset back to global time coordinates

### Speaker Assignment Module (Timestamp Overlap)

The pipeline includes a speaker assignment module that combines Gemini's diarization with WhisperX's precise timestamps:

```
cloud-run-orchestrator/src/pipeline.ts (runPipeline)
        │
        │ 1. WhisperX (timestamps + transcript text)
        ▼
┌──────────────────────────────┐
│  Cloud Run GPU WhisperX      │
│  (word-level timestamps      │
│   + transcript text)         │
│  IAM-authenticated HTTP      │
└──────────────┬───────────────┘
               │
               │ 2. Gemini Pass 1 (text-only)
               ▼
┌──────────────────────────────┐
│  extractSpeakerIntelligence  │
│  ├─ Parses WhisperX text     │
│  ├─ Extracts names + anchors │
│  ├─ Encodes address inversion│
│  └─ Returns SpeakerIntel or  │
│     null (graceful fallback) │
└──────────────┬───────────────┘
               │
               │ 3. Gemini Pass 2 (audio + context)
               ▼
┌──────────────────────────────┐
│  Speaker diarization windows │
│  ├─ Injected SpeakerIntel    │
│  │  context (or truncated    │
│  │  transcript if Pass 1     │
│  │  failed)                  │
│  └─ Approximate timestamps   │
│     (no transcript text)     │
└──────────────┬───────────────┘
               │
               │ 4. speakerAssignment.ts
               ▼
┌──────────────────────────────┐
│  Timestamp-Overlap Assignment│
│  ├─ For each WhisperX word:  │
│  │  find Gemini diarization  │
│  │  window with any overlap  │
│  └─ Assign speaker from      │
│     matching window           │
└──────────────┬───────────────┘
               │
               ▼
          Success or
          Hard Failure
          (no fallback)
```

**Key Components:**

- `functions/src/alignment.ts` - WhisperX Cloud Run GPU calls
- `functions/src/speakerAssignment.ts` - Timestamp-overlap speaker assignment (copied to orchestrator's `_functions/` by `copy-functions-modules.sh`)
- Calls WhisperX via IAM-authenticated HTTP to Cloud Run GPU service
- `WHISPER_SERVICE_URL` stored as Firebase secret

**Failure Behavior:**

- WhisperX is mandatory — if it is unavailable, the pipeline fails with `WHISPERX_UNAVAILABLE`
- No fallback to scaled Gemini timestamps (Gemini's no-text prompt does not return transcript text)
- The `alignmentError` field stores the failure reason

### Playback Flow

```
1. User clicks conversation in Library
        ↓
2. ConversationContext sets activeConversationId
        ↓
3. Viewer mounts, gets activeConversation from context
        ↓
4. useAudioPlayer initializes Audio element
        ↓
5. Audio loads, metadata event fires
        ↓
6. User clicks segment → seek to timestamp
        ↓
7. Audio plays, timeupdate events fire
        ↓
8. activeSegmentIndex updates, UI highlights
```

### Search Flow

```
1. User navigates to /search or clicks Search button
        ↓
2. URL query params parsed (?q=term&dateRange=7d&speakers=A,B&topics=X)
        ↓
3. Search.tsx mounts, initializes from URL or sessionStorage
        ↓
4. useSearch + useSearchFilters hooks orchestrate:
   ├── useDebounce (300ms) prevents search on every keystroke
   ├── useSearchFilters manages filter state + URL/session sync
   └── searchService.searchConversations() runs after debounce
        ↓
5. searchService (client-side) processes:
   ├── Tokenizes query
   ├── Searches all conversation segments (already in memory)
   ├── Applies filters (date range, speakers, topics)
   ├── Ranks matches by relevance
   └── Extracts snippets with ~50-char context windows
        ↓
6. Results grouped by conversation, displayed with:
   ├── Match counts per conversation
   ├── Highlighted snippets (textHighlight.ts)
   ├── Live speaker/topic counts from filtered results
   └── "Load more" pagination (20 results per page)
        ↓
7. "Open in Viewer" → navigate to Viewer with targetSegmentId
        ↓
8. Viewer.tsx scrolls to segment + applies temporary highlight
```

**Filter UI (responsive):**

- **Desktop**: 300px sticky sidebar with collapsible sections
- **Mobile**: Bottom sheet triggered by "Filters (N)" button
  - Drag-to-dismiss gesture (swipe down >80px to close)
  - Backdrop click or Apply button also dismiss

**Key Points:**

- Search runs entirely client-side (no additional Firestore queries)
- Uses conversations already loaded via ConversationContext
- URL syncs with query AND filters for shareable search links
- Browser back/forward restores full filter state
- SessionStorage persists filters when navigating away and returning

### Chat Flow (Backend)

```
1. User asks question about transcript
        ↓
2. chatWithConversation Cloud Function invoked
        ↓
3. Rate limit check (20 queries/day per conversation)
        ↓
4. Fetch conversation from Firestore + verify ownership
        ↓
5. buildChatPrompt constructs context:
   ├── Full transcript with speaker attribution
   ├── Topics, terms, people metadata
   └── System instructions requiring timestamp citations
        ↓
6. Call Gemini API (gemini-2.0-flash-exp)
        ↓
7. Extract segment indices from LLM response
        ↓
8. validateTimestampSources verifies citations:
   ├── Match segment indices to actual segments
   ├── Assign confidence levels (high/medium/low)
   └── Filter out invalid sources
        ↓
9. Calculate cost and record metrics to _metrics collection
        ↓
10. Return structured response with:
    ├── Answer text
    ├── Validated timestamp sources
    ├── Token usage and cost
    ├── Rate limit remaining
    └── isUnanswerable flag
```

**Key Components:**

- `functions/src/chat.ts` - Main Cloud Function
- `functions/src/utils/promptBuilder.ts` - Context-rich prompt construction
- `functions/src/utils/timestampValidation.ts` - Source validation and confidence scoring
- `functions/src/utils/rateLimit.ts` - Firestore-backed rate limiting
- `functions/src/utils/chatMetrics.ts` - Chat-specific metrics recording

**Rate Limiting:**

- 20 queries per conversation per day per user
- Stored in `_chat_rate_limits/{conversationId}_{userId}_{YYYY-MM-DD}`
- Resets daily at midnight UTC
- Uses Firestore transactions for atomic increment

**Unanswerable Questions:**

- LLM instructed to explicitly state when information not in transcript
- `isUnanswerable` flag set based on response patterns
- Empty or low-confidence sources returned for unanswerable questions

### Chat UI Flow (Frontend)

The chat interface is integrated into the Viewer sidebar as a third tab alongside Context and People.

```
┌─────────────────────────────────────────────────────────────┐
│                    Viewer Page                              │
│                                                             │
│  ┌───────────────────┐              ┌──────────────────┐   │
│  │  Transcript       │              │  Sidebar         │   │
│  │  View             │              │                  │   │
│  │                   │              │  [Context|People │   │
│  │  Audio Player     │              │   |Chat ③]       │   │
│  │  (synchronized)   │              │                  │   │
│  └───────────────────┘              │  ┌────────────┐  │   │
│                                     │  │ Chat Panel │  │   │
│                                     │  └────────────┘  │   │
│                                     └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**Component Hierarchy:**

```
Viewer.tsx
├── useChat({ conversationId })
│   ├── messages: ChatMessage[]
│   ├── draftInput: string
│   ├── sendMessage(msg: string)
│   └── isLoading, error states
│
├── Sidebar.tsx
│   ├── activeTab: 'context' | 'people' | 'chat'
│   ├── chatMessageCount badge on tab
│   │
│   └── ChatSidebar.tsx (when activeTab === 'chat')
│       ├── Header: title + duration
│       ├── Empty state with example questions
│       ├── Message list (scrollable)
│       │   └── ChatMessage.tsx × N
│       │       ├── User/Assistant avatar
│       │       ├── Message content
│       │       ├── CostIndicator (assistant only)
│       │       └── Timestamp sources (clickable links)
│       │
│       └── ChatInput.tsx (fixed at bottom)
│           ├── Auto-resizing textarea
│           ├── Enter to submit, Shift+Enter for newline
│           └── Send button
```

**State Management:**

1. **useChatHistory Hook** (`hooks/useChatHistory.ts`):
   - Real-time Firestore listener for message synchronization
   - Loads most recent 10 messages initially
   - Provides `loadOlder()` for pagination (batches of 10)
   - Tracks message count for 50 message limit enforcement
   - Automatic cleanup on conversation change/unmount
   - Works across devices (messages sync in real-time)

2. **useChat Hook** (`hooks/useChat.ts`):
   - Manages draft input (persists across tab switches)
   - Handles message sending and persistence
   - Checks message count limit (50 messages per conversation)
   - Calls chatHistoryService to persist both user and assistant messages
   - Error handling and loading states

3. **Chat History Service** (`services/chatHistoryService.ts`):
   - Firestore CRUD for `conversations/{id}/chatHistory` subcollection
   - Real-time subscriptions with pagination support
   - Batch deletion for clear history
   - Export to JSON with clean formatting
   - Message count tracking for limit enforcement

4. **Chat Service** (`services/chatService.ts`):
   - Wrapper around Firebase callable: `httpsCallable(functions, 'chatWithConversation')`
   - Client-side validation (message length, empty check)
   - Error transformation from Firebase error codes

**User Flow:**

```
1. User clicks Chat tab in Sidebar
        ↓
2. useChatHistory subscribes to Firestore chatHistory subcollection
        ↓
3. Most recent 10 messages loaded from Firestore
        ↓
4. If no messages, empty state shows example questions
        ↓
5. User types question in ChatInput
        ↓
6. Press Enter → sendMessage() called
        ↓
7. User message persisted to Firestore via chatHistoryService
        ↓
8. Real-time listener adds user message to UI instantly
        ↓
9. Loading spinner appears
        ↓
10. Backend processes request (see Chat Flow above)
        ↓
11. Assistant response persisted to Firestore via chatHistoryService
        ↓
12. Real-time listener adds assistant response to UI
        ↓
13. Timestamp sources rendered as clickable links
        ↓
14. Click timestamp → scroll to segment + seek audio
        ↓
15. If user has older messages, "Load older" button appears
        ↓
16. Click "Load older" → previous 10 messages loaded
```

**Timestamp Citations:**

- Format: `[▶ 12:34 - Speaker Name]`
- Clicking navigates to segment and seeks audio
- Uses existing `handleNavigateToSegment()` + `seek()` from Viewer
- Blue pill styling matching design system

**Empty State:**

- Shows when `messages.length === 0`
- Provides 4 example questions:
  - "What are the main topics discussed?"
  - "Who are the key people mentioned?"
  - "What decisions were made?"
  - "Can you summarize the conversation?"

**Error Handling:**

- Rate limit exceeded → dismissible error banner
- Network errors → dismissible error banner
- Failed messages do not persist to Firestore

**Chat History Persistence:**

- Messages stored in Firestore `conversations/{id}/chatHistory` subcollection
- Real-time synchronization across tabs and devices
- Survives page reloads and browser restarts
- Automatically cleaned up when parent conversation is deleted
- Draft input persists when switching tabs (in-memory only)

**Message Limits:**

- 50 message limit per conversation (user + assistant combined)
- Warning indicator at 45 messages (yellow badge)
- Blocking indicator at 50 messages (red badge + disabled input)
- Clear history resets count to 0

**Chat History Controls:**

- **Export**: Downloads all messages as JSON with metadata
- **Clear**: Batch deletes all messages (with confirmation modal)
- **Load Older**: Pagination for loading previous messages (10 at a time)
- Message count display: `X/50` with color-coded warnings

### Two-Way Selection Sync

```
Transcript → Sidebar:
  Click term in segment → onTermClick(termId)
  → useTranscriptSelection.handleTermClickInTranscript()
  → setSelectedTermId → scroll sidebar card into view

Sidebar → Transcript:
  Click term card → onTermSelect(termId)
  → useTranscriptSelection.handleTermClickInSidebar()
  → setSelectedTermId → scroll segment into view
```

## Security Model

### Authentication

- **Firebase Auth**: Google OAuth 2.0
- **Token Management**: Automatic refresh by Firebase SDK
- **Session Persistence**: `LOCAL` (survives browser restart)

### Data Isolation

All Firestore queries include `userId` filter:

```typescript
query(collection(db, 'conversations'), where('userId', '==', user.uid));
```

### Security Rules

```javascript
// Firestore
match /conversations/{conversationId} {
  allow read, write: if request.auth != null
    && resource.data.userId == request.auth.uid;
}

// Admin-only metrics collection
match /_metrics/{doc} {
  allow read: if isAdmin();
  allow write: if false;  // Only Cloud Functions can write
}

// Storage
match /audio/{userId}/{fileName} {
  allow read, write: if request.auth != null
    && request.auth.uid == userId;
}
```

### Admin Role

Admin users have access to the observability dashboard. Admin status is determined by the `isAdmin` field in the user's Firestore document:

```
users/{userId}
├── isAdmin: boolean    // Grants access to admin dashboard
├── email: string
└── ...
```

The `AuthContext` fetches this field on login and exposes `isAdmin` to the app. The `AdminRoute` component gates admin-only content.

## Observability System

The observability system provides comprehensive metrics, cost tracking, and usage analytics for both admins and regular users.

### Data Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                    Cloud Functions                                │
│                                                                  │
│  ┌───────────────┐    ┌──────────────┐    ┌─────────────────┐   │
│  │ transcribe.ts │───▶│  metrics.ts  │───▶│ _metrics/{id}   │   │
│  │               │    │  (LLM usage, │    └─────────────────┘   │
│  │ Gemini +      │    │   costs)     │                          │
│  │ WhisperX      │    └──────────────┘                          │
│  └───────────────┘                                              │
│                                                                  │
│  ┌───────────────────┐    ┌──────────────────────────────────┐  │
│  │ statsTriggers.ts  │───▶│ _user_events, _user_stats        │  │
│  │ (onCreate/Delete) │    │ (per-user aggregates)            │  │
│  └───────────────────┘    └──────────────────────────────────┘  │
│                                                                  │
│  ┌───────────────────┐    ┌──────────────────────────────────┐  │
│  │ statsAggregator   │───▶│ _global_stats, _daily_stats      │  │
│  │ (scheduled 2AM)   │    │ (system-wide aggregates)         │  │
│  └───────────────────┘    └──────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                       Frontend                                   │
│                                                                  │
│  ┌────────────────┐    ┌───────────────────┐                    │
│  │ metricsService │───▶│ hooks/useMetrics  │                    │
│  │ (Firestore     │    │ (React state)     │                    │
│  │  queries)      │    └─────────┬─────────┘                    │
│  └────────────────┘              │                              │
│                                  ▼                              │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                   UI Components                          │    │
│  │  ┌──────────────┐  ┌─────────────┐  ┌────────────────┐  │    │
│  │  │ AdminDash    │  │ UserStats   │  │ PricingManager │  │    │
│  │  │ (admin)      │  │ (all users) │  │ (admin)        │  │    │
│  │  └──────────────┘  └─────────────┘  └────────────────┘  │    │
│  └─────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

### Firestore Collections

| Collection      | Purpose                                | Writers         | Readers           |
| --------------- | -------------------------------------- | --------------- | ----------------- |
| `_metrics`      | Per-job processing details + LLM usage | Cloud Functions | Admin             |
| `_user_events`  | Activity audit trail                   | Cloud Functions | Admin             |
| `_user_stats`   | Pre-computed user aggregates           | Cloud Functions | Owner, Admin      |
| `_global_stats` | System-wide aggregates                 | Cloud Functions | Admin             |
| `_daily_stats`  | Time-series for charts                 | Cloud Functions | Admin             |
| `_pricing`      | LLM pricing configuration              | Admin           | All authenticated |

See [Data Model](data-model.md) for detailed schemas.

### LLM Usage Tracking

Each processing job captures LLM usage from Gemini and WhisperX:

```typescript
llmUsage: {
  geminiAnalysis: {
    inputTokens: number;           // Total input tokens (backward compat)
    audioInputTokens?: number;     // Tokens from audio input (WAV)
    textInputTokens?: number;      // Tokens from text input
    outputTokens: number;
    model: string;  // e.g., 'gemini-3-flash'
  };
  whisperx: {
    computeTimeSeconds: number;  // Cloud Run GPU compute time (timestamps only)
    model: string;  // 'whisperx-timestamps'
  };
}
```

### Billing Cost Tracking

The cost tracking system supports estimated vs. actual cost comparison through several mechanisms:

**BigQuery Billing Sync (v2.2.0+)**: Actual Gemini costs are synced from BigQuery billing exports:

- `syncBillingCosts` Cloud Function runs daily at 4 AM UTC
- Queries BigQuery billing exports using `conversation_id` labels
- Updates `_metrics` documents with `actualCost` field for comparison
- Admin dashboard shows variance between estimated and actual costs

**Pricing Snapshots**: Each `_metrics` document includes a `pricingSnapshot` capturing:

- The exact rates used for cost calculation
- The `_pricing` document IDs (or null if not configured)
- Audio vs. text input rate breakdown
- The timestamp when pricing was looked up

This enables historical cost recalculation even after prices change.

**Important**: Pricing configuration is **required**. The `_pricing` collection must have records for `gemini-3-flash`, `gemini-3-flash-text`, and `whisperx`. Missing pricing results in $0 costs with warnings.

**Vertex AI Request Labels**: All Gemini API calls include billing attribution labels (`functions/src/utils/llmMetadata.ts`):

- `conversation_id`: Correlates costs with specific conversations
- `user_id`: Enables per-user cost tracking
- `call_type`: Distinguishes between different Gemini operations (pre_analysis, analysis, chat, etc.)
- `environment`: Separates production vs. emulator costs

These labels appear in BigQuery billing exports for automatic cost attribution and comparison with usage metrics.

### Cost Calculation

Costs are calculated using database-driven pricing configuration:

```typescript
// Gemini (token-based, with audio/text separation as of v2.2.0)
// Audio tokens (pre-analysis): $1/1M, Text tokens (transcript analysis): $0.30/1M
geminiCost =
  (audioInputTokens * audioInputPricePerMillion) / 1_000_000 +
  (textInputTokens * textInputPricePerMillion) / 1_000_000 +
  (outputTokens * outputPricePerMillion) / 1_000_000;

// Cloud Run GPU (time-based, timestamps only)
whisperxCost = computeTimeSeconds * pricePerSecond;
```

Pricing is looked up by model and timestamp, supporting historical accuracy as prices change. As of v2.2.0, audio and text input tokens are tracked separately for more accurate cost calculation.

**Important**: For WhisperX, we use **actual GPU compute time** from the Cloud Run response, not wall-clock duration. Wall-clock time includes cold start and network latency, which would inflate cost estimates.

### User Activity Tracking

Firestore triggers capture user activity:

```typescript
// On conversation create
onConversationCreated → recordUserEvent('conversation_created') → updateUserStats

// On conversation delete
onConversationDeleted → recordUserEvent('conversation_deleted') → updateUserStats

// On processing complete (in transcribe.ts)
recordUserEvent('processing_completed', { durationMs, estimatedCostUsd })
```

### Rolling Window Stats

User stats maintain three time windows:

- **Lifetime**: All-time totals
- **Last 7 Days**: Rolling week
- **Last 30 Days**: Rolling month

Rolling windows are recalculated during the scheduled aggregation job.

### Admin Dashboard

Five-tab interface for administrators:

1. **Overview**: Global stats cards, time-series charts (jobs, costs, usage)
2. **Users**: User list with drill-down to individual user metrics
3. **Jobs**: Processing history table with expandable details and drill-down to job detail view
4. **Chat**: Chat activity aggregated by conversation with pricing migration warnings
5. **Pricing**: View/add LLM pricing configurations

### Job Detail View

Accessed via `/admin/jobs/:metricId` when clicking a job row in the Jobs tab. Shows comprehensive job-level observability:

**Timing Breakdown:**

- Visual progress bars showing relative time spent in each phase
- Detailed millisecond-level timing for: download, WhisperX, segment building, Gemini analysis, speaker correction, transform, and Firestore write operations

**LLM Usage:**

- Per-call token counts for Gemini Analysis and Speaker Correction
- WhisperX compute time for billing verification

**Pricing Snapshot:**

- Captured rates used at job execution time
- Enables historical cost verification even after pricing changes

**Cost Verification:**

- "Estimated vs Current" comparison using `CostVerificationBadge`
- Visual indicators: ✓ (green) for variance <1%, ⚠️ (yellow) for 1-5%, ❌ (red) for >5%
- Hover tooltip shows detailed variance breakdown

### Chat Metrics Tab

Aggregates chat queries by conversation, showing:

- Query count per conversation
- Total tokens (input/output breakdown)
- Average response time
- Total cost per conversation
- Last query timestamp

**Pricing Migration Warning:**

- Displayed when any chat metrics lack `pricingSnapshot` field
- Indicates billing audit data is not yet available for those queries
- Helps track rollout of pricing snapshot feature

### Cost Comparison Report

Accessible at `/admin/reports/cost-comparison`. Provides billing verification workflow:

**Period Summaries:**

- Weekly or monthly aggregation toggle
- Per-service breakdown (Gemini, WhisperX, Chat)
- Estimated vs recalculated cost comparison
- Variance highlighting (rows >5% variance shown in red)
- Status badges: ✓ Match, ⚠️ Minor, ❌ Significant

**Pricing Change Log:**

- All pricing configuration changes within the date range
- Effective dates and rate details
- Notes field for tracking why pricing changed

**CSV Export:**

- Finance-friendly export format
- Columns: Period, Service, Jobs, Estimated Cost, Recalculated Cost, Variance, Variance %
- Filename includes export date for tracking

**Variance Thresholds:**

- Match: <1% variance
- Minor: 1-5% variance (yellow)
- Significant: >5% variance (red)

### Cost Verification Badge

Reusable component that appears in:

- MetricsTable expanded rows
- Job Detail page cost comparison section

**Functionality:**

- Calls `recalculateCostWithCurrentPricing()` to compare stored cost against current pricing
- Memoized to avoid redundant computation
- Hover tooltip shows detailed breakdown: original cost, recalculated cost, variance amount and percentage
- Falls back gracefully when pricing snapshot is missing (older docs)

**Variance Calculation:**
For processing metrics:

```typescript
// Recalculate using current pricing
geminiCost = lookup(model).inputPrice * tokens...
whisperxCost = lookup(model).pricePerSecond * seconds...
variance = recalculatedCost - originalCost
variancePercent = (variance / originalCost) * 100
```

For chat metrics:

```typescript
chatCost =
  lookup(model).inputPrice * inputTokens +
  lookup(model).outputPrice * outputTokens;
variance = recalculatedCost - originalCost;
```

### User Stats Page

Personal usage statistics for all users:

- Lifetime totals (conversations, audio hours, estimated cost)
- 7-day and 30-day rolling windows
- Recent processing jobs table

**Pricing Accuracy Indicator:**

- Shows comparison of stored pricing snapshot vs current pricing configuration
- Visual badge: ✓ Match (<1%), ⚠️ Minor (1-5%), ❌ Significant (>5%)
- Displays timestamp when rates were captured
- Includes disclaimer about configured vs actual billing rates
- Admin users see link to detailed cost breakdown in admin dashboard

**Cost Display Centralization:**

- Inline cost indicators removed from upload/delete/abort modals
- Cost details consolidated in My Stats page for accuracy
- Prevents displaying ad-hoc cost guesses during active processing

Access: All authenticated users can view their own stats via "My Stats" in Library header.

### Scheduled Aggregation

The `computeGlobalStats` Cloud Function runs daily at 2 AM UTC:

1. Queries all `_user_stats` documents
2. Computes global totals and rolling windows
3. Recalculates user rolling windows from `_user_events`
4. Writes to `_global_stats/current` and `_daily_stats/{date}`

### Security Model

```javascript
// Admin-only collections
match /_metrics/{doc} { allow read: if isAdmin(); allow write: if false; }
match /_user_events/{doc} { allow read: if isAdmin(); allow write: if false; }
match /_global_stats/{doc} { allow read: if isAdmin(); allow write: if false; }
match /_daily_stats/{doc} { allow read: if isAdmin(); allow write: if false; }

// User stats - owner or admin
match /_user_stats/{userId} {
  allow read: if request.auth.uid == userId || isAdmin();
  allow write: if false;
}

// Pricing - anyone can read (for cost display), admin can write
match /_pricing/{pricingId} {
  allow read: if request.auth != null;
  allow write: if isAdmin();
}
```

## Offline Support

Firebase provides automatic offline persistence:

```typescript
const db = initializeFirestore(app, {
  cacheSizeBytes: 100 * 1024 * 1024, // 100MB
});
```

Behavior:

- Reads from cache first (instant)
- Writes queue locally, sync when online
- Real-time listeners work offline with cached data

## Performance Considerations

### Optimizations

1. **Real-time Listeners**: Firestore `onSnapshot` instead of polling
2. **Audio Streaming**: Signed URLs for direct streaming from Storage
3. **Lazy Loading**: Conversation content loaded on demand
4. **Drift Correction**: Timestamps scaled once on first load

### Bundle Size

| Module           | Size (gzipped) |
| ---------------- | -------------- |
| React + ReactDOM | ~45KB          |
| Firebase SDK     | ~35KB          |
| Application Code | ~25KB          |
| Tailwind CSS     | ~10KB          |

## Deployment Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   GitHub        │────▶│  GitHub Actions │
│   Repository    │     │  (CI/CD)        │
└─────────────────┘     └────────┬────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
                    ▼                         ▼
           ┌──────────────┐          ┌──────────────┐
           │  Cloud Run   │          │   Firebase   │
           │  (Frontend)  │          │  Functions   │
           │              │          │  + Rules     │
           └──────────────┘          └──────────────┘
                                            │
                                     ┌──────┴──────┐
                                     ▼             ▼
                              ┌──────────┐  ┌──────────┐
                              │ Gemini   │  │Cloud Run │
                              │ API      │  │WhisperX  │
                              └──────────┘  └──────────┘
```

**Parallel Deployment:** Frontend and Firebase Functions deploy simultaneously on merge to main.

## Google Cloud Infrastructure

### Vertex AI SDK Integration

The application uses the `@google-cloud/vertexai` SDK for Gemini API calls (migrated from `@google/generative-ai` to enable billing labels). Cloud Functions authenticate automatically using the default service account.

**Environment Variables:**

- `GCLOUD_PROJECT` or `GCP_PROJECT`: Auto-detected by Cloud Functions
- `VERTEX_AI_LOCATION`: Defaults to `us-central1` if not set

**Required IAM Permission:**

- The Cloud Functions service account (`PROJECT@appspot.gserviceaccount.com`) requires `roles/aiplatform.endpoints.predict` to call Vertex AI models.

**WhisperX Cloud Run Integration:**

- `alignTimestamps()` calls the WhisperX Cloud Run GPU service via IAM-authenticated HTTP for word-level timestamps and transcript text; `speakerAssignment.ts` then overlays Gemini diarization windows by timestamp overlap
- Compute time tracked in `_metrics` documents for cost attribution
- `WHISPER_SERVICE_URL` secret stores the Cloud Run service URL

### Required APIs

The application requires the following Google Cloud APIs:

| API                                 | Service             | Purpose                                                          |
| ----------------------------------- | ------------------- | ---------------------------------------------------------------- |
| `aiplatform.googleapis.com`         | Vertex AI           | Gemini API calls with billing labels                             |
| `cloudfunctions.googleapis.com`     | Cloud Functions     | Serverless function execution                                    |
| `cloudscheduler.googleapis.com`     | Cloud Scheduler     | Scheduled functions (daily stats aggregation)                    |
| `cloudbuild.googleapis.com`         | Cloud Build         | Build container images for functions                             |
| `artifactregistry.googleapis.com`   | Artifact Registry   | Store container images                                           |
| `run.googleapis.com`                | Cloud Run           | Functions v2 runtime (functions run as containers)               |
| `eventarc.googleapis.com`           | Eventarc            | Route Storage events to Cloud Functions                          |
| `pubsub.googleapis.com`             | Pub/Sub             | Event message delivery (used by Eventarc)                        |
| `secretmanager.googleapis.com`      | Secret Manager      | Secure storage for GEMINI_API_KEY, WHISPER_SERVICE_URL, HF_TOKEN |
| `firestore.googleapis.com`          | Firestore           | NoSQL database                                                   |
| `storage.googleapis.com`            | Cloud Storage       | Audio file storage                                               |
| `iamcredentials.googleapis.com`     | IAM Credentials     | Workload Identity for CI/CD                                      |
| `cloudbilling.googleapis.com`       | Cloud Billing       | Project billing verification                                     |
| `firebaseextensions.googleapis.com` | Firebase Extensions | Firebase deployment features                                     |

### Cloud Functions v2 Event Pipeline

When an audio file is uploaded to Storage, this event pipeline triggers transcription:

```
┌──────────────────┐
│  Firebase        │
│  Storage         │
│  (audio upload)  │
└────────┬─────────┘
         │ onObjectFinalized event
         ▼
┌──────────────────┐     ┌──────────────────┐
│  Cloud Storage   │────▶│  Pub/Sub         │
│  Service Agent   │     │  (event message) │
│  @gs-project-    │     └────────┬─────────┘
│  accounts.iam    │              │
└──────────────────┘              ▼
                        ┌──────────────────┐
                        │  Eventarc        │
                        │  Service Agent   │
                        │  @gcp-sa-        │
                        │  eventarc.iam    │
                        └────────┬─────────┘
                                 │ routes to
                                 ▼
                        ┌──────────────────┐
                        │  Cloud Run       │
                        │  (Functions v2)  │
                        │                  │
                        │  transcribeAudio │
                        └────────┬─────────┘
                                 │ calls
                                 ▼
                        ┌──────────────────┐
                        │  Secret Manager  │
                        │  GEMINI_API_KEY  │
                        │  WHISPER_SERVICE │
                        │  _URL            │
                        └────────┬─────────┘
                                 │
                        ┌────────┴────────┐
                        ▼                 ▼
                ┌──────────────┐  ┌──────────────┐
                │  Gemini API  │  │  Cloud Run   │
                │  (Gemini 3)  │  │  (WhisperX)  │
                └──────┬───────┘  └──────┬───────┘
                       │                 │
                       └────────┬────────┘
                                │
                                ▼
                        ┌──────────────────────┐
                        │  speakerAssignment   │
                        │  (timestamp overlap) │
                        └────────┬─────────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │  Firestore       │
                        │  (save results)  │
                        └──────────────────┘
```

### Service Accounts

#### User-Managed Service Accounts

| Service Account                                       | Purpose                 | Key Roles                                                                          |
| ----------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `firebase-adminsdk-*@PROJECT.iam.gserviceaccount.com` | CI/CD deployment        | Cloud Functions Admin, Cloud Scheduler Admin, Secret Manager Admin, Firebase Admin |
| `PROJECT@appspot.gserviceaccount.com`                 | Cloud Functions runtime | Secret Manager Secret Accessor (auto-granted)                                      |

#### Google-Managed Service Agents

These are automatically created and managed by Google Cloud:

| Service Agent | Format                                                            | Purpose                               | Required Role                                       |
| ------------- | ----------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------- |
| Storage       | `service-PROJECT_NUM@gs-project-accounts.iam.gserviceaccount.com` | Publish storage events                | `roles/pubsub.publisher`                            |
| Pub/Sub       | `service-PROJECT_NUM@gcp-sa-pubsub.iam.gserviceaccount.com`       | Create auth tokens for event delivery | `roles/iam.serviceAccountTokenCreator`              |
| Eventarc      | `service-PROJECT_NUM@gcp-sa-eventarc.iam.gserviceaccount.com`     | Read storage bucket metadata          | `objectViewer` on bucket                            |
| Compute       | `PROJECT_NUM-compute@developer.gserviceaccount.com`               | Invoke Cloud Run, receive events      | `roles/run.invoker`, `roles/eventarc.eventReceiver` |

### IAM Role Dependencies

```
                    ┌─────────────────────────────────┐
                    │         GitHub Actions          │
                    │    (FIREBASE_SERVICE_ACCOUNT)   │
                    └───────────────┬─────────────────┘
                                    │ authenticates as
                                    ▼
┌───────────────────────────────────────────────────────────────────┐
│                    firebase-adminsdk-* SA                         │
├───────────────────────────────────────────────────────────────────┤
│  roles/cloudfunctions.admin    → deploy functions                 │
│  roles/cloudscheduler.admin    → manage scheduled functions       │
│  roles/firebaserules.admin     → deploy security rules            │
│  roles/firebase.admin          → Firebase Extensions API          │
│  roles/storage.admin           → manage Storage                   │
│  roles/datastore.user          → read/write Firestore             │
│  roles/iam.serviceAccountUser  → act as runtime SA                │
│  roles/secretmanager.admin     → manage secrets, grant access     │
└───────────────────────────────────────────────────────────────────┘
                                    │
                                    │ grants access to
                                    ▼
┌───────────────────────────────────────────────────────────────────┐
│                    PROJECT@appspot.gserviceaccount.com            │
│                         (Runtime SA)                              │
├───────────────────────────────────────────────────────────────────┤
│  roles/secretmanager.secretAccessor → read GEMINI_API_KEY,        │
│                                         WHISPER_SERVICE_URL       │
│  (auto-granted by Firebase during deployment)                     │
└───────────────────────────────────────────────────────────────────┘
```

### CI/CD Pipeline Flow

```
┌──────────────┐    ┌──────────────┐
│   GitHub     │    │   GitHub     │
│   Push/PR    │───▶│   Actions    │
└──────────────┘    └──────┬───────┘
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
┌─────────────────────────┐  ┌─────────────────────────┐
│   deploy-frontend       │  │ deploy-firebase-        │
│                         │  │ functions               │
│  Cloud Build → GCR      │  │                         │
│  → Cloud Run deploy     │  │  npm ci → npm build     │
│  → Health check         │  │  → firebase deploy      │
│                         │  │    --only functions     │
└─────────────────────────┘  └─────────────────────────┘
        │                            │
        ▼                            ▼
┌─────────────────────────┐  ┌─────────────────────────┐
│  Cloud Run (Frontend)   │  │  Firebase Functions     │
│  - React SPA            │  │  - transcribeAudio      │
│  - Static assets        │  │  - newPipeline.ts       │
└─────────────────────────┘  │  - alignment.ts          │
                             └─────────────────────────┘
```

**Parallel Execution:** Both jobs run simultaneously (~3-4 min total).

## Related Documentation

- [Data Model](data-model.md) - Firestore schema and types
- [Design Decisions](../explanation/design-decisions.md) - Why we built it this way
- [Firebase Setup](../how-to/firebase-setup.md) - Configuration guide
