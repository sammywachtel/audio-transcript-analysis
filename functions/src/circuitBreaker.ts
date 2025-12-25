/**
 * Circuit Breaker pattern for external API calls
 *
 * Protects against cascading failures when external services are down.
 * States: closed (normal) → open (failing) → half-open (testing) → closed
 */

import { log } from './logger';

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerConfig {
  failureThreshold: number;    // Failures before opening circuit
  resetTimeout: number;         // Milliseconds before trying half-open
  halfOpenRequests: number;     // Successes needed to close circuit
}

interface CircuitStats {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime?: number;
  totalRequests: number;
  totalFailures: number;
}

/**
 * Circuit breaker for external API calls
 * Prevents hammering a failing service and provides fast-fail behavior
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime?: number;
  private totalRequests = 0;
  private totalFailures = 0;

  constructor(
    private readonly name: string,
    private readonly config: CircuitBreakerConfig
  ) {
    log.info(`Circuit breaker initialized: ${name}`, {
      stage: 'circuit-breaker',
      failureThreshold: config.failureThreshold,
      resetTimeout: config.resetTimeout
    });
  }

  /**
   * Execute a function with circuit breaker protection
   * Throws error if circuit is open, calls fallback if provided
   */
  async execute<T>(
    fn: () => Promise<T>,
    fallback?: () => Promise<T>
  ): Promise<T> {
    this.totalRequests++;

    // Check if circuit allows request
    if (!this.isAllowed()) {
      log.warn(`Circuit breaker OPEN for ${this.name} - request blocked`, {
        stage: 'circuit-breaker',
        state: this.state,
        failureCount: this.failureCount
      });

      if (fallback) {
        log.info(`Using fallback for ${this.name}`, { stage: 'circuit-breaker' });
        return fallback();
      }

      throw new Error(`Circuit breaker open for ${this.name} - service unavailable`);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);

      // Still throw the error after recording it
      // Caller decides how to handle
      throw error;
    }
  }

  /**
   * Check if circuit allows request
   */
  isAllowed(): boolean {
    if (this.state === 'closed') {
      return true;
    }

    if (this.state === 'open') {
      // Check if enough time has passed to try half-open
      const now = Date.now();
      const timeSinceFailure = this.lastFailureTime
        ? now - this.lastFailureTime
        : Infinity;

      if (timeSinceFailure >= this.config.resetTimeout) {
        this.transitionTo('half-open');
        return true;
      }

      return false;
    }

    // half-open state - allow requests
    return true;
  }

  /**
   * Get current circuit breaker statistics
   */
  getStats(): CircuitStats {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures
    };
  }

  /**
   * Manually reset circuit breaker to closed state
   */
  reset(): void {
    log.info(`Circuit breaker manually reset: ${this.name}`, {
      stage: 'circuit-breaker'
    });
    this.transitionTo('closed');
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = undefined;
  }

  /**
   * Handle successful request
   */
  private onSuccess(): void {
    this.failureCount = 0;

    if (this.state === 'half-open') {
      this.successCount++;

      if (this.successCount >= this.config.halfOpenRequests) {
        this.transitionTo('closed');
        this.successCount = 0;
      }
    }
  }

  /**
   * Handle failed request
   */
  private onFailure(error: unknown): void {
    this.failureCount++;
    this.totalFailures++;
    this.lastFailureTime = Date.now();

    const errorMessage = error instanceof Error ? error.message : String(error);

    log.warn(`Circuit breaker failure for ${this.name}`, {
      stage: 'circuit-breaker',
      failureCount: this.failureCount,
      threshold: this.config.failureThreshold,
      error: errorMessage
    });

    if (this.state === 'half-open') {
      // Failure during half-open - go back to open
      this.transitionTo('open');
      this.successCount = 0;
    } else if (this.failureCount >= this.config.failureThreshold) {
      // Too many failures - open circuit
      this.transitionTo('open');
    }
  }

  /**
   * Transition to new state with logging
   */
  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) {
      return;
    }

    log.warn(`Circuit breaker state change: ${this.name} ${this.state} → ${newState}`, {
      stage: 'circuit-breaker',
      oldState: this.state,
      newState,
      failureCount: this.failureCount,
      totalFailures: this.totalFailures
    });

    this.state = newState;
  }
}

/**
 * Circuit breaker for Replicate (WhisperX) API
 * Conservative settings - 2 failures triggers open
 */
export const replicateCircuit = new CircuitBreaker('replicate', {
  failureThreshold: 2,
  resetTimeout: 60000,      // 1 minute
  halfOpenRequests: 1
});

/**
 * Circuit breaker for Gemini API
 * More lenient - 3 failures before opening
 */
export const geminiCircuit = new CircuitBreaker('gemini', {
  failureThreshold: 3,
  resetTimeout: 30000,       // 30 seconds
  halfOpenRequests: 2
});
