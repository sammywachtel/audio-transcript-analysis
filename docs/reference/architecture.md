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
│  │  └─────────┬──────────┘    └────────────────────────┘     │   │
│  │            │                                              │   │
│  └────────────┼──────────────────────────────────────────────┘   │
│               │                                                  │
└───────────────┼──────────────────────────────────────────────────┘
                │
                ▼
┌──────────────────────────┐
│      Gemini API          │
│   (Google AI Studio)     │
└──────────────────────────┘
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
│   │   └── ProtectedRoute.tsx
│   └── viewer/             # Transcript viewer components
│       ├── AudioPlayer.tsx
│       ├── Sidebar.tsx
│       ├── TranscriptSegment.tsx
│       ├── TranscriptView.tsx
│       ├── TopicMarker.tsx
│       └── ViewerHeader.tsx
├── contexts/               # React contexts
│   ├── AuthContext.tsx     # Authentication state
│   └── ConversationContext.tsx
├── hooks/                  # Custom React hooks
│   ├── useAudioPlayer.ts
│   ├── useAutoScroll.ts
│   ├── usePersonMentions.ts
│   └── useTranscriptSelection.ts
├── pages/                  # Page components
│   ├── Library.tsx         # Conversation list + upload
│   └── Viewer.tsx          # Transcript viewer
├── services/               # Firebase services
│   ├── firestoreService.ts
│   └── storageService.ts
├── functions/              # Cloud Functions (Node.js)
│   └── src/
│       ├── index.ts        # Function exports
│       └── transcribe.ts   # Gemini transcription
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
3. Frontend creates Firestore doc (status: 'processing')
   firestoreService.save(conversation)
        ↓
4. Storage trigger fires Cloud Function
   onObjectFinalized → transcribeAudio()
        ↓
5. Function downloads audio, calls Gemini API
        ↓
6. Function writes results to Firestore (status: 'complete')
        ↓
7. Real-time listener updates UI
   onSnapshot → setConversations()
```

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

// Storage
match /audio/{userId}/{fileName} {
  allow read, write: if request.auth != null
    && request.auth.uid == userId;
}
```

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
           │  (Frontend)  │          │  (Backend)   │
           └──────────────┘          └──────────────┘
```

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
| `secretmanager.googleapis.com` | Secret Manager | Secure storage for GEMINI_API_KEY |
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
                        │  (GEMINI_API_KEY)│
                        └────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │  Gemini API      │
                        │  (transcription) │
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
│  roles/secretmanager.secretAccessor → read GEMINI_API_KEY         │
│  (auto-granted by Firebase during deployment)                     │
└───────────────────────────────────────────────────────────────────┘
```

### CI/CD Pipeline Flow

```
┌──────────────┐    ┌──────────────┐    ┌──────────────────────────┐
│   GitHub     │    │   GitHub     │    │    Google Cloud          │
│   Push/PR    │───▶│   Actions    │───▶│                          │
└──────────────┘    └──────┬───────┘    │  ┌────────────────────┐  │
                           │            │  │ google-github-     │  │
                           │            │  │ actions/auth@v2    │  │
                           │            │  │ (sets up ADC)      │  │
                           │            │  └─────────┬──────────┘  │
                           │            │            │             │
                           │            │            ▼             │
                           │            │  ┌────────────────────┐  │
                           │            │  │ Firebase CLI       │  │
                           │            │  │ firebase deploy    │  │
                           │            │  └─────────┬──────────┘  │
                           │            │            │             │
                           │            │   ┌───────┴───────┐     │
                           │            │   ▼               ▼     │
                           │            │ Rules          Functions │
                           │            │ (Firestore,    (Cloud    │
                           │            │  Storage)       Run)     │
                           │            └──────────────────────────┘
```

## Related Documentation

- [Data Model](data-model.md) - Firestore schema and types
- [Design Decisions](../explanation/design-decisions.md) - Why we built it this way
- [Firebase Setup](../how-to/firebase-setup.md) - Configuration guide
