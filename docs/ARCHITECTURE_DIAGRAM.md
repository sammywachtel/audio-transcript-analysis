# Architecture Diagram

## Layer Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         App.tsx                             │
│                  (Routing & Provider Wrapper)               │
└─────────────────────────────────────────────────────────────┘
                              │
                ┌─────────────┴─────────────┐
                │                           │
         ┌──────▼──────┐            ┌──────▼──────┐
         │   Library   │            │   Viewer    │
         │    Page     │            │    Page     │
         └─────────────┘            └─────────────┘
                │                          │
                │                          │
    ┌───────────┴───────────┐  ┌──────────┴──────────────────┐
    │                       │  │                             │
    │  Conversation List    │  │  Viewer Sub-Components:     │
    │  Upload Modal         │  │  - ViewerHeader             │
    │                       │  │  - TranscriptView           │
    └───────────────────────┘  │  - Sidebar                  │
                               │  - AudioPlayer              │
                               │  - RenameSpeakerModal       │
                               └─────────────────────────────┘
                                          │
        ┌─────────────────────────────────┼─────────────────────┐
        │                                 │                     │
    ┌───▼────────────┐        ┌──────────▼─────────┐   ┌──────▼──────┐
    │ useAudioPlayer │        │ usePersonMentions  │   │ useSelection│
    │                │        │                    │   │             │
    │ - Playback     │        │ - Regex detection  │   │ - Two-way   │
    │ - Sync         │        │ - Mention mapping  │   │   sync      │
    │ - Drift fix    │        └────────────────────┘   └─────────────┘
    └────────────────┘
            │
    ┌───────┴────────┐
    │                │
┌───▼────────┐  ┌────▼─────────┐
│  Context   │  │   Services   │
│            │  │              │
│ - State    │  │ - Storage    │
│ - CRUD     │  │ - API        │
└────────────┘  └──────────────┘
```

## Data Flow

### Upload Flow
```
User selects file
        ↓
  UploadModal
        ↓
transcriptionService.processAudio()
        ↓
   Gemini API
        ↓
  Conversation
        ↓
useConversations().addConversation()
        ↓
conversationStorage.save()
        ↓
   IndexedDB
        ↓
Context updates state
        ↓
Library re-renders
```

### Playback Flow
```
Viewer mounts
        ↓
useAudioPlayer(conversation)
        ↓
Creates Audio element
        ↓
Detects drift
        ↓
Scales timestamps
        ↓
Calls onDriftCorrected
        ↓
Viewer.updateConversation()
        ↓
Context.updateConversation()
        ↓
conversationStorage.save()
        ↓
IndexedDB updated
```

## Directory Structure

```
audio-transcript-analysis-app/
│
├── services/                    📦 Data Layer
│   ├── conversationStorage.ts       (IndexedDB)
│   └── transcriptionService.ts      (Gemini API)
│
├── contexts/                    🌍 State Layer
│   └── ConversationContext.tsx      (Global state)
│
├── hooks/                       🎣 Logic Layer
│   ├── useAudioPlayer.ts            (Playback)
│   ├── usePersonMentions.ts         (Detection)
│   ├── useTranscriptSelection.ts    (Selection)
│   └── useAutoScroll.ts             (Behavior)
│
├── components/                  🎨 Presentation Layer
│   ├── Button.tsx
│   └── viewer/
│       ├── ViewerHeader.tsx
│       ├── TranscriptView.tsx
│       ├── TranscriptSegment.tsx
│       ├── TopicMarker.tsx
│       ├── Sidebar.tsx
│       ├── AudioPlayer.tsx
│       └── RenameSpeakerModal.tsx
│
├── pages/                       📄 Page Layer
│   ├── Library.tsx                  (List + Upload)
│   └── Viewer.tsx                   (Orchestrator)
│
└── App.tsx                      🚀 Root Layer
                                    (Routing)
```

## Component Relationships

```
App.tsx
  └─ ConversationProvider ──────────┐
       │                            │
       ├─ Library.tsx               │
       │    ├─ ConversationList     │
       │    └─ UploadModal          │
       │         └─ transcriptionService
       │
       └─ Viewer.tsx                │
            ├─ useConversations() ──┘
            ├─ useAudioPlayer()
            │    └─ Audio element
            │
            ├─ usePersonMentions()
            │    └─ Regex logic
            │
            ├─ useTranscriptSelection()
            │    └─ Selection state
            │
            ├─ useAutoScroll()
            │    └─ Scroll logic
            │
            ├─ ViewerHeader
            ├─ TranscriptView
            │    ├─ TranscriptSegment (×N)
            │    └─ TopicMarker (×N)
            │
            ├─ Sidebar
            │    ├─ TermCards (×N)
            │    └─ PersonCards (×N)
            │
            ├─ AudioPlayer
            └─ RenameSpeakerModal
```

## Service Dependencies

```
Components
    │
    └─── use hooks ────┐
                       │
    ┌──────────────────┘
    │
    ▼
  Hooks
    │
    └─── use context ──┐
                       │
    ┌──────────────────┘
    │
    ▼
 Context
    │
    └─── use services ─┐
                       │
    ┌──────────────────┘
    │
    ▼
Services
    │
    ├─── IndexedDB
    └─── Gemini API
```

## State Flow Diagram

```
┌─────────────────────────────────────────────────┐
│         ConversationContext                     │
│                                                 │
│  State:                                         │
│    - conversations: Conversation[]              │
│    - activeConversationId: string | null        │
│    - isLoaded: boolean                          │
│                                                 │
│  Computed:                                      │
│    - activeConversation: Conversation | null    │
│                                                 │
│  Actions:                                       │
│    - loadConversations()                        │
│    - addConversation()                          │
│    - updateConversation()                       │
│    - deleteConversation()                       │
│    - setActiveConversationId()                  │
│                                                 │
└─────────────────────────────────────────────────┘
                     │
                     │ provides via useConversations()
                     │
         ┌───────────┴───────────┐
         │                       │
    ┌────▼─────┐          ┌──────▼──────┐
    │ Library  │          │   Viewer    │
    │          │          │             │
    │ - List   │          │ - Display   │
    │ - Upload │          │ - Edit      │
    │ - Delete │          │ - Playback  │
    └──────────┘          └─────────────┘
```

## Hook Dependencies

```
Viewer.tsx
    │
    ├─ useConversations()
    │    └─ ConversationContext
    │
    ├─ useAudioPlayer(conversation, options)
    │    ├─ useState (playback state)
    │    ├─ useEffect (audio setup)
    │    ├─ useRef (audio element)
    │    └─ useCallback (actions)
    │
    ├─ usePersonMentions(people, segments)
    │    └─ useMemo (regex matching)
    │
    ├─ useTranscriptSelection(termOccurrences)
    │    ├─ useState (selection)
    │    └─ useCallback (handlers)
    │
    └─ useAutoScroll(isPlaying, activeIndex, segments)
         └─ useEffect (scroll logic)
```

## Before vs After Comparison

### Before (Monolithic)
```
┌─────────────────────────────┐
│         App.tsx             │
│  - All state (100+ lines)   │
│  - All CRUD                 │
│  - All loading              │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│       Viewer.tsx            │
│  - Audio logic (100+ lines) │
│  - Person logic (70+ lines) │
│  - Selection (50+ lines)    │
│  - Modal (40+ lines)        │
│  - Header (30+ lines)       │
│  - Transcript (150+ lines)  │
│                             │
│  TOTAL: 516 lines           │
└─────────────────────────────┘
```

### After (Layered)
```
┌──────────────┐
│   App.tsx    │ 56 lines (routing only)
└──────┬───────┘
       │
┌──────▼───────────────────────┐
│   ConversationProvider       │ 140 lines (state)
└──────┬───────────────────────┘
       │
┌──────▼───────────────────────┐
│    Services Layer            │ 425 lines (data)
├──────────────────────────────┤
│ - conversationStorage        │
│ - transcriptionService       │
└──────────────────────────────┘

┌──────────────────────────────┐
│    Hooks Layer               │ 369 lines (logic)
├──────────────────────────────┤
│ - useAudioPlayer             │
│ - usePersonMentions          │
│ - useTranscriptSelection     │
│ - useAutoScroll              │
└──────────────────────────────┘

┌──────────────────────────────┐
│  Components Layer            │ 273 lines (UI)
├──────────────────────────────┤
│ - ViewerHeader               │
│ - TranscriptView             │
│ - RenameSpeakerModal         │
│ - (+ existing components)    │
└──────────────────────────────┘

┌──────────────────────────────┐
│    Pages Layer               │ 505 lines (orchestration)
├──────────────────────────────┤
│ - Library.tsx                │
│ - Viewer.tsx                 │
└──────────────────────────────┘
```

## Key Patterns

### 1. Container/Presenter Pattern
```
Viewer (Container)
  ├─ Manages state via hooks
  ├─ Handles business logic
  └─ Passes data to presenters
        ↓
ViewerHeader (Presenter)
  ├─ Receives props
  ├─ Renders UI
  └─ Emits events
```

### 2. Service Layer Pattern
```
Component
    ↓
  Hook
    ↓
 Context
    ↓
 Service
    ↓
External System (DB/API)
```

### 3. Custom Hook Pattern
```
Complex Logic in Component
    ↓
Extract to Hook
    ↓
Hook returns interface
    ↓
Component uses clean API
```

## Testing Strategy

```
┌─────────────────────────────┐
│     Integration Tests       │
│  (Full page workflows)      │
└────────────┬────────────────┘
             │
┌────────────▼────────────────┐
│    Component Tests          │
│  (Render + interactions)    │
└────────────┬────────────────┘
             │
┌────────────▼────────────────┐
│      Hook Tests             │
│  (Logic in isolation)       │
└────────────┬────────────────┘
             │
┌────────────▼────────────────┐
│    Service Tests            │
│  (Mock DB/API responses)    │
└─────────────────────────────┘
```

---

*This diagram represents the refactored architecture as of December 2025*
