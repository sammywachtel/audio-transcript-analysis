#!/usr/bin/env tsx
/**
 * PoC: Test Gemini diarization using the ORIGINAL Dec 2025 approach.
 *
 * Mirrors the original transcriptionService.ts as closely as possible:
 *   - gemini-2.5-flash (stable)
 *   - inlineData (base64)
 *   - Full transcription prompt (text + speakers + timestamps)
 *   - Same structured output schema
 *
 * Usage:
 *   npx tsx scripts/poc-gemini-original-style.ts <audio-file-path>
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';

// Node 24 undici timeout fix
import { setGlobalDispatcher, Agent } from 'undici';
setGlobalDispatcher(new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

async function main(): Promise<void> {
  const audioPath = process.argv[2];
  if (!audioPath) {
    console.error('Usage: npx tsx scripts/poc-gemini-original-style.ts <audio-file>');
    process.exit(1);
  }

  const resolvedPath = path.resolve(audioPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Audio file not found: ${resolvedPath}`);
  }

  const stats = fs.statSync(resolvedPath);
  const sizeMB = stats.size / 1024 / 1024;
  console.log(`Audio file: ${resolvedPath} (${sizeMB.toFixed(1)}MB)`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 600_000 } });
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  // Read file and base64 encode — exactly how the original did it
  const audioBuffer = fs.readFileSync(resolvedPath);
  const base64Audio = audioBuffer.toString('base64');
  console.log(`Base64 size: ${(base64Audio.length / 1024 / 1024).toFixed(1)}MB`);

  // The original Dec 2025 prompt — nearly verbatim from commit 609a5c0
  const prompt = `
    You are an expert transcriber. Process the attached audio file with PRECISE timing.

    CRITICAL TIMESTAMP REQUIREMENTS:
    - Timestamps must be in MILLISECONDS from the START of the audio (0ms = beginning)
    - Each segment's startMs must be the EXACT moment the speaker begins that segment
    - Each segment's endMs must be the EXACT moment the speaker finishes that segment
    - Timestamps must match the actual audio timing
    - Segments should be contiguous
    - Do NOT pad or estimate - use the actual audio timing

    Tasks:
    1. Transcribe verbatim with ACCURATE timestamps in milliseconds.
    2. Identify speakers (Speaker 1, Speaker 2, etc.) and attribute each segment.
    3. Segment based on natural pauses or speaker changes. Keep segments reasonably short (5-30 seconds each).
    4. Extract technical terms/acronyms with brief definitions based on context.
    5. Identify main topics and tangents.
    6. List people mentioned (not the speakers) with their inferred affiliation.

    Populate the JSON schema provided.
  `;

  console.log(`\nModel: ${model}`);
  console.log('Sending request (inlineData, original-style prompt)...');
  const start = Date.now();

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'audio/mp3', data: base64Audio } },
          { text: prompt },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          speakers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
              },
              required: ['id', 'name'],
            },
          },
          segments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                speakerId: { type: 'string' },
                startMs: { type: 'number' },
                endMs: { type: 'number' },
                text: { type: 'string' },
              },
              required: ['speakerId', 'startMs', 'endMs', 'text'],
            },
          },
          terms: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                term: { type: 'string' },
                definition: { type: 'string' },
                aliases: { type: 'array', items: { type: 'string' } },
              },
              required: ['id', 'term', 'definition'],
            },
          },
          topics: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                startSegmentIndex: { type: 'number' },
                endSegmentIndex: { type: 'number' },
                type: { type: 'string', enum: ['main', 'tangent'] },
              },
              required: ['title', 'startSegmentIndex', 'endSegmentIndex', 'type'],
            },
          },
          people: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                affiliation: { type: 'string' },
              },
              required: ['name'],
            },
          },
        },
        required: ['title', 'speakers', 'segments', 'terms', 'topics', 'people'],
      },
    },
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const usage = response.usageMetadata;
  console.log(`\nResponse in ${elapsed}s`);
  console.log(`Tokens: prompt=${usage?.promptTokenCount}, completion=${usage?.candidatesTokenCount}, total=${usage?.totalTokenCount}`);

  const rawText = response.text ?? '';
  let data;
  try {
    data = JSON.parse(rawText.replace(/```json\s*|\s*```/g, '').trim());
  } catch (_e) {
    console.error('JSON parse failed. Saving raw text.');
    const outPath = path.join(PROJECT_ROOT, '.agent_process/work/poc_gemini_hybrid/iteration_01_a/results/original_style_raw.txt');
    fs.writeFileSync(outPath, rawText);
    console.log(`Saved to: ${outPath}`);
    return;
  }

  // Analyze
  const speakers = data.speakers || [];
  const segments = data.segments || [];
  console.log(`\nTitle: ${data.title}`);
  console.log(`Speakers: ${speakers.length}`);
  console.log(`Segments: ${segments.length}`);
  console.log(`Terms: ${(data.terms || []).length}`);
  console.log(`Topics: ${(data.topics || []).length}`);
  console.log(`People: ${(data.people || []).length}`);

  // Speaker distribution
  const bySpeaker: Record<string, number> = {};
  for (const seg of segments) {
    bySpeaker[seg.speakerId] = (bySpeaker[seg.speakerId] || 0) + 1;
  }
  console.log('\nSpeaker distribution:');
  for (const [spk, count] of Object.entries(bySpeaker).sort((a, b) => b[1] - a[1])) {
    const name = speakers.find((s: { id: string; name: string }) => s.id === spk)?.name || spk;
    const pct = ((count / segments.length) * 100).toFixed(1);
    console.log(`  ${name} (${spk}): ${count} segments (${pct}%)`);
  }

  // Coverage
  if (segments.length > 0) {
    const lastSeg = segments[segments.length - 1];
    console.log(`\nCoverage: 0ms - ${lastSeg.endMs}ms (${(lastSeg.endMs / 1000 / 60).toFixed(1)} min)`);
  }

  // Save result
  const outPath = path.join(
    PROJECT_ROOT,
    '.agent_process/work/poc_gemini_hybrid/iteration_01_a/results/original_style_result.json'
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ model, elapsed, usage, data }, null, 2));
  console.log(`\nSaved: ${outPath}`);
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
