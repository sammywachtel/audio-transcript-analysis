/**
 * Tests for TranscriptView selection mode gating
 *
 * Verifies that clicks behave differently based on isSelectionMode:
 * - Navigation mode (default): clicks seek audio
 * - Selection mode: clicks toggle segment selection
 * - Clear signal resets all selections
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TranscriptView } from '@/components/viewer/TranscriptView';
import { Conversation } from '@/config/types';

// Minimal conversation fixture — just enough to render without blowing up
const makeConversation = (segmentCount = 3): Conversation => ({
  conversationId: 'test-convo',
  userId: 'user1',
  title: 'Test Conversation',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  durationMs: 60000,
  status: 'complete',
  speakers: {
    s1: { speakerId: 's1', displayName: 'Alice', colorIndex: 0 },
    s2: { speakerId: 's2', displayName: 'Bob', colorIndex: 1 }
  },
  segments: Array.from({ length: segmentCount }, (_, i) => ({
    segmentId: `seg-${i}`,
    index: i,
    speakerId: i % 2 === 0 ? 's1' : 's2',
    startMs: i * 5000,
    endMs: (i + 1) * 5000,
    text: `Segment ${i} text content here`
  })),
  terms: {},
  termOccurrences: [],
  topics: [],
  people: []
});

describe('TranscriptView - Selection Mode Gating', () => {
  const defaultProps = {
    conversation: makeConversation(),
    activeSegmentIndex: -1,
    personOccurrences: {} as Record<string, { start: number; end: number; personId: string }[]>,
    onSeek: vi.fn(),
    onTermClick: vi.fn(),
    onRenameSpeaker: vi.fn(),
    onReassignSpeaker: vi.fn(),
    onReassignSegments: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders segments in navigation mode by default', () => {
    render(<TranscriptView {...defaultProps} />);

    // All segments should render
    expect(screen.getByText('Segment 0 text content here')).toBeInTheDocument();
    expect(screen.getByText('Segment 1 text content here')).toBeInTheDocument();
    expect(screen.getByText('Segment 2 text content here')).toBeInTheDocument();
  });

  it('shows compact Select button when not in selection mode', () => {
    render(<TranscriptView {...defaultProps} isSelectionMode={false} />);

    expect(screen.getByText('Select')).toBeInTheDocument();
  });

  it('calls onToggleSelectionMode when Select button is clicked', () => {
    const onToggle = vi.fn();
    render(
      <TranscriptView
        {...defaultProps}
        isSelectionMode={false}
        onToggleSelectionMode={onToggle}
      />
    );

    fireEvent.click(screen.getByText('Select'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows full selection bar with "Click segments to select" when in selection mode with no selections', () => {
    render(
      <TranscriptView
        {...defaultProps}
        isSelectionMode={true}
      />
    );

    expect(screen.getByText('Click segments to select')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('shows Done button that calls onToggleSelectionMode', () => {
    const onToggle = vi.fn();
    render(
      <TranscriptView
        {...defaultProps}
        isSelectionMode={true}
        onToggleSelectionMode={onToggle}
      />
    );

    fireEvent.click(screen.getByText('Done'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('clears selections when selectionClearSignal increments', () => {
    const { rerender } = render(
      <TranscriptView
        {...defaultProps}
        isSelectionMode={true}
        selectionClearSignal={0}
      />
    );

    // Click a segment to select it (first non-active segment div)
    const segmentDivs = document.querySelectorAll('[class*="border-l-"]');
    fireEvent.click(segmentDivs[0]);

    // Should show "1 segment selected"
    expect(screen.getByText('1 segment selected')).toBeInTheDocument();

    // Bump the clear signal
    rerender(
      <TranscriptView
        {...defaultProps}
        isSelectionMode={true}
        selectionClearSignal={1}
      />
    );

    // Should show zero-selection prompt again
    expect(screen.getByText('Click segments to select')).toBeInTheDocument();
  });

  it('shows segment count after clicking in selection mode', () => {
    render(
      <TranscriptView
        {...defaultProps}
        isSelectionMode={true}
      />
    );

    // Click first segment
    const segmentDivs = document.querySelectorAll('[class*="border-l-"]');
    fireEvent.click(segmentDivs[0]);

    expect(screen.getByText('1 segment selected')).toBeInTheDocument();

    // Click second segment
    fireEvent.click(segmentDivs[1]);

    expect(screen.getByText('2 segments selected')).toBeInTheDocument();
  });

  it('shows Reassign dropdown when segments are selected in selection mode', () => {
    render(
      <TranscriptView
        {...defaultProps}
        isSelectionMode={true}
      />
    );

    // Click a segment to select it
    const segmentDivs = document.querySelectorAll('[class*="border-l-"]');
    fireEvent.click(segmentDivs[0]);

    // Reassign button should appear
    expect(screen.getByText('Reassign to...')).toBeInTheDocument();
  });

  it('toggles selection off with second click in selection mode', () => {
    render(
      <TranscriptView
        {...defaultProps}
        isSelectionMode={true}
      />
    );

    const segmentDivs = document.querySelectorAll('[class*="border-l-"]');

    // Select
    fireEvent.click(segmentDivs[0]);
    expect(screen.getByText('1 segment selected')).toBeInTheDocument();

    // Deselect
    fireEvent.click(segmentDivs[0]);
    expect(screen.getByText('Click segments to select')).toBeInTheDocument();
  });
});
