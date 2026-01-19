# What's New

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
