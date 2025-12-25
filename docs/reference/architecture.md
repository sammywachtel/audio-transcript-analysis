# Architecture Reference

Technical architecture of the Audio Transcript Analysis App.

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         User Browser                            │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    React Application                        ││
│  │  ┌─────────┐  ┌─────────────────┐  ┌───────────────────┐    ││
│  │  │  Auth   │  │  Conversation   │  │      Pages        │    ││
│  │  │ Context │  │    Context      │  │ Library / Viewer  │    ││
│  │  └────┬────┘  └────────┬────────┘  └─────────────────┬─┘    ││
│  │       │                │                              │     ││
│  │       └────────────────┼──────────────────────────────┘     ││
│  │                        │                                    ││
│  │  ┌─────────────────────┴─────────────────────────────────┐  ││
│  │  │                   Firebase SDK                        │  ││
│  │  │  Auth │ Firestore (real-time) │ Storage │ Functions   │  ││
│  │  └───────────────────────────────────────────────────────┘  ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTPS
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                        Firebase                                  │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐    │
│  │  Firebase    │  │  Firestore   │  │  Firebase Storage    │    │
│  │  Auth        │  │  Database    │  │  (Audio Blobs)       │    │
│  └──────────────┘  └──────────────┘  └──────────────────────┘    │
│                                              │                   │
│                                              │ onObjectFinalized │
│                                              ▼                   │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │                   Cloud Functions                         │   │
│  │                                                           │   │
│  │  ┌────────────────────┐    ┌────────────────────────┐     │   │
│  │  │  transcribeAudio   │    │    getAudioUrl         │     │   │
│  │  │  (Storage trigger) │    │    (HTTPS callable)    │     │   │
│  │  │                    │    └────────────────────────┘     │   │
│  │  │  ┌──────────────┐  │                                   │   │
│  │  │  │  alignment   │  │  ← HARDY algorithm (internal)     │   │
│  │  │  │  module      │  │                                   │   │
│  │  │  └──────────────┘  │                                   │   │
│  │  └─────────┬──────────┘                                   │   │
│  │            │                                              │   │
│  └────────────┼──────────────────────────────────────────────┘   │
│               │                                                  │
└───────────────┼──────────────────────────────────────────────────┘
                │
        ┌───────┴───────┐
        ▼               ▼
┌──────────────┐  ┌──────────────┐
│  Gemini API  │  │ Replicate    │
│  (Google AI) │  │ (WhisperX)   │
└──────────────┘  └──────────────┘
```

## Component Architecture

### Frontend Layers

```
Pages (Library, Viewer)
        │
        ├── use contexts ────┐
        │                    │
        ▼                    ▼
    Hooks              Contexts
    ├── useAudioPlayer      ├── AuthContext
    ├── usePersonMentions   └── ConversationContext
    └── useTranscriptSelection
        │
        └── use services ────┐
                             │
                             ▼
                        Services
                        ├── firestoreService
                        └── storageService
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
│   └── viewer/             # Transcript viewer components
│       ├── AudioPlayer.tsx
│       ├── Sidebar.tsx
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
│   ├── usePersonMentions.ts
│   └── useTranscriptSelection.ts
├── pages/                  # Page components
│   ├── Library.tsx         # Conversation list + upload
│   ├── Viewer.tsx          # Transcript viewer
│   └── AdminDashboard.tsx  # Processing metrics (admin-only)
├── services/               # Firebase services
│   ├── firestoreService.ts
│   └── storageService.ts
├── functions/              # Cloud Functions (Node.js)
│   └── src/
│       ├── index.ts        # Function exports
│       ├── transcribe.ts   # WhisperX + Gemini analysis
│       ├── alignment.ts    # WhisperX integration via Replicate
│       ├── metrics.ts      # Processing metrics recording
│       └── logger.ts       # Structured logging utility
├── types.ts                # TypeScript types
├── utils.ts                # Helper functions
└── firebase-config.ts      # Firebase initialization
```

## Data Flow

### Upload Flow

```
1. User selects audio file
        ↓
2. Frontend uploads to Firebase Storage
   storageService.uploadAudio(file)
        ↓
3. Frontend creates Firestore doc (status: 'processing', alignmentStatus: 'pending')
   firestoreService.save(conversation)
        ↓
4. Storage trigger fires Cloud Function
   onObjectFinalized → transcribeAudio()
        ↓
5. Function downloads audio, calls Gemini API for transcription
        ↓
6. Function calls WhisperX alignment service for precise timestamps
   ├── Success → alignmentStatus: 'aligned'
   └── Failure → alignmentStatus: 'fallback' (keeps Gemini timestamps)
        ↓
7. Function writes results to Firestore (status: 'complete')
        ↓
8. Real-time listener updates UI
   onSnapshot → setConversations()
```

### Alignment Module (HARDY Algorithm)

The Cloud Function includes an integrated alignment module that provides precise timestamps using WhisperX via Replicate:

```
Cloud Function (transcribeAudio)
        │
        │ 1. Gemini API (transcription + speaker diarization)
        ▼
┌──────────────────────────────┐
│  Segments with approximate   │
│  timestamps from Gemini      │
└──────────────┬───────────────┘
               │
               │ 2. alignment.ts (HARDY algorithm)
               ▼
┌──────────────────────────────┐
│  Replicate WhisperX API      │
│  (word-level timestamps)     │
└──────────────┬───────────────┘
               │
               │ 3. Fuzzy matching + anchor-based alignment
               ▼
┌──────────────────────────────┐
│  HARDY 4-Level Alignment     │
│  ├─ Level 1: Anchor Points   │
│  ├─ Level 2: Region Segment  │
│  ├─ Level 3: Regional Align  │
│  └─ Level 4: Validation      │
└──────────────┬───────────────┘
               │
       ┌───────┴───────┐
       │               │
       ▼               ▼
  Success           Failure
  alignmentStatus:  alignmentStatus:
  'aligned'         'fallback'
  (~50ms accuracy)  (uses Gemini
                    timestamps)
```

**Key Components:**
- `functions/src/alignment.ts` - HARDY algorithm implementation
- Uses `fuzzball` for fuzzy string matching
- Uses `replicate` SDK for WhisperX API calls
- `REPLICATE_API_TOKEN` stored as Firebase secret

**Fallback Behavior:**
- If WhisperX times out or fails, the Cloud Function uses Gemini's original timestamps
- The `alignmentError` field stores the reason for fallback
- Client displays "Fallback Sync" badge with tooltip explaining the issue
- Timestamps are still usable but may be ~5-10 seconds off

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
query(
  collection(db, 'conversations'),
  where('userId', '==', user.uid)
)
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

## Observability

### Metrics Collection

Processing metrics are recorded to `_metrics` collection after each transcription job:

```typescript
interface ProcessingMetrics {
  conversationId: string;
  userId: string;
  status: 'success' | 'failed';
  errorMessage?: string;
  timingMs: {
    download: number;
    whisperx: number;
    buildSegments: number;
    gemini: number;
    speakerCorrection: number;
    transform: number;
    firestore: number;
    total: number;
  };
  segmentCount: number;
  speakerCount: number;
  speakerCorrectionsApplied: number;
  audioSizeMB: number;
  durationMs: number;
  timestamp: Timestamp;
}
```

### Admin Dashboard

The `AdminDashboard` page displays aggregate metrics:
- Total jobs, success rate, failed jobs
- Average processing times (total, Gemini, WhisperX)
- Speaker corrections applied
- Recent processing jobs table with per-user visibility

Only users with `isAdmin: true` can access this page.

## Offline Support

Firebase provides automatic offline persistence:

```typescript
const db = initializeFirestore(app, {
  cacheSizeBytes: 100 * 1024 * 1024 // 100MB
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

| Module | Size (gzipped) |
|--------|----------------|
| React + ReactDOM | ~45KB |
| Firebase SDK | ~35KB |
| Application Code | ~25KB |
| Tailwind CSS | ~10KB |

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
                              │ Gemini   │  │Replicate │
                              │ API      │  │WhisperX  │
                              └──────────┘  └──────────┘
```

**Parallel Deployment:** Frontend and Firebase Functions deploy simultaneously on merge to main.

## Google Cloud Infrastructure

### Required APIs

The application requires the following Google Cloud APIs:

| API | Service | Purpose |
|-----|---------|---------|
| `cloudfunctions.googleapis.com` | Cloud Functions | Serverless function execution |
| `cloudbuild.googleapis.com` | Cloud Build | Build container images for functions |
| `artifactregistry.googleapis.com` | Artifact Registry | Store container images |
| `run.googleapis.com` | Cloud Run | Functions v2 runtime (functions run as containers) |
| `eventarc.googleapis.com` | Eventarc | Route Storage events to Cloud Functions |
| `pubsub.googleapis.com` | Pub/Sub | Event message delivery (used by Eventarc) |
| `secretmanager.googleapis.com` | Secret Manager | Secure storage for GEMINI_API_KEY and REPLICATE_API_TOKEN |
| `firestore.googleapis.com` | Firestore | NoSQL database |
| `storage.googleapis.com` | Cloud Storage | Audio file storage |
| `iamcredentials.googleapis.com` | IAM Credentials | Workload Identity for CI/CD |
| `cloudbilling.googleapis.com` | Cloud Billing | Project billing verification |
| `firebaseextensions.googleapis.com` | Firebase Extensions | Firebase deployment features |

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
                        │  REPLICATE_TOKEN │
                        └────────┬─────────┘
                                 │
                        ┌────────┴────────┐
                        ▼                 ▼
                ┌──────────────┐  ┌──────────────┐
                │  Gemini API  │  │  Replicate   │
                │ (transcript) │  │  (WhisperX)  │
                └──────┬───────┘  └──────┬───────┘
                       │                 │
                       └────────┬────────┘
                                │
                                ▼
                        ┌──────────────────┐
                        │  alignment.ts    │
                        │  (HARDY match)   │
                        └────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │  Firestore       │
                        │  (save results)  │
                        └──────────────────┘
```

### Service Accounts

#### User-Managed Service Accounts

| Service Account | Purpose | Key Roles |
|-----------------|---------|-----------|
| `firebase-adminsdk-*@PROJECT.iam.gserviceaccount.com` | CI/CD deployment | Cloud Functions Admin, Secret Manager Admin, Firebase Admin |
| `PROJECT@appspot.gserviceaccount.com` | Cloud Functions runtime | Secret Manager Secret Accessor (auto-granted) |

#### Google-Managed Service Agents

These are automatically created and managed by Google Cloud:

| Service Agent | Format | Purpose | Required Role |
|---------------|--------|---------|---------------|
| Storage | `service-PROJECT_NUM@gs-project-accounts.iam.gserviceaccount.com` | Publish storage events | `roles/pubsub.publisher` |
| Pub/Sub | `service-PROJECT_NUM@gcp-sa-pubsub.iam.gserviceaccount.com` | Create auth tokens for event delivery | `roles/iam.serviceAccountTokenCreator` |
| Eventarc | `service-PROJECT_NUM@gcp-sa-eventarc.iam.gserviceaccount.com` | Read storage bucket metadata | `objectViewer` on bucket |
| Compute | `PROJECT_NUM-compute@developer.gserviceaccount.com` | Invoke Cloud Run, receive events | `roles/run.invoker`, `roles/eventarc.eventReceiver` |

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
│                                         REPLICATE_API_TOKEN       │
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
│  - Static assets        │  │  - alignment.ts         │
└─────────────────────────┘  │  - getAudioUrl          │
                             └─────────────────────────┘
```

**Parallel Execution:** Both jobs run simultaneously (~3-4 min total).

## Related Documentation

- [Data Model](data-model.md) - Firestore schema and types
- [Design Decisions](../explanation/design-decisions.md) - Why we built it this way
- [Firebase Setup](../how-to/firebase-setup.md) - Configuration guide
