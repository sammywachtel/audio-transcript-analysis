# Backend Integration Implementation Plan

## Overview
This document outlines the plan to migrate from a client-side-only architecture to a cloud-backed system with data persistence, API security, and cross-device sync.

## Current State (Client-Only Architecture)

**What Works:**
- Audio transcription via Gemini 2.5 Flash API (client-side)
- IndexedDB storage for conversations (browser-local)
- Audio blob storage in IndexedDB
- All processing happens in browser

**Limitations:**
1. **No Cross-Device Sync**: Conversations stuck on one device
2. **API Key Exposure**: Gemini API key visible in client code
3. **No Data Backup**: Browser clear = data loss
4. **Processing Limits**: Large audio files limited by browser memory
5. **No Sharing**: Can't share conversations with others
6. **Limited Features**: Can't implement cloud-only features (webhooks, batch processing)

## Goals

1. **Data Persistence**: Store conversations in cloud database
2. **Cross-Device Sync**: Access conversations from any device
3. **API Security**: Move Gemini API calls to backend
4. **Scalability**: Handle larger audio files with server-side processing
5. **Collaboration**: Enable sharing conversations (future)
6. **Offline Support**: Maintain offline-first experience

## Architecture Options

### Option 1: Firebase (Firestore + Cloud Functions) - Recommended
**Pros:**
- Seamless integration with Firebase Auth
- Real-time sync built-in (Firestore listeners)
- Serverless functions for API calls
- File storage via Firebase Storage
- Free tier covers prototype
- Minimal DevOps overhead

**Cons:**
- Vendor lock-in
- Query limitations in Firestore
- Cost scales with usage (storage, reads/writes, function invocations)

**Stack:**
- **Database**: Firestore (NoSQL document store)
- **Storage**: Firebase Storage (audio blobs)
- **Functions**: Cloud Functions for Firebase (transcription API)
- **Auth**: Firebase Authentication (from previous plan)

### Option 2: Custom Backend (Node.js + PostgreSQL)
**Pros:**
- Full control over architecture
- Relational database for complex queries
- No vendor lock-in
- Cost-effective at scale

**Cons:**
- More setup complexity (server, database, deployment)
- Need to handle auth, sync, real-time updates manually
- DevOps overhead (monitoring, scaling, backups)

**Stack:**
- **Backend**: Node.js + Express/Fastify
- **Database**: PostgreSQL (relational) or MongoDB (NoSQL)
- **Storage**: S3 or Google Cloud Storage
- **Deployment**: Railway, Render, or fly.io
- **Auth**: Firebase Auth or custom JWT

### Option 3: Supabase (Open Source Firebase Alternative)
**Pros:**
- Open-source, can self-host
- PostgreSQL database (more powerful than Firestore)
- Real-time subscriptions built-in
- Row-level security (RLS) for data protection
- Generous free tier

**Cons:**
- Smaller ecosystem than Firebase
- Less mature than Firebase
- Need to learn Supabase-specific patterns

**Stack:**
- **Database**: PostgreSQL (via Supabase)
- **Storage**: Supabase Storage
- **Functions**: Supabase Edge Functions (Deno)
- **Auth**: Supabase Auth (supports Google)

## Recommended Approach: Firebase (Firestore + Cloud Functions)

**Rationale:**
1. Already using Firebase Auth (from auth plan)
2. Fastest time-to-market
3. Real-time sync out of the box
4. Minimal backend code to write
5. Proven reliability at scale

## Data Model

### Firestore Collections

```typescript
// conversations/{conversationId}
interface ConversationDoc {
  conversationId: string;
  userId: string; // Owner
  title: string;
  createdAt: Timestamp;
  durationMs: number;
  audioStoragePath: string; // Firebase Storage path

  // Metadata
  audioUrl?: string; // Signed download URL (temporary)
  status: 'processing' | 'ready' | 'error';
  processingError?: string;

  // Analysis results
  speakers: Record<string, Speaker>;
  segments: Segment[];
  terms: Record<string, Term>;
  termOccurrences: TermOccurrence[];
  topics: Topic[];
  people: Person[];

  // Timestamps
  lastModified: Timestamp;
  lastViewed?: Timestamp;
}

// users/{userId}
interface UserDoc {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  createdAt: Timestamp;

  // Preferences
  preferences?: {
    theme?: 'light' | 'dark';
    autoUpload?: boolean;
  };
}

// conversations/{conversationId}/shares/{shareId} (Future)
interface ShareDoc {
  shareId: string;
  conversationId: string;
  sharedBy: string; // userId
  sharedWith: string; // email or userId
  permissions: 'view' | 'edit';
  createdAt: Timestamp;
  expiresAt?: Timestamp;
}
```

### Firestore Security Rules

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Users can only read/write their own user doc
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }

    // Conversations are private to the owner
    match /conversations/{conversationId} {
      allow read, write: if request.auth != null
        && resource.data.userId == request.auth.uid;
      allow create: if request.auth != null
        && request.resource.data.userId == request.auth.uid;
    }

    // TODO: Add sharing rules when implementing collaboration
  }
}
```

## Implementation Phases

### Phase 1: Database Setup
**Tasks:**
1. Create Firestore database
2. Define collections and indexes
3. Set up security rules
4. Create data migration utility (IndexedDB → Firestore)

**Files to Create:**
- `firestore.rules` - Security rules
- `firestore.indexes.json` - Query indexes
- `src/services/firestoreService.ts` - CRUD operations
- `src/utils/migrateToFirestore.ts` - Migration script

**Duration:** 1 day

### Phase 2: Audio Storage
**Tasks:**
1. Set up Firebase Storage
2. Implement audio upload flow
3. Generate signed URLs for playback
4. Handle audio deletion when conversation deleted

**Files to Create:**
- `storage.rules` - Storage security rules
- `src/services/storageService.ts` - Upload/download logic

**Duration:** 1 day

### Phase 3: Backend API (Cloud Functions)
**Tasks:**
1. Move Gemini API calls to Cloud Functions
2. Implement transcription endpoint
3. Handle audio processing server-side
4. Return results to client via Firestore

**Files to Create:**
- `functions/src/index.ts` - Main functions file
- `functions/src/transcribe.ts` - Transcription logic
- `functions/package.json` - Dependencies

**Function Flow:**
```
┌─────────────┐
│ Client      │
│ Uploads     │
│ Audio       │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Firebase    │
│ Storage     │
└──────┬──────┘
       │ Trigger
       ▼
┌─────────────┐
│ Cloud       │
│ Function    │
│ (onFinalize)│
└──────┬──────┘
       │
       │ 1. Download audio
       │ 2. Call Gemini API
       │ 3. Write results to Firestore
       │
       ▼
┌─────────────┐
│ Firestore   │
│ Document    │
│ Updated     │
└──────┬──────┘
       │ Real-time
       │ Listener
       ▼
┌─────────────┐
│ Client      │
│ Shows       │
│ Results     │
└─────────────┘
```

**Duration:** 2 days

### Phase 4: Real-Time Sync
**Tasks:**
1. Replace IndexedDB reads with Firestore listeners
2. Implement optimistic updates
3. Handle offline mode (Firebase offline persistence)
4. Sync local changes on reconnect

**Files to Modify:**
- `src/contexts/ConversationContext.tsx` - Use Firestore instead of IndexedDB
- `src/db.ts` - Keep as local cache layer (optional)

**Duration:** 2 days

### Phase 5: Migration & Cleanup
**Tasks:**
1. Build migration UI (one-time data upload)
2. Test migration with real user data
3. Remove direct Gemini API calls from client
4. Update documentation

**Duration:** 1 day

## API Endpoints (Cloud Functions)

### 1. Transcribe Audio
```typescript
// functions/src/transcribe.ts
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { getFirestore } from 'firebase-admin/firestore';

export const transcribeAudio = onObjectFinalized(async (event) => {
  const filePath = event.data.name; // e.g., "audio/userId/conversationId.mp3"
  const [_, userId, fileName] = filePath.split('/');
  const conversationId = fileName.split('.')[0];

  // 1. Download audio from Storage
  const audioBuffer = await downloadAudio(filePath);

  // 2. Call Gemini API (server-side, using secure API key)
  const result = await processAudioWithGemini(audioBuffer);

  // 3. Write results to Firestore
  const db = getFirestore();
  await db.collection('conversations').doc(conversationId).update({
    status: 'ready',
    speakers: result.speakers,
    segments: result.segments,
    terms: result.terms,
    // ... other fields
    lastModified: FieldValue.serverTimestamp()
  });
});
```

### 2. Generate Audio URL
```typescript
// functions/src/getAudioUrl.ts
import { onCall } from 'firebase-functions/v2/https';
import { getStorage } from 'firebase-admin/storage';

export const getAudioUrl = onCall(async (request) => {
  const { conversationId } = request.data;
  const userId = request.auth?.uid;

  // 1. Verify user owns conversation
  const db = getFirestore();
  const doc = await db.collection('conversations').doc(conversationId).get();
  if (doc.data()?.userId !== userId) {
    throw new Error('Unauthorized');
  }

  // 2. Generate signed URL (expires in 1 hour)
  const storage = getStorage();
  const file = storage.bucket().file(doc.data()?.audioStoragePath);
  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: Date.now() + 3600 * 1000
  });

  return { url };
});
```

## Client-Side Changes

### ConversationContext Refactor

**Before (IndexedDB):**
```typescript
const loadConversations = async () => {
  const convos = await db.conversations.toArray();
  setConversations(convos);
};
```

**After (Firestore + Real-Time):**
```typescript
useEffect(() => {
  if (!user) return;

  const unsubscribe = onSnapshot(
    query(
      collection(firestore, 'conversations'),
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc')
    ),
    (snapshot) => {
      const convos = snapshot.docs.map(doc => ({
        conversationId: doc.id,
        ...doc.data()
      }));
      setConversations(convos);
    }
  );

  return unsubscribe;
}, [user]);
```

### Upload Flow

**Before:**
```typescript
// Client processes audio directly
const result = await processAudioWithGemini(audioFile);
await db.conversations.add(result);
```

**After:**
```typescript
// 1. Upload to Firebase Storage
const storageRef = ref(storage, `audio/${userId}/${conversationId}.mp3`);
await uploadBytes(storageRef, audioFile);

// 2. Create placeholder doc
await setDoc(doc(firestore, 'conversations', conversationId), {
  conversationId,
  userId,
  status: 'processing',
  createdAt: serverTimestamp(),
  audioStoragePath: storageRef.fullPath
});

// 3. Cloud Function processes automatically
// 4. Real-time listener updates UI when ready
```

## Offline Support

Firebase provides offline persistence:

```typescript
import { initializeFirestore, enableIndexedDbPersistence } from 'firebase/firestore';

const db = initializeFirestore(app, {
  cacheSizeBytes: 100 * 1024 * 1024 // 100MB cache
});

enableIndexedDbPersistence(db).catch((err) => {
  if (err.code === 'failed-precondition') {
    // Multiple tabs open
  } else if (err.code === 'unimplemented') {
    // Browser doesn't support
  }
});
```

**Behavior:**
- Reads from cache first (instant)
- Writes go to cache + sync queue
- Auto-sync when back online
- Optimistic updates for better UX

## Cost Estimation (Firebase)

### Free Tier Limits (Spark Plan)
- **Firestore**: 1GB storage, 50K reads/day, 20K writes/day
- **Storage**: 5GB storage, 1GB downloads/day
- **Functions**: 125K invocations/month

### Blaze Plan (Pay-as-you-go)
**Typical Prototype Usage (10 active users, 50 conversations/month):**

- **Firestore**:
  - Storage: ~500MB ($0.09/month)
  - Reads: ~15K/day ($0.18/month)
  - Writes: ~500/day ($0.09/month)

- **Storage**:
  - Audio files: ~2GB ($0.05/month)
  - Bandwidth: ~1GB/month ($0.12/month)

- **Cloud Functions**:
  - Invocations: ~500/month (free tier)
  - Compute time: Minimal ($0.10/month)

**Estimated Total: ~$0.63/month** (well within free tier initially)

## Migration Strategy

### Migrating Existing Users

**Step 1: Automatic Migration on First Sign-In**
```typescript
const migrateLocalData = async (userId: string) => {
  // 1. Get all conversations from IndexedDB
  const localConvos = await db.conversations.toArray();

  // 2. Upload each conversation
  for (const convo of localConvos) {
    // Upload audio to Storage
    const audioBlob = await fetch(convo.audioUrl).then(r => r.blob());
    const storageRef = ref(storage, `audio/${userId}/${convo.conversationId}.mp3`);
    await uploadBytes(storageRef, audioBlob);

    // Create Firestore doc
    await setDoc(doc(firestore, 'conversations', convo.conversationId), {
      ...convo,
      userId,
      audioStoragePath: storageRef.fullPath,
      status: 'ready',
      createdAt: serverTimestamp()
    });
  }

  // 3. Mark migration complete
  localStorage.setItem('migrated', 'true');
};
```

**Step 2: Show Migration Progress**
```typescript
// Show loading modal during migration
<MigrationModal
  onComplete={() => setMigrated(true)}
  conversationCount={localConvos.length}
/>
```

## Security Considerations

1. **API Key Protection**: ✅ Gemini API key only in Cloud Functions
2. **User Data Isolation**: ✅ Firestore rules enforce userId checks
3. **Audio Access Control**: ✅ Signed URLs expire after 1 hour
4. **CORS**: ✅ Cloud Functions handle CORS automatically
5. **Input Validation**: ✅ Validate file size/type before upload

## Testing Strategy

1. **Local Development**:
   - Use Firebase Emulator Suite (Firestore, Storage, Functions)
   - Test offline mode
   - Test migration flow

2. **Integration Tests**:
   - Upload audio → verify transcription
   - Multiple users → verify data isolation
   - Offline → online sync

3. **Load Testing**:
   - Concurrent uploads
   - Large audio files (>50MB)
   - Many simultaneous listeners

## Timeline Estimate

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| Database Setup | 1 day | Firebase Auth complete |
| Audio Storage | 1 day | Phase 1 |
| Backend API | 2 days | Phase 2 |
| Real-Time Sync | 2 days | Phase 3 |
| Migration & Cleanup | 1 day | Phase 4 |
| **Total** | **7 days** | |

## Dependencies

**New npm packages:**
```json
{
  "dependencies": {
    "firebase": "^10.x.x" // Already installed for auth
  },
  "devDependencies": {
    "firebase-tools": "^13.x.x", // CLI for deployment
    "firebase-functions-test": "^3.x.x" // Testing
  }
}
```

**Firebase Functions dependencies:**
```json
{
  "dependencies": {
    "firebase-admin": "^12.x.x",
    "firebase-functions": "^5.x.x",
    "@google/generative-ai": "^0.x.x" // Gemini SDK
  }
}
```

## Rollout Plan

### Phase 1: Soft Launch (Internal Testing)
- Deploy to staging environment
- Test with 2-3 real users
- Monitor costs and performance
- Fix bugs

### Phase 2: Beta (Invite-Only)
- Invite 10-20 beta users
- Collect feedback
- Monitor Firestore usage patterns
- Optimize queries if needed

### Phase 3: Public Launch
- Open sign-ups
- Monitor costs closely
- Implement rate limiting if needed
- Add analytics

## Monitoring & Observability

**Firebase Console:**
- Function invocations and errors
- Firestore read/write counts
- Storage usage and bandwidth

**Custom Logging:**
```typescript
// functions/src/logger.ts
import { logger } from 'firebase-functions/v2';

logger.info('Transcription started', { conversationId, userId });
logger.error('Gemini API error', { error: err.message, conversationId });
```

**Alerts:**
- Function errors > 5% (email notification)
- Storage > 80% of quota
- Firestore writes spike (abnormal usage)

## Future Enhancements

1. **Collaboration**: Share conversations with other users
2. **Export**: Download conversations as JSON/PDF
3. **Search**: Full-text search across all conversations
4. **Webhooks**: Notify external services when transcription completes
5. **Batch Processing**: Process multiple files at once
6. **Speech-to-Speech**: Generate audio summaries

## Alternative: Hybrid Architecture

If you want to keep some processing client-side (faster for small files):

```typescript
// Hybrid approach: small files → client, large files → server
const processAudio = async (audioFile: File) => {
  const MAX_CLIENT_SIZE = 10 * 1024 * 1024; // 10MB

  if (audioFile.size < MAX_CLIENT_SIZE) {
    // Process on client (faster)
    return await processAudioWithGemini(audioFile);
  } else {
    // Upload to server (more reliable for large files)
    await uploadAndProcess(audioFile);
  }
};
```

## Related Documents
- `google-authentication-plan.md` - Prerequisites for backend integration
- `speaker-naming-requirements.md` - Applies to both client and server processing

## Status
- **Current**: Implementation in progress
- **Firebase Project**: `audio-transcript-app-67465`
- **Auth**: ✅ Complete (Google OAuth implemented)

## Implementation Decisions

1. **Hybrid Approach**: Small files (<10MB) processed client-side for speed, larger files use Cloud Functions
2. **Storage Strategy**: Audio files retained indefinitely (user can delete manually)
3. **Quotas**: No limits initially (monitor usage, add if needed)
4. **Pricing**: Free tier initially (Spark plan)
5. **Data Retention**: No auto-deletion policy (users manage their own data)

## Implementation Progress

### Phase 1: Firebase Configuration ✅
- [x] Firebase project created: `audio-transcript-app-67465`
- [x] Firebase Auth enabled with Google Sign-In
- [x] Firestore database config created (`firestore.rules`, `firestore.indexes.json`)
- [x] Firebase Storage config created (`storage.rules`)
- [x] Firebase config file created (`firebase.json`)

### Phase 2: Client Services ✅
- [x] `services/firestoreService.ts` - Firestore CRUD operations with real-time listeners
- [x] `services/storageService.ts` - Audio upload/download with signed URLs
- [x] `firebase-config.ts` updated with Firestore, Storage, and Functions

### Phase 3: Cloud Functions ✅
- [x] `functions/src/transcribe.ts` - Server-side Gemini API calls (triggered on upload)
- [x] `functions/src/getAudioUrl.ts` - Signed URL generation with auth
- [x] `functions/src/index.ts` - Main entry point
- [ ] Deploy functions to Firebase (requires `firebase deploy --only functions`)

### Phase 4: Context Updates ✅
- [x] `ConversationContext.tsx` updated for Firestore real-time listeners
- [x] `Library.tsx` updated with sync status indicator and new upload flow
- [x] `services/migrationService.ts` created for IndexedDB → Firestore migration

### Phase 5: Testing & Deployment
- [ ] Run `npm install` in `functions/` directory
- [ ] Deploy security rules: `npx firebase deploy --only firestore:rules,storage:rules`
- [ ] Deploy Cloud Functions: `npx firebase deploy --only functions`
- [ ] Set Gemini API key secret: `npx firebase functions:secrets:set GEMINI_API_KEY`  <!-- pragma: allowlist secret -->
- [ ] Enable Firestore in Firebase Console
- [ ] Enable Cloud Functions in Firebase Console
- [ ] Set `VITE_USE_FIRESTORE=true` in `.env` to enable cloud mode
- [ ] Test end-to-end upload and sync
- [ ] Verify multi-user data isolation

### Phase 6: CI/CD Setup ✅
- [x] Created `scripts/setup-firebase.sh` - One-time setup script
- [x] Created `scripts/deploy-firebase.sh` - Reusable deployment script
- [x] Created `.github/workflows/firebase-deploy.yml` - GitHub Actions workflow

## CI/CD Configuration

### One-Time Setup (Manual Steps)

These steps must be done once per environment and cannot be fully automated:

1. **Firebase Console Setup**
   - Enable Firestore Database: https://console.firebase.google.com/project/audio-transcript-app-67465/firestore
   - Enable Firebase Storage: https://console.firebase.google.com/project/audio-transcript-app-67465/storage
   - Enable Cloud Functions (requires Blaze plan for external API calls)

2. **Enable Required Google Cloud APIs**

   These APIs must be enabled before deployment will work:
   - [Cloud Functions API](https://console.cloud.google.com/apis/library/cloudfunctions.googleapis.com?project=audio-transcript-app-67465)
   - [Cloud Build API](https://console.cloud.google.com/apis/library/cloudbuild.googleapis.com?project=audio-transcript-app-67465)
   - [Artifact Registry API](https://console.cloud.google.com/apis/library/artifactregistry.googleapis.com?project=audio-transcript-app-67465)
   - [Secret Manager API](https://console.cloud.google.com/apis/library/secretmanager.googleapis.com?project=audio-transcript-app-67465)
   - [Firebase Extensions API](https://console.cloud.google.com/apis/library/firebaseextensions.googleapis.com?project=audio-transcript-app-67465)

   Or via CLI:
   ```bash
   gcloud services enable \
     cloudfunctions.googleapis.com \
     cloudbuild.googleapis.com \
     artifactregistry.googleapis.com \
     secretmanager.googleapis.com \
     firebaseextensions.googleapis.com \
     --project=audio-transcript-app-67465
   ```

3. **Authentication**
   ```bash
   npx firebase login
   npx firebase use audio-transcript-app-67465
   ```

4. **Set Gemini API Secret**
   ```bash
   npx firebase functions:secrets:set GEMINI_API_KEY
   ```

5. **Create Service Account for CI/CD**
   - Go to Firebase Console → Project Settings → Service Accounts
   - Click "Generate new private key"
   - Download the JSON file
   - Add as GitHub Secret: `FIREBASE_SERVICE_ACCOUNT`  <!-- pragma: allowlist secret -->

6. **Configure Service Account IAM Roles**

   The service account needs these roles in Google Cloud IAM:
   - Go to: https://console.cloud.google.com/iam-admin/iam?project=audio-transcript-app-67465
   - Find the service account (email ends in `@audio-transcript-app-67465.iam.gserviceaccount.com`)
   - Click Edit (pencil icon) and add these roles:
     - **Firebase Rules Admin** - Deploy Firestore and Storage security rules
     - **Cloud Functions Admin** - Deploy Cloud Functions
     - **Service Account User** - Allow functions to run as service account
     - **Cloud Datastore User** - Read/write Firestore data
     - **Storage Admin** - Manage Firebase Storage
     - **Firebase Admin** - Access Firebase Extensions API
     - **Secret Manager Secret Accessor** - Read secrets during deployment

   Or via CLI:
   ```bash
   SA_EMAIL="firebase-adminsdk-xxxxx@audio-transcript-app-67465.iam.gserviceaccount.com"
   PROJECT="audio-transcript-app-67465"

   gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:$SA_EMAIL" --role="roles/firebaserules.admin"
   gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:$SA_EMAIL" --role="roles/cloudfunctions.admin"
   gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:$SA_EMAIL" --role="roles/iam.serviceAccountUser"
   gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:$SA_EMAIL" --role="roles/datastore.user"
   gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:$SA_EMAIL" --role="roles/storage.admin"
   gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:$SA_EMAIL" --role="roles/firebase.admin"
   gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:$SA_EMAIL" --role="roles/secretmanager.secretAccessor"
   ```

7. **Add GitHub Secrets**
   - `FIREBASE_SERVICE_ACCOUNT`: Service account JSON key (for deployment)
   - `GEMINI_API_KEY`: Gemini API key (already set via Firebase secrets)

### Automated Deployment (GitHub Actions)

The workflow in `.github/workflows/firebase-deploy.yml` handles:

**Automatic Triggers:**
- Push to `main` branch when Firebase-related files change:
  - `functions/**`
  - `firestore.rules`, `storage.rules`
  - `firestore.indexes.json`
  - `firebase.json`

**Manual Triggers:**
- Go to Actions → Firebase Deploy → Run workflow
- Choose deployment target:
  - `all`: Deploy rules + functions (default)
  - `rules-only`: Deploy Firestore and Storage rules only
  - `functions-only`: Deploy Cloud Functions only

### Local Deployment Scripts

**First-time setup (new developer machine):**
```bash
./scripts/setup-firebase.sh
```

**Deploy changes locally:**
```bash
# Deploy everything
./scripts/deploy-firebase.sh

# Deploy only rules
./scripts/deploy-firebase.sh --rules-only

# Deploy only functions
./scripts/deploy-firebase.sh --functions

# Preview what would be deployed
./scripts/deploy-firebase.sh --dry-run
```

### Environment Recreation

To recreate the Firebase environment from scratch:

1. **Create Firebase Project** (if needed)
   ```bash
   npx firebase projects:create audio-transcript-app-67465
   ```

2. **Run Setup Script**
   ```bash
   ./scripts/setup-firebase.sh
   ```

3. **Configure GitHub Actions**
   - Add `FIREBASE_SERVICE_ACCOUNT` secret to repository
   - Workflow will auto-deploy on push to main

### Cost Monitoring

Firebase Blaze plan is pay-as-you-go. Monitor costs at:
- https://console.firebase.google.com/project/audio-transcript-app-67465/usage/details

Set budget alerts at:
- https://console.cloud.google.com/billing
