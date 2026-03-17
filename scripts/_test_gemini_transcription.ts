#!/usr/bin/env tsx
/**
 * Quick test: Gemini 3 Flash transcript-only (no diarization, no analysis).
 * Compares transcription quality against Chirp-3 / WhisperX.
 *
 * Usage: WAV=1 npx tsx scripts/_test_gemini_transcription.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { GoogleGenAI, createPartFromUri } from '@google/genai';
import admin from 'firebase-admin';
import 'dotenv/config';
import { resolvePocResultsDir } from './poc-results-dir.js';

import { setGlobalDispatcher, Agent } from 'undici';
setGlobalDispatcher(new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCOPE = 'poc_gemini_hybrid';
const { resultsDir: RESULTS_DIR } = resolvePocResultsDir(PROJECT_ROOT, SCOPE, process.argv[3]);
const CONVERT_TO_WAV = process.env.WAV === '1';

function initFirebase(): admin.app.App {
  const saKeyPath = path.join(PROJECT_ROOT, 'firebase-sa-key.json');
  if (!fs.existsSync(saKeyPath)) throw new Error(`SA key not found at ${saKeyPath}`);
  if (admin.apps.length > 0) return admin.apps[0]!;
  return admin.initializeApp({
    credential: admin.credential.cert(saKeyPath),
    storageBucket: 'audio-transcript-analyzer-01.firebasestorage.app',
  });
}

function convertToWav(inputPath: string): string {
  const wavPath = inputPath.replace(/\.[^.]+$/, '.wav');
  execFileSync('ffmpeg', ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', wavPath], { stdio: 'pipe' });
  console.log(`[Convert] WAV: ${(fs.statSync(wavPath).size / 1024 / 1024).toFixed(1)}MB`);
  return wavPath;
}

async function main(): Promise<void> {
  const conversationId = process.argv[2] || 'c_1773188486911';

  console.log('='.repeat(70));
  console.log(`Gemini 3 Flash Transcription Test — ${conversationId}`);
  console.log('='.repeat(70));

  initFirebase();
  const db = admin.firestore();
  const convoDoc = await db.collection('conversations').doc(conversationId).get();
  if (!convoDoc.exists) throw new Error(`Conversation ${conversationId} not found`);

  const convoData = convoDoc.data()!;
  const audioStoragePath = convoData.audioStoragePath as string;

  // Download audio
  const bucket = admin.storage().bucket();
  const tmpDir = os.tmpdir();
  const mp3Path = path.join(tmpDir, `gemini-txn-test-${Date.now()}.mp3`);
  await bucket.file(audioStoragePath).download({ destination: mp3Path });
  console.log(`[Download] ${(fs.statSync(mp3Path).size / 1024 / 1024).toFixed(1)}MB`);

  let audioPath = mp3Path;
  if (CONVERT_TO_WAV) {
    audioPath = convertToWav(mp3Path);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not found');

  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 600_000 } });
  const model = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';

  // Upload
  console.log('[Gemini] Uploading...');
  const uploadedFile = await ai.files.upload({
    file: audioPath,
    config: { mimeType: CONVERT_TO_WAV ? 'audio/wav' : 'audio/mpeg', displayName: `txn-test-${conversationId}` },
  });

  // Wait for processing
  let fileState = uploadedFile.state;
  while (fileState === 'PROCESSING') {
    await new Promise(r => setTimeout(r, 2000));
    const info = await ai.files.get({ name: uploadedFile.name! });
    fileState = info.state;
  }

  // Ask for plain transcript only
  console.log(`[Gemini] Model: ${model}, requesting plain transcript...`);
  const apiStart = Date.now();

  const response = await ai.models.generateContent({
    model,
    contents: [{
      role: 'user',
      parts: [
        createPartFromUri(uploadedFile.uri!, uploadedFile.mimeType!),
        { text: `Transcribe this entire audio recording verbatim. Output ONLY the transcript text — no speaker labels, no timestamps, no formatting, no commentary. Include every word spoken, including filler words (um, uh, like). Do not stop early — cover the ENTIRE recording from start to finish.` },
      ],
    }],
    config: {
      temperature: 0.0,
      maxOutputTokens: 65536,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const apiDuration = Date.now() - apiStart;
  const text = response.text ?? '';
  const usage = response.usageMetadata;

  console.log(`[Gemini] Done in ${(apiDuration / 1000).toFixed(1)}s`);
  console.log(`[Gemini] Tokens: prompt=${usage?.promptTokenCount}, completion=${usage?.candidatesTokenCount}, total=${usage?.totalTokenCount}`);

  const geminiWords = text.trim().split(/\s+/).filter(Boolean);
  console.log(`[Gemini] Transcript: ${geminiWords.length} words`);

  // Clean up
  try { await ai.files.delete({ name: uploadedFile.name! }); } catch (_) { /* */ }
  try { fs.unlinkSync(mp3Path); } catch (_) { /* */ }
  if (audioPath !== mp3Path) try { fs.unlinkSync(audioPath); } catch (_) { /* */ }

  // Load Chirp-3 transcript for comparison
  const chirpPath = path.join(RESULTS_DIR, 'chirp3_benchmark.json');
  let chirpWords: string[] = [];
  if (fs.existsSync(chirpPath)) {
    const chirp = JSON.parse(fs.readFileSync(chirpPath, 'utf-8'));
    chirpWords = chirp.utterances.flatMap((u: { text: string }) => u.text.split(/\s+/).filter(Boolean));
  }

  // Load WhisperX transcript from Firestore segments
  const whisperxWords = (convoData.segments || []).flatMap((s: { text?: string }) =>
    (s.text || '').split(/\s+/).filter(Boolean)
  );

  // Save results
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const resultPath = path.join(RESULTS_DIR, 'transcription_comparison.json');
  fs.writeFileSync(resultPath, JSON.stringify({
    gemini: { wordCount: geminiWords.length, first200: geminiWords.slice(0, 200).join(' '), last100: geminiWords.slice(-100).join(' ') },
    chirp3: { wordCount: chirpWords.length, first200: chirpWords.slice(0, 200).join(' '), last100: chirpWords.slice(-100).join(' ') },
    whisperx: { wordCount: whisperxWords.length, first200: whisperxWords.slice(0, 200).join(' '), last100: whisperxWords.slice(-100).join(' ') },
    apiDurationMs: apiDuration,
    model,
    format: CONVERT_TO_WAV ? 'wav' : 'mp3',
  }, null, 2));

  // Print comparison
  console.log('\n' + '='.repeat(70));
  console.log('TRANSCRIPTION COMPARISON');
  console.log('='.repeat(70));
  console.log(`Gemini 3 Flash: ${geminiWords.length} words (${(apiDuration / 1000).toFixed(1)}s)`);
  console.log(`Chirp-3:        ${chirpWords.length} words`);
  console.log(`WhisperX:       ${whisperxWords.length} words`);
  console.log('');
  console.log('--- First 50 words ---');
  console.log(`Gemini:   ${geminiWords.slice(0, 50).join(' ')}`);
  console.log(`Chirp-3:  ${chirpWords.slice(0, 50).join(' ')}`);
  console.log(`WhisperX: ${whisperxWords.slice(0, 50).join(' ')}`);
  console.log('');
  console.log('--- Last 30 words ---');
  console.log(`Gemini:   ${geminiWords.slice(-30).join(' ')}`);
  console.log(`Chirp-3:  ${chirpWords.slice(-30).join(' ')}`);
  console.log(`WhisperX: ${whisperxWords.slice(-30).join(' ')}`);
  console.log('');
  console.log(`Results saved to: ${resultPath}`);
}

main().catch(err => { console.error('\nFATAL:', err); process.exit(1); });
