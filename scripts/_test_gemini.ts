import { GoogleGenAI, createPartFromUri } from '@google/genai';
import admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

// Monkey-patch fetch to log requests
const originalFetch = globalThis.fetch;
globalThis.fetch = async function patchedFetch(input: any, init?: any) {
  const url = typeof input === 'string' ? input : input?.url || input?.toString();
  console.log(`[FETCH] ${init?.method || 'GET'} ${url?.substring(0, 120)}...`);
  if (init?.body) {
    const bodyStr = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    console.log(`[FETCH] Body length: ${bodyStr?.length || 'unknown'}`);
  }
  try {
    const result = await originalFetch(input, init);
    console.log(`[FETCH] Response: ${result.status} ${result.statusText}`);
    return result;
  } catch (err: any) {
    console.error(`[FETCH] Error:`, err.message);
    if (err.cause) console.error(`[FETCH] Cause:`, err.cause);
    throw err;
  }
};

async function main() {
  const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

  const saKeyPath = path.join(PROJECT_ROOT, 'firebase-sa-key.json');
  admin.initializeApp({
    credential: admin.credential.cert(saKeyPath),
    storageBucket: 'audio-transcript-analyzer-01.firebasestorage.app',
  });

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

  // Download audio
  console.log('Downloading audio...');
  const bucket = admin.storage().bucket();
  const audioPath = '/tmp/test_audio_gemini2.mp3';
  await bucket.file('audio/XZJjbLz1oRe8Y9tJYSMLSAvirlg1/c_1773188486911.mp3').download({ destination: audioPath });
  console.log('Downloaded');

  // Upload
  console.log('Uploading to Gemini...');
  const uploadedFile = await ai.files.upload({
    file: audioPath,
    config: { mimeType: 'audio/mpeg', displayName: 'test' },
  });
  console.log('Uploaded. URI:', uploadedFile.uri, 'State:', uploadedFile.state);

  // Now call generateContent with the BIG prompt (same as the real script)
  const DIARIZATION_PROMPT = `You are an expert audio transcription analyst. Listen to this entire audio recording and produce a detailed analysis.

## Task 1: Speaker Diarization
Identify every distinct speaker in the recording.

## Output Format
Respond with ONLY a JSON object:
{"speakers": {}, "segments": [], "terms": [], "topics": [], "persons": []}

Just output a simple JSON with a count of speakers you detect.`;

  console.log('Calling generateContent...');
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          createPartFromUri(uploadedFile.uri!, uploadedFile.mimeType!),
          { text: DIARIZATION_PROMPT },
        ],
      },
    ],
    config: {
      temperature: 0.1,
      maxOutputTokens: 65536,
    },
  });
  console.log('Response:', response.text?.substring(0, 200));
  console.log('Usage:', response.usageMetadata);

  // Cleanup
  fs.unlinkSync(audioPath);
  try { await ai.files.delete({ name: uploadedFile.name! }); } catch (_) { /* cleanup is best-effort */ }
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
