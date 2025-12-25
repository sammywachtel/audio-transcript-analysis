/**
 * Structured logging utility for Cloud Functions
 *
 * Wraps firebase-functions logger with context-aware formatting.
 * All logs include conversationId/userId when available for traceability.
 */

import { logger } from 'firebase-functions';

interface LogContext {
  conversationId?: string;
  userId?: string;
  stage?: string;
  duration?: number;
  [key: string]: unknown;
}

/**
 * Format log message with context prefix
 * Example: "[abc12345][gemini] Analysis complete"
 */
export function formatMessage(message: string, context?: LogContext): string {
  const prefix = context?.conversationId
    ? `[${context.conversationId.slice(0, 8)}]`
    : '';
  const stage = context?.stage ? `[${context.stage}]` : '';
  return `${prefix}${stage} ${message}`.trim();
}

/**
 * Logger interface for type-safe logging
 */
interface Logger {
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  timing(operation: string, durationMs: number, context?: LogContext): void;
  timed<T>(operation: string, fn: () => Promise<T>, context?: LogContext): Promise<{ result: T; durationMs: number }>;
  child(defaultContext: LogContext): Logger;
}

/**
 * Structured logger with context support
 */
export const log: Logger = {
  /**
   * Info-level logs (default visibility)
   */
  info(message: string, context?: LogContext): void {
    const formatted = formatMessage(message, context);
    logger.info(formatted, context);
  },

  /**
   * Warning-level logs
   */
  warn(message: string, context?: LogContext): void {
    const formatted = formatMessage(message, context);
    logger.warn(formatted, context);
  },

  /**
   * Error-level logs
   */
  error(message: string, context?: LogContext): void {
    const formatted = formatMessage(message, context);
    logger.error(formatted, context);
  },

  /**
   * Debug-level logs (only visible when LOG_LEVEL=DEBUG)
   */
  debug(message: string, context?: LogContext): void {
    // Only log debug messages if LOG_LEVEL is DEBUG
    if (process.env.LOG_LEVEL === 'DEBUG') {
      const formatted = formatMessage(message, context);
      logger.debug(formatted, context);
    }
  },

  /**
   * Log timing information
   */
  timing(operation: string, durationMs: number, context?: LogContext): void {
    const formatted = formatMessage(
      `${operation} took ${durationMs}ms (${(durationMs / 1000).toFixed(1)}s)`,
      { ...context, duration: durationMs }
    );
    logger.info(formatted, { ...context, duration: durationMs });
  },

  /**
   * Execute function and log timing
   * Returns { result, durationMs } for use in metrics
   */
  async timed<T>(
    operation: string,
    fn: () => Promise<T>,
    context?: LogContext
  ): Promise<{ result: T; durationMs: number }> {
    const startTime = Date.now();
    const result = await fn();
    const durationMs = Date.now() - startTime;

    this.timing(operation, durationMs, context);

    return { result, durationMs };
  },

  /**
   * Create child logger with default context
   * Useful for scoping all logs in a function to a specific conversation
   */
  child(defaultContext: LogContext): Logger {
    return {
      info: (message: string, context?: LogContext) =>
        log.info(message, { ...defaultContext, ...context }),
      warn: (message: string, context?: LogContext) =>
        log.warn(message, { ...defaultContext, ...context }),
      error: (message: string, context?: LogContext) =>
        log.error(message, { ...defaultContext, ...context }),
      debug: (message: string, context?: LogContext) =>
        log.debug(message, { ...defaultContext, ...context }),
      timing: (operation: string, durationMs: number, context?: LogContext) =>
        log.timing(operation, durationMs, { ...defaultContext, ...context }),
      timed: <T>(operation: string, fn: () => Promise<T>, context?: LogContext) =>
        log.timed(operation, fn, { ...defaultContext, ...context }),
      child: (childContext: LogContext) =>
        log.child({ ...defaultContext, ...childContext })
    };
  }
};
