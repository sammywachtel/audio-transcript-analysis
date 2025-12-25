/**
 * Unit tests for circuit breaker
 */

import { CircuitBreaker } from '../circuitBreaker';

// Mock the logger to avoid actual logging during tests
jest.mock('../logger', () => ({
  log: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

describe('CircuitBreaker', () => {
  let circuit: CircuitBreaker;

  beforeEach(() => {
    // Create fresh circuit breaker for each test
    circuit = new CircuitBreaker('test-service', {
      failureThreshold: 2,
      resetTimeout: 1000,
      halfOpenRequests: 1
    });
  });

  it('should start in closed state', () => {
    const stats = circuit.getStats();
    expect(stats.state).toBe('closed');
    expect(stats.failureCount).toBe(0);
    expect(stats.successCount).toBe(0);
  });

  it('should allow requests in closed state', () => {
    expect(circuit.isAllowed()).toBe(true);
  });

  it('should transition to open after failureThreshold failures', async () => {
    const failingFn = jest.fn().mockRejectedValue(new Error('Service down'));

    // First failure
    await expect(circuit.execute(failingFn)).rejects.toThrow('Service down');
    expect(circuit.getStats().state).toBe('closed');

    // Second failure - should open circuit
    await expect(circuit.execute(failingFn)).rejects.toThrow('Service down');
    expect(circuit.getStats().state).toBe('open');
  });

  it('should block requests when circuit is open', async () => {
    const failingFn = jest.fn().mockRejectedValue(new Error('Service down'));

    // Trigger circuit open
    await expect(circuit.execute(failingFn)).rejects.toThrow();
    await expect(circuit.execute(failingFn)).rejects.toThrow();

    // Circuit should be open now
    expect(circuit.getStats().state).toBe('open');

    // Next request should be blocked
    await expect(circuit.execute(failingFn)).rejects.toThrow('Circuit breaker open');
  });

  it('should call fallback when circuit is open', async () => {
    const failingFn = jest.fn().mockRejectedValue(new Error('Service down'));
    const fallbackFn = jest.fn().mockResolvedValue('fallback result');

    // Trigger circuit open
    await expect(circuit.execute(failingFn)).rejects.toThrow();
    await expect(circuit.execute(failingFn)).rejects.toThrow();

    // Circuit should be open, fallback should be called
    const result = await circuit.execute(failingFn, fallbackFn);
    expect(result).toBe('fallback result');
    expect(fallbackFn).toHaveBeenCalled();
  });

  it('should transition to half-open after resetTimeout', async () => {
    const failingFn = jest.fn().mockRejectedValue(new Error('Service down'));

    // Trigger circuit open
    await expect(circuit.execute(failingFn)).rejects.toThrow();
    await expect(circuit.execute(failingFn)).rejects.toThrow();
    expect(circuit.getStats().state).toBe('open');

    // Wait for reset timeout (1000ms)
    await new Promise(resolve => setTimeout(resolve, 1100));

    // Check if circuit transitions to half-open
    expect(circuit.isAllowed()).toBe(true);
    const stats = circuit.getStats();
    expect(stats.state).toBe('half-open');
  });

  it('should transition to closed after halfOpenRequests successes', async () => {
    const failingFn = jest.fn().mockRejectedValue(new Error('Service down'));
    const successFn = jest.fn().mockResolvedValue('success');

    // Trigger circuit open
    await expect(circuit.execute(failingFn)).rejects.toThrow();
    await expect(circuit.execute(failingFn)).rejects.toThrow();
    expect(circuit.getStats().state).toBe('open');

    // Wait for reset timeout
    await new Promise(resolve => setTimeout(resolve, 1100));

    // Circuit should be half-open, try a successful request
    await circuit.execute(successFn);

    // Circuit should be closed after 1 success (halfOpenRequests = 1)
    const stats = circuit.getStats();
    expect(stats.state).toBe('closed');
    expect(stats.failureCount).toBe(0);
  });

  it('should transition back to open if request fails in half-open state', async () => {
    const failingFn = jest.fn().mockRejectedValue(new Error('Service down'));

    // Trigger circuit open
    await expect(circuit.execute(failingFn)).rejects.toThrow();
    await expect(circuit.execute(failingFn)).rejects.toThrow();
    expect(circuit.getStats().state).toBe('open');

    // Wait for reset timeout
    await new Promise(resolve => setTimeout(resolve, 1100));

    // Circuit should be half-open, try a failing request
    await expect(circuit.execute(failingFn)).rejects.toThrow('Service down');

    // Circuit should be open again
    expect(circuit.getStats().state).toBe('open');
  });

  it('should reset circuit manually', async () => {
    const failingFn = jest.fn().mockRejectedValue(new Error('Service down'));

    // Trigger circuit open
    await expect(circuit.execute(failingFn)).rejects.toThrow();
    await expect(circuit.execute(failingFn)).rejects.toThrow();
    expect(circuit.getStats().state).toBe('open');

    // Manual reset
    circuit.reset();

    // Circuit should be closed
    const stats = circuit.getStats();
    expect(stats.state).toBe('closed');
    expect(stats.failureCount).toBe(0);
    expect(stats.successCount).toBe(0);
  });

  it('should track total requests and failures', async () => {
    const failingFn = jest.fn().mockRejectedValue(new Error('Service down'));
    const successFn = jest.fn().mockResolvedValue('success');

    // Mix of successes and failures
    await circuit.execute(successFn);
    await expect(circuit.execute(failingFn)).rejects.toThrow();
    await circuit.execute(successFn);

    const stats = circuit.getStats();
    expect(stats.totalRequests).toBe(3);
    expect(stats.totalFailures).toBe(1);
  });

  it('should reset failure count after success in closed state', async () => {
    const failingFn = jest.fn().mockRejectedValue(new Error('Service down'));
    const successFn = jest.fn().mockResolvedValue('success');

    // One failure
    await expect(circuit.execute(failingFn)).rejects.toThrow();
    expect(circuit.getStats().failureCount).toBe(1);

    // Success should reset failure count
    await circuit.execute(successFn);
    expect(circuit.getStats().failureCount).toBe(0);
    expect(circuit.getStats().state).toBe('closed');
  });
});
