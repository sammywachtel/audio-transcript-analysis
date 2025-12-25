# Comprehensive UX Design: Audio Transcript Analysis App

**Date:** 2025-12-23
**Prepared by:** UX Designer (Claude Code - Ux Designer Persona)
**Document Version:** 1.0

---

## Executive Summary

This document provides a comprehensive UX analysis and design strategy for expanding the Audio Transcript Analysis App from a personal transcription tool into a collaborative platform with AI-powered insights. The analysis covers:

1. **UX Audit** - Critical evaluation of existing Library and Viewer features
2. **Feature Designs** - Detailed UX patterns for 5 new capabilities
3. **Information Architecture** - Navigation and mental model redesign
4. **Design System** - Consistent patterns for expanded functionality
5. **Accessibility & Usability** - WCAG compliance and cognitive load optimization

**Key Finding:** The current app has a strong foundation with minimal cognitive load and clear information hierarchy, but requires careful navigation redesign to prevent feature sprawl as new capabilities are added.

---

## Part 1: UX Audit of Existing Features

### 1.1 Library Page - Current State Analysis

#### **What Users Are Trying to Accomplish:**
- Quickly scan and find past conversations
- Upload new audio files for transcription
- Monitor processing status of recent uploads
- Understand cloud sync state

#### **Cognitive Load Assessment: ✅ LOW**

**Strengths:**
- **Scannable table layout** with clear visual hierarchy
- **Status indicators** use color + icon + text (multi-modal feedback)
- **Processing progress** shows real-time feedback with granular steps
- **Empty state** provides clear call-to-action for new users
- **Sync status badge** is persistent but unobtrusive

**Usability Issues Identified:**

| Issue | Severity | User Impact | Recommendation |
|-------|----------|-------------|----------------|
| No search/filter functionality | **HIGH** | Users with 50+ conversations will struggle to find specific items | Add search bar above table with filters for date, speaker count, status |
| Table column headers not clickable | **MEDIUM** | Users expect sorting by clicking "Name", "Date", "Duration" | Add sort indicators and click handlers |
| Mobile responsiveness hides key data | **MEDIUM** | Status column hidden on mobile removes important feedback | Consider progressive disclosure or cards on mobile |
| Deletion confirmation uses browser `confirm()` | **LOW** | Not branded, jarring modal | Replace with styled modal matching app aesthetic |
| No bulk operations | **LOW** | Power users can't delete/tag multiple conversations | Add checkbox selection + bulk action toolbar |

#### **Mental Model Analysis:**

**Current Model:** "Personal library of recordings"
**Desired Model (with new features):** "Collaborative knowledge base"

The Library currently signals **ownership** (your recordings) but will need to evolve to show:
- Shared conversations (from others)
- Cross-conversation insights
- Search across all accessible content

---

### 1.2 Viewer Page - Current State Analysis

#### **What Users Are Trying to Accomplish:**
- Read transcript while listening to audio
- Jump to specific topics or speaker turns
- Look up unfamiliar terms mentioned in conversation
- Track people mentioned in the discussion
- Correct speaker attribution errors

#### **Cognitive Load Assessment: ✅ MEDIUM-LOW**

**Strengths:**
- **Two-way sync** (click transcript → audio jumps; audio plays → transcript highlights)
- **Sidebar context** provides definitions without interrupting reading flow
- **Visual rhythm** uses speaker avatars + topic markers for scannable structure
- **Inline editing** for speaker names reduces friction
- **Real-time audio sync** with drift correction

**Usability Issues Identified:**

| Issue | Severity | User Impact | Recommendation |
|-------|----------|-------------|----------------|
| Sidebar only visible on desktop (lg+ breakpoint) | **HIGH** | Mobile users lose access to terms/people context | Add bottom sheet or tabs for mobile |
| No keyboard shortcuts | **MEDIUM** | Power users can't navigate efficiently | Add space=play/pause, ←/→ skip, J/K jump segments |
| Person mentions navigation counter is subtle | **MEDIUM** | Users may not notice the mention tracking feature | Consider highlighting mentions in transcript with same visual treatment as terms |
| No way to ask questions about content | **HIGH** | Users must manually search/reread to find information | **→ NEW FEATURE: Conversation chatbot** |
| No export or sharing functionality | **HIGH** | Users can't collaborate or share insights | **→ NEW FEATURE: Sharing** |

#### **Mental Model Analysis:**

**Current Model:** "Interactive document viewer with multimedia sync"
**User Expectation:** "Intelligent assistant that can answer questions about the conversation"

The Viewer is well-designed for **passive consumption** but lacks **active inquiry**. Users need to:
1. Ask questions ("What did they say about the budget?")
2. Get summarized answers with timestamps
3. Share specific insights with collaborators

---

### 1.3 Upload Modal - Current State Analysis

#### **Cognitive Load Assessment: ✅ LOW**

**Strengths:**
- **Drag-and-drop + click** (dual input methods)
- **Visual state feedback** (dragging, selected, uploading, error)
- **Progressive disclosure** (shows file info only after selection)
- **Clear error messaging**

**Usability Issues Identified:**

| Issue | Severity | User Impact | Recommendation |
|-------|----------|-------------|----------------|
| "Max 100MB" shown in placeholder, but code doesn't enforce it | **HIGH** | Users experience cryptic upload failures | Add client-side validation with file size check |
| Upload blocks UI until complete | **MEDIUM** | Users can't browse library during upload | Make upload non-blocking with notification |
| No metadata capture during upload | **LOW** | Users can't add title/description before processing | Add optional metadata form |
| "Max 100MB" insufficient for long meetings | **HIGH** | Enterprise users need 2+ hour recordings | **→ NEW FEATURE: Large file support** |

---

## Part 2: User Journey Maps for New Features

### 2.1 Feature: Conversation Chatbot (Single Conversation Q&A)

#### **User Journey: Finance Team Manager**

**Persona:** Sarah, Finance Manager
**Goal:** Review quarterly planning meeting to extract budget commitments
**Context:** 2-hour meeting recording, needs to pull specific numbers for board deck

**Journey Stages:**

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. DISCOVER                                                     │
│ Sarah opens conversation in Viewer                              │
│ • Sees new "Ask About This Conversation" panel in sidebar       │
│ • Recognizes it as a Q&A interface (chat bubble icon)           │
│ 🎯 Expectation: "I can ask questions about this recording"      │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. ENGAGE                                                       │
│ Sarah types: "What budget numbers were mentioned?"              │
│ • Chat interface shows typing indicator                         │
│ • Response appears in ~3-5 seconds                              │
│ 🎯 Mental model: "This is like asking a colleague who          │
│    attended the meeting"                                        │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. EVALUATE                                                     │
│ Response shows:                                                 │
│ • "Here are the budget figures mentioned:                       │
│   • Q1: $2.4M (at 34:12)                                       │
│   • Q2: $2.7M (at 42:56)                                       │
│   • Annual: $11M (at 51:30)"                                   │
│ • Each timestamp is a clickable link                            │
│ 🎯 Affordance discovery: "I can jump to context"                │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. VERIFY                                                       │
│ Sarah clicks timestamp "34:12"                                  │
│ • Audio jumps to that moment                                    │
│ • Transcript scrolls and highlights the segment                 │
│ • She hears: "...so Q1 came in at 2.4 million..."             │
│ 🎯 Trust building: "The AI got this right"                      │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. REFINE                                                       │
│ Sarah follows up: "What concerns did Lisa raise?"               │
│ • Chat maintains context (knows this is same conversation)      │
│ • Response: "Lisa raised 3 concerns: [list with timestamps]"   │
│ 🎯 Natural dialogue: "This remembers what we're talking about"  │
└─────────────────────────────────────────────────────────────────┘
```

**Pain Points to Address:**
1. **Hallucination risk** - AI must cite sources (timestamps) for every claim
2. **Context limits** - Long conversations (2+ hours) may exceed token limits
3. **Ambiguity** - User questions like "What did they say?" need clarification prompts

---

### 2.2 Feature: Search Across Conversations

#### **User Journey: Product Manager**

**Persona:** Marcus, Product Manager
**Goal:** Find all mentions of "user authentication" across 3 months of customer interviews
**Context:** 15 recorded interviews, needs to compile requirements

**Journey Stages:**

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. INITIATE SEARCH                                              │
│ Marcus opens Library page                                       │
│ • New search bar at top (prominent placement)                   │
│ • Types "user authentication"                                   │
│ • Search scope selector shows: "This conversation" vs "All"     │
│ 🎯 Expectation: "Like Slack/Notion search but for audio"        │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. REVIEW RESULTS                                               │
│ Results page shows:                                             │
│ • 23 matches across 8 conversations                             │
│ • Grouped by conversation (most relevant first)                 │
│ • Each result shows:                                            │
│   - Conversation title                                          │
│   - Speaker + timestamp                                         │
│   - Text snippet with highlighted term                          │
│   - Relevance score (visual indicator)                          │
│ 🎯 Scannable format: "I can quickly assess relevance"           │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. FILTER & REFINE                                              │
│ Marcus uses sidebar filters:                                    │
│ • Date range: "Last 3 months" ✓                                │
│ • Speaker: (shows all speakers across conversations)            │
│ • Topic: Selects "Security" and "Login"                         │
│ • Results update live to 12 matches                             │
│ 🎯 Progressive disclosure: "I can narrow down without           │
│    losing context"                                              │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. NAVIGATE TO CONTEXT                                          │
│ Marcus clicks a result snippet                                  │
│ • Opens that conversation in Viewer                             │
│ • Auto-seeks to the timestamp                                   │
│ • Search term is highlighted in transcript                      │
│ • Breadcrumb shows: "Search results > [Conversation title]"     │
│ 🎯 Context preservation: "I can return to results"              │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. COMPILE INSIGHTS                                             │
│ Back in search results, Marcus selects 5 key snippets           │
│ • "Export selected" button appears                              │
│ • Options: Copy to clipboard / Export to CSV / Share link       │
│ • Exported format includes: conversation title, speaker,        │
│   timestamp, full segment text                                  │
│ 🎯 Workflow completion: "I can use this in my PRD"              │
└─────────────────────────────────────────────────────────────────┘
```

**Technical Considerations:**
- Full-text search across all user conversations (Firestore full-text limitations)
- Real-time index updates as new conversations are processed
- Ranking algorithm: exact match > term occurrence > topic match

---

### 2.3 Feature: Cross-Conversation Chatbot

#### **User Journey: Research Analyst**

**Persona:** Dr. Chen, Qualitative Researcher
**Goal:** Identify common themes across 20 participant interviews
**Context:** Needs to synthesize findings for research paper

**Journey Stages:**

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. ACCESS CROSS-CONVERSATION MODE                               │
│ Dr. Chen navigates to Library page                              │
│ • New tab in header: "Library" | "Cross-Conversation Insights"  │
│ • Clicks "Cross-Conversation Insights"                          │
│ • Page explains: "Ask questions across all your conversations"  │
│ 🎯 Mode switching: "This is different from single-conversation  │
│    questions"                                                   │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. SELECT SCOPE                                                 │
│ Interface shows conversation selector:                          │
│ • "All conversations" (default)                                 │
│ • "Select specific conversations" (multi-select)                │
│ • Dr. Chen filters by tag: "Study Participants"                 │
│ • 20 conversations selected                                     │
│ • Visual indicator: "Analyzing 20 conversations (~8 hours)"     │
│ 🎯 Transparency: "I know what data is being analyzed"           │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. ASK COMPLEX QUESTION                                         │
│ Dr. Chen types: "What are the most common frustrations          │
│ mentioned by participants?"                                     │
│ • Processing indicator shows: "Analyzing 20 conversations..."   │
│ • Takes 15-20 seconds (longer than single conversation)         │
│ • Progress bar shows partial results streaming in               │
│ 🎯 Expectation setting: "This takes longer, but I see progress" │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. REVIEW SYNTHESIZED ANSWER                                    │
│ Response shows:                                                 │
│ • "Top 5 frustrations mentioned:                                │
│   1. Slow load times (mentioned in 15/20 conversations)         │
│      - [Participant A, 12:34] 'It takes forever...'            │
│      - [Participant B, 8:45] 'The waiting is frustrating'      │
│   2. Confusing navigation (12/20)                               │
│   ..."                                                          │
│ • Each mention is a clickable link to source                    │
│ 🎯 Evidence-based synthesis: "AI shows its work"                │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. DRILL INTO SOURCES                                           │
│ Dr. Chen clicks "View all mentions of 'slow load times'"        │
│ • Opens expanded view with all 15 quotes                        │
│ • Can play audio clip for each                                  │
│ • Export options: Formatted report / CSV / Notion               │
│ 🎯 Workflow integration: "This fits my research process"        │
└─────────────────────────────────────────────────────────────────┘
```

**Cognitive Load Considerations:**
- **Scope management** - Users need to understand which conversations are included
- **Processing time** - Long operations need clear progress indicators
- **Source attribution** - Every claim must link to specific conversation + timestamp
- **Export formats** - Researchers need APA/MLA citations, not just raw data

---

### 2.4 Feature: Conversation Sharing

#### **User Journey: Team Collaboration**

**Persona:** Alex, Team Lead
**Goal:** Share weekly standup recording with remote team member who missed the meeting
**Context:** Need to grant access without exposing other private conversations

**Journey Stages:**

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. INITIATE SHARING                                             │
│ Alex opens conversation in Library or Viewer                    │
│ • New "Share" button in header (next to Delete)                 │
│ • Clicks Share                                                  │
│ • Modal opens: "Share 'Weekly Standup - Dec 19'"               │
│ 🎯 Familiar pattern: "Like sharing a Google Doc"                │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. SELECT RECIPIENTS                                            │
│ Modal shows:                                                    │
│ • Email input field (autocompletes from team)                   │
│ • "Anyone with the link" toggle (off by default)                │
│ • Permission level dropdown:                                    │
│   - View only (can read + listen)                               │
│   - Comment (can add notes to sidebar)                          │
│   - Edit (can rename speakers, update terms)                    │
│ 🎯 Granular control: "I choose what they can do"                │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. CONFIGURE ACCESS                                             │
│ Alex adds email: jamie@company.com                              │
│ • Sets permission: "View only"                                  │
│ • Expiration dropdown: "Never" / "7 days" / "30 days" / Custom  │
│ • Optional message field: "Here's the standup you missed"       │
│ • "Send invite" button                                          │
│ 🎯 Security mindset: "I can limit access duration"              │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. RECIPIENT RECEIVES NOTIFICATION                              │
│ Jamie receives email:                                           │
│ • Subject: "Alex shared 'Weekly Standup - Dec 19' with you"    │
│ • Body: Custom message + "Open Conversation" button             │
│ • Clicks button → Redirects to app                              │
│ • If not signed in: Prompted to sign in with Google             │
│ • If signed in: Opens directly to Viewer                        │
│ 🎯 Low friction: "One click to access"                          │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. MANAGE SHARED ACCESS                                         │
│ Alex later revisits Share modal:                                │
│ • Shows list of people with access                              │
│ • Can revoke access (trash icon)                                │
│ • Can change permission level                                   │
│ • See activity log: "Jamie viewed 2 days ago"                   │
│ 🎯 Ongoing control: "I can see and manage who has access"       │
└─────────────────────────────────────────────────────────────────┘
```

**Security Considerations:**
- Email verification required for new users
- Shared conversations appear in Library with distinct visual indicator
- Owner can always revoke access
- Audit log tracks all access (GDPR compliance)

---

### 2.5 Feature: Large File Upload Support

#### **User Journey: Enterprise Customer**

**Persona:** Corporate training team uploading 3-hour webinar recording (450MB)
**Goal:** Upload large file without failures or browser timeouts
**Context:** Previous uploads failed at 200MB limit

**Journey Stages:**

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. SELECT LARGE FILE                                            │
│ User clicks "Upload Audio"                                      │
│ • Modal opens, drags 450MB MP4 file                             │
│ • File size check runs client-side                              │
│ • Instead of error, sees: "Large file detected (450MB)"         │
│ • Message: "This will use chunked upload for reliability"       │
│ 🎯 Transparency: "The app adapts to my file size"               │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. METADATA CAPTURE                                             │
│ Before upload starts, form appears:                             │
│ • "Title" field (pre-filled from filename)                      │
│ • Optional "Description" field                                  │
│ • "Expected duration" estimate (helps with processing)          │
│ • "Start upload" button                                         │
│ 🎯 Useful pause: "I can add context before 20-minute upload"    │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. RESUMABLE UPLOAD                                             │
│ Upload begins with detailed progress:                           │
│ • Chunk 1/45 (10MB each) uploaded                               │
│ • Progress bar: 23% | 103MB / 450MB                             │
│ • Speed: "5.2 MB/s"                                             │
│ • Time remaining: "~6 minutes"                                  │
│ • "Pause" and "Cancel" buttons visible                          │
│ 🎯 Control: "I can pause if network is slow"                    │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. HANDLE INTERRUPTION                                          │
│ WiFi disconnects at 67% (network error)                         │
│ • Upload pauses automatically                                   │
│ • Message: "Upload paused - waiting for connection"             │
│ • WiFi reconnects after 30 seconds                              │
│ • "Resume upload" button appears                                │
│ • Click resumes from chunk 30/45 (not from start)               │
│ 🎯 Resilience: "I don't lose 15 minutes of progress"            │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. BACKGROUND PROCESSING                                        │
│ Upload completes:                                               │
│ • Modal closes automatically                                    │
│ • Library shows new item with status "Uploading complete"       │
│ • Processing begins (may take 30-45 minutes for 3-hour audio)   │
│ • User can close browser - email notification when done         │
│ • Notification settings: "Email me when processing completes"   │
│ 🎯 Freedom: "I don't need to babysit this"                      │
└─────────────────────────────────────────────────────────────────┘
```

**Technical Implementation:**
- Multipart upload to Firebase Storage (5MB chunks)
- Client-side resumable upload library
- Server-side assembly of chunks
- Background Cloud Function processing with email notification

---

## Part 3: Information Architecture Redesign

### 3.1 Current vs. Proposed Navigation

#### **Current Navigation (Simple Two-View)**

```
App
├── Library (list view)
└── Viewer (detail view)
```

**Problems:**
- No home for cross-conversation features
- No space for search results
- No access to chatbot without opening a conversation

#### **Proposed Navigation (Feature-Based)**

```
App
├── Library
│   ├── My Conversations (current default)
│   ├── Shared With Me (new)
│   └── Tags/Collections (new organization feature)
│
├── Search (new top-level)
│   ├── Search results page
│   └── Filters sidebar
│
├── Insights (new top-level)
│   ├── Cross-Conversation Chat
│   ├── Saved Queries
│   └── Exported Reports
│
└── Conversation Viewer
    ├── Transcript (current)
    ├── Conversation Chat (new sidebar tab)
    └── Share (new header action)
```

### 3.2 Global Navigation Pattern

**Header Layout:**

```
┌─────────────────────────────────────────────────────────────────┐
│ [Logo] [Library] [Search] [Insights] [Upload]    [Help] [User]  │
└─────────────────────────────────────────────────────────────────┘
```

**Responsive Behavior (Mobile):**
```
┌──────────────────────────────────────────────────┐
│ [☰ Menu] [Logo]              [Upload] [User]     │
└──────────────────────────────────────────────────┘

Menu expanded:
┌──────────────────────────────────────────────────┐
│ [X Close]                                        │
│                                                  │
│ → Library                                        │
│ → Search                                         │
│ → Insights                                       │
│ → Help                                           │
└──────────────────────────────────────────────────┘
```

### 3.3 Library Page - New Layout with Search

**Desktop View:**

```
┌─────────────────────────────────────────────────────────────────┐
│ Library                                    [Upload] [User Menu]  │
│ Your transcribed conversations                                  │
│                                                                 │
│ [🔍 Search conversations...]                    [⚙️ Filters ▾]  │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Tabs: [My Conversations] [Shared With Me] [Collections]    │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Name              Date       Duration    Status      Actions│ │
│ ├─────────────────────────────────────────────────────────────┤ │
│ │ [🎤] Q4 Planning  Dec 19    1:34:22     Complete   [... ▾] │ │
│ │ [🎤] Customer #12 Dec 18    45:12       Complete   [... ▾] │ │
│ │ [🔄] Team Sync    Dec 17    --:--       Processing [... ]  │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

**Key Changes:**
1. **Persistent search bar** at top (always visible)
2. **Tab navigation** for My/Shared/Collections
3. **Filter dropdown** for date range, speakers, topics, status
4. **Actions menu** (•••) replaces hover-only delete button
5. **Shared indicator** icon on items shared with you

---

## Part 4: Wireframes for Key New Features

### 4.1 Conversation Chatbot Interface

**Location:** Sidebar in Viewer (new tab alongside Terms/People)

```
┌─────────────────────────────────────────────────────┐
│ [Context ▾] [People ▾] [Chat 💬]                    │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Ask about this conversation                        │
│                                                     │
│  ┌───────────────────────────────────────────────┐ │
│  │ You:                                          │ │
│  │ What budget numbers were mentioned?           │ │
│  └───────────────────────────────────────────────┘ │
│                                                     │
│  ┌───────────────────────────────────────────────┐ │
│  │ AI:                                           │ │
│  │ Here are the budget figures mentioned:        │ │
│  │                                               │ │
│  │ • Q1: $2.4M [▶️ 34:12]                        │ │
│  │ • Q2: $2.7M [▶️ 42:56]                        │ │
│  │ • Annual: $11M [▶️ 51:30]                     │ │
│  │                                               │ │
│  │ Would you like me to summarize the budget     │ │
│  │ discussion?                                   │ │
│  └───────────────────────────────────────────────┘ │
│                                                     │
│  ┌───────────────────────────────────────────────┐ │
│  │ Type your question...             [Send →]    │ │
│  └───────────────────────────────────────────────┘ │
│                                                     │
│  [Clear chat] [Export conversation]                │
└─────────────────────────────────────────────────────┘
```

**Interaction Details:**
- Clicking timestamp `[▶️ 34:12]` seeks audio and scrolls transcript
- "Clear chat" resets conversation context
- "Export conversation" saves Q&A as markdown/PDF
- Chat history persists per conversation (saved in Firestore)

---

### 4.2 Cross-Conversation Insights Page

**Full-Page Layout:**

```
┌─────────────────────────────────────────────────────────────────┐
│ [Library] [Search] [Insights] [Upload]         [Help] [User]    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Cross-Conversation Insights                                     │
│ Ask questions across multiple conversations                     │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 📊 Conversation Scope                                       │ │
│ │                                                             │ │
│ │ ○ All conversations (23 conversations, ~14 hours)           │ │
│ │ ● Select specific (12 selected)                             │ │
│ │                                                             │ │
│ │ [Tag: Study Participants ✓] [Date: Last 30 days ✓]         │ │
│ │ [Add filter +]                                              │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 💬 Ask a Question                                           │ │
│ │                                                             │ │
│ │ ┌─────────────────────────────────────────────────────────┐ │ │
│ │ │ What are the most common frustrations mentioned?       │ │ │
│ │ │                                                         │ │ │
│ │ │                                           [Analyze →]   │ │ │
│ │ └─────────────────────────────────────────────────────────┘ │ │
│ │                                                             │ │
│ │ Example questions:                                          │ │
│ │ • What topics appear across all conversations?              │ │
│ │ • Who is mentioned most frequently?                         │ │
│ │ • Summarize key decisions made                              │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 📝 Analysis Results                                         │ │
│ │                                                             │ │
│ │ Top 5 frustrations mentioned:                               │ │
│ │                                                             │ │
│ │ 1. ⚡ Slow load times                                       │ │
│ │    Mentioned in 15/20 conversations                         │ │
│ │    [▼ Show all mentions]                                    │ │
│ │                                                             │ │
│ │ 2. 🧭 Confusing navigation                                  │ │
│ │    Mentioned in 12/20 conversations                         │ │
│ │    [▼ Show all mentions]                                    │ │
│ │                                                             │ │
│ │ ...                                                         │ │
│ │                                                             │ │
│ │ [Export report ↓] [Save query 💾]                           │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

**Interaction Flow:**
1. User selects conversation scope (all or specific subset)
2. User types question
3. "Analyze" button triggers processing (15-20 sec)
4. Results stream in progressively
5. User can expand each finding to see source quotes
6. Export options: PDF report, CSV, JSON, Notion integration

---

### 4.3 Search Results Page

```
┌─────────────────────────────────────────────────────────────────┐
│ [Library] [Search] [Insights] [Upload]         [Help] [User]    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ [🔍 user authentication                              ] [Search]  │
│                                                                 │
│ 23 results across 8 conversations                               │
└─────────────────────────────────────────────────────────────────┘

┌──────────────────┬──────────────────────────────────────────────┐
│ Filters          │ Results                                      │
│                  │                                              │
│ Date Range       │ ┌──────────────────────────────────────────┐ │
│ ○ All time       │ │ Customer Interview #12 - Dec 18          │ │
│ ○ Last 7 days    │ │ Speaker: Sarah at 23:45                  │ │
│ ● Last 30 days   │ │ "...the user authentication process is   │ │
│ ○ Custom         │ │  really confusing for first-time users"  │ │
│                  │ │                            [Open →] [▶️]  │ │
│ Speakers         │ └──────────────────────────────────────────┘ │
│ ☐ Alex (12)      │                                              │
│ ☑ Sarah (8)      │ ┌──────────────────────────────────────────┐ │
│ ☐ Marcus (3)     │ │ Q4 Planning Meeting - Dec 19             │ │
│                  │ │ Speaker: Marcus at 1:04:22               │ │
│ Topics           │ │ "...we need to redesign user              │ │
│ ☑ Security (15)  │ │  authentication before launch"           │ │
│ ☑ Login (10)     │ │                            [Open →] [▶️]  │ │
│ ☐ UX (5)         │ └──────────────────────────────────────────┘ │
│                  │                                              │
│ [Clear filters]  │ ... (more results)                           │
└──────────────────┴──────────────────────────────────────────────┘
```

**Interaction Details:**
- Results are live-filtered as user checks/unchecks filters
- [Open →] opens conversation in Viewer at that timestamp
- [▶️] plays audio snippet without leaving search page (modal player)
- Checkbox selection allows bulk export

---

### 4.4 Share Modal

```
┌─────────────────────────────────────────────────────────┐
│ Share "Q4 Planning Meeting"                        [X]  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ Share with people                                       │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Enter email addresses...                            │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ Permission level                                        │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ View only                                       [▾]  │ │
│ └─────────────────────────────────────────────────────┘ │
│ Options: View only / Can comment / Can edit            │
│                                                         │
│ Expiration                                              │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Never                                           [▾]  │ │
│ └─────────────────────────────────────────────────────┘ │
│ Options: Never / 7 days / 30 days / Custom date        │
│                                                         │
│ ☐ Anyone with the link can view                        │
│   (Link: https://app.example.com/s/abc123)             │
│                                                         │
│ Message (optional)                                      │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Here's the Q4 planning meeting you asked about...   │ │
│ │                                                     │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│ People with access                                      │
│                                                         │
│ • jamie@company.com (View only) Viewed 2d ago [Revoke] │
│ • alex@company.com (Owner)                              │
│                                                         │
├─────────────────────────────────────────────────────────┤
│                          [Cancel]  [Send invite]        │
└─────────────────────────────────────────────────────────┘
```

---

## Part 5: Design System Considerations

### 5.1 Component Patterns for New Features

#### **Chat Message Component**

**Variants:**
- User message (right-aligned, blue background)
- AI message (left-aligned, gray background)
- System message (centered, italic)

**Anatomy:**
```
┌─────────────────────────────────────────────────┐
│ [Avatar] [Name]                      [Timestamp]│
│          Message text with possible             │
│          • Bullet points                        │
│          • [Clickable timestamps]               │
│          • **Markdown formatting**              │
│                                                 │
│          [Thumbs up] [Thumbs down] [Copy]       │
└─────────────────────────────────────────────────┘
```

**Accessibility:**
- Use `role="log"` for chat container (screen reader announces new messages)
- Timestamp links have descriptive labels: "Jump to 34 minutes 12 seconds"

---

#### **Search Result Card**

**Anatomy:**
```
┌─────────────────────────────────────────────────┐
│ [Checkbox] [Conversation icon] Conversation Title│
│            Speaker: [Name] at [Timestamp]        │
│                                                 │
│            "...text snippet with **highlighted** │
│            search term in context..."           │
│                                                 │
│            [Open in Viewer] [Play snippet]      │
└─────────────────────────────────────────────────┘
```

**States:**
- Default
- Hover (slight shadow lift)
- Selected (checkbox checked, blue border)
- Visited (dimmed, checkmark icon)

---

#### **Conversation Scope Selector**

**Component for Cross-Conversation Insights:**

```
┌─────────────────────────────────────────────────┐
│ 📊 Conversation Scope                           │
│                                                 │
│ Radio buttons:                                  │
│ ○ All conversations (23 conversations, 14h)     │
│ ● Select specific (12 selected)                 │
│                                                 │
│ When "Select specific" chosen:                  │
│ ┌─────────────────────────────────────────────┐ │
│ │ [Filter panel slides in]                    │ │
│ │ Tags: [Study Participants ✓]                │ │
│ │ Date: [Last 30 days ✓]                      │ │
│ │ Speaker: [All speakers ▾]                   │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

**Progressive Disclosure:**
- Default shows radio buttons only
- Selecting "Select specific" reveals filter panel below

---

### 5.2 Color System Expansion

**Current Palette (from existing code):**
- Primary: Blue (used for interactive elements, active states)
- Success: Emerald (used for complete status)
- Warning: Amber (used for offline status)
- Error: Red (used for failed status)
- Neutral: Slate (used for text, borders, backgrounds)

**New Semantic Colors Needed:**

| Use Case | Color | Hex/Tailwind | Example |
|----------|-------|--------------|---------|
| AI message background | Light purple | `purple-50` | Chatbot responses |
| Shared item indicator | Teal | `teal-500` | Library items shared with you |
| Cross-conversation scope | Indigo | `indigo-100` | Scope selector background |
| Search highlight | Yellow | `yellow-200` | Search term in results |
| Person mention | Purple | `purple-200` | Person name highlights in transcript |

---

### 5.3 Typography Scale

**Current Usage (inferred from code):**
- H1: 2xl (24px) - Page titles
- H2: lg (18px) - Section headers
- Body: sm (14px) - Main content
- Caption: xs (12px) - Metadata, timestamps

**Additions Needed:**
- **Display** (4xl/36px) - Empty states, hero sections
- **Mono** (Fira Code or similar) - Timestamps, code snippets in AI responses

---

### 5.4 Spacing System

**Recommendation:** Continue using Tailwind's 4px-based scale

**Common Patterns:**
- Card padding: `p-4` (16px)
- Section gaps: `gap-6` (24px)
- Button padding: `px-4 py-2` (16px horizontal, 8px vertical)
- Sidebar width: `w-80` (320px)

---

## Part 6: Accessibility & Usability Recommendations

### 6.1 WCAG 2.1 AA Compliance Checklist

#### **Critical Issues to Address:**

| Issue | Current State | Target | Implementation |
|-------|---------------|--------|----------------|
| **Keyboard navigation** | No keyboard shortcuts | Full keyboard support | Add keyboard shortcuts for play/pause, seek, navigation |
| **Focus indicators** | Browser defaults | Custom focus rings | Use `ring-2 ring-blue-500` on all interactive elements |
| **Color contrast** | Mostly good, some issues | 4.5:1 for text | Audit slate-400 text on white (may fail) |
| **Alt text** | Icons have no labels | Descriptive labels | Add `aria-label` to icon buttons |
| **Screen reader support** | Basic HTML semantics | Enhanced ARIA | Add live regions for chat, status updates |
| **Mobile touch targets** | Some buttons < 44px | Minimum 44x44px | Increase small icon button sizes |

---

#### **Specific Fixes:**

**1. Keyboard Shortcuts**

```typescript
// Add to Viewer component
useEffect(() => {
  const handleKeyPress = (e: KeyboardEvent) => {
    // Ignore if typing in input
    if (e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement) return;

    switch(e.key) {
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        seek(currentTime - 5000); // Skip back 5s
        break;
      case 'ArrowRight':
        seek(currentTime + 5000); // Skip forward 5s
        break;
      case 'j':
        // Jump to previous segment
        break;
      case 'k':
        // Jump to next segment
        break;
      case '/':
        // Focus search input
        break;
    }
  };

  window.addEventListener('keydown', handleKeyPress);
  return () => window.removeEventListener('keydown', handleKeyPress);
}, [currentTime, togglePlay, seek]);
```

**Visual Hint:** Add keyboard shortcut legend (press `?` to show)

---

**2. Focus Management**

When modal opens (Share, Upload), focus should move to first input.
When modal closes, focus should return to trigger button.

```typescript
const ShareModal = ({ onClose }) => {
  const emailInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailInputRef.current?.focus();
  }, []);

  // ... rest of component
};
```

---

**3. Screen Reader Announcements**

Use live regions for dynamic content:

```tsx
// In Library page, announce when new conversation finishes processing
<div
  role="status"
  aria-live="polite"
  className="sr-only"
>
  {justCompletedConversation &&
    `${justCompletedConversation.title} processing complete`
  }
</div>
```

---

### 6.2 Cognitive Load Reduction Strategies

#### **Information Hierarchy Best Practices:**

**1. Progressive Disclosure**
- Show 5 search results initially, "Load more" button for next 20
- Collapse long AI responses with "Show more" after 3 paragraphs
- Hide advanced filters behind "More filters" dropdown

**2. Defaults that Work for 80% of Users**
- Search defaults to "All conversations" but remembers last scope
- Share permission defaults to "View only"
- Upload expands automatically to metadata form for files > 100MB

**3. Status Transparency**
- Always show what the system is doing: "Analyzing 12 conversations..."
- Provide time estimates when possible: "~15 seconds remaining"
- Explain why something failed: "Upload failed: File size exceeds 500MB limit"

---

#### **Reducing Decision Fatigue:**

**Bad:** "Do you want to enable chunked upload?" (User doesn't know what this means)
**Good:** Automatically detect file size and use appropriate upload method silently

**Bad:** 12 sharing permission options
**Good:** 3 clear options with help text
- View only - "They can read and listen"
- Can comment - "They can add notes to sidebar"
- Can edit - "They can rename speakers and update terms"

---

### 6.3 Error Prevention & Recovery

#### **Upload Failures:**

**Current:** Silent failure or generic error
**Improved:**
1. Client-side validation before upload starts
2. Clear error messages with recovery steps
3. Option to retry automatically

```tsx
// Error message component
<Alert variant="error">
  <AlertCircle />
  <div>
    <strong>Upload failed: Connection lost</strong>
    <p>Your upload was 67% complete (302MB / 450MB)</p>
    <Button onClick={resumeUpload}>Resume from 302MB</Button>
    <Button variant="ghost" onClick={cancelUpload}>Cancel</Button>
  </div>
</Alert>
```

---

#### **AI Hallucination Detection:**

**Problem:** Gemini may generate incorrect information
**Solution:** Confidence scoring + source citation

```tsx
// In chatbot response
<AIMessage>
  <p>The budget for Q1 was <strong>$2.4M</strong>
    <ConfidenceBadge level="high" timestamp="34:12" />
  </p>
  <p>The team discussed hiring <em>5-7 engineers</em>
    <ConfidenceBadge level="medium" />
    <InfoIcon tooltip="This is an estimate based on context, not a direct quote" />
  </p>
</AIMessage>
```

**Confidence levels:**
- **High** - Direct quote with exact timestamp
- **Medium** - Paraphrased from multiple mentions
- **Low** - Inferred from context (shown with disclaimer)

---

### 6.4 Mobile Optimization Gaps

#### **Current Issues:**

1. **Sidebar hidden on mobile** - No access to Terms/People/Chat
2. **Small touch targets** - Icon buttons are 32x32px (need 44x44px)
3. **No swipe gestures** - Natural mobile interaction missing

#### **Recommended Mobile UX:**

**Bottom Sheet Pattern for Sidebar:**

```
┌──────────────────────────────────────┐
│ [Transcript view]                    │
│                                      │
│ Segment 1: Speaker A                 │
│ "This is the transcript..."          │
│                                      │
│ [Active segment highlighted]         │
│                                      │
│ ... more segments ...                │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ [Context] [People] [Chat] 👆    │ │ ← Swipe up to expand
│ └──────────────────────────────────┘ │
│                                      │
│ [Audio player fixed at bottom]       │
└──────────────────────────────────────┘

When swiped up:
┌──────────────────────────────────────┐
│ [Transcript view - 40% height]       │
│ ...segments...                       │
├──────────────────────────────────────┤
│ [Context] [People] [Chat] 👇        │ ← Swipe down to collapse
│                                      │
│ [Sidebar content - 60% height]       │
│                                      │
│ [Term definitions / Chat interface]  │
│                                      │
└──────────────────────────────────────┘
```

**Implementation:** Use `react-spring-bottom-sheet` or similar library

---

#### **Touch Gesture Enhancements:**

- Swipe left/right on segment → Skip to previous/next segment
- Long press on timestamp → Copy to clipboard
- Double-tap segment → Play that segment
- Pinch on waveform (future feature) → Zoom in/out

---

## Part 7: Implementation Roadmap

### 7.1 Phased Rollout Strategy

#### **Phase 1: Search & Single-Conversation Chat (Sprint 1-2)**

**Why first:**
- Builds on existing infrastructure (Firestore, Gemini API)
- Highest user value for current users
- No new auth/sharing complexity

**Deliverables:**
- Search bar in Library with full-text search
- Chat tab in Viewer sidebar
- Keyboard shortcuts for accessibility

**Success Metrics:**
- 60% of users try search within first week
- 40% of users ask at least one chat question
- Average search → open time < 10 seconds

---

#### **Phase 2: Sharing & Collaboration (Sprint 3-4)**

**Why second:**
- Requires auth work (email verification, permissions)
- Enables team use cases (MVP → Enterprise)
- Sets foundation for multi-user features

**Deliverables:**
- Share modal with email invite
- "Shared With Me" tab in Library
- Permission levels (view/comment/edit)
- Email notifications

**Success Metrics:**
- 25% of users share at least one conversation
- Average time from share → first view < 24 hours
- Zero security incidents (audit logs working)

---

#### **Phase 3: Cross-Conversation Insights (Sprint 5-6)**

**Why third:**
- Most complex feature (multi-conversation indexing)
- Requires robust search from Phase 1
- Benefits from sharing infrastructure (team insights)

**Deliverables:**
- Insights page with scope selector
- Cross-conversation chat with source attribution
- Saved queries and export functionality

**Success Metrics:**
- 15% of users with 10+ conversations use Insights
- Average query response time < 20 seconds
- 80% of responses include source citations

---

#### **Phase 4: Large File Support (Sprint 7)**

**Why last:**
- Infrastructure work (chunked upload, background processing)
- Lower priority than collaboration features
- Requires DevOps changes (Cloud Function memory limits)

**Deliverables:**
- Resumable upload with pause/resume
- Email notification on processing complete
- Metadata capture during upload

**Success Metrics:**
- Upload success rate for files > 200MB: > 95%
- Average upload time improvement: 30% faster
- User complaints about upload failures: < 5%

---

### 7.2 Technical Debt & Refactoring Needs

**Before implementing new features, address:**

1. **Library table component** - Extract to separate component, add sorting/filtering props
2. **Modal system** - Create reusable modal wrapper (Share, Upload, Rename use same pattern)
3. **Error boundaries** - Add React error boundaries for Chat and Search features
4. **Firestore security rules** - Update rules for sharing (user can read if in `sharedWith` array)
5. **Test coverage** - Current coverage unknown, aim for 70% before adding features

---

### 7.3 Performance Budgets

**Page Load Targets:**
- Library initial render: < 1.5s
- Viewer initial render: < 2.0s
- Search results: < 800ms
- Chat response: < 5s (single conversation), < 20s (cross-conversation)

**Bundle Size Limits:**
- Initial bundle: < 300KB gzipped
- Code-split chunks: < 100KB each
- Lazy load: Chat components, Search results, Insights page

---

## Part 8: Design System Assets Needed

### 8.1 New Components to Build

| Component | Priority | Dependencies | Design File |
|-----------|----------|--------------|-------------|
| Chat message bubble | P0 | None | `chat-message.tsx` |
| Search result card | P0 | None | `search-result.tsx` |
| Share modal | P1 | Modal wrapper | `share-modal.tsx` |
| Conversation scope selector | P1 | Filter components | `scope-selector.tsx` |
| Confidence badge | P2 | Tooltip | `confidence-badge.tsx` |
| Bottom sheet (mobile) | P2 | react-spring | `bottom-sheet.tsx` |
| Keyboard shortcuts legend | P2 | Modal wrapper | `shortcuts-modal.tsx` |

---

### 8.2 Icon Additions Needed

**Current library:** Lucide React (existing)

**New icons to add:**
- `MessageSquare` - Chat tab icon
- `Share2` - Share button
- `Filter` - Filter dropdown
- `Sparkles` - AI/Gemini indicator
- `Users2` - Shared with me indicator
- `Layers` - Cross-conversation insights
- `Download` - Export actions
- `Link2` - Copy link action

All icons already available in Lucide React - no custom SVGs needed.

---

### 8.3 Animation & Micro-interactions

**New animations to implement:**

1. **Chat message fade-in**
   - Message slides up + fades in (200ms)
   - Timestamp appears after message (stagger 100ms)

2. **Search results loading skeleton**
   - Pulse animation on loading cards
   - Smooth transition when results populate

3. **Share modal slide-down**
   - Modal slides from top (not center zoom)
   - Background blur transition (300ms)

4. **Scope selector expand**
   - Filter panel slides down (250ms ease-out)
   - Height auto-animates (not instant)

5. **Processing progress**
   - Indeterminate spinner for < 3s operations
   - Determinate progress bar for > 3s operations
   - Success checkmark animation (scale + rotate)

**Rationale:** Animations provide feedback and reduce perceived latency.

---

## Part 9: Accessibility Testing Plan

### 9.1 Manual Testing Checklist

**Screen Reader Testing (NVDA/JAWS on Windows, VoiceOver on Mac):**
- [ ] All buttons have descriptive labels
- [ ] Chat messages announce correctly with speaker
- [ ] Search results announce result count
- [ ] Loading states announce "Loading..." then result
- [ ] Form errors announce via `aria-live` region

**Keyboard Navigation Testing:**
- [ ] Tab order follows visual layout
- [ ] All interactive elements reachable by keyboard
- [ ] Modal traps focus (can't tab outside)
- [ ] Escape key closes modals
- [ ] Shortcuts work without modifiers (no Ctrl+K traps)

**Color Contrast Testing:**
- [ ] Run axe DevTools on all new pages
- [ ] Test with Windows High Contrast mode
- [ ] Verify slate-400 text meets 4.5:1 ratio
- [ ] Check focus indicators have 3:1 ratio

---

### 9.2 Automated Testing

**Tools to integrate:**
- `@axe-core/react` - Catch accessibility issues in development
- `jest-axe` - Unit test accessibility violations
- `cypress-axe` - E2E accessibility tests

**Example test:**
```typescript
// Library.test.tsx
import { axe, toHaveNoViolations } from 'jest-axe';
expect.extend(toHaveNoViolations);

test('Library page has no accessibility violations', async () => {
  const { container } = render(<Library />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});
```

---

## Part 10: Open Questions & User Research Needs

### 10.1 Questions for User Testing

**Search Feature:**
1. Do users expect search to include audio transcription text or just metadata (title, speakers)?
2. How do users want to filter results - by date, speaker, topic, or relevance?
3. Should search support boolean operators (AND, OR, NOT) or natural language only?

**Chat Feature:**
4. Do users trust AI responses without explicit source citations?
5. How long are users willing to wait for cross-conversation analysis (10s? 30s? 1min?)?
6. Should chat history persist across sessions or reset on each visit?

**Sharing Feature:**
7. What's the expected mental model for "shared conversations" - like Google Docs or Dropbox?
8. Should shared conversations appear in a separate list or inline with "My Conversations"?
9. Do users need granular permissions (view only, comment, edit) or just "can view"?

**Large Files:**
10. What file size limit is acceptable for the target user base (200MB? 500MB? 1GB?)?
11. Should upload continue in background if user closes browser, or require tab to stay open?
12. Do users need batch upload (multiple files at once) or one-at-a-time is sufficient?

---

### 10.2 Recommended User Research Studies

**Study 1: Usability Testing of Search + Chat (n=8 users)**
- **Method:** Moderated remote sessions (60 min each)
- **Tasks:**
  1. Find a specific conversation from 3 months ago
  2. Ask chatbot to summarize key decisions
  3. Verify chatbot answer by jumping to timestamp
- **Metrics:** Task success rate, time on task, user confidence rating
- **Timing:** Before Phase 1 implementation (wireframe testing)

**Study 2: Share Modal Comprehension (n=20 users)**
- **Method:** Unmoderated card sorting + tree testing
- **Questions:**
  1. Sort sharing permissions by expected access level
  2. Find where to revoke someone's access
  3. Find where to see who has viewed the conversation
- **Metrics:** Findability score, time to complete, error rate
- **Timing:** During Phase 2 design iteration

**Study 3: Cross-Conversation Insights Concept Test (n=12 users)**
- **Method:** Think-aloud protocol with interactive prototype
- **Scenarios:**
  1. "Find common themes across customer interviews"
  2. "See which decisions were made in Q4 planning meetings"
  3. "Export insights for a report"
- **Metrics:** Ease of use (SUS score), feature comprehension, likelihood to use
- **Timing:** Before Phase 3 implementation

---

## Appendix: Design Patterns Library

### A1. Component Specification: Chat Message

```typescript
interface ChatMessageProps {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
  sources?: { text: string; timestamp: string; conversationId: string }[];
  onTimestampClick?: (timestamp: string) => void;
  onSourceClick?: (conversationId: string, timestamp: string) => void;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({
  role,
  content,
  timestamp,
  sources,
  onTimestampClick,
  onSourceClick
}) => {
  return (
    <div className={cn(
      "flex gap-3 mb-4",
      role === 'user' && "flex-row-reverse"
    )}>
      <Avatar role={role} />
      <div className={cn(
        "flex-1 rounded-lg p-3",
        role === 'user' ? "bg-blue-100" : "bg-slate-100"
      )}>
        <Markdown content={content} />
        {sources && sources.length > 0 && (
          <div className="mt-2 pt-2 border-t border-slate-200">
            <p className="text-xs text-slate-500 mb-1">Sources:</p>
            {sources.map((source, idx) => (
              <button
                key={idx}
                onClick={() => onSourceClick?.(source.conversationId, source.timestamp)}
                className="block text-xs text-blue-600 hover:underline"
              >
                {source.text} [{source.timestamp}]
              </button>
            ))}
          </div>
        )}
      </div>
      {timestamp && (
        <span className="text-xs text-slate-400">{timestamp}</span>
      )}
    </div>
  );
};
```

---

### A2. Responsive Breakpoint Strategy

**Tailwind breakpoints:**
- `sm`: 640px - Small tablets, large phones in landscape
- `md`: 768px - Tablets
- `lg`: 1024px - Small laptops (current sidebar breakpoint)
- `xl`: 1280px - Desktop
- `2xl`: 1536px - Large desktop

**Recommended layouts:**

| Screen Size | Library Layout | Viewer Layout |
|-------------|----------------|---------------|
| < 640px (mobile) | Single column list with cards | Transcript only, bottom sheet for sidebar |
| 640px - 1024px (tablet) | 2-column grid | Transcript with floating sidebar toggle |
| 1024px+ (desktop) | Table with all columns | Split view (transcript 70% + sidebar 30%) |

---

### A3. Error Message Copy Guidelines

**Tone:** Friendly but direct, explain what happened and what to do next

**Template:**
```
[Emoji] [What happened]
[Why it happened - optional]
[Action buttons]
```

**Examples:**

```
❌ Upload failed
Your internet connection was lost halfway through the upload.

[Retry from 302MB] [Cancel]
```

```
⚠️ Search took too long
We're searching across 150 conversations, which is taking longer than expected.

[Keep waiting] [Cancel]
```

```
🚫 Can't share this conversation
You need to be the owner to share. Contact alex@company.com to request sharing permissions.

[Got it]
```

---

## Summary & Next Steps

### Key Recommendations

1. **Prioritize search + single-conversation chat** - Highest value, lowest complexity
2. **Design sharing with security-first mindset** - Email verification, audit logs, revocable access
3. **Use progressive disclosure** - Don't overwhelm with 5 new top-level nav items
4. **Test cross-conversation insights early** - Most novel feature, highest risk of poor UX
5. **Address accessibility gaps before launch** - Keyboard shortcuts, ARIA labels, focus management

### Metrics to Track Post-Launch

- **Adoption:** % of users who try each new feature within 30 days
- **Engagement:** Median queries per user per week (search + chat)
- **Collaboration:** % of conversations shared, average viewers per shared item
- **Performance:** P95 response time for chat queries
- **Satisfaction:** NPS score, feature-specific ratings

### Design Assets Delivery

**Next steps for development team:**
1. Review this document and flag any unclear sections
2. Prioritize Phase 1 features (search + chat) for next sprint planning
3. Request high-fidelity mockups if needed (this doc provides wireframes)
4. Schedule user research sessions for Share modal testing
5. Set up accessibility testing tools (`axe`, `jest-axe`, `cypress-axe`)

---

**Document End**
Questions? Contact UX team for clarification or design iteration workshops.
