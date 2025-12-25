# Data Model Reference

Firestore schema and TypeScript type definitions.

## Firestore Collections

### conversations

Primary collection storing conversation data.

**Path**: `conversations/{conversationId}`

```typescript
interface ConversationDoc {
  // Identity
  conversationId: string;
  userId: string;           // Firebase Auth UID
  title: string;

  // Timestamps
  createdAt: Timestamp;
  updatedAt: Timestamp;

  // Audio
  durationMs: number;
  audioStoragePath: string; // Firebase Storage path

  // Processing
  status: 'processing' | 'complete' | 'failed';
  processingError?: string;

  // Alignment Status
  alignmentStatus?: 'pending' | 'aligned' | 'fallback';
  alignmentError?: string;      // Reason for fallback if applicable

  // Analysis Results
  speakers: Record<string, Speaker>;
  segments: Segment[];
  terms: Record<string, Term>;
  termOccurrences: TermOccurrence[];
  topics: Topic[];
  people: Person[];
}
```

### users

User profile, preferences, and admin status.

**Path**: `users/{userId}`

```typescript
interface UserDoc {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  createdAt: Timestamp;
  isAdmin?: boolean;      // Grants access to admin dashboard
  preferences?: {
    theme?: 'light' | 'dark';
  };
}
```

**Note**: The `isAdmin` field must be manually set in Firestore to grant admin access. There is no self-service admin enrollment.

### _metrics

Processing metrics for observability (admin read-only).

**Path**: `_metrics/{docId}`

```typescript
interface MetricsDoc {
  conversationId: string;
  userId: string;
  status: 'success' | 'failed';
  errorMessage?: string;
  alignmentStatus?: 'aligned' | 'fallback';

  // Stage timings (milliseconds)
  timingMs: {
    download: number;      // Audio download from Storage
    whisperx: number;      // WhisperX transcription + diarization
    buildSegments: number; // Segment construction
    gemini: number;        // Gemini analysis (topics, terms, etc.)
    speakerCorrection: number; // Gemini speaker reassignment
    transform: number;     // Data transformation
    firestore: number;     // Firestore write
    total: number;         // Total processing time
  };

  // Result counts
  segmentCount: number;
  speakerCount: number;
  termCount: number;
  topicCount: number;
  personCount: number;
  speakerCorrectionsApplied: number;

  // Audio metadata
  audioSizeMB: number;
  durationMs: number;

  // Timestamp
  timestamp: Timestamp;
}
```

**Security**: Only Cloud Functions can write to `_metrics`. Only admin users can read.

## TypeScript Types

### Conversation

```typescript
interface Conversation {
  conversationId: string;
  userId: string;
  title: string;
  createdAt: string;          // ISO timestamp
  updatedAt: string;          // ISO timestamp
  durationMs: number;
  audioUrl?: string;          // Temporary signed URL
  status: 'processing' | 'complete' | 'failed';
  alignmentStatus?: 'pending' | 'aligned' | 'fallback';
  alignmentError?: string;    // Reason for fallback
  speakers: Record<string, Speaker>;
  segments: Segment[];
  terms: Record<string, Term>;
  termOccurrences: TermOccurrence[];
  topics: Topic[];
  people: Person[];
}
```

### Speaker

```typescript
interface Speaker {
  speakerId: string;
  displayName: string;        // User-editable name
  colorIndex: number;         // Index into color palette
}
```

### Segment

```typescript
interface Segment {
  segmentId: string;
  index: number;              // Order in transcript
  speakerId: string;
  startMs: number;            // Start time in milliseconds
  endMs: number;              // End time in milliseconds
  text: string;
}
```

### Term

```typescript
interface Term {
  termId: string;
  key: string;                // Normalized term (lowercase)
  display: string;            // Display form
  definition: string;         // AI-generated explanation
  aliases: string[];          // Alternative forms
}
```

### TermOccurrence

```typescript
interface TermOccurrence {
  termId: string;
  segmentId: string;
  startChar: number;          // Character offset in segment
  endChar: number;
}
```

### Topic

```typescript
interface Topic {
  topicId: string;
  label: string;              // Topic title
  startsAfterSegmentIndex: number;
  isTangent: boolean;         // Whether this is a digression
}
```

### Person

```typescript
interface Person {
  personId: string;
  name: string;               // Person's name
  affiliation?: string;       // Company, role, etc.
  userNotes?: string;         // User-added notes
}
```

### PersonOccurrence

Computed at runtime (not stored):

```typescript
interface PersonOccurrence {
  personId: string;
  segmentId: string;
  startChar: number;
  endChar: number;
}
```

## Firebase Storage Structure

```
audio/
└── {userId}/
    └── {conversationId}.{ext}
```

**Example**: `audio/abc123/conv-456.mp3`

### Storage Rules

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /audio/{userId}/{fileName} {
      allow read, write: if request.auth != null
        && request.auth.uid == userId;

      // Max file size: 100MB
      allow write: if request.resource.size < 100 * 1024 * 1024;

      // Only audio/video files
      allow write: if request.resource.contentType.matches('audio/.*')
        || request.resource.contentType.matches('video/.*');
    }
  }
}
```

## Firestore Security Rules

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Helper: Check if user is admin
    function isAdmin() {
      return request.auth != null &&
        exists(/databases/$(database)/documents/users/$(request.auth.uid)) &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.isAdmin == true;
    }

    match /users/{userId} {
      allow read, write: if request.auth != null
        && request.auth.uid == userId;
    }

    match /conversations/{conversationId} {
      // Read: must be owner
      allow read: if request.auth != null
        && resource.data.userId == request.auth.uid;

      // Create: must set userId to own uid
      allow create: if request.auth != null
        && request.resource.data.userId == request.auth.uid;

      // Update: must be owner
      allow update: if request.auth != null
        && resource.data.userId == request.auth.uid;

      // Delete: must be owner
      allow delete: if request.auth != null
        && resource.data.userId == request.auth.uid;
    }

    // Metrics collection - admin read only, Cloud Functions write only
    match /_metrics/{doc} {
      allow read: if isAdmin();
      allow write: if false;  // Only Cloud Functions can write
    }
  }
}
```

## Firestore Indexes

```json
{
  "indexes": [
    {
      "collectionGroup": "conversations",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "userId", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    }
  ]
}
```

## Service API

### FirestoreService

```typescript
interface FirestoreService {
  // Subscribe to user's conversations (real-time)
  subscribeToUserConversations(
    userId: string,
    callback: (conversations: Conversation[]) => void
  ): () => void;  // Returns unsubscribe function

  // Save conversation
  save(conversation: Conversation): Promise<void>;

  // Update conversation
  update(conversation: Partial<Conversation>): Promise<void>;

  // Delete conversation
  delete(conversationId: string): Promise<void>;

  // Get single conversation
  getById(conversationId: string): Promise<Conversation | null>;
}
```

### StorageService

```typescript
interface StorageService {
  // Upload audio file
  uploadAudio(
    userId: string,
    conversationId: string,
    file: File
  ): Promise<string>;  // Returns storage path

  // Get signed download URL
  getAudioUrl(storagePath: string): Promise<string>;

  // Delete audio file
  deleteAudio(storagePath: string): Promise<void>;
}
```

## Cloud Function Schemas

### transcribeAudio (Storage Trigger)

**Trigger**: `onObjectFinalized` on `audio/{userId}/{fileName}`

**Process**:
1. Download audio from Storage
2. Call Gemini API with audio
3. Parse structured response
4. Update Firestore document

**Gemini Response Schema**:

```typescript
interface GeminiResponse {
  title: string;
  speakers: Array<{
    id: string;
    name: string;
  }>;
  segments: Array<{
    speakerId: string;
    startMs: number;
    endMs: number;
    text: string;
  }>;
  terms: Array<{
    key: string;
    display: string;
    definition: string;
    aliases: string[];
  }>;
  topics: Array<{
    label: string;
    startsAfterSegmentIndex: number;
    isTangent: boolean;
  }>;
  people: Array<{
    name: string;
    affiliation?: string;
  }>;
}
```

### getAudioUrl (HTTPS Callable)

**Request**:
```typescript
{ conversationId: string }
```

**Response**:
```typescript
{ url: string }  // Signed URL valid for 1 hour
```

## Related Documentation

- [Architecture](architecture.md) - System design
- [Firebase Setup](../how-to/firebase-setup.md) - Configuration
