# What's New

## Version 2.13.0 - March 6, 2026

### 🐛 Better Transcript Segmentation

**Conversations Stay Properly Broken Down**
- Fixed an issue where transcripts could collapse dozens of natural sentences into a handful of giant text blocks
- Each speaker turn now preserves WhisperX's original sentence-level breaks, so you see granular, navigable segments instead of walls of text
- This particularly improves results for multi-speaker conversations where different people's words were being mashed together in the same block

---

## Version 2.11.0 - February 27, 2026

### ✨ Resizable Sidebar

**Drag to Fit Your Screen**
- You can now **drag the left edge of the sidebar** to make it wider or narrower
- Your preferred width is remembered across sessions — set it once and forget it
- Works with any width from 280px up to half your screen

---

## Version 2.10.0 - February 26, 2026

### 🚀 Faster Multi-Chunk Processing

**Smarter Speaker Handoff Between Chunks**
- When processing long audio files, the first chunk now acts as the "leader" and shares what it learns about speakers with all subsequent chunks
- Later chunks skip redundant speaker analysis entirely, so your long files process **faster** and cost less in API tokens
- Speaker names are more consistent across chunks — fewer cases where "Sam" in the first half becomes "Speaker 2" in the second half

### 🎯 Improved Speaker Matching

**More Reliable Name-Based Merging**
- When the system identifies the same person by name in different parts of a long recording, the matching logic is now more precise
- Previously, a small additive boost could occasionally let unrelated speakers sneak through — now a floor-based approach guarantees named matches clear the merge threshold without inflating already-strong matches

**Fewer Duplicate Speakers**
- The system now catches over-fragmentation more aggressively, triggering corrective merges when the detected speaker count is unreasonably high relative to the actual number of people talking

---

## Version 2.9.2 - February 25, 2026

### 🎯 Selection Mode for Speaker Fixes

**Clicks Do What You Expect**
- Clicking a transcript segment now always jumps to that point in the audio — no more accidentally selecting segments when you just want to navigate
- The previous behavior (where a click could toggle multi-select) caused confusion when you expected playback and got a purple highlight instead

**Explicit Selection Mode**
- Press `S` on your keyboard or click the "Select" button to enter selection mode
- In selection mode, click segments to select them (purple highlight), then use the floating bar to reassign them to a different speaker
- Shift+Click selects a range of segments at once
- Press `Escape` to exit selection mode and clear your selections
- Click "Done" to exit but keep your selections for later

**Always Know What Mode You're In**
- A visible indicator shows when selection mode is active
- Selected segment count is displayed so you always know how many segments you've picked
- The `?` help modal now lists the new `S` and `Esc` shortcuts

---

## Version 2.9.1 - February 23, 2026

### 🐛 More Accurate Speaker Boundaries

**Cleaner Sentence Breaks**
- Transcript segments now break at natural sentence boundaries more reliably
- Previously, a segment could start or end mid-sentence (e.g., "Yeah. So what I was" cut off from "saying is...") — now trailing fragments are moved to where they belong
- The system also catches smaller fragments after commas and semicolons

**Smarter Speaker Corrections**
- When the AI detects that a segment contains speech from two different people, it can now split the segment at the sentence boundary instead of just reassigning the whole thing
- Invalid splits are safely skipped — no risk of garbled or missing text

---

## Version 2.9.0 - February 22, 2026

### 🎯 Smarter Speaker Matching

**Name-Aware Voice Matching**
- When the system identifies the same person by name across different parts of a long recording, it now uses that as a tiebreaker for voice matching
- Previously, speakers with borderline voice similarity could end up split into separate entries even when both were clearly "Sam" — now matching names nudge the system toward merging them correctly
- Generic labels like "Speaker 1" are ignored to prevent false merges

**Better Role Recognition**
- Speakers with roles like "Team Member", "Engineer", "Presenter", or "Consultant" are now correctly recognized as active participants
- Previously, if someone named "Terry" was both a speaker and mentioned in conversation, their name could be rejected unless they had a role like "Host" or "Guest" — this is now fixed for 13 additional roles

---

## Version 2.8.0 - February 20, 2026

### 🚀 Faster Transcription with Dedicated GPU

**Self-Hosted Whisper Processing**
- Transcription now runs on a dedicated GPU server instead of a third-party API
- The same Whisper Large v3 Turbo + pyannote speaker diarization you know, now faster and more reliable
- Finer gap detection (0.3s) preserves quick acknowledgments like "Yeah" and "Mm-hmm" that were previously merged into neighboring segments

### 🐛 Bug Fix: Speaker Corrections

**Reassign-Then-Undo No Longer Breaks**
- Fixed a bug where reassigning a segment to a different speaker and then trying to move it back would fail
- The backend now correctly tracks your corrections, so multi-step speaker edits work as expected

---

## Version 2.7.0 - January 30, 2026

### ✨ Manual Speaker Correction

**Fix Diarization Mistakes Yourself**
- When the system incorrectly splits one person into multiple speakers, you can now **merge them** with a simple 3-click workflow
- New "Speakers" tab in the sidebar shows all speakers with merge controls
- Click "Merge" on the wrong speaker → Select the correct speaker → Confirm
- Your changes are saved automatically and apply instantly—no need to re-process

**Reassign Individual Segments**
- Right-click (or long-press on mobile) any transcript segment to move it to a different speaker
- Shift+Click to select multiple segments, then bulk-reassign them all at once
- Speakers with no remaining segments automatically hide from the list

**Inline Speaker Renaming**
- Double-click any speaker name to rename them directly
- Names update everywhere instantly—no modal dialogs needed

**Full Undo Support**
- Every change (merge, reassign, rename) can be undone with the Undo button
- Toast notifications appear after each action with a 10-second undo window
- Your original transcript is never modified—all corrections are applied on top

---

## Version 2.6.0 - January 28, 2026

### ✨ Smarter Speaker Identification

**Names Assigned from Conversation Context**
- When someone says "I'm Chris" or "My name is Alex," they're now correctly labeled with that name
- The system also picks up names from how people address each other ("Thanks, Mike")
- Names are only assigned when the evidence is strong—uncertain cases keep their role labels (Host, Guest, etc.)

**Fewer Duplicate Speakers**
- Improved detection of when the same speaker appears across different parts of a long recording
- The system now automatically adjusts when it detects too many speaker fragments, merging them more aggressively
- Better calibration means fewer cases where one person is split into multiple speaker IDs

---

## Version 2.5.1-beta.2 - January 25, 2026

### 🔧 Behind the Scenes

**Zero-Configuration Deployments**
- Speaker reconciliation feature flags are now automatically created during deployment
- Fresh deployments work immediately—no manual Firestore setup required
- Existing settings are preserved; the system only initializes when flags don't exist

---

## Version 2.5.1-beta.1 - January 25, 2026

### 🔧 Behind the Scenes

**Smarter Speaker Matching**
- Speaker identification now considers **audio quality** when matching voices across chunks
- Speakers who talk close together in time are more likely to be correctly linked
- The system now automatically adjusts its sensitivity based on how many speakers it detects—fewer duplicate speakers overall

**Safer Rollouts (Admin)**
- New feature flag system allows gradual rollout of speaker reconciliation improvements
- Auto-disable kicks in if error rates spike, preventing issues from affecting all users
- Quality metrics now visible in Admin Dashboard under a new "Quality" tab

---

## Version 2.5.0 - January 19, 2026

### ✨ Improvements

**Copy Any AI Response**
- You can now copy **any** assistant message to your clipboard, including responses where the AI couldn't answer your question
- Copied text is clean—timestamp citations and "Additional sources" content are excluded automatically

**Chat Controls Work Instantly**
- Export and clear buttons now enable immediately after you send your first message
- Previously, you had to refresh the page to use these controls after starting a new conversation

---

## Version 2.4.0 - January 15, 2026

### ✨ Improvements

**More Reliable Chat**
- Chat no longer fails intermittently with "resource exhausted" errors
- If the AI service is temporarily busy, the app now automatically retries instead of showing an error
- Upgraded to a more stable AI model for consistent responses

**Better Source Citations**
- Timestamp citations in chat responses now work more reliably
- When the AI groups multiple sources together like `[segment 3, segment 4, segment 9]`, each one now becomes a separate clickable button
- Previously, grouped citations would sometimes appear as plain text—now they all render correctly

---

## Version 2.3.2 - January 15, 2026

### 🐛 Bug Fixes

**Historical Job Details Now Display Correctly**
- The admin dashboard now properly shows processing details for older transcription jobs
- Duration and timing information for jobs processed before v2.2.0 now displays as "-" instead of causing display errors

### 🔧 Admin Tools

**Repair Tool for Old Data**
- Added a new script mode (`--mode=fix-missing`) to repair metrics documents from older versions
- Run `node scripts/reset-metrics.mjs --mode=fix-missing-dry` to preview what will be fixed

---

## Version 2.3.1 - January 15, 2026

### 🐛 Bug Fixes

**Code Blocks Now Display Correctly**
- Fixed an issue where code blocks in chat responses didn't scroll horizontally
- Long lines of code now stay readable instead of breaking the layout
- This was a regression from the v2.3.0 update

---

## Version 2.3.0 - January 14, 2026

### ✨ New Features

**Richer AI Responses**
- Chat responses now display **formatted text** including bold, italic, bullet lists, numbered lists, and code snippets
- Technical code blocks scroll horizontally so they don't break the chat layout
- Risky content (images, iframes) is automatically filtered for security

**Inline Source Citations**
- When the AI references a part of your transcript, you'll now see a clickable **timestamp button right in the text**
- Click any timestamp to jump to that moment in the audio and highlight the segment
- No more scrolling to find which source matches which statement—it's all inline now
- Any extra sources still appear at the bottom in an "Additional sources" section

### 🐛 Bug Fixes

**Speaker Names Now Show Correctly**
- Source citations now properly display the speaker's name instead of "Unknown"
- Previously, a data mismatch caused speaker information to get lost between the server and app

---

## Version 2.2.0 - January 14, 2026

### ✨ New Features

**Real Cost Tracking (Admin)**
- Cost reports now show **actual** GCP billing data alongside estimates
- Billing data syncs daily from BigQuery, so you can verify if estimates match reality
- New diagnostic tools help debug billing label propagation

### 🔧 Improvements

**More Accurate Cost Estimates**
- Audio input tokens (from voice analysis) and text input tokens (from transcript analysis) are now tracked separately
- This gives more accurate cost breakdowns since audio and text have different rates

**Cleaner Cost Tracking**
- Removed obsolete separate diarization costs—speaker identification is now bundled with transcription
- Cost calculations now use actual compute times from Replicate instead of local timing

### ⚠️ Admin Notice

**Pricing Configuration Required**
- Cost calculation now requires pricing to be configured in the `_pricing` collection
- If pricing isn't set up, costs will show as $0 with a warning (previously used hardcoded defaults)
- This prevents silent underestimation when rates change

---

## Version 2.0.3 - January 13, 2026

### ✨ New Features

**Job Control for Active Transcriptions**
- You can now **cancel** a transcription while it's processing—no more waiting for a stuck job to finish
- The cancel button works at any stage: processing, chunking, merging, or reprocessing
- **Retry** failed or cancelled jobs with one click (up to 3 attempts per file)
- For long files that were partially processed, retry picks up where it left off instead of starting over

### 🐛 Bug Fixes

**More Reliable Retries**
- Fixed an issue where retrying a job could get confused by leftover background tasks from the previous attempt
- Progress bars no longer jump around unexpectedly during retries

**Better Memory for Large Files**
- Processing now uses more memory (2GB), which helps with large or high-quality audio files

---

## Version 2.0.2 - January 13, 2026

### 🔧 Improvements

**Larger File Uploads**
- You can now upload audio files up to **500MB** (previously 100MB)
- Handles longer uncompressed WAV recordings
- If you try to upload a file that's too large, you'll see a clear error message before the upload even starts

---

## Version 2.0.0 - January 13, 2026

### ✨ New Features

**Smarter Speaker Identification**
- Speakers are now identified by their **voice signature**, not just what they say
- This dramatically improves accuracy for conversations with multiple speakers—you'll see 2-3 speakers instead of 20+ duplicates
- Works automatically for new uploads; older transcripts use the previous method

**Faster Processing for Long Audio**
- Large files (30+ minutes) now process in **parallel** for faster results
- New "Fast mode" is the default; you can switch to "Legacy mode" if you prefer sequential processing
- Upload modal explains the trade-offs between speed and accuracy

**Accurate Audio Seeking**
- Clicking on a transcript segment now plays the **exact** audio position
- Fixes the 3-10 second drift that occurred with some audio files (especially YouTube downloads)
- You'll see an "Optimizing Audio" step during upload as we prepare your file

### 🔧 Improvements

**Debugging Made Easier**
- Conversation ID now visible in the viewer header (click to copy)
- Processing version tracked for each transcript to help diagnose issues

### 🐛 Bug Fixes
- Progress bar no longer jumps backwards during parallel processing
- Fixed errors when retrying failed chunks
- Fixed random single-character highlights in term detection
- Large high-quality audio files (46MB+) now chunk properly before processing

---

## Version 1.8.0-beta - January 5, 2026

### ✨ New Features

**Cost Transparency for Everyone**
- You can now see a **pricing accuracy indicator** on your My Stats page that shows whether your cost estimates are up-to-date with current rates
- The indicator displays when rates were last captured and includes a disclaimer about how costs are calculated
- Admins see a convenient link to dive deeper into the cost breakdown

**Admin Cost Dashboard**
- New Job Detail view shows timing breakdowns, token usage, and cost verification for each processing job
- Chat metrics tab shows query volumes and response times by conversation
- Cost Reconciliation report for monthly billing verification with CSV export

### 🔧 Improvements

**Cleaner Modals**
- Delete and abort confirmation dialogs no longer show potentially inaccurate cost estimates
- You'll be directed to My Stats for accurate cost information instead

**Better Billing Integration**
- All API calls now include billing labels for easier cost tracking in Google Cloud

### 🐛 Bug Fixes
- Fixed admin dashboard URL routing for job detail and reconciliation pages
- Fixed timezone issues in cost reconciliation date grouping
- Pricing accuracy now correctly shows "No pricing configured" when rates haven't been set up (previously showed a misleading "match" status)

---

*For technical details, see [CHANGELOG.md](./CHANGELOG.md)*
