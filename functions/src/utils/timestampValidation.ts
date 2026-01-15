/**
 * Timestamp Validation Utilities
 *
 * Validates that cited timestamps from LLM responses actually exist in the transcript.
 * Uses fuzzy matching with tolerance to handle slight variations in timestamps.
 */

import type { Segment } from '../types';

export interface TimestampSource {
  segmentIndex: number;
  segmentId: string;
  startMs: number;
  endMs: number;
  text: string;
  speaker: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Match tolerance for timestamp validation (in milliseconds)
 * Allows for slight variations in LLM-cited timestamps vs actual segment timestamps
 */
const TIMESTAMP_TOLERANCE_MS = 500;

/**
 * Validate and enrich timestamp sources from LLM response
 *
 * Takes raw timestamp citations from the LLM and:
 * 1. Verifies they map to actual segments in the transcript
 * 2. Assigns confidence levels based on match quality
 * 3. Filters out invalid or low-quality citations
 * 4. PRESERVES ORDER from rawSources for {{SOURCE_n}} placeholder mapping
 *
 * @param rawSources - Sources extracted from LLM response (segment index or timestamps)
 * @param segments - Full transcript segments for validation
 * @returns Validated sources with confidence scores IN THE SAME ORDER as rawSources
 */
export function validateTimestampSources(
  rawSources: Array<{ segmentIndex?: number; startMs?: number; endMs?: number }>,
  segments: Segment[]
): TimestampSource[] {
  const validatedSources: TimestampSource[] = [];

  for (const source of rawSources) {
    let matchedSegment: Segment | null = null;
    let confidence: 'high' | 'medium' | 'low' = 'low';

    // Try to match by segment index first (most reliable)
    if (source.segmentIndex !== undefined) {
      matchedSegment = segments.find(seg => seg.index === source.segmentIndex) || null;
      if (matchedSegment) {
        confidence = 'high';
      }
    }
    // Fall back to timestamp matching
    else if (source.startMs !== undefined && source.endMs !== undefined) {
      matchedSegment = findSegmentByTimestamp(
        source.startMs,
        source.endMs,
        segments
      );

      if (matchedSegment) {
        // Check how close the timestamps are
        const startDiff = Math.abs(matchedSegment.startMs - source.startMs);
        const endDiff = Math.abs(matchedSegment.endMs - source.endMs);

        if (startDiff <= 100 && endDiff <= 100) {
          confidence = 'high';
        } else if (startDiff <= TIMESTAMP_TOLERANCE_MS && endDiff <= TIMESTAMP_TOLERANCE_MS) {
          confidence = 'medium';
        } else {
          confidence = 'low';
        }
      }
    }

    // Only include if we found a valid match
    if (matchedSegment) {
      validatedSources.push({
        segmentIndex: matchedSegment.index,
        segmentId: matchedSegment.segmentId,
        startMs: matchedSegment.startMs,
        endMs: matchedSegment.endMs,
        text: matchedSegment.text,
        speaker: matchedSegment.speakerId,
        confidence
      });
    }
  }

  // CRITICAL: Do NOT sort. Preserve order for {{SOURCE_n}} placeholder mapping.
  // Frontend expects sources[0] to correspond to {{SOURCE_0}}, etc.
  return validatedSources;
}

/**
 * Find a segment that overlaps with the given timestamp range
 *
 * Uses tolerance to handle slight variations in timestamps.
 * Prefers exact matches, falls back to overlapping segments.
 */
function findSegmentByTimestamp(
  startMs: number,
  endMs: number,
  segments: Segment[]
): Segment | null {
  // First try: exact match within tolerance
  for (const segment of segments) {
    const startDiff = Math.abs(segment.startMs - startMs);
    const endDiff = Math.abs(segment.endMs - endMs);

    if (startDiff <= TIMESTAMP_TOLERANCE_MS && endDiff <= TIMESTAMP_TOLERANCE_MS) {
      return segment;
    }
  }

  // Second try: overlapping segments
  for (const segment of segments) {
    const overlaps =
      (startMs >= segment.startMs && startMs <= segment.endMs) ||
      (endMs >= segment.startMs && endMs <= segment.endMs) ||
      (startMs <= segment.startMs && endMs >= segment.endMs);

    if (overlaps) {
      return segment;
    }
  }

  return null;
}

/**
 * Extract segment indices from LLM response text
 *
 * Looks for patterns like:
 * - [Segment 5]
 * - [Segment 10: 1:23-1:45]
 * - segment 3
 *
 * CRITICAL: Returns indices in ORDER OF FIRST APPEARANCE for {{SOURCE_n}} mapping.
 *
 * @param responseText - Raw LLM response
 * @returns Array of segment indices in order of first appearance (deduplicated)
 */
export function extractSegmentIndices(responseText: string): number[] {
  const indices: number[] = [];

  // Pattern: [Segment N] or segment N (case insensitive)
  const pattern = /\[?segment\s+(\d+)\]?/gi;
  let match;

  while ((match = pattern.exec(responseText)) !== null) {
    const index = parseInt(match[1], 10);
    // Only add if not already present (preserves first appearance order)
    if (!indices.includes(index)) {
      indices.push(index);
    }
  }

  // CRITICAL: Do NOT sort. Preserve order of appearance for {{SOURCE_n}} mapping.
  return indices;
}
