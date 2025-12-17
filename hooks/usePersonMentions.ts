import { useMemo } from 'react';
import { Person, Segment } from '../types';

interface PersonOccurrence {
  start: number;
  end: number;
  personId: string;
}

interface UsePersonMentionsReturn {
  // personId -> array of segmentIds where they're mentioned
  mentionsMap: Record<string, string[]>;

  // segmentId -> array of character ranges where people are mentioned
  personOccurrences: Record<string, PersonOccurrence[]>;
}

/**
 * usePersonMentions - Detects person name mentions in transcript segments
 *
 * Uses regex matching to find full names and first names in segment text.
 * Returns both a mentions map (for navigation) and occurrence ranges (for highlighting).
 *
 * This used to live inside Viewer as a giant useMemo. Now it's its own hook,
 * which makes testing easier and Viewer less intimidating.
 */
export const usePersonMentions = (
  people: Person[],
  segments: Segment[]
): UsePersonMentionsReturn => {
  return useMemo(() => {
    const mentionsMap: Record<string, string[]> = {};
    const personOccurrences: Record<string, PersonOccurrence[]> = {};

    if (!people || people.length === 0) {
      return { mentionsMap, personOccurrences };
    }

    // Helper to escape regex special characters
    const escapeRegExp = (string: string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    people.forEach(person => {
      const personMentions: string[] = [];
      const safeName = escapeRegExp(person.name);

      // Match exact full name (case insensitive, word boundaries)
      const fullRegex = new RegExp(`\\b${safeName}\\b`, 'gi');

      // Optional fallback: First name only (if full name has multiple words)
      let firstNameRegex: RegExp | null = null;
      if (person.name.trim().includes(' ')) {
        const parts = person.name.trim().split(' ');
        if (parts[0].length > 2) {
          firstNameRegex = new RegExp(`\\b${escapeRegExp(parts[0])}\\b`, 'gi');
        }
      }

      segments.forEach(seg => {
        let found = false;

        // Find all full name matches
        let match;
        fullRegex.lastIndex = 0; // Reset regex state
        while ((match = fullRegex.exec(seg.text)) !== null) {
          found = true;
          if (!personOccurrences[seg.segmentId]) {
            personOccurrences[seg.segmentId] = [];
          }
          personOccurrences[seg.segmentId].push({
            start: match.index,
            end: match.index + match[0].length,
            personId: person.personId
          });
        }

        // If no full name matches, try first name
        if (!found && firstNameRegex) {
          firstNameRegex.lastIndex = 0;
          while ((match = firstNameRegex.exec(seg.text)) !== null) {
            found = true;
            if (!personOccurrences[seg.segmentId]) {
              personOccurrences[seg.segmentId] = [];
            }
            personOccurrences[seg.segmentId].push({
              start: match.index,
              end: match.index + match[0].length,
              personId: person.personId
            });
          }
        }

        // Track which segments mention this person
        if (found && !personMentions.includes(seg.segmentId)) {
          personMentions.push(seg.segmentId);
        }
      });

      mentionsMap[person.personId] = personMentions;
    });

    return { mentionsMap, personOccurrences };
  }, [people, segments]);
};
