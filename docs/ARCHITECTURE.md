# Architecture Documentation

## Overview

This document describes the refactored architecture of the Audio Transcript Analysis App. The refactoring focused on **separation of concerns**, **component composition**, and **state management** improvements without adding new features.

## Architecture Principles

### 1. Separation of Concerns
- **Data layer** (services) is separate from **UI layer** (components)
- **State management** (context) is separate from **presentation** (components)
- **Business logic** (hooks) is separate from **rendering** (JSX)

### 2. Single Responsibility
Each module has one clear purpose:
- Services handle external interactions (API, storage)
- Hooks handle reusable logic
- Components handle presentation
- Context handles shared state

### 3. Dependency Flow
```
Components
    ↓
  Hooks
    ↓
 Context
    ↓
 Services
```

## Directory Structure

```
/
├── services/              # Data layer - external interactions
│   ├── conversationStorage.ts    # IndexedDB operations
│   ├── transcriptionService.ts   # Gemini API integration
│   └── index.ts                  # Barrel export
│
├── contexts/              # State management layer
│   └── ConversationContext.tsx   # Global conversation state
│
├── hooks/                 # Reusable logic layer
│   ├── useAudioPlayer.ts         # Audio playback & sync
│   ├── usePersonMentions.ts      # Person name detection
│   ├── useTranscriptSelection.ts # Selection state
│   ├── useAutoScroll.ts          # Auto-scroll behavior
│   └── index.ts                  # Barrel export
│
├── components/            # Presentation layer
│   ├── Button.tsx                # Reusable button
│   └── viewer/                   # Viewer-specific components
│       ├── ViewerHeader.tsx      # Header with nav
│       ├── TranscriptView.tsx    # Transcript rendering
│       ├── TranscriptSegment.tsx # Individual segment
│       ├── TopicMarker.tsx       # Topic boundaries
│       ├── Sidebar.tsx           # Terms & people sidebar
│       ├── AudioPlayer.tsx       # Playback controls
│       └── RenameSpeakerModal.tsx # Speaker rename dialog
│
├── pages/                 # Page-level components
│   ├── Library.tsx               # Conversation list + upload
│   └── Viewer.tsx                # Main transcript viewer
│
└── App.tsx                # Root component with routing
```

## Layer Details

### Services Layer

**Purpose**: Isolate external dependencies (APIs, storage) from the rest of the app.

#### `conversationStorage.ts`
- Encapsulates all IndexedDB operations
- Handles Blob ↔ Blob URL conversions
- Provides singleton instance: `conversationStorage`
- Methods:
  - `save(conversation)` - Persist conversation
  - `loadAll()` - Load all conversations
  - `loadById(id)` - Load single conversation
  - `delete(id)` - Remove conversation
  - `clearAll()` - Clear all data

**Why this matters**: If we switch from IndexedDB to another storage solution (backend API, localStorage, etc.), only this file changes.

#### `transcriptionService.ts`
- Encapsulates Gemini API integration
- Handles audio → base64 conversion
- Transforms AI response → internal Conversation type
- Provides singleton instance: `transcriptionService`
- Methods:
  - `processAudio(file)` - Process audio file with AI

**Why this matters**: If we switch AI providers (Whisper, AssemblyAI, etc.), only this file changes.

---

### Context Layer

**Purpose**: Manage shared application state without prop drilling.

#### `ConversationContext.tsx`
- Manages all conversation data
- Handles loading, adding, updating, deleting
- Provides `useConversations()` hook
- API:
  ```typescript
  {
    conversations: Conversation[];
    activeConversationId: string | null;
    activeConversation: Conversation | null;
    isLoaded: boolean;
    loadConversations: () => Promise<void>;
    addConversation: (conv) => Promise<void>;
    updateConversation: (conv) => Promise<void>;
    deleteConversation: (id) => Promise<void>;
    setActiveConversationId: (id) => void;
  }
  ```

**Why this matters**: Components can access conversation state without passing props through multiple levels. App.tsx went from 105 lines to 56 lines.

---

### Hooks Layer

**Purpose**: Extract reusable logic from components for testability and reuse.

#### `useAudioPlayer.ts`
- Manages audio element lifecycle
- Handles play/pause/seek operations
- Implements drift correction (auto-sync timestamps)
- Provides fallback simulation mode (for mock data)
- Returns:
  ```typescript
  {
    isPlaying, currentTime, duration,
    activeSegmentIndex, isSyncing,
    audioRef, togglePlay, seek, scrub
  }
  ```

**Key feature**: Drift correction automatically detects when AI timestamps don't match actual audio duration (>5% difference) and linearly scales all segments.

#### `usePersonMentions.ts`
- Detects person name mentions via regex
- Handles full name + first name fallback
- Returns mentions map + occurrence ranges
- Returns:
  ```typescript
  {
    mentionsMap: Record<personId, segmentId[]>;
    personOccurrences: Record<segmentId, occurrence[]>;
  }
  ```

#### `useTranscriptSelection.ts`
- Manages selected term/person state
- Implements two-way sync (transcript ↔ sidebar)
- Returns:
  ```typescript
  {
    selectedTermId, selectedPersonId,
    handleTermClickInTranscript,
    handleTermClickInSidebar,
    handlePersonClickInSidebar
  }
  ```

#### `useAutoScroll.ts`
- Auto-scrolls transcript to active segment during playback
- Simple effect hook - no return value

**Why this matters**: Viewer.tsx went from 516 lines to 195 lines. Complex logic is now isolated, testable, and reusable.

---

### Components Layer

**Purpose**: Present data and handle user interactions.

#### Page Components

**`Library.tsx`**
- Shows conversation list
- Handles file upload modal
- Uses `useConversations()` for data
- Props: `{ onOpen }`

**Before refactor**: Received conversations, onUpload, onDelete as props from App.tsx
**After refactor**: Gets everything from context, only needs onOpen callback

**`Viewer.tsx`**
- Orchestrates all viewer sub-components
- Uses all custom hooks
- Manages local speaker rename state
- Props: `{ onBack }`

**Before refactor**: 516 lines with all logic inline
**After refactor**: 195 lines, mostly hook calls and component composition

#### Viewer Sub-Components

**`ViewerHeader.tsx`**
- Top navigation bar
- Shows title, date, sync status, action buttons
- Props: `{ title, createdAt, isSyncing, onBack }`

**`TranscriptView.tsx`**
- Renders scrollable transcript
- Iterates over segments with topics
- Props: `{ conversation, activeSegmentIndex, ... }`

**`TranscriptSegment.tsx`** *(existing, unchanged)*
- Individual segment with highlighting
- Handles term/person occurrence highlighting

**`Sidebar.tsx`** *(existing, unchanged)*
- Terms and People tabs
- Search functionality
- Person navigation controls

**`AudioPlayer.tsx`** *(existing, unchanged)*
- Playback controls
- Progress scrubber
- Skip forward/backward buttons

**`RenameSpeakerModal.tsx`**
- Modal dialog for renaming speakers
- Auto-focuses input on open
- Props: `{ initialName, onClose, onSave }`

---

## Data Flow Examples

### Loading Conversations on App Start

```
1. App.tsx renders
2. ConversationProvider mounts
3. useEffect calls loadConversations()
4. conversationStorage.loadAll()
5. IndexedDB → Conversations array
6. Context updates state
7. Library.tsx re-renders with data
```

### Uploading a New Audio File

```
1. User selects file in UploadModal
2. UploadModal calls transcriptionService.processAudio()
3. Service sends audio to Gemini API
4. AI response → Conversation object
5. UploadModal calls addConversation()
6. Context calls conversationStorage.save()
7. Context updates conversations array
8. Library.tsx re-renders with new item
```

### Playing Audio with Drift Correction

```
1. Viewer calls useAudioPlayer()
2. Hook creates Audio element
3. 'loadedmetadata' event fires
4. Hook compares audio duration vs last segment timestamp
5. If >5% difference: scale all segment timestamps
6. Call onDriftCorrected callback
7. Viewer updates conversation state
8. Viewer calls updateConversation()
9. Context persists updated timestamps
```

### Two-Way Term Selection Sync

```
Transcript → Sidebar:
1. User clicks highlighted term in segment
2. TranscriptSegment calls onTermClick(termId)
3. Viewer calls handleTermClickInTranscript()
4. useTranscriptSelection sets selectedTermId
5. Hook scrolls to sidebar card via DOM ID

Sidebar → Transcript:
1. User clicks term card in sidebar
2. Sidebar calls onTermSelect(termId)
3. Viewer calls handleTermClickInSidebar()
4. useTranscriptSelection sets selectedTermId
5. Hook finds first occurrence and scrolls to segment
```

---

## Benefits of This Architecture

### Before vs After

| Aspect | Before | After |
|--------|--------|-------|
| **App.tsx** | 105 lines, all state management | 56 lines, just routing |
| **Viewer.tsx** | 516 lines, massive component | 195 lines, orchestration only |
| **Storage logic** | Scattered in App.tsx + db.ts | Centralized in conversationStorage service |
| **API logic** | In utils.ts | Centralized in transcriptionService |
| **Audio sync** | Inline in Viewer | Extracted to useAudioPlayer hook |
| **Person mentions** | Giant useMemo in Viewer | Extracted to usePersonMentions hook |
| **Selection state** | Multiple useState in Viewer | Extracted to useTranscriptSelection hook |

### Testability

**Before**: Testing Viewer.tsx required mocking:
- IndexedDB
- Gemini API
- Audio elements
- DOM scroll methods
- All in one massive component

**After**: Each layer can be tested independently:
- Services: Mock storage/API responses
- Hooks: Test logic in isolation
- Components: Test rendering with mock props

### Maintainability

**Before**: Adding a feature meant:
1. Finding the right spot in a 500-line component
2. Adding state scattered among other state
3. Mixing concerns (UI + logic + data)

**After**: Adding a feature means:
1. Identify the layer (service/hook/component)
2. Add logic in focused, single-purpose file
3. Wire it up via props/hooks

### Scalability

**Before**: Growing complexity → growing component size → harder to understand

**After**: Growing complexity → new hooks/services → same component size

---

## Migration Notes

### Breaking Changes
None - this is a refactor, not a feature change.

### Backward Compatibility
- IndexedDB schema unchanged
- Data migrations handled automatically (people array fallback)
- All existing features work identically

### Future Improvements

Now that the architecture is clean, future improvements become easier:

1. **Testing**: Add unit tests for hooks and services
2. **TypeScript**: Strengthen type safety in component props
3. **Performance**: Memoize expensive computations in hooks
4. **Features**: Add new capabilities without bloating components
5. **Backend migration**: Replace storage service with API client
6. **Error boundaries**: Add error handling at layer boundaries

---

## File Size Comparison

| File | Before (lines) | After (lines) | Change |
|------|----------------|---------------|---------|
| App.tsx | 105 | 56 | -47% |
| Viewer.tsx | 516 | 195 | -62% |
| Library.tsx | 301 | ~310 | +3% (added context usage) |
| **New Services** | 0 | 279 | +279 |
| **New Hooks** | 0 | 234 | +234 |
| **New Components** | 0 | 133 | +133 |
| **Total** | 922 | 1207 | +31% |

**Net result**: +285 lines of code, but:
- Much better organized
- Highly testable
- Easier to maintain
- Clearer responsibilities
- Future-proof architecture

The 31% code increase is entirely in **reusable, isolated modules** rather than monolithic components.

---

## Quick Reference

### Import Patterns

```typescript
// Services
import { conversationStorage } from '../services/conversationStorage';
import { transcriptionService } from '../services/transcriptionService';

// Context
import { useConversations } from '../contexts/ConversationContext';

// Hooks
import { useAudioPlayer } from '../hooks/useAudioPlayer';
import { usePersonMentions } from '../hooks/usePersonMentions';
// Or use barrel export:
import { useAudioPlayer, usePersonMentions } from '../hooks';

// Components
import { ViewerHeader } from '../components/viewer/ViewerHeader';
```

### Common Patterns

**Get conversation list in any component:**
```typescript
const { conversations, isLoaded } = useConversations();
```

**Add a new conversation:**
```typescript
const { addConversation } = useConversations();
await addConversation(newConversation);
```

**Update a conversation:**
```typescript
const { updateConversation } = useConversations();
updateConversation({ ...conversation, title: 'New Title' });
```

**Use audio player:**
```typescript
const { isPlaying, togglePlay, seek } = useAudioPlayer(conversation, {
  audioUrl: conversation.audioUrl,
  initialDuration: conversation.durationMs,
  segments: conversation.segments
});
```

---

## Conclusion

This refactoring transformed a prototype with scattered concerns into a well-architected application following React best practices:

✅ **Service layer** abstracts external dependencies
✅ **Context** manages global state without prop drilling
✅ **Hooks** extract reusable logic
✅ **Components** focus on presentation
✅ **Single responsibility** throughout
✅ **Testable** at every layer
✅ **Maintainable** for future growth

All without changing functionality or adding new features.
