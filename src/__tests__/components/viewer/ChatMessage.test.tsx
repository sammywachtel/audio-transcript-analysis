/**
 * Tests for ChatMessage component
 *
 * Verifies:
 * - User/assistant message rendering
 * - Copy button appears on assistant messages
 * - Copy strips [segment N] citations and markdown
 * - Copy provides visual feedback
 * - Accessibility (aria-label, focusable)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ChatMessage } from '@/components/viewer/ChatMessage';
import { ChatHistoryMessage } from '@/services/chatHistoryService';
import { Speaker } from '@/config/types';

// Mock the clipboard API
const mockWriteText = vi.fn();
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: mockWriteText },
  writable: true,
  configurable: true
});

describe('ChatMessage', () => {
  const mockSpeakers: Record<string, Speaker> = {
    speaker1: { speakerId: 'speaker1', displayName: 'John Doe', colorIndex: 0 }
  };

  const mockCallbacks = {
    onSeek: vi.fn(),
    onPlay: vi.fn(),
    onHighlight: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteText.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  const createMessage = (overrides: Partial<ChatHistoryMessage> = {}): ChatHistoryMessage => ({
    id: 'msg-1',
    role: 'assistant',
    content: 'Hello world',
    createdAt: new Date().toISOString(),
    ...overrides
  });

  describe('message rendering', () => {
    it('should render user messages with "You" label', () => {
      const message = createMessage({ role: 'user', content: 'Test question' });

      render(
        <ChatMessage
          message={message}
          speakers={mockSpeakers}
          conversationId="conv-1"
          {...mockCallbacks}
        />
      );

      expect(screen.getByText('You')).toBeInTheDocument();
      expect(screen.getByText('Test question')).toBeInTheDocument();
    });

    it('should render assistant messages with "Assistant" label', () => {
      const message = createMessage({ role: 'assistant', content: 'Test response' });

      render(
        <ChatMessage
          message={message}
          speakers={mockSpeakers}
          conversationId="conv-1"
          {...mockCallbacks}
        />
      );

      expect(screen.getByText('Assistant')).toBeInTheDocument();
    });

    it('should render unanswerable messages with info banner', () => {
      const message = createMessage({
        role: 'assistant',
        content: 'I could not find that information.',
        isUnanswerable: true
      });

      render(
        <ChatMessage
          message={message}
          speakers={mockSpeakers}
          conversationId="conv-1"
          {...mockCallbacks}
        />
      );

      expect(screen.getByText(/couldn't be found/)).toBeInTheDocument();
    });
  });

  describe('copy button', () => {
    it('should show copy button on assistant messages', () => {
      const message = createMessage({ role: 'assistant' });

      render(
        <ChatMessage
          message={message}
          speakers={mockSpeakers}
          conversationId="conv-1"
          {...mockCallbacks}
        />
      );

      expect(screen.getByRole('button', { name: /copy message/i })).toBeInTheDocument();
    });

    it('should NOT show copy button on user messages', () => {
      const message = createMessage({ role: 'user' });

      render(
        <ChatMessage
          message={message}
          speakers={mockSpeakers}
          conversationId="conv-1"
          {...mockCallbacks}
        />
      );

      expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument();
    });

    it('should show copy button on unanswerable assistant messages', () => {
      const message = createMessage({
        role: 'assistant',
        content: 'I could not find that information.',
        isUnanswerable: true
      });

      render(
        <ChatMessage
          message={message}
          speakers={mockSpeakers}
          conversationId="conv-1"
          {...mockCallbacks}
        />
      );

      // Unanswerable messages should also have the copy button
      expect(screen.getByRole('button', { name: /copy message/i })).toBeInTheDocument();
    });

    it('should copy plain text to clipboard when clicked', async () => {
      const message = createMessage({
        content: 'This is **bold** and *italic* text.'
      });

      render(
        <ChatMessage
          message={message}
          speakers={mockSpeakers}
          conversationId="conv-1"
          {...mockCallbacks}
        />
      );

      const copyButton = screen.getByRole('button', { name: /copy message/i });

      await act(async () => {
        fireEvent.click(copyButton);
        // Flush the promise from clipboard.writeText
        await Promise.resolve();
      });

      expect(mockWriteText).toHaveBeenCalledWith(
        'This is bold and italic text.'
      );
    });

    it('should strip [segment N] citations when copying', async () => {
      const message = createMessage({
        content: 'Check this source [segment 5] for details [segment 12].'
      });

      render(
        <ChatMessage
          message={message}
          speakers={mockSpeakers}
          conversationId="conv-1"
          {...mockCallbacks}
        />
      );

      const copyButton = screen.getByRole('button', { name: /copy message/i });

      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
      });

      expect(mockWriteText).toHaveBeenCalledWith(
        'Check this source  for details .'
      );
    });

    it('should strip comma-separated segment lists when copying', async () => {
      const message = createMessage({
        content: 'Multiple sources [segment 5, segment 12] here.'
      });

      render(
        <ChatMessage
          message={message}
          speakers={mockSpeakers}
          conversationId="conv-1"
          {...mockCallbacks}
        />
      );

      const copyButton = screen.getByRole('button', { name: /copy message/i });

      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
      });

      expect(mockWriteText).toHaveBeenCalledWith(
        'Multiple sources  here.'
      );
    });

    it('should convert markdown headers to plain text', async () => {
      const message = createMessage({
        content: '# Main Topic\n\n## Subtopic\n\nContent here.'
      });

      render(
        <ChatMessage
          message={message}
          speakers={mockSpeakers}
          conversationId="conv-1"
          {...mockCallbacks}
        />
      );

      const copyButton = screen.getByRole('button', { name: /copy message/i });

      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
      });

      expect(mockWriteText).toHaveBeenCalledWith(
        'Main Topic\n\nSubtopic\n\nContent here.'
      );
    });

    it('should convert list markers to bullets', async () => {
      const message = createMessage({
        content: '- Item 1\n- Item 2\n1. Numbered'
      });

      render(
        <ChatMessage
          message={message}
          speakers={mockSpeakers}
          conversationId="conv-1"
          {...mockCallbacks}
        />
      );

      const copyButton = screen.getByRole('button', { name: /copy message/i });

      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
      });

      expect(mockWriteText).toHaveBeenCalledWith(
        '• Item 1\n• Item 2\n• Numbered'
      );
    });

    it('should strip links but keep link text', async () => {
      const message = createMessage({
        content: 'Check [the docs](https://example.com) for more.'
      });

      render(
        <ChatMessage
          message={message}
          speakers={mockSpeakers}
          conversationId="conv-1"
          {...mockCallbacks}
        />
      );

      const copyButton = screen.getByRole('button', { name: /copy message/i });

      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
      });

      expect(mockWriteText).toHaveBeenCalledWith(
        'Check the docs for more.'
      );
    });

    it('should show "Copied!" feedback after successful copy', async () => {
      const message = createMessage({ content: 'Hello' });

      render(
        <ChatMessage
          message={message}
          speakers={mockSpeakers}
          conversationId="conv-1"
          {...mockCallbacks}
        />
      );

      const copyButton = screen.getByRole('button', { name: /copy message/i });

      // Click and wait for the async clipboard operation
      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
      });

      // Should show "Copied to clipboard" feedback
      expect(screen.getByRole('button', { name: /copied to clipboard/i })).toBeInTheDocument();

      // Fast-forward past the feedback timeout
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      // Should revert to "Copy message"
      expect(screen.getByRole('button', { name: /copy message/i })).toBeInTheDocument();
    });

    it('should have proper focus styling for accessibility', () => {
      const message = createMessage();

      render(
        <ChatMessage
          message={message}
          speakers={mockSpeakers}
          conversationId="conv-1"
          {...mockCallbacks}
        />
      );

      const copyButton = screen.getByRole('button', { name: /copy message/i });

      // Button should be focusable and have focus ring classes
      expect(copyButton).toHaveClass('focus:ring-2');
      expect(copyButton).toHaveClass('focus:ring-blue-500');
    });
  });

  describe('cost indicator', () => {
    it('should show cost on assistant messages when provided', () => {
      const message = createMessage({
        role: 'assistant',
        costUsd: 0.0035
      });

      render(
        <ChatMessage
          message={message}
          speakers={mockSpeakers}
          conversationId="conv-1"
          {...mockCallbacks}
        />
      );

      // CostIndicator should render - exact format depends on CostIndicator component
      // Just verify it's present (the exact text depends on the component's formatting)
      expect(screen.getByText(/\$/)).toBeInTheDocument();
    });
  });
});
