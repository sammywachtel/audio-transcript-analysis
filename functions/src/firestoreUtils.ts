/**
 * Shared Firestore utility functions.
 *
 * Extracted from chunkContext.ts during the legacy chunk pipeline removal
 * (gemini_hybrid_06_legacy_deprecation-02). The sanitizer is the one piece
 * of that module the active hybrid pipeline still needs.
 */

/**
 * Recursively strip undefined values from an object.
 * Firestore doesn't allow undefined — it throws
 * "Cannot use undefined as a Firestore value".
 *
 * Removes undefined fields entirely rather than setting them to null,
 * because Firestore treats null as a real stored value whereas a missing
 * field simply doesn't appear in the document.
 */
export function sanitizeForFirestore<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForFirestore(item)) as T;
  }

  if (typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) {
        sanitized[key] = sanitizeForFirestore(value);
      }
    }
    return sanitized as T;
  }

  return obj;
}
