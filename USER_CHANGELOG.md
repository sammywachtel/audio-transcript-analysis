# What's New

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
