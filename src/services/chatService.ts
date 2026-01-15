/**
 * Chat Service
 *
 * Wrapper around Firebase callable function for chatWithConversation.
 * Handles the request/response contract with proper typing.
 */

import { httpsCallable } from 'firebase/functions';
import { functions } from '@/config/firebase-config';

/**
 * Timestamp source from chat response
 * Contains segment metadata for citation links
 *
 * Note: Backend (timestampValidation.ts) returns 'speaker' not 'speakerId'.
 * Keep this aligned with the Cloud Function's TimestampSource interface.
 */
export interface TimestampSource {
  segmentIndex: number;
  segmentId: string;
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Chat request payload
 */
interface ChatRequest {
  conversationId: string;
  message: string;
}

/**
 * Token usage metadata (for cost calculation)
 */
interface ChatTokenUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/**
 * Chat response from Cloud Function
 */
export interface ChatResponse {
  answer: string;
  sources: TimestampSource[];
  isUnanswerable: boolean;
  tokenUsage: ChatTokenUsage;
  costUsd: number;
  responseTimeMs: number;
  rateLimitRemaining: number;
}

/**
 * Send a chat message to the conversation's transcript
 *
 * @param conversationId - ID of the conversation to chat with
 * @param message - User's question (max 1000 chars)
 * @returns Promise<ChatResponse> - LLM answer with timestamp citations
 * @throws Error if request fails or rate limit exceeded
 */
export async function sendChatMessage(
  conversationId: string,
  message: string
): Promise<ChatResponse> {
  // Client-side validation (server also validates)
  if (!message || message.trim().length === 0) {
    throw new Error('Message cannot be empty');
  }

  if (message.length > 1000) {
    throw new Error('Message too long (max 1000 characters)');
  }

  // Call Cloud Function
  const chatFn = httpsCallable<ChatRequest, ChatResponse>(functions, 'chatWithConversation');

  try {
    const result = await chatFn({ conversationId, message });
    return result.data;
  } catch (error: unknown) {
    // Firebase wraps errors in a specific format - extract the message
    // FirebaseError has a 'code' property we can check
    const firebaseError = error as { code?: string; message?: string };

    if (firebaseError.code === 'functions/resource-exhausted') {
      throw new Error(`Rate limit exceeded: ${firebaseError.message}`);
    }

    if (firebaseError.code === 'functions/unauthenticated') {
      throw new Error('You must be signed in to use chat');
    }

    if (firebaseError.code === 'functions/permission-denied') {
      throw new Error('You do not have access to this conversation');
    }

    if (firebaseError.code === 'functions/not-found') {
      throw new Error('Conversation not found');
    }

    // Generic error fallback
    throw new Error(firebaseError.message || 'Failed to send chat message');
  }
}
