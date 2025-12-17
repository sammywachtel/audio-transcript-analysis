# Conversation Transcript + Context Web App — Requirements Document (v1.1)

## Document control
- **Version:** 1.1
- **Date:** 2025-12-15
- **Owner:** Product / Architecture
- **Audience:** Engineering, Design, QA
- **Status:** Local Prototype Phase (IndexedDB + Client-side Gemini)

---

## 0) Project Status & Roadmap (New)

### Current Status: Local Prototype
The application is currently functioning as a **local-only React application**.
- **Storage:** Uses IndexedDB (`idb`) for persistence instead of Firestore/GCS.
- **AI Processing:** Uses Client-side Gemini API calls.
- **Auth:** No authentication (local session only).
- **Features Live:** Audio upload, playback, transcript rendering, speaker renaming, term highlighting, topic segmentation.

### Immediate Next Steps
1.  **Implement Person/Entity Extraction:** Update Gemini prompt to extract mentioned people and affiliations.
2.  **UI - People Panel:** Add a secondary tab to the sidebar to list people and allow manual notes.
3.  **Cloud Migration (Future):** Implement Firebase Auth, Firestore, and GCS as defined in Section 14.

---

## 1) Product overview

### Problem statement
People often leave conversations (work calls, interviews, technical discussions, medical consults, etc.) with incomplete understanding of the terms, acronyms, and topic shifts that occurred. Existing transcription tools produce text, but they rarely:
- Provide **educational context** for technical terms,
- Make it easy to **jump between transcript and audio precisely**,
- Help users understand **topic boundaries** and **tangents**,
- **Identify key stakeholders** mentioned during the conversation,
- Persist and support **corrections** (speaker names, transcript, notes, segmentation) tied to an account.

### Target users
- **Knowledge workers**: engineers, product managers, analysts, support, sales.
- **Learners**: people reviewing technical conversations to educate themselves.
- **Interviewers/interviewees**: reviewing interviews or coaching sessions.
- **Consultation users**: customers reviewing complex instructions (non-medical guidance).

### Primary use cases
- Upload a recorded conversation → view a high-quality transcript with speakers and punctuation.
- Identify unfamiliar acronyms/technical terms → read concise explanations in a sidebar.
- **Identify people mentioned** → see a list of names and inferred companies/groups; add private notes.
- Click transcript text to play audio at the corresponding time; follow along as audio plays.
- Understand conversation structure via topic markers and tangent highlights.
- Correct and refine transcript, speakers, notes, and segmentation; changes persist.

### Core value proposition
**“A transcript that teaches you what you heard.”**
The app transforms a raw recording into an interactive, navigable learning artifact: time-aligned transcript + speaker labels + contextual term notes + topic/tangent structure + **people directory**, all editable and saved.

---

## 2) Scope and non-scope

### In scope (v1)
- Google login (Firebase Auth / Google Sign-In) [Currently mocked locally].
- Audio upload (web) and durable storage (GCS) + metadata in Firestore [Currently Local/IndexedDB].
- Asynchronous processing pipeline:
  - Speaker diarization (speaker count + segments),
  - ASR transcription with punctuation,
  - Timestamped transcript segments (and optional word-level timestamps),
  - Technical term/acronym extraction + note generation + linking occurrences,
  - **Mentioned People detection** (Name + Affiliation) with user note-taking capabilities,
  - Topic segmentation and tangent detection with markers.
- Conversation viewer:
  - Transcript with speaker labels,
  - Inline highlighting for terms,
  - Right-side panel for **Terms** and **People**,
  - Two-way selection sync between transcript highlights and sidebar notes,
  - Audio playback from any text location; playback-follow highlighting.
- Editing:
  - Assign names to diarized speakers,
  - Edit transcript text (segment-level),
  - Edit term notes (content + titles),
  - **Edit people notes** (add manual context),
  - Edit topic/tangent markers (add/move/delete, reclassify tangent),
  - All edits persisted.
- Library/history of past uploads with search/filter.

### Out of scope (explicit for v1)
- Live recording / real-time transcription.
- Multi-user collaboration on the same conversation.
- Organization-level admin, SSO beyond Google, multi-tenant enterprise controls.
- Automated action items, summaries, or meeting minutes (beyond term notes/topics).
- Full document export formatting (PDF/Word), except basic export of transcript JSON/Markdown (optional).
- Full multilingual UI; limited language support in ASR is allowed but not guaranteed.
- Automated speaker name inference from calendars/contacts (may be a future enhancement).
- Compliance guarantees (HIPAA/BAA, SOC2) — see “Compliance considerations”.

---

## 3) Assumptions
- **Assumption:** Web app targets modern evergreen browsers (Chrome, Edge, Safari, Firefox), desktop-first; mobile support is “best-effort” for viewer, not optimized for heavy editing.
- **Assumption:** Max v1 recording length is **2 hours** and max file size is **1 GB** (configurable).
- **Assumption:** ASR and diarization are performed server-side using a managed service or containerized models; initial implementation favors reliability and cost control over extreme accuracy.
- **Assumption:** Word-level timestamps are used when available; otherwise fallback to segment-level timestamps.
- **Assumption:** Term note “sources” can be either: (a) model-generated with no external citations, or (b) optionally enriched with a limited set of curated reference sources (future enhancement).

---

## 4) Personas and user stories

### Personas
- **P1: “Sam” (Technical learner):** uploads a team call; wants to understand acronyms and topic changes.
- **P2: “Jordan” (Manager):** reviews a project call; wants quick navigation and accurate attribution.
- **P3: “Casey” (Interviewer):** reviews an interview; wants speaker labels and precise audio replay.

### User stories (prioritized)
| Priority | User story | Success indicator |
|---|---|---|
| P0 | As a user, I can sign in with Google and see my saved uploads. | Can view library tied to account. |
| P0 | As a user, I can upload an audio file and see processing progress. | Job completes; viewer loads. |
| P0 | As a user, I can see an attributed transcript with punctuation and timestamps. | Transcript renders with speakers + segments. |
| P0 | As a user, I can assign human-readable names to speakers and see them reflected everywhere. | Name mapping persists and updates UI. |
| P0 | As a user, I can click anywhere in the transcript to start audio from that point. | Playback starts at correct time. |
| P0 | As a user, I can click highlighted terms and see the corresponding note in the sidebar. | Correct note selected + scrolled. |
| P1 | As a user, I can see a list of people mentioned in the conversation and their companies. | Sidebar populates with people. |
| P1 | As a user, I can add a manual note to a mentioned person (e.g., "Follow up with him"). | Note saves and persists. |
| P1 | As a user, I can edit transcript text and not lose alignment to audio. | Edits persist; timestamps stable. |
| P1 | As a user, I can correct term notes and topic/tangent markers when the model is wrong. | Markers editable and saved. |
| P2 | As a user, I can search my library and re-open prior conversations quickly. | Search returns results quickly. |

---

## 5) Functional requirements

### 5.1 Authentication and accounts
- **FR-AUTH-1:** Support Google Sign-In via Firebase Auth.
- **FR-AUTH-2:** Backend APIs must verify Firebase ID tokens and enforce per-user access control.
- **FR-AUTH-3:** User can sign out; token/session cleared client-side.

### 5.2 Upload and processing
- **FR-UP-1:** User can upload audio file formats: `.mp3, .m4a, .wav, .aac, .flac` (configurable).
- **FR-UP-2:** Upload must be resumable for large files (preferred) or robust with retry.
- **FR-UP-3:** After upload, create a processing job and show status: `queued → processing → needs_review (optional) → complete` or `failed`.
- **FR-UP-4:** Store audio in GCS; store a reference in Firestore (no raw audio stored in Firestore).

### 5.3 Speaker diarization and naming
- **FR-DIAR-1:** System estimates number of speakers and assigns speaker IDs (`spk_1`, `spk_2`, ...).
- **FR-DIAR-2:** Transcript segments must reference a speaker ID.
- **FR-DIAR-3:** If speaker names are not known, prompt user in viewer to assign names.
- **FR-DIAR-4:** Allow user to rename speakers at any time; changes re-render transcript and notes.

### 5.4 Transcription (ASR) and punctuation
- **FR-ASR-1:** Generate transcript text with punctuation and sentence boundaries as best as possible.
- **FR-ASR-2:** Transcript stored as ordered segments with timestamps.
- **FR-ASR-3:** Preserve a raw ASR output (for debugging) separate from user-edited text.
- **FR-ASR-4:** Support partial confidence metadata.

### 5.5 Audio-text alignment and playback
- **FR-ALIGN-1:** Clicking a transcript segment plays audio from that segment’s `start_ms`.
- **FR-ALIGN-2:** If word-level timestamps exist, clicking inside a segment (word/position) plays from the nearest word timestamp.
- **FR-ALIGN-3:** While audio plays, the UI highlights current segment/word.
- **FR-ALIGN-4:** Audio player supports play/pause, scrub bar, jump ±5s, playback speed (0.75x–2.0x).
- **FR-ALIGN-5:** Transcript scroll-follow can be toggled.

### 5.6 Technical term/acronym detection and notes
- **FR-TERM-1:** Detect candidate terms (acronyms, proper nouns, domain terms).
- **FR-TERM-2:** Highlight terms inline in transcript.
- **FR-TERM-3:** Build a term entity list with display label, definition, and linked occurrences.
- **FR-TERM-4:** Right-side “Notes” panel lists unique terms.
- **FR-TERM-5:** Deduplicate multiple occurrences.

### 5.7 Two-way selection sync behavior
- **FR-SYNC-1:** Clicking transcript term -> Selects sidebar note.
- **FR-SYNC-2:** Clicking sidebar note -> Highlights transcript occurrences.
- **FR-SYNC-3:** Click outside -> Clear selection.
- **FR-SYNC-4:** Keyboard navigation support.

### 5.8 Topic segmentation and tangent highlighting
- **FR-TOPIC-1:** System inserts topic boundary markers.
- **FR-TOPIC-2:** Tangents are represented as sub-ranges within a topic.
- **FR-TOPIC-3:** Topic markers and tangents are clickable.
- **FR-TOPIC-4:** User can edit topic titles and boundaries.
- **FR-TOPIC-5:** Topic/tangent structure reflected in navigation UI.

### 5.9 Library/history
- **FR-LIB-1:** User can view list of prior conversations.
- **FR-LIB-2:** Delete conversation capability.

### 5.10 Mentioned People & Affiliations (New)
- **FR-PEOPLE-1:** The system must detect full names of people mentioned in the transcript (distinct from the Speakers themselves, though they may overlap).
- **FR-PEOPLE-2:** The system must attempt to infer the "Affiliation" (Company, Department, or Group) of the person based on context.
- **FR-PEOPLE-3:** Display detected people in a dedicated panel (or tab) within the Viewer.
- **FR-PEOPLE-4:** The user must be able to add a manual text note to any detected person (e.g., "This is the decision maker").
- **FR-PEOPLE-5:** These manual notes must be persisted with the conversation.

---

## 6) UX / UI requirements (detailed)

### 6.1 Primary pages / views

#### A) Login
- Google Sign-In button.

#### B) Upload + processing status
- Upload area with drag/drop.
- Progress indicators.

#### C) Conversation viewer (core)
Layout (desktop):
- **Top bar:** conversation title (editable), status, export (optional), delete.
- **Main area (left 65–75%):** transcript with speaker labels and topic/tangent markers.
- **Right panel (25–35%):** Tabbed interface:
  - **Tab 1: Context (Terms)** - existing term notes list.
  - **Tab 2: People** - list of mentioned people + affiliations + editable notes.
- **Bottom or floating:** audio player with scrubber and playback controls.

#### D) Library/history
- Table or card list of conversations.

---

## 7) Processing pipeline requirements

### 7.1 High-level pipeline (async)
1. **Ingestion** (GCS + Firestore).
2. **Pre-processing**.
3. **Speaker diarization**.
4. **ASR transcription**.
5. **Alignment**.
6. **Term extraction**.
7. **Person/Entity Extraction (New):**
   - Extract names and affiliations from transcript text.
8. **Topic/tangent detection**.
9. **Persist results**.
10. **Indexing**.

---

## 8) Data model (Firestore / Local DB)

### 8.1 Collections overview (Updates)

#### `users/{uid}/conversations/{conversationId}`
Same as before, but with added `people` collection or field.

#### `people/{personId}` (New Subcollection or Field)
If storing as a subcollection `users/{uid}/conversations/{conversationId}/people/{personId}`:

| Field | Type | Description |
|---|---|---|
| personId | string | Unique ID |
| name | string | Detected Name |
| affiliation | string? | Inferred Company/Group |
| userNotes | string? | Manual note added by user |
| firstMentionSegmentId | string | Link to first appearance |
| createdBy | string | `system` |
| updatedAt | timestamp | Last update |

---

## 9) API requirements
*Updates to support PATCH on People.*

#### Update Person Note
`PATCH /conversations/{conversationId}/people/{personId}`

**Request**
```json
{ "userNotes": "Key contact for billing." }
```

---

*End of Document*
