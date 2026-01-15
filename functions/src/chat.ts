/**
 * Chat with Conversation Cloud Function
 *
 * Allows users to ask questions about their transcripts and get timestamp-backed answers.
 * Uses Gemini API to analyze the transcript and provide citations.
 *
 * Features:
 * - Requires authentication and ownership verification
 * - Rate limiting (20 queries per conversation per day per user)
 * - Timestamp validation (ensures LLM cites real segments)
 * - Cost tracking and metrics recording
 * - Handles unanswerable questions gracefully
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { VertexAI } from '@google-cloud/vertexai';
import { db } from './index';
import { buildChatPrompt } from './utils/promptBuilder';
import {
  validateTimestampSources,
  extractSegmentIndices,
  TimestampSource
} from './utils/timestampValidation';
import { checkAndIncrementRateLimit } from './utils/rateLimit';
import {
  recordChatMetrics,
  calculateChatCost,
  classifyQueryType,
  ChatTokenUsage,
  ChatCostResult
} from './utils/chatMetrics';
import { buildGeminiLabels } from './utils/llmMetadata';
import { log } from './logger';
import type { Conversation } from './types';

/**
 * Create a Vertex AI client for Gemini API calls.
 * Uses automatic project detection from Cloud Functions environment.
 * Location defaults to us-central1 unless VERTEX_AI_LOCATION is set.
 */
function getVertexAIClient(): VertexAI {
  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  if (!project) {
    throw new Error('GCP project ID not found in environment');
  }

  const location = process.env.VERTEX_AI_LOCATION || 'us-central1';

  return new VertexAI({ project, location });
}

/**
 * Retry with exponential backoff for transient Vertex AI errors.
 * Handles 429 (rate limit), 503 (service unavailable), and similar.
 */
async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries = 3,
  baseDelayMs = 2000
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Retryable errors: rate limits, temporary unavailability
      const isRetryable = errorMessage.includes('429') ||
                          errorMessage.includes('RESOURCE_EXHAUSTED') ||
                          errorMessage.includes('503') ||
                          errorMessage.includes('UNAVAILABLE') ||
                          errorMessage.includes('DEADLINE_EXCEEDED');

      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      log.warn(`${operationName} failed (attempt ${attempt}/${maxRetries}), retrying in ${delayMs}ms`, {
        error: errorMessage,
        attempt,
        maxRetries
      });
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`${operationName} failed after ${maxRetries} attempts`);
}

interface ChatRequest {
  conversationId: string;
  message: string;
}

interface ChatResponse {
  answer: string;
  sources: TimestampSource[];
  isUnanswerable: boolean;
  tokenUsage: ChatTokenUsage;
  costUsd: number;
  responseTimeMs: number;
  rateLimitRemaining: number;
}

/**
 * Chat with a conversation's transcript
 *
 * Security:
 * - Requires authentication
 * - Verifies user owns the conversation
 * - Rate limited (20 queries/day per conversation per user)
 */
export const chatWithConversation = onCall<ChatRequest>(
  {
    region: 'us-central1',
    memory: '512MiB',
    // CORS: allow all origins (callable functions are already auth-protected)
    cors: true
  },
  async (request): Promise<ChatResponse> => {
    const startTime = Date.now();

    // Require authentication
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in to chat');
    }

    const { conversationId, message } = request.data;
    const userId = request.auth.uid;

    // Validate input
    if (!conversationId) {
      throw new HttpsError('invalid-argument', 'conversationId is required');
    }
    if (!message || message.trim().length === 0) {
      throw new HttpsError('invalid-argument', 'message cannot be empty');
    }
    if (message.length > 1000) {
      throw new HttpsError('invalid-argument', 'message too long (max 1000 characters)');
    }

    // Check rate limit BEFORE processing
    const rateLimit = await checkAndIncrementRateLimit(conversationId, userId);
    if (!rateLimit.allowed) {
      throw new HttpsError(
        'resource-exhausted',
        `Rate limit exceeded. You can make ${rateLimit.remaining} more queries. ` +
        `Limit resets at ${rateLimit.resetAt.toISOString()}.`
      );
    }

    log.info('Chat request received', {
      conversationId,
      userId,
      messageLength: message.length,
      rateLimitRemaining: rateLimit.remaining
    });

    try {
      // Fetch conversation and verify ownership
      const conversationDoc = await db.collection('conversations').doc(conversationId).get();

      if (!conversationDoc.exists) {
        throw new HttpsError('not-found', 'Conversation not found');
      }

      const conversation = conversationDoc.data() as Conversation;

      if (conversation.userId !== userId) {
        throw new HttpsError('permission-denied', 'You do not have access to this conversation');
      }

      // Verify conversation is ready for chat
      if (conversation.status !== 'complete') {
        throw new HttpsError(
          'failed-precondition',
          `Conversation is not ready for chat (status: ${conversation.status})`
        );
      }

      // Build prompt with full transcript context
      const prompt = buildChatPrompt(conversation, message);

      // Call Gemini API via Vertex AI
      const vertexAI = getVertexAIClient();
      const model = vertexAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

      // Build labels for billing attribution
      const labels = buildGeminiLabels(conversationId, userId, 'chat');

      // Wrap in retry logic for transient 429/rate limit errors
      const result = await retryWithBackoff(
        () => model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          labels
        }),
        'Gemini chat completion',
        3,     // maxRetries
        3000   // 3 second base delay (gives rate limits time to recover)
      );
      const response = result.response;
      // Vertex AI SDK response structure
      const answerText = response.candidates?.[0]?.content?.parts?.[0]?.text || '';

      // Extract token usage
      const usage = response.usageMetadata;
      const tokenUsage: ChatTokenUsage = {
        inputTokens: usage?.promptTokenCount || 0,
        outputTokens: usage?.candidatesTokenCount || 0,
        model: 'gemini-2.5-flash'
      };

      // Determine if the question is unanswerable
      const isUnanswerable = detectUnanswerableResponse(answerText);

      // Extract and validate timestamp sources
      const segmentIndices = extractSegmentIndices(answerText);
      const rawSources = segmentIndices.map(index => ({ segmentIndex: index }));
      const validatedSources = validateTimestampSources(rawSources, conversation.segments);

      // Calculate cost using live pricing from _pricing collection
      const costResult: ChatCostResult = await calculateChatCost(tokenUsage);
      const costUsd = costResult.costUsd;

      // Calculate response time
      const responseTimeMs = Date.now() - startTime;

      // Record metrics with pricing snapshot and billing labels (non-blocking)
      const queryType = classifyQueryType(message);
      recordChatMetrics({
        type: 'chat',
        conversationId,
        userId,
        queryType,
        tokenUsage,
        costUsd,
        responseTimeMs,
        sourcesCount: validatedSources.length,
        isUnanswerable,
        geminiLabels: labels,  // Billing labels for cost attribution
        pricingId: costResult.pricingId,
        pricingSnapshot: {
          capturedAt: costResult.capturedAt,
          inputPricePerMillion: costResult.inputPricePerMillion,
          outputPricePerMillion: costResult.outputPricePerMillion
        }
      }).catch(err => {
        log.warn('Failed to record chat metrics (non-blocking)', { error: err });
      });

      log.info('Chat request completed', {
        conversationId,
        userId,
        responseTimeMs,
        tokenUsage,
        costUsd,
        sourcesCount: validatedSources.length,
        isUnanswerable
      });

      // If unanswerable, override answer and sources to enforce contract
      const finalAnswer = isUnanswerable
        ? 'This information is not mentioned in the transcript.'
        : answerText;
      const finalSources = isUnanswerable ? [] : validatedSources;

      return {
        answer: finalAnswer,
        sources: finalSources,
        isUnanswerable,
        tokenUsage,
        costUsd,
        responseTimeMs,
        rateLimitRemaining: rateLimit.remaining
      };

    } catch (error) {
      const responseTimeMs = Date.now() - startTime;

      log.error('Chat request failed', {
        conversationId,
        userId,
        responseTimeMs,
        error: error instanceof Error ? error.message : String(error)
      });

      // Re-throw HttpsErrors as-is
      if (error instanceof HttpsError) {
        throw error;
      }

      // Wrap other errors
      throw new HttpsError(
        'internal',
        'Failed to process chat request: ' + (error instanceof Error ? error.message : String(error))
      );
    }
  }
);

/**
 * Detect if the LLM response indicates the question is unanswerable
 *
 * Looks for phrases like:
 * - "not mentioned in the transcript"
 * - "cannot be found"
 * - "no information about"
 */
function detectUnanswerableResponse(responseText: string): boolean {
  const normalized = responseText.toLowerCase();

  const unanswerableIndicators = [
    'not mentioned in the transcript',
    'not discussed in the transcript',
    'cannot be found in the transcript',
    'no information about',
    'not covered in the transcript',
    'does not mention',
    'not present in the transcript',
    'not addressed in the transcript'
  ];

  for (const indicator of unanswerableIndicators) {
    if (normalized.includes(indicator)) {
      return true;
    }
  }

  return false;
}
