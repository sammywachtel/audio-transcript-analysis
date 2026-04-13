#!/usr/bin/env tsx
/**
 * Speaker Detection Test Matrix Runner
 *
 * Tests Pass 1 (extractSpeakerIntelligence) in isolation against
 * controlled test cases to build a confusion matrix of what works
 * and what doesn't.
 *
 * Usage:
 *   npx tsx scripts/speaker-matrix/run-matrix.ts
 *   npx tsx scripts/speaker-matrix/run-matrix.ts --case brief_speaker
 *   npx tsx scripts/speaker-matrix/run-matrix.ts --verbose
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// Types
// =============================================================================

interface TestCase {
  id: string;
  description: string;
  challenge: string;
  transcript: string;
  expected: {
    speakerCount: number;
    speakers: string[];
    anchorPoints?: Array<{ text: string; speakerIsNot?: string }>;
    notes?: string;
  };
}

interface TestCasesFile {
  version: string;
  description: string;
  cases: TestCase[];
}

interface SpeakerIntelligence {
  speakerCount: number;
  speakers: Array<{
    name: string;
    roleClue?: string;
    estimatedTurns: number;
  }>;
  anchorPoints: Array<{
    timestampMs: number;
    name: string;
    context: string;
    isAddressed: boolean;
  }>;
  disambiguationNotes?: string;
}

interface TestResult {
  caseId: string;
  challenge: string;
  passed: boolean;
  expected: {
    speakerCount: number;
    speakers: string[];
  };
  actual: {
    speakerCount: number;
    speakers: string[];
  };
  speakersFound: string[];
  speakersMissed: string[];
  speakersExtra: string[];
  anchorPointsChecked?: number;
  anchorPointsCorrect?: number;
  durationMs: number;
  error?: string;
}

// =============================================================================
// Gemini API Setup
// =============================================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY not set in environment');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
// Use gemini-2.5-flash (stable, fast) or gemini-3-flash-preview (matches production)
const MODEL = process.env.GEMINI_MODEL || 'models/gemini-2.5-flash';

// =============================================================================
// Speaker Intelligence Schema (must match gemini3Pipeline.ts)
// =============================================================================

const SPEAKER_INTELLIGENCE_SCHEMA = {
  type: 'object' as const,
  properties: {
    speakerCount: { type: 'integer' as const, description: 'Total unique speakers' },
    speakers: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const },
          roleClue: { type: 'string' as const },
          estimatedTurns: { type: 'integer' as const },
        },
        required: ['name', 'estimatedTurns'],
      },
    },
    anchorPoints: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          timestampMs: { type: 'integer' as const },
          name: { type: 'string' as const },
          context: { type: 'string' as const },
          isAddressed: { type: 'boolean' as const },
        },
        required: ['timestampMs', 'name', 'context', 'isAddressed'],
      },
    },
    disambiguationNotes: { type: 'string' as const },
  },
  required: ['speakerCount', 'speakers', 'anchorPoints'],
};

// =============================================================================
// Pass 1 Prompt (must match gemini3Pipeline.ts - update both when changing!)
// =============================================================================

const SPEAKER_INTELLIGENCE_PROMPT = `You are a speaker identification expert. Analyze this transcript and extract structured speaker intelligence.

## CRITICAL: Identify ALL Speakers

**Do NOT skip speakers who only speak once or twice.** Brief speakers are just as important as frequent speakers. A person who says a single sentence is still a unique speaker and MUST be included in your output.

Look carefully for:
- Speakers who only have 1-2 utterances in the entire transcript
- Speakers who are addressed by name but speak briefly
- Speakers who ask a single question then stay quiet
- Facilitators or observers who speak rarely

## Output Requirements

### 1. Speaker List
List EVERY unique speaker, including:
- Frequent speakers (many turns)
- Moderate speakers (a few turns)
- Brief speakers (1-2 turns) ← DO NOT MISS THESE

For each speaker provide:
- name: Best guess at their name (or "Unknown Speaker N" if unclear)
- roleClue: Brief role description if evident
- estimatedTurns: Approximate number of speaking turns

### 2. Anchor Points
Find moments where a speaker is clearly identified by name:
- Direct-address events: "Hey [Name]", "[Name], what do you think?" → isAddressed: true
  (The voice speaking is NOT the named person!)
- Self-identification: "I'm [Name], I'll be..." → isAddressed: false
- Responses to direct address: if A addresses B, the next turn is likely B

Capture up to 30 anchor points — quality over quantity.

### 3. Disambiguation Notes
If any names seem ambiguous (same person, nicknames), note it here.

## Transcript
`;

// =============================================================================
// Extract Speaker Intelligence (mirrors gemini3Pipeline.ts)
// =============================================================================

async function extractSpeakerIntelligence(
  transcriptText: string,
): Promise<SpeakerIntelligence | null> {
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: SPEAKER_INTELLIGENCE_PROMPT + transcriptText }] }],
      config: {
        temperature: 0.1,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        responseSchema: SPEAKER_INTELLIGENCE_SCHEMA,
      },
    });

    const raw = JSON.parse(response.text ?? '{}') as SpeakerIntelligence;
    return raw;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ API error: ${msg}`);
    return null;
  }
}

// =============================================================================
// Fuzzy Speaker Matching
// =============================================================================

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function speakerMatches(actual: string, expected: string): boolean {
  const normActual = normalizeName(actual);
  const normExpected = normalizeName(expected);

  // Exact match
  if (normActual === normExpected) return true;

  // Substring match (e.g., "Chris" matches "Chris Savage")
  if (normActual.includes(normExpected) || normExpected.includes(normActual)) return true;

  // Handle common variations
  const variations: Record<string, string[]> = {
    'sammy': ['sam', 'samuel'],
    'sam': ['sammy', 'samuel'],
    'jj': ['jjjonathan', 'jonathan'],
    'chris': ['christopher'],
    'chrissavage': ['chris savage', 'savage'],
  };

  const actualVariations = variations[normActual] || [];
  const expectedVariations = variations[normExpected] || [];

  if (actualVariations.includes(normExpected)) return true;
  if (expectedVariations.includes(normActual)) return true;

  return false;
}

// =============================================================================
// Run Single Test Case
// =============================================================================

async function runTestCase(testCase: TestCase, verbose: boolean): Promise<TestResult> {
  const start = Date.now();

  console.log(`\n▶ Running: ${testCase.id}`);
  console.log(`  Challenge: ${testCase.challenge}`);
  console.log(`  Expected: ${testCase.expected.speakerCount} speakers (${testCase.expected.speakers.join(', ')})`);

  const result = await extractSpeakerIntelligence(testCase.transcript);
  const durationMs = Date.now() - start;

  if (!result) {
    return {
      caseId: testCase.id,
      challenge: testCase.challenge,
      passed: false,
      expected: {
        speakerCount: testCase.expected.speakerCount,
        speakers: testCase.expected.speakers,
      },
      actual: { speakerCount: 0, speakers: [] },
      speakersFound: [],
      speakersMissed: testCase.expected.speakers,
      speakersExtra: [],
      durationMs,
      error: 'API call failed or returned null',
    };
  }

  const actualSpeakers = result.speakers.map(s => s.name);

  if (verbose) {
    console.log(`  Actual: ${result.speakerCount} speakers (${actualSpeakers.join(', ')})`);
    console.log(`  Anchor points: ${result.anchorPoints.length}`);
  }

  // Match speakers
  const speakersFound: string[] = [];
  const speakersMissed: string[] = [];
  const matchedActual = new Set<string>();

  for (const expected of testCase.expected.speakers) {
    const match = actualSpeakers.find(
      actual => !matchedActual.has(actual) && speakerMatches(actual, expected)
    );
    if (match) {
      speakersFound.push(expected);
      matchedActual.add(match);
    } else {
      speakersMissed.push(expected);
    }
  }

  const speakersExtra = actualSpeakers.filter(a => !matchedActual.has(a));

  // Check anchor points if specified
  let anchorPointsChecked = 0;
  let anchorPointsCorrect = 0;
  if (testCase.expected.anchorPoints) {
    for (const expectedAnchor of testCase.expected.anchorPoints) {
      anchorPointsChecked++;
      const matching = result.anchorPoints.find(a =>
        a.context.toLowerCase().includes(expectedAnchor.text.toLowerCase())
      );
      if (matching) {
        if (expectedAnchor.speakerIsNot) {
          // Check inversion rule
          if (matching.isAddressed && !speakerMatches(matching.name, expectedAnchor.speakerIsNot)) {
            // Wrong — the anchor should be flagged as addressed to speakerIsNot
          } else if (matching.isAddressed) {
            anchorPointsCorrect++;
          }
        } else {
          anchorPointsCorrect++;
        }
      }
    }
  }

  const passed =
    speakersMissed.length === 0 &&
    result.speakerCount === testCase.expected.speakerCount;

  console.log(passed ? '  ✅ PASS' : '  ❌ FAIL');
  if (speakersMissed.length > 0) {
    console.log(`  Missing: ${speakersMissed.join(', ')}`);
  }
  if (speakersExtra.length > 0) {
    console.log(`  Extra: ${speakersExtra.join(', ')}`);
  }

  return {
    caseId: testCase.id,
    challenge: testCase.challenge,
    passed,
    expected: {
      speakerCount: testCase.expected.speakerCount,
      speakers: testCase.expected.speakers,
    },
    actual: {
      speakerCount: result.speakerCount,
      speakers: actualSpeakers,
    },
    speakersFound,
    speakersMissed,
    speakersExtra,
    anchorPointsChecked: anchorPointsChecked || undefined,
    anchorPointsCorrect: anchorPointsCorrect || undefined,
    durationMs,
  };
}

// =============================================================================
// Generate Report
// =============================================================================

function generateReport(results: TestResult[]): void {
  console.log('\n' + '═'.repeat(70));
  console.log('SPEAKER DETECTION CONFUSION MATRIX');
  console.log('═'.repeat(70));

  const passed = results.filter(r => r.passed).length;
  const total = results.length;

  console.log(`\nOverall: ${passed}/${total} tests passed (${((passed / total) * 100).toFixed(0)}%)\n`);

  // Group by challenge type
  const byChallenge = new Map<string, TestResult[]>();
  for (const r of results) {
    const list = byChallenge.get(r.challenge) || [];
    list.push(r);
    byChallenge.set(r.challenge, list);
  }

  console.log('By Challenge Type:');
  console.log('─'.repeat(50));
  for (const [challenge, caseResults] of byChallenge) {
    const challengePassed = caseResults.filter(r => r.passed).length;
    const status = challengePassed === caseResults.length ? '✅' : '❌';
    console.log(`  ${status} ${challenge}: ${challengePassed}/${caseResults.length}`);
  }

  // Detailed failures
  const failures = results.filter(r => !r.passed);
  if (failures.length > 0) {
    console.log('\n' + '─'.repeat(50));
    console.log('FAILURES:');
    console.log('─'.repeat(50));
    for (const f of failures) {
      console.log(`\n  ${f.caseId}:`);
      console.log(`    Expected: ${f.expected.speakerCount} speakers`);
      console.log(`    Actual:   ${f.actual.speakerCount} speakers`);
      if (f.speakersMissed.length > 0) {
        console.log(`    MISSED:   ${f.speakersMissed.join(', ')}`);
      }
      if (f.speakersExtra.length > 0) {
        console.log(`    EXTRA:    ${f.speakersExtra.join(', ')}`);
      }
      if (f.error) {
        console.log(`    ERROR:    ${f.error}`);
      }
    }
  }

  // Speaker detection matrix
  console.log('\n' + '─'.repeat(50));
  console.log('SPEAKER DETECTION MATRIX:');
  console.log('─'.repeat(50));

  const allExpected = new Set<string>();
  const allActual = new Set<string>();
  const detectionCounts = new Map<string, { found: number; missed: number }>();

  for (const r of results) {
    for (const s of r.expected.speakers) {
      allExpected.add(s);
      const counts = detectionCounts.get(s) || { found: 0, missed: 0 };
      if (r.speakersFound.includes(s)) {
        counts.found++;
      } else {
        counts.missed++;
      }
      detectionCounts.set(s, counts);
    }
    for (const s of r.actual.speakers) {
      allActual.add(s);
    }
  }

  console.log('\n  Speaker Detection Rate:');
  for (const [speaker, counts] of detectionCounts) {
    const total = counts.found + counts.missed;
    const rate = ((counts.found / total) * 100).toFixed(0);
    const bar = '█'.repeat(Math.round(counts.found / total * 10)) +
                '░'.repeat(10 - Math.round(counts.found / total * 10));
    const status = counts.missed === 0 ? '✅' : '⚠️';
    console.log(`    ${status} ${speaker.padEnd(15)} ${bar} ${rate}% (${counts.found}/${total})`);
  }

  // Save results
  const outputPath = path.join(__dirname, 'results.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n📄 Results saved to: ${outputPath}`);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose') || args.includes('-v');
  const caseIdx = args.indexOf('--case');
  const caseFilter = args.find(a => a.startsWith('--case='))?.split('=')[1] ||
                     (caseIdx !== -1 && args[caseIdx + 1] && !args[caseIdx + 1].startsWith('-')
                       ? args[caseIdx + 1]
                       : undefined);

  // Load test cases
  const casesPath = path.join(__dirname, 'test-cases.json');
  const casesFile = JSON.parse(fs.readFileSync(casesPath, 'utf8')) as TestCasesFile;

  let cases = casesFile.cases;
  if (caseFilter) {
    cases = cases.filter(c => c.id === caseFilter);
    if (cases.length === 0) {
      console.error(`❌ Test case not found: ${caseFilter}`);
      console.log('Available cases:', casesFile.cases.map(c => c.id).join(', '));
      process.exit(1);
    }
  }

  console.log('═'.repeat(70));
  console.log(`SPEAKER DETECTION TEST MATRIX - ${cases.length} test case(s)`);
  console.log(`Model: ${MODEL}`);
  console.log('═'.repeat(70));

  const results: TestResult[] = [];
  for (const testCase of cases) {
    const result = await runTestCase(testCase, verbose);
    results.push(result);
  }

  generateReport(results);
}

main().catch(console.error);
