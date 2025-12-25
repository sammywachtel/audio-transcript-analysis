/**
 * Unit tests for structured logger utility
 */

import { formatMessage } from '../logger';

describe('logger', () => {
  describe('formatMessage', () => {
    it('should format message with no context', () => {
      const result = formatMessage('Test message');
      expect(result).toBe('Test message');
    });

    it('should format message with conversationId', () => {
      const result = formatMessage('Test message', {
        conversationId: 'abc123def456' // pragma: allowlist secret
      });
      expect(result).toBe('[abc123de] Test message');
    });

    it('should format message with stage', () => {
      const result = formatMessage('Test message', {
        stage: 'gemini'
      });
      expect(result).toBe('[gemini] Test message');
    });

    it('should format message with conversationId and stage', () => {
      const result = formatMessage('Test message', {
        conversationId: 'abc123def456', // pragma: allowlist secret
        stage: 'whisperx'
      });
      expect(result).toBe('[abc123de][whisperx] Test message');
    });

    it('should handle empty context object', () => {
      const result = formatMessage('Test message', {});
      expect(result).toBe('Test message');
    });

    it('should handle short conversationId', () => {
      const result = formatMessage('Test message', {
        conversationId: 'abc'
      });
      expect(result).toBe('[abc] Test message');
    });

    it('should ignore extra context fields in formatting', () => {
      const result = formatMessage('Test message', {
        conversationId: 'abc123def456', // pragma: allowlist secret
        userId: 'user123',
        duration: 1000,
        customField: 'ignored'
      });
      // Only conversationId is used in prefix
      expect(result).toBe('[abc123de] Test message');
    });
  });
});
