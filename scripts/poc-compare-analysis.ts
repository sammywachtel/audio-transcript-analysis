#!/usr/bin/env tsx
/**
 * Phase 3: Compare Gemini's Content Analysis Against Current Pipeline
 *
 * Compares the terms, topics, and persons that Gemini extracted
 * (piggybacked on the Phase 1 diarization call) against what the
 * current per-chunk Gemini analysis + merge pipeline produced.
 *
 * The hypothesis: a single full-file pass should produce MORE coherent
 * analysis than 4 separate chunk analyses stitched together, because
 * Gemini sees the complete conversation context.
 *
 * Usage:
 *   npx tsx scripts/poc-compare-analysis.ts [conversationId] [iteration]
 *
 * Requires:
 *   gemini_analysis_raw.json from poc-gemini-diarize.ts
 *
 * Output:
 *   .agent_process/work/poc_gemini_hybrid/<iteration>/results/phase3_analysis.md
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as admin from 'firebase-admin';
import 'dotenv/config';
import { resolvePocResultsDir } from './poc-results-dir.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCOPE = 'poc_gemini_hybrid';
const { iteration: ITERATION, resultsDir: RESULTS_DIR } = resolvePocResultsDir(
  PROJECT_ROOT,
  SCOPE,
  process.argv[3]
);

// ============================================================================
// Types
// ============================================================================

interface GeminiAnalysisArtifact {
  conversationId: string;
  model: string;
  timestamp: string;
  terms: Array<{
    key: string;
    display: string;
    definition: string;
    aliases: string[];
  }>;
  topics: Array<{
    title: string;
    startApproxMs: number;
    endApproxMs: number;
    type: 'main' | 'tangent';
  }>;
  persons: Array<{
    name: string;
    affiliation?: string;
  }>;
}

interface StoredTerm {
  termId: string;
  key: string;
  display: string;
  definition: string;
  aliases: string[];
}

interface StoredTopic {
  topicId: string;
  title: string;
  startIndex: number;
  endIndex: number;
  type: 'main' | 'tangent';
}

interface StoredPerson {
  personId: string;
  name: string;
  affiliation?: string;
}

interface AnalysisComparison {
  terms: {
    geminiCount: number;
    storedCount: number;
    matchedTerms: Array<{ geminiKey: string; storedKey: string; similarity: number }>;
    geminiOnlyTerms: string[];
    storedOnlyTerms: string[];
    coverage: number;   // % of stored terms found in Gemini output
    precision: number;  // % of Gemini terms that match stored terms
  };
  topics: {
    geminiCount: number;
    storedCount: number;
    geminiTopics: string[];
    storedTopics: string[];
    qualitativeNotes: string;
  };
  persons: {
    geminiCount: number;
    storedCount: number;
    matchedPersons: Array<{ geminiName: string; storedName: string }>;
    geminiOnlyPersons: string[];
    storedOnlyPersons: string[];
    coverage: number;
    precision: number;
  };
}

// ============================================================================
// Firebase init
// ============================================================================

function initFirebase(): void {
  const saKeyPath = path.join(PROJECT_ROOT, 'firebase-sa-key.json');
  if (!fs.existsSync(saKeyPath)) {
    throw new Error(`Service account key not found at ${saKeyPath}`);
  }
  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(saKeyPath),
    });
  }
}

// ============================================================================
// Fuzzy matching utilities
// ============================================================================

/**
 * Normalize a term key for comparison.
 * We're comparing across two different Gemini runs that may use
 * slightly different formatting, so be generous.
 */
function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[_\-\s]+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

/**
 * Simple string similarity (Dice coefficient on bigrams).
 * Not perfect, but good enough for fuzzy term matching in a PoC.
 * We tried Levenshtein first but it penalizes length differences
 * too much when comparing "ML" to "machine learning".
 */
function stringSimilarity(a: string, b: string): number {
  const na = normalizeKey(a);
  const nb = normalizeKey(b);

  if (na === nb) return 1.0;
  if (na.length < 2 || nb.length < 2) return na === nb ? 1.0 : 0.0;

  // Check if one contains the other (handles abbreviation cases)
  if (na.includes(nb) || nb.includes(na)) return 0.85;

  // Bigram Dice coefficient
  const bigramsA = new Set<string>();
  for (let i = 0; i < na.length - 1; i++) bigramsA.add(na.substring(i, i + 2));

  const bigramsB = new Set<string>();
  for (let i = 0; i < nb.length - 1; i++) bigramsB.add(nb.substring(i, i + 2));

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }

  return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

/**
 * Match person names with fuzzy logic.
 * People get referred to in many ways — "Dr. Smith", "John Smith",
 * "Smith", "Professor Smith" should all match.
 */
function personNameMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();

  if (na === nb) return true;

  // Check if either name is a substring of the other
  if (na.includes(nb) || nb.includes(na)) return true;

  // Check last-name match (crude but effective)
  const aWords = na.split(/\s+/);
  const bWords = nb.split(/\s+/);
  const aLast = aWords[aWords.length - 1];
  const bLast = bWords[bWords.length - 1];
  if (aLast === bLast && aLast.length > 2) return true;

  return stringSimilarity(na, nb) > 0.7;
}

// ============================================================================
// Comparison logic
// ============================================================================

function compareTerms(
  geminiTerms: GeminiAnalysisArtifact['terms'],
  storedTerms: StoredTerm[]
): AnalysisComparison['terms'] {
  const MATCH_THRESHOLD = 0.6;

  const matched: Array<{ geminiKey: string; storedKey: string; similarity: number }> = [];
  const matchedStored = new Set<string>();
  const matchedGemini = new Set<string>();

  // For each Gemini term, find the best-matching stored term
  for (const gTerm of geminiTerms) {
    let bestMatch: StoredTerm | null = null;
    let bestSim = 0;

    for (const sTerm of storedTerms) {
      // Compare key, display name, and aliases
      const keySim = stringSimilarity(gTerm.key, sTerm.key);
      const displaySim = stringSimilarity(gTerm.display, sTerm.display);

      // Also check against aliases
      let aliasSim = 0;
      for (const alias of [...(gTerm.aliases || []), ...(sTerm.aliases || [])]) {
        aliasSim = Math.max(
          aliasSim,
          stringSimilarity(gTerm.key, alias),
          stringSimilarity(gTerm.display, alias)
        );
      }

      const sim = Math.max(keySim, displaySim, aliasSim);
      if (sim > bestSim) {
        bestSim = sim;
        bestMatch = sTerm;
      }
    }

    if (bestMatch && bestSim >= MATCH_THRESHOLD && !matchedStored.has(bestMatch.key)) {
      matched.push({
        geminiKey: gTerm.key,
        storedKey: bestMatch.key,
        similarity: bestSim,
      });
      matchedStored.add(bestMatch.key);
      matchedGemini.add(gTerm.key);
    }
  }

  const geminiOnly = geminiTerms.filter((t) => !matchedGemini.has(t.key)).map((t) => t.display);
  const storedOnly = storedTerms.filter((t) => !matchedStored.has(t.key)).map((t) => t.display);

  return {
    geminiCount: geminiTerms.length,
    storedCount: storedTerms.length,
    matchedTerms: matched,
    geminiOnlyTerms: geminiOnly,
    storedOnlyTerms: storedOnly,
    coverage: storedTerms.length > 0 ? matched.length / storedTerms.length : 0,
    precision: geminiTerms.length > 0 ? matched.length / geminiTerms.length : 0,
  };
}

function comparePersons(
  geminiPersons: GeminiAnalysisArtifact['persons'],
  storedPersons: StoredPerson[]
): AnalysisComparison['persons'] {
  const matched: Array<{ geminiName: string; storedName: string }> = [];
  const matchedStored = new Set<string>();
  const matchedGemini = new Set<string>();

  for (const gPerson of geminiPersons) {
    for (const sPerson of storedPersons) {
      if (matchedStored.has(sPerson.name)) continue;

      if (personNameMatch(gPerson.name, sPerson.name)) {
        matched.push({ geminiName: gPerson.name, storedName: sPerson.name });
        matchedStored.add(sPerson.name);
        matchedGemini.add(gPerson.name);
        break;
      }
    }
  }

  return {
    geminiCount: geminiPersons.length,
    storedCount: storedPersons.length,
    matchedPersons: matched,
    geminiOnlyPersons: geminiPersons.filter((p) => !matchedGemini.has(p.name)).map((p) => p.name),
    storedOnlyPersons: storedPersons.filter((p) => !matchedStored.has(p.name)).map((p) => p.name),
    coverage: storedPersons.length > 0 ? matched.length / storedPersons.length : 0,
    precision: geminiPersons.length > 0 ? matched.length / geminiPersons.length : 0,
  };
}

// ============================================================================
// Report generation
// ============================================================================

function generateReport(comparison: AnalysisComparison, conversationId: string): string {
  const lines: string[] = [];
  const p = (s: string) => lines.push(s);

  p('# Phase 3: Content Analysis Comparison');
  p('');
  p(`**Conversation:** \`${conversationId}\``);
  p(`**Generated:** ${new Date().toISOString()}`);
  p('');

  // Terms
  p('## Term Extraction');
  p('');
  p(`| Metric | Value |`);
  p(`|--------|-------|`);
  p(`| Gemini terms | ${comparison.terms.geminiCount} |`);
  p(`| Current pipeline terms | ${comparison.terms.storedCount} |`);
  p(`| Matched terms | ${comparison.terms.matchedTerms.length} |`);
  p(`| Coverage (stored found in Gemini) | ${(comparison.terms.coverage * 100).toFixed(1)}% |`);
  p(`| Precision (Gemini matched to stored) | ${(comparison.terms.precision * 100).toFixed(1)}% |`);
  p(`| Acceptance (coverage >= 80%) | ${comparison.terms.coverage >= 0.8 ? 'PASS' : 'FAIL'} |`);
  p('');

  if (comparison.terms.matchedTerms.length > 0) {
    p('### Matched Terms');
    p('');
    p(`| Gemini Term | Stored Term | Similarity |`);
    p(`|------------|------------|-----------|`);
    for (const m of comparison.terms.matchedTerms) {
      p(`| ${m.geminiKey} | ${m.storedKey} | ${(m.similarity * 100).toFixed(0)}% |`);
    }
    p('');
  }

  if (comparison.terms.geminiOnlyTerms.length > 0) {
    p('### Gemini-Only Terms (not in current pipeline)');
    p('');
    for (const t of comparison.terms.geminiOnlyTerms) {
      p(`- ${t}`);
    }
    p('');
  }

  if (comparison.terms.storedOnlyTerms.length > 0) {
    p('### Current Pipeline-Only Terms (missed by Gemini)');
    p('');
    for (const t of comparison.terms.storedOnlyTerms) {
      p(`- ${t}`);
    }
    p('');
  }

  // Topics
  p('## Topic Segmentation');
  p('');
  p(`| Metric | Value |`);
  p(`|--------|-------|`);
  p(`| Gemini topics | ${comparison.topics.geminiCount} |`);
  p(`| Current pipeline topics | ${comparison.topics.storedCount} |`);
  p('');

  p('### Gemini Topics');
  p('');
  for (const t of comparison.topics.geminiTopics) {
    p(`- ${t}`);
  }
  p('');

  p('### Current Pipeline Topics');
  p('');
  for (const t of comparison.topics.storedTopics) {
    p(`- ${t}`);
  }
  p('');

  p(`### Qualitative Assessment`);
  p('');
  p(comparison.topics.qualitativeNotes);
  p('');

  // Persons
  p('## Person Detection');
  p('');
  p(`| Metric | Value |`);
  p(`|--------|-------|`);
  p(`| Gemini persons | ${comparison.persons.geminiCount} |`);
  p(`| Current pipeline persons | ${comparison.persons.storedCount} |`);
  p(`| Matched persons | ${comparison.persons.matchedPersons.length} |`);
  p(`| Coverage | ${(comparison.persons.coverage * 100).toFixed(1)}% |`);
  p(`| Precision | ${(comparison.persons.precision * 100).toFixed(1)}% |`);
  p(`| Acceptance (all named found) | ${comparison.persons.coverage >= 1.0 ? 'PASS' : 'FAIL'} |`);
  p('');

  if (comparison.persons.geminiOnlyPersons.length > 0) {
    p('### Gemini-Only Persons');
    p('');
    for (const n of comparison.persons.geminiOnlyPersons) {
      p(`- ${n}`);
    }
    p('');
  }

  if (comparison.persons.storedOnlyPersons.length > 0) {
    p('### Missed by Gemini');
    p('');
    for (const n of comparison.persons.storedOnlyPersons) {
      p(`- ${n}`);
    }
    p('');
  }

  // Decision gate
  p('## Decision Gate Assessment');
  p('');
  const termPass = comparison.terms.coverage >= 0.8;
  const personPass = comparison.persons.coverage >= 1.0;
  p(`- [${termPass ? 'x' : ' '}] Term coverage >= 80% (${(comparison.terms.coverage * 100).toFixed(1)}%)`);
  p(`- [ ] Topic segmentation covers same arcs (requires manual review)`);
  p(`- [${personPass ? 'x' : ' '}] All named persons detected (${(comparison.persons.coverage * 100).toFixed(1)}%)`);
  p(`- [ ] No hallucinated terms/persons (requires manual review of Gemini-only items above)`);
  p('');
  p(`**Phase 3 Outcome:** ${termPass && personPass ? 'LIKELY PASS — manual review recommended' : 'NEEDS REVIEW'}`);
  p('');

  return lines.join('\n');
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const conversationId = process.argv[2] || 'c_1773188486911';

  console.log('='.repeat(70));
  console.log(`PoC: Compare Analysis — conversation ${conversationId}`);
  console.log(`[Context] Scope: ${SCOPE}, Iteration: ${ITERATION}`);
  console.log('='.repeat(70));

  // Load Gemini analysis artifact
  const artifactPath = path.join(RESULTS_DIR, 'gemini_analysis_raw.json');
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `Gemini analysis artifact not found at ${artifactPath}\n` +
      'Run poc-gemini-diarize.ts first!'
    );
  }
  const geminiAnalysis: GeminiAnalysisArtifact = JSON.parse(
    fs.readFileSync(artifactPath, 'utf-8')
  );

  console.log(`[Load] Gemini: ${geminiAnalysis.terms.length} terms, ${geminiAnalysis.topics.length} topics, ${geminiAnalysis.persons.length} persons`);

  // Load stored analysis from Firestore
  initFirebase();
  const db = admin.firestore();
  const convoDoc = await db.collection('conversations').doc(conversationId).get();
  if (!convoDoc.exists) throw new Error(`Conversation ${conversationId} not found`);
  const convoData = convoDoc.data()!;

  const storedTerms: StoredTerm[] = Object.values(convoData.terms || {});
  const storedTopics: StoredTopic[] = convoData.topics || [];
  const storedPersons: StoredPerson[] = convoData.people || [];

  console.log(`[Load] Stored: ${storedTerms.length} terms, ${storedTopics.length} topics, ${storedPersons.length} persons`);

  // Compare terms
  console.log('\n[Compare] Matching terms...');
  const termComparison = compareTerms(geminiAnalysis.terms, storedTerms);

  // Compare persons
  console.log('[Compare] Matching persons...');
  const personComparison = comparePersons(geminiAnalysis.persons, storedPersons);

  // Topics — mostly qualitative, we just list them side-by-side
  const topicComparison = {
    geminiCount: geminiAnalysis.topics.length,
    storedCount: storedTopics.length,
    geminiTopics: geminiAnalysis.topics.map(
      (t) => `${t.title} (${t.type}, ${(t.startApproxMs / 60000).toFixed(1)}-${(t.endApproxMs / 60000).toFixed(1)} min)`
    ),
    storedTopics: storedTopics.map(
      (t) => `${t.title} (${t.type}, segments ${t.startIndex}-${t.endIndex})`
    ),
    qualitativeNotes:
      'Topic comparison requires manual review. Gemini uses timestamps while the current ' +
      'pipeline uses segment indices, making automated comparison difficult. Compare the ' +
      'topic lists above to assess whether Gemini captures the same conversation arcs.',
  };

  const comparison: AnalysisComparison = {
    terms: termComparison,
    topics: topicComparison,
    persons: personComparison,
  };

  // Generate report
  const report = generateReport(comparison, conversationId);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const reportPath = path.join(RESULTS_DIR, 'phase3_analysis.md');
  fs.writeFileSync(reportPath, report);
  console.log(`\n[Report] Written to ${reportPath}`);

  // Save metrics
  const metricsPath = path.join(RESULTS_DIR, 'phase3_metrics.json');
  fs.writeFileSync(metricsPath, JSON.stringify(comparison, null, 2));
  console.log(`[Report] Metrics saved to ${metricsPath}`);

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(70));
  console.log(`Terms: ${termComparison.matchedTerms.length}/${storedTerms.length} matched (${(termComparison.coverage * 100).toFixed(1)}% coverage)`);
  console.log(`Topics: ${geminiAnalysis.topics.length} Gemini vs ${storedTopics.length} stored`);
  console.log(`Persons: ${personComparison.matchedPersons.length}/${storedPersons.length} matched (${(personComparison.coverage * 100).toFixed(1)}% coverage)`);
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
