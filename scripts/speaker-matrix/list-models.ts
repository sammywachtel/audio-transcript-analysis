#!/usr/bin/env tsx
/**
 * List available Gemini models to find the right one
 */

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY not set');
  process.exit(1);
}

async function main() {
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  console.log('Listing available models...\n');

  try {
    const models = await ai.models.list();
    console.log('Available models:');
    for await (const model of models) {
      if (model.name?.includes('gemini')) {
        console.log(`  - ${model.name} (${model.displayName})`);
      }
    }
  } catch (err) {
    console.error('Error listing models:', err);
  }
}

main();
