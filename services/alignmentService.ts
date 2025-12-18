import { Conversation, Segment } from '../types';

/**
 * Configuration for the alignment service
 * Uses process.env which is defined by Vite at build time
 */
declare const process: { env: { ALIGNMENT_SERVICE_URL?: string } };

// Empty string is falsy in JS, so we need explicit check
const configuredUrl = process.env.ALIGNMENT_SERVICE_URL;
const ALIGNMENT_SERVICE_URL = (configuredUrl && configuredUrl.trim() !== '')
  ? configuredUrl
  : 'http://localhost:8080';

// Debug logging in production to help diagnose deployment issues
if (typeof window !== 'undefined') {
  console.log('[AlignmentService] Configured URL:', ALIGNMENT_SERVICE_URL);
  console.log('[AlignmentService] Raw env value:', JSON.stringify(process.env.ALIGNMENT_SERVICE_URL));
}

/**
 * Response from the alignment service
 */
interface AlignedSegment {
  speakerId: string;
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
}

interface AlignmentResponse {
  segments: AlignedSegment[];
  average_confidence: number;
}

/**
 * AlignmentService - Handles timestamp alignment via WhisperX backend
 *
 * Takes a conversation with potentially inaccurate Gemini timestamps
 * and returns it with precise timestamps from WhisperX forced alignment.
 *
 * The heavy lifting happens on the backend:
 * 1. Frontend sends audio + transcript to alignment service
 * 2. Service calls Replicate's WhisperX for word-level timestamps
 * 3. Service fuzzy-matches Gemini segments to WhisperX words
 * 4. Frontend receives corrected timestamps
 */
export class AlignmentService {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || ALIGNMENT_SERVICE_URL;
  }

  /**
   * Check if the alignment service is available and configured
   */
  async healthCheck(): Promise<{ status: string; replicate_configured: boolean }> {
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Align a conversation's timestamps using WhisperX
   *
   * @param conversation - The conversation with Gemini timestamps
   * @param audioBlob - The audio blob (fetched from blob URL)
   * @returns Updated conversation with aligned timestamps
   */
  async align(conversation: Conversation, audioBlob: Blob): Promise<Conversation> {
    console.log('[AlignmentService] Starting alignment for', conversation.conversationId);

    // Convert audio blob to base64
    const audioBase64 = await this.blobToBase64(audioBlob);

    // Prepare segments for the API
    const segmentsPayload = conversation.segments.map(seg => ({
      speakerId: seg.speakerId,
      text: seg.text,
      startMs: seg.startMs,
      endMs: seg.endMs
    }));

    console.log('[AlignmentService] Sending', segmentsPayload.length, 'segments for alignment');

    // Call alignment service
    const response = await fetch(`${this.baseUrl}/align`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_base64: audioBase64,
        segments: segmentsPayload
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[AlignmentService] Alignment failed:', errorText);
      throw new Error(`Alignment failed: ${response.statusText}`);
    }

    const result: AlignmentResponse = await response.json();

    console.log('[AlignmentService] Alignment complete. Average confidence:', result.average_confidence);

    // Quality gate: warn on low confidence but still apply
    // HARDY algorithm handles failures gracefully with interpolation/fallback
    const MIN_CONFIDENCE_THRESHOLD = 0.55;
    if (result.average_confidence < MIN_CONFIDENCE_THRESHOLD) {
      const pct = (result.average_confidence * 100).toFixed(0);
      console.warn(`[AlignmentService] Alignment confidence is low (${pct}%), some timestamps may use fallback`);
    }

    // Map aligned segments back to conversation format
    const alignedSegments: Segment[] = result.segments.map((aligned, idx) => ({
      ...conversation.segments[idx],  // Keep other fields like segmentId, index
      startMs: aligned.startMs,
      endMs: aligned.endMs,
      // Store confidence for debugging (could add to Segment type later)
    }));

    // Update duration based on aligned segments
    const lastSegment = alignedSegments[alignedSegments.length - 1];
    const alignedDurationMs = lastSegment ? lastSegment.endMs : conversation.durationMs;

    return {
      ...conversation,
      segments: alignedSegments,
      durationMs: alignedDurationMs,
      // Mark as aligned (could add alignmentStatus to types)
    };
  }

  /**
   * Convert a Blob to base64 string
   */
  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        // Strip the data URL prefix (e.g., "data:audio/mp3;base64,")
        const base64 = dataUrl.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}

/**
 * Fetch the audio blob from a conversation
 * (blob URLs are ephemeral, we need to fetch the actual bytes)
 */
export async function fetchAudioBlob(audioUrl: string): Promise<Blob> {
  if (!audioUrl) {
    throw new Error('No audio URL available');
  }

  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error('Failed to fetch audio blob');
  }

  return response.blob();
}

// Export singleton instance
export const alignmentService = new AlignmentService();
