# Design Decisions

Explanation of key architectural and technical decisions.

## Why Firebase?

**Decision**: Use Firebase (Firestore, Storage, Cloud Functions, Auth) as the backend.

**Alternatives Considered**:
1. **Custom Backend (Node.js + PostgreSQL)**: Full control, but more DevOps overhead
2. **Supabase**: Open-source, but smaller ecosystem
3. **AWS (DynamoDB + Lambda + S3)**: Powerful, but more complex setup

**Rationale**:
- **Real-time sync built-in**: Firestore `onSnapshot` provides instant updates
- **Minimal DevOps**: No servers to manage, automatic scaling
- **Integrated auth**: Firebase Auth works seamlessly with Firestore rules
- **Generous free tier**: Covers prototype and early production
- **Familiar to team**: Previous Firebase experience

**Trade-offs**:
- Vendor lock-in to Google ecosystem
- Firestore query limitations (no joins, limited indexing)
- Cost can spike with heavy usage

## Why Server-Side Gemini?

**Decision**: Call Gemini API from Cloud Functions instead of the browser.

**Previous Approach**: Client-side API calls with key in environment variables.

**Rationale**:
- **Security**: API key not exposed in browser bundle
- **Rate limiting**: Can implement per-user quotas
- **Processing limits**: Server has more memory for large files
- **Monitoring**: Centralized logging and error tracking

**Trade-offs**:
- Added latency (function cold starts)
- More complex deployment
- Costs for Cloud Functions invocations

## Why Real-Time Listeners?

**Decision**: Use Firestore `onSnapshot` for data instead of REST calls.

**Rationale**:
- **Instant updates**: UI updates immediately when data changes
- **Offline support**: Firebase SDK handles caching automatically
- **Reduced polling**: No need to refresh or poll for updates
- **Simpler code**: One subscription handles all updates

**Implementation**:
```typescript
const unsubscribe = onSnapshot(
  query(collection(db, 'conversations'), where('userId', '==', uid)),
  (snapshot) => setConversations(snapshot.docs.map(doc => doc.data()))
);
```

## Why Separate Audio Storage?

**Decision**: Store audio files in Firebase Storage, not Firestore.

**Rationale**:
- **Firestore document limit**: 1MB max per document
- **Streaming**: Storage provides efficient audio streaming
- **Cost**: Storage is cheaper than Firestore for large blobs
- **CDN**: Storage has built-in CDN for fast delivery

**Flow**:
1. Upload audio to Storage
2. Store path reference in Firestore document
3. Generate signed URL when user wants to play

## Why Cloud Run for Frontend?

**Decision**: Deploy React SPA to Cloud Run instead of Firebase Hosting.

**Alternatives Considered**:
1. **Firebase Hosting**: Static hosting, simpler setup
2. **Vercel/Netlify**: Popular for React apps
3. **Cloud Run**: Container-based, more control

**Rationale**:
- **Consistency**: Already using Google Cloud for backend
- **Custom server**: Can add server-side logic if needed
- **Same billing**: Unified billing with Firebase
- **Docker**: Familiar deployment model

## Why React Context Over Redux?

**Decision**: Use React Context for state management.

**Rationale**:
- **Simpler**: No additional library needed
- **Sufficient**: App state is straightforward (conversations, auth)
- **Type-safe**: Easy TypeScript integration
- **Hooks-based**: Natural fit with functional components

**Implementation**:
```typescript
const { conversations, addConversation } = useConversations();
```

**When to reconsider**:
- Complex state interactions
- Need for middleware (logging, persistence)
- Performance issues with context re-renders

## Why Custom Hooks?

**Decision**: Extract complex logic into custom hooks.

**Hooks Created**:
- `useAudioPlayer`: Playback, seeking, drift correction
- `usePersonMentions`: Regex detection and mapping
- `useTranscriptSelection`: Two-way sync between transcript and sidebar
- `useAutoScroll`: Auto-scroll to active segment

**Rationale**:
- **Separation of concerns**: Logic separate from rendering
- **Testability**: Hooks can be tested in isolation
- **Reusability**: Same hook can be used in multiple components
- **Readability**: Components stay focused on presentation

**Example - Before**:
```typescript
// Viewer.tsx (516 lines)
const [isPlaying, setIsPlaying] = useState(false);
const [currentTime, setCurrentTime] = useState(0);
// ... 200 more lines of audio logic
```

**Example - After**:
```typescript
// Viewer.tsx (195 lines)
const { isPlaying, currentTime, togglePlay } = useAudioPlayer(conversation);
```

## Why Drift Correction?

**Decision**: Automatically scale timestamps if audio duration doesn't match transcript.

**Problem**: Gemini sometimes estimates timestamps that don't match actual audio duration.

**Example**:
- Audio duration: 3 minutes (180,000ms)
- Last segment ends: 2.5 minutes (150,000ms)
- Difference: 30 seconds (20%)

**Solution**:
```typescript
if (driftRatio > 1.05 || driftRatio < 0.95) {
  // Scale all timestamps by ratio
  segments = segments.map(s => ({
    ...s,
    startMs: s.startMs * driftRatio,
    endMs: s.endMs * driftRatio
  }));
}
```

**Trade-offs**:
- Linear scaling assumes uniform drift (not always true)
- Only runs once on first load (not re-evaluated)
- Could be more sophisticated with word-level alignment

## Why IndexedDB Offline Cache?

**Decision**: Enable Firebase offline persistence for local caching.

**Rationale**:
- **Instant loads**: Data available immediately from cache
- **Offline support**: App works without network
- **Automatic sync**: Firebase handles conflict resolution
- **No extra code**: Built into Firebase SDK

**Configuration**:
```typescript
const db = initializeFirestore(app, {
  cacheSizeBytes: 100 * 1024 * 1024 // 100MB
});
```

## Why Google-Only Auth?

**Decision**: Only support Google Sign-In (no email/password, social providers).

**Rationale**:
- **Simplest**: One flow to implement and test
- **Secure**: Delegated to Google, no password storage
- **User base**: Most users have Google accounts
- **Firebase integration**: Seamless with Firebase Auth

**Future consideration**: Add email/password if users request it.

## Why Tailwind CSS?

**Decision**: Use Tailwind CSS for styling.

**Rationale**:
- **Rapid development**: Utility classes are fast to write
- **Consistent**: Standardized spacing, colors, typography
- **No context switching**: Stay in JSX, no separate CSS files
- **Tree-shaking**: Only includes used utilities

**Trade-offs**:
- Long class strings can be hard to read
- Learning curve for utility-first approach
- Need PostCSS build step (handled by Vite)

## Evolution and Future

### Decisions That Worked Well
- Real-time Firestore listeners (smooth UX)
- Custom hooks (great code organization)
- Firebase for auth + database (fast development)

### Decisions to Revisit
- Client-side audio processing (may need WebWorkers for large files)
- Single-region deployment (may need multi-region for latency)
- Context-based state (may need Redux for complex features)

### Planned Improvements
- Add WhisperX alignment for better timestamps
- Implement collaboration features
- Add export functionality (PDF, Markdown)
