/**
 * Tests for ChatHistory component
 *
 * Verifies:
 * - Message count display
 * - Export/clear button states based on messageCount
 * - Warning states at 45 and 50 messages
 * - Button enablement reflects real-time message count
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChatHistory } from '@/components/viewer/ChatHistory';
import { chatHistoryService } from '@/services/chatHistoryService';

// Mock the chatHistoryService
vi.mock('@/services/chatHistoryService', () => ({
  chatHistoryService: {
    clearHistory: vi.fn().mockResolvedValue(undefined),
    exportHistory: vi.fn().mockResolvedValue([])
  }
}));

// Mock URL.createObjectURL and URL.revokeObjectURL
global.URL.createObjectURL = vi.fn(() => 'mock-url');
global.URL.revokeObjectURL = vi.fn();

describe('ChatHistory', () => {
  const defaultProps = {
    conversationId: 'conv-1',
    conversationTitle: 'Test Conversation',
    messageCount: 5,
    onClearComplete: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('message count display', () => {
    it('should display current message count', () => {
      render(<ChatHistory {...defaultProps} messageCount={12} />);

      expect(screen.getByText('12/50')).toBeInTheDocument();
    });

    it('should show green/normal styling for counts below 45', () => {
      render(<ChatHistory {...defaultProps} messageCount={44} />);

      const countElement = screen.getByText('44/50');
      expect(countElement).toHaveClass('text-slate-700');
    });

    it('should show yellow/warning styling for counts 45-49', () => {
      render(<ChatHistory {...defaultProps} messageCount={45} />);

      const countElement = screen.getByText('45/50');
      expect(countElement).toHaveClass('text-yellow-600');
      expect(screen.getByText('Near limit')).toBeInTheDocument();
    });

    it('should show red/blocked styling for count at 50', () => {
      render(<ChatHistory {...defaultProps} messageCount={50} />);

      const countElement = screen.getByText('50/50');
      expect(countElement).toHaveClass('text-red-600');
      expect(screen.getByText('Limit reached')).toBeInTheDocument();
    });
  });

  describe('button enablement', () => {
    it('should disable export button when messageCount is 0', () => {
      render(<ChatHistory {...defaultProps} messageCount={0} />);

      const exportButton = screen.getByTitle('Export history as JSON');
      expect(exportButton).toBeDisabled();
    });

    it('should enable export button when messageCount > 0', () => {
      render(<ChatHistory {...defaultProps} messageCount={1} />);

      const exportButton = screen.getByTitle('Export history as JSON');
      expect(exportButton).not.toBeDisabled();
    });

    it('should disable clear button when messageCount is 0', () => {
      render(<ChatHistory {...defaultProps} messageCount={0} />);

      const clearButton = screen.getByTitle('Clear all history');
      expect(clearButton).toBeDisabled();
    });

    it('should enable clear button when messageCount > 0', () => {
      render(<ChatHistory {...defaultProps} messageCount={1} />);

      const clearButton = screen.getByTitle('Clear all history');
      expect(clearButton).not.toBeDisabled();
    });

    it('should update button state immediately when messageCount changes', () => {
      const { rerender } = render(<ChatHistory {...defaultProps} messageCount={0} />);

      // Initially disabled
      expect(screen.getByTitle('Export history as JSON')).toBeDisabled();
      expect(screen.getByTitle('Clear all history')).toBeDisabled();

      // Rerender with new count (simulating real-time update)
      rerender(<ChatHistory {...defaultProps} messageCount={1} />);

      // Should now be enabled - no refresh needed!
      expect(screen.getByTitle('Export history as JSON')).not.toBeDisabled();
      expect(screen.getByTitle('Clear all history')).not.toBeDisabled();
    });
  });

  describe('export functionality', () => {
    it('should call exportHistory when export button clicked', async () => {
      const mockMessages = [
        { id: '1', role: 'user', content: 'Hello', createdAt: '2024-01-01' }
      ];
      vi.mocked(chatHistoryService.exportHistory).mockResolvedValue(mockMessages as never);

      render(<ChatHistory {...defaultProps} messageCount={1} />);

      const exportButton = screen.getByTitle('Export history as JSON');
      fireEvent.click(exportButton);

      await waitFor(() => {
        expect(chatHistoryService.exportHistory).toHaveBeenCalledWith('conv-1');
      });
    });
  });

  describe('clear functionality', () => {
    it('should show confirmation modal when clear button clicked', () => {
      render(<ChatHistory {...defaultProps} messageCount={5} />);

      const clearButton = screen.getByTitle('Clear all history');
      fireEvent.click(clearButton);

      expect(screen.getByText('Clear Chat History?')).toBeInTheDocument();
      expect(screen.getByText('Test Conversation')).toBeInTheDocument();
      expect(screen.getByText('5 messages')).toBeInTheDocument();
    });

    it('should close modal when Cancel clicked', () => {
      render(<ChatHistory {...defaultProps} messageCount={5} />);

      fireEvent.click(screen.getByTitle('Clear all history'));
      expect(screen.getByText('Clear Chat History?')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Cancel'));
      expect(screen.queryByText('Clear Chat History?')).not.toBeInTheDocument();
    });

    it('should close modal when Escape pressed', () => {
      render(<ChatHistory {...defaultProps} messageCount={5} />);

      fireEvent.click(screen.getByTitle('Clear all history'));
      expect(screen.getByText('Clear Chat History?')).toBeInTheDocument();

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByText('Clear Chat History?')).not.toBeInTheDocument();
    });

    it('should call clearHistory and onClearComplete when confirmed', async () => {
      const onClearComplete = vi.fn();
      vi.mocked(chatHistoryService.clearHistory).mockResolvedValue(undefined);

      render(<ChatHistory {...defaultProps} messageCount={5} onClearComplete={onClearComplete} />);

      fireEvent.click(screen.getByTitle('Clear all history'));
      fireEvent.click(screen.getByText('Clear History'));

      await waitFor(() => {
        expect(chatHistoryService.clearHistory).toHaveBeenCalledWith('conv-1');
        expect(onClearComplete).toHaveBeenCalled();
      });
    });

    it('should confirm with Enter key', async () => {
      const onClearComplete = vi.fn();
      vi.mocked(chatHistoryService.clearHistory).mockResolvedValue(undefined);

      render(<ChatHistory {...defaultProps} messageCount={5} onClearComplete={onClearComplete} />);

      fireEvent.click(screen.getByTitle('Clear all history'));
      fireEvent.keyDown(document, { key: 'Enter' });

      await waitFor(() => {
        expect(chatHistoryService.clearHistory).toHaveBeenCalled();
      });
    });
  });

  describe('warning indicators', () => {
    it('should show warning triangle at 45 messages', () => {
      render(<ChatHistory {...defaultProps} messageCount={45} />);

      // AlertTriangle icon should be present with yellow color
      const warningText = screen.getByText('Near limit');
      expect(warningText).toHaveClass('text-yellow-600');
    });

    it('should show warning triangle at 50 messages', () => {
      render(<ChatHistory {...defaultProps} messageCount={50} />);

      const blockedText = screen.getByText('Limit reached');
      expect(blockedText).toHaveClass('text-red-600');
    });

    it('should NOT show warning below 45 messages', () => {
      render(<ChatHistory {...defaultProps} messageCount={44} />);

      expect(screen.queryByText('Near limit')).not.toBeInTheDocument();
      expect(screen.queryByText('Limit reached')).not.toBeInTheDocument();
    });
  });
});
