# Quick Reference Guide

## Directory Structure

```
audio-transcript-analysis-app/
│
├── services/                    # Data layer
│   ├── conversationStorage.ts   # IndexedDB operations
│   ├── transcriptionService.ts  # Gemini API integration
│   └── index.ts                 # Barrel export
│
├── contexts/                    # State management
│   └── ConversationContext.tsx  # Global conversation state
│
├── hooks/                       # Reusable logic
│   ├── useAudioPlayer.ts        # Audio playback & sync
│   ├── usePersonMentions.ts     # Person detection
│   ├── useTranscriptSelection.ts # Selection state
│   ├── useAutoScroll.ts         # Auto-scroll behavior
│   └── index.ts                 # Barrel export
│
├── components/                  # Presentation
│   ├── Button.tsx               # Reusable button
│   └── viewer/                  # Viewer components
│       ├── ViewerHeader.tsx
│       ├── TranscriptView.tsx
│       ├── TranscriptSegment.tsx
│       ├── TopicMarker.tsx
│       ├── Sidebar.tsx
│       ├── AudioPlayer.tsx
│       └── RenameSpeakerModal.tsx
│
├── pages/                       # Page components
│   ├── Library.tsx              # List + upload
│   └── Viewer.tsx               # Transcript viewer
│
├── App.tsx                      # Root + routing
├── types.ts                     # TypeScript types
├── utils.ts                     # Helper functions
└── constants.ts                 # Mock data
```

---

## Import Cheat Sheet

### Services
```typescript
// IndexedDB operations
import { conversationStorage } from '../services/conversationStorage';
await conversationStorage.save(conversation);
await conversationStorage.loadAll();
await conversationStorage.delete(id);

// Gemini API
import { transcriptionService } from '../services/transcriptionService';
const conversation = await transcriptionService.processAudio(file);

// Or use barrel export
import { conversationStorage, transcriptionService } from '../services';
```

### Context
```typescript
import { useConversations } from '../contexts/ConversationContext';

const {
  conversations,        // Conversation[]
  activeConversation,   // Conversation | null
  isLoaded,            // boolean
  addConversation,     // (conv: Conversation) => Promise<void>
  updateConversation,  // (conv: Conversation) => Promise<void>
  deleteConversation,  // (id: string) => Promise<void>
  setActiveConversationId // (id: string | null) => void
} = useConversations();
```

### Hooks
```typescript
// Audio player
import { useAudioPlayer } from '../hooks/useAudioPlayer';
const {
  isPlaying, currentTime, duration,
  activeSegmentIndex, isSyncing,
  togglePlay, seek, scrub
} = useAudioPlayer(conversation, {
  audioUrl: conversation.audioUrl,
  initialDuration: conversation.durationMs,
  segments: conversation.segments,
  onDriftCorrected: (fixed) => updateConversation(fixed)
});

// Person mentions
import { usePersonMentions } from '../hooks/usePersonMentions';
const { mentionsMap, personOccurrences } = usePersonMentions(
  conversation.people,
  conversation.segments
);

// Selection state
import { useTranscriptSelection } from '../hooks/useTranscriptSelection';
const {
  selectedTermId, selectedPersonId,
  handleTermClickInTranscript,
  handleTermClickInSidebar,
  handlePersonClickInSidebar
} = useTranscriptSelection({ termOccurrences });

// Auto-scroll
import { useAutoScroll } from '../hooks/useAutoScroll';
useAutoScroll(isPlaying, activeSegmentIndex, segments);

// Or use barrel export
import {
  useAudioPlayer,
  usePersonMentions,
  useTranscriptSelection,
  useAutoScroll
} from '../hooks';
```

---

## Data Flow Diagrams

### Application Startup
```
┌─────────┐
│ App.tsx │
└────┬────┘
     │
     ├─ Wraps with ConversationProvider
     │
     ├─ Provider mounts
     │  └─> useEffect calls loadConversations()
     │      └─> conversationStorage.loadAll()
     │          └─> IndexedDB.getAll('conversations')
     │              └─> Recreate Blob URLs from stored Blobs
     │                  └─> setConversations(loaded)
     │
     └─ Renders AppContent
        └─> useConversations() gets loaded data
            └─> Renders Library or Viewer based on route
```

### Upload Flow
```
User selects file
      ↓
UploadModal.handleStartUpload()
      ↓
transcriptionService.processAudio(file)
      ↓
┌─────────────────────────────────┐
│ Gemini API Processing          │
│ 1. Convert file → base64       │
│ 2. Send to gemini-2.5-flash    │
│ 3. Parse JSON response          │
│ 4. Transform to Conversation    │
└─────────────────────────────────┘
      ↓
Returns Conversation object
      ↓
UploadModal calls handleUpload(conversation)
      ↓
useConversations().addConversation(conversation)
      ↓
conversationStorage.save(conversation)
      ↓
IndexedDB.put('conversations', conversation)
      ↓
Context updates state
      ↓
Library re-renders with new item
```

### Audio Playback with Drift Correction
```
Viewer mounts
      ↓
useAudioPlayer(conversation, options)
      ↓
Creates new Audio(audioUrl)
      ↓
Audio fires 'loadedmetadata' event
      ↓
┌─────────────────────────────────────────┐
│ Drift Detection Logic                  │
│                                         │
│ audioDuration = 180000ms                │
│ lastSegment.endMs = 150000ms            │
│ ratio = 180000 / 150000 = 1.2           │
│ diff = 30000ms > 2000ms                 │
│ ratio 1.2 > 1.05 threshold              │
│ ∴ DRIFT DETECTED                        │
│                                         │
│ Scale all segments:                     │
│   seg.startMs *= 1.2                    │
│   seg.endMs *= 1.2                      │
└─────────────────────────────────────────┘
      ↓
Calls onDriftCorrected(fixedConversation)
      ↓
Viewer.updateConversation(fixedConversation)
      ↓
Context persists to storage
      ↓
UI reflects corrected timestamps
```

### Two-Way Selection Sync
```
TRANSCRIPT → SIDEBAR:
  User clicks term in segment
        ↓
  TranscriptSegment.onTermClick(termId)
        ↓
  Viewer.handleTermClickInTranscript(termId)
        ↓
  useTranscriptSelection sets selectedTermId
        ↓
  Hook finds card element by ID
        ↓
  document.getElementById('term-card-{id}')
        ↓
  Scrolls card into view


SIDEBAR → TRANSCRIPT:
  User clicks term card
        ↓
  Sidebar.onTermSelect(termId)
        ↓
  Viewer.handleTermClickInSidebar(termId)
        ↓
  useTranscriptSelection sets selectedTermId
        ↓
  Hook finds first occurrence
        ↓
  Finds segment element by ID
        ↓
  Scrolls segment into view
```

---

## Common Use Cases

### Adding a New Conversation
```typescript
import { useConversations } from '../contexts/ConversationContext';

const MyComponent = () => {
  const { addConversation } = useConversations();

  const handleAdd = async () => {
    const newConv: Conversation = { /* ... */ };
    await addConversation(newConv); // Persists + updates UI
  };
};
```

### Updating Conversation Data
```typescript
const { activeConversation, updateConversation } = useConversations();

const handleRename = (newTitle: string) => {
  if (activeConversation) {
    updateConversation({
      ...activeConversation,
      title: newTitle
    });
  }
};
```

### Processing Audio File
```typescript
import { transcriptionService } from '../services';

const handleUpload = async (file: File) => {
  try {
    const conversation = await transcriptionService.processAudio(file);
    await addConversation(conversation);
  } catch (err) {
    console.error('Processing failed:', err);
  }
};
```

### Using Audio Player
```typescript
const audio = useAudioPlayer(conversation, {
  audioUrl: conversation.audioUrl,
  initialDuration: conversation.durationMs,
  segments: conversation.segments,
  onDriftCorrected: (fixed) => {
    setLocalConversation(fixed);
    updateConversation(fixed);
  }
});

return (
  <AudioPlayer
    isPlaying={audio.isPlaying}
    onPlayPause={audio.togglePlay}
    onSeek={audio.seek}
    currentTimeMs={audio.currentTime}
    durationMs={audio.duration}
  />
);
```

---

## TypeScript Type Reference

### Core Types
```typescript
interface Conversation {
  conversationId: string;
  title: string;
  createdAt: string;
  durationMs: number;
  audioUrl?: string;
  status: 'processing' | 'needs_review' | 'complete' | 'failed';
  speakers: Record<string, Speaker>;
  segments: Segment[];
  terms: Record<string, Term>;
  termOccurrences: TermOccurrence[];
  topics: Topic[];
  people: Person[];
}

interface Speaker {
  speakerId: string;
  displayName: string;
  colorIndex: number;
}

interface Segment {
  segmentId: string;
  index: number;
  speakerId: string;
  startMs: number;
  endMs: number;
  text: string;
}

interface Term {
  termId: string;
  key: string;
  display: string;
  definition: string;
  aliases: string[];
}

interface Person {
  personId: string;
  name: string;
  affiliation?: string;
  userNotes?: string;
}
```

### Service Types
```typescript
class ConversationStorageService {
  save(conversation: Conversation): Promise<void>;
  loadAll(): Promise<Conversation[]>;
  loadById(id: string): Promise<Conversation | null>;
  delete(id: string): Promise<void>;
  clearAll(): Promise<void>;
}

class TranscriptionService {
  processAudio(file: File): Promise<Conversation>;
}
```

### Hook Types
```typescript
// useAudioPlayer return type
interface UseAudioPlayerReturn {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  activeSegmentIndex: number;
  isSyncing: boolean;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  togglePlay: () => void;
  seek: (ms: number) => void;
  scrub: (ms: number) => void;
  setIsPlaying: (playing: boolean) => void;
}

// usePersonMentions return type
interface UsePersonMentionsReturn {
  mentionsMap: Record<string, string[]>;
  personOccurrences: Record<string, PersonOccurrence[]>;
}

// useTranscriptSelection return type
interface UseTranscriptSelectionReturn {
  selectedTermId: string | undefined;
  selectedPersonId: string | undefined;
  selectTerm: (termId: string) => void;
  selectPerson: (personId: string) => void;
  clearSelection: () => void;
  handleTermClickInTranscript: (termId: string) => void;
  handleTermClickInSidebar: (termId: string) => void;
  handlePersonClickInSidebar: (personId: string) => void;
}
```

---

## Component Props Reference

### Page Components
```typescript
// Library
interface LibraryProps {
  onOpen: (id: string) => void;
}

// Viewer
interface ViewerProps {
  onBack: () => void;
}
```

### Viewer Sub-Components
```typescript
// ViewerHeader
interface ViewerHeaderProps {
  title: string;
  createdAt: string;
  isSyncing: boolean;
  onBack: () => void;
}

// TranscriptView
interface TranscriptViewProps {
  conversation: Conversation;
  activeSegmentIndex: number;
  selectedTermId?: string;
  selectedPersonId?: string;
  personOccurrences: Record<string, PersonOccurrence[]>;
  onSeek: (ms: number) => void;
  onTermClick: (termId: string) => void;
  onRenameSpeaker: (speakerId: string) => void;
}

// RenameSpeakerModal
interface RenameSpeakerModalProps {
  initialName: string;
  onClose: () => void;
  onSave: (name: string) => void;
}

// AudioPlayer
interface AudioPlayerProps {
  durationMs: number;
  currentTimeMs: number;
  isPlaying: boolean;
  onPlayPause: () => void;
  onSeek: (ms: number) => void;
  onScrub?: (ms: number) => void;
}
```

---

## File Size Reference

| File | Lines | Purpose |
|------|-------|---------|
| **Services** |
| conversationStorage.ts | 139 | IndexedDB CRUD |
| transcriptionService.ts | 279 | Gemini API |
| **Context** |
| ConversationContext.tsx | 140 | Global state |
| **Hooks** |
| useAudioPlayer.ts | 180 | Audio playback |
| usePersonMentions.ts | 90 | Person detection |
| useTranscriptSelection.ts | 74 | Selection sync |
| useAutoScroll.ts | 25 | Auto-scroll |
| **Components** |
| ViewerHeader.tsx | 52 | Header bar |
| TranscriptView.tsx | 64 | Transcript render |
| RenameSpeakerModal.tsx | 54 | Rename dialog |
| **Pages** |
| App.tsx | 56 | Root + routing |
| Viewer.tsx | 195 | Viewer orchestration |
| Library.tsx | 310 | List + upload |

---

## Testing Strategy (Future)

### Services
```typescript
// Mock storage
jest.mock('../services/conversationStorage');
conversationStorage.loadAll.mockResolvedValue([mockConv]);

// Test service directly
test('loads conversations', async () => {
  const convs = await conversationStorage.loadAll();
  expect(convs).toHaveLength(1);
});
```

### Hooks
```typescript
import { renderHook, act } from '@testing-library/react-hooks';
import { useAudioPlayer } from '../useAudioPlayer';

test('toggles playback', () => {
  const { result } = renderHook(() => useAudioPlayer(mockConv, opts));

  act(() => {
    result.current.togglePlay();
  });

  expect(result.current.isPlaying).toBe(true);
});
```

### Components
```typescript
import { render, screen } from '@testing-library/react';
import { ViewerHeader } from '../ViewerHeader';

test('renders title', () => {
  render(<ViewerHeader title="Test" createdAt="..." onBack={jest.fn()} />);
  expect(screen.getByText('Test')).toBeInTheDocument();
});
```

---

## Performance Optimization Opportunities

### Current
- No memoization (not needed yet - performance is good)
- Context re-renders all consumers on any change
- No code splitting

### Future
```typescript
// Memoize expensive computations
const mentionsMap = useMemo(
  () => computeMentions(people, segments),
  [people, segments]
);

// Memoize components
const MemoizedSidebar = React.memo(Sidebar);

// Split context if needed
<ConversationListProvider>
  <ActiveConversationProvider>
    <App />
  </ActiveConversationProvider>
</ConversationListProvider>

// Code split pages
const Library = lazy(() => import('./pages/Library'));
const Viewer = lazy(() => import('./pages/Viewer'));
```

---

## Migration Checklist

When adapting this pattern to other projects:

✅ Identify external dependencies → Create services
✅ Identify shared state → Create context
✅ Identify complex logic → Create hooks
✅ Identify large components → Break into sub-components
✅ Extract JSX blocks → Create presentation components
✅ Remove prop drilling → Use context
✅ Test each layer independently
✅ Document architecture decisions

---

## Common Pitfalls

### ❌ Don't Do This
```typescript
// Importing from multiple layers in one component
import { conversationStorage } from '../services';
import { useConversations } from '../contexts';
// Pick one! Either use service directly OR use context

// Mixing concerns in one file
export const Viewer = () => {
  // Don't put 500 lines of logic here
  // Extract to hooks!
};

// Prop drilling when context exists
<Parent conversations={conversations}>
  <Child conversations={conversations}>
    <GrandChild conversations={conversations} />
// Use useConversations() in GrandChild instead!
```

### ✅ Do This Instead
```typescript
// Use context in components
const { conversations } = useConversations();

// Use hooks for complex logic
const audio = useAudioPlayer(...);

// Keep components focused
export const ViewerHeader = ({ title, onBack }) => (
  <header>...</header>
);
```

---

## Quick Debug Commands

```bash
# Build and check for errors
npm run build

# Start dev server
npm run dev

# Check file sizes
find . -name "*.tsx" -o -name "*.ts" | grep -v node_modules | xargs wc -l

# Find large components
find . -name "*.tsx" | grep -v node_modules | xargs wc -l | sort -rn | head -10

# Search for TODO comments
grep -r "TODO" --include="*.ts" --include="*.tsx"
```

---

## Resources

- **Architecture Overview**: `/docs/ARCHITECTURE.md`
- **Refactoring Summary**: `/docs/REFACTORING_SUMMARY.md`
- **This Guide**: `/docs/QUICK_REFERENCE.md`
- **PRD**: `/docs/conversation-transcript-context-prd.md`

---

*Last updated after comprehensive refactoring - December 2025*
