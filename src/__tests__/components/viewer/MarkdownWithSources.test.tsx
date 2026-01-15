/**
 * Tests for MarkdownWithSources component
 *
 * Verifies markdown rendering with inline timestamp sources.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownWithSources, TimestampSource } from '@/components/viewer/MarkdownWithSources';
import { Speaker } from '@/config/types';

describe('MarkdownWithSources', () => {
  const mockSpeakers: Record<string, Speaker> = {
    speaker1: { speakerId: 'speaker1', displayName: 'John Doe', colorIndex: 0 }
  };

  const mockSources: TimestampSource[] = [
    { segmentId: 'seg1', startMs: 1000, speaker: 'speaker1' },
    { segmentId: 'seg2', startMs: 2000, speaker: 'speaker1' }
  ];

  const mockCallbacks = {
    onSeek: vi.fn(),
    onPlay: vi.fn(),
    onHighlight: vi.fn(),
    onUnconsumedSources: vi.fn()
  };

  it('should render plain markdown without sources', () => {
    const content = 'This is **bold** and *italic* text.';

    render(
      <MarkdownWithSources
        content={content}
        sources={[]}
        speakers={mockSpeakers}
        conversationId="test-conv"
        {...mockCallbacks}
      />
    );

    expect(screen.getByText('bold')).toBeInTheDocument();
    expect(screen.getByText('italic')).toBeInTheDocument();
  });

  it('should render inline code blocks', () => {
    const content = 'Use `const x = 42` for constants.';

    render(
      <MarkdownWithSources
        content={content}
        sources={[]}
        speakers={mockSpeakers}
        conversationId="test-conv"
        {...mockCallbacks}
      />
    );

    expect(screen.getByText('const x = 42')).toHaveClass('font-mono');
  });

  it('should render block code with proper styling', () => {
    const content = '```javascript\nfunction hello() {\n  return "world";\n}\n```';

    render(
      <MarkdownWithSources
        content={content}
        sources={[]}
        speakers={mockSpeakers}
        conversationId="test-conv"
        {...mockCallbacks}
      />
    );

    // Code blocks should have overflow-x-auto for scrolling
    const codeBlock = screen.getByText(/function hello/);
    expect(codeBlock).toHaveClass('overflow-x-auto');
  });

  it('should render lists with proper structure', () => {
    const content = '- Item 1\n- Item 2\n- Item 3';

    render(
      <MarkdownWithSources
        content={content}
        sources={[]}
        speakers={mockSpeakers}
        conversationId="test-conv"
        {...mockCallbacks}
      />
    );

    expect(screen.getByText('Item 1')).toBeInTheDocument();
    expect(screen.getByText('Item 2')).toBeInTheDocument();
    expect(screen.getByText('Item 3')).toBeInTheDocument();
  });

  it('should render headings with proper hierarchy', () => {
    const content = '# Heading 1\n## Heading 2\n### Heading 3';

    render(
      <MarkdownWithSources
        content={content}
        sources={[]}
        speakers={mockSpeakers}
        conversationId="test-conv"
        {...mockCallbacks}
      />
    );

    expect(screen.getByText('Heading 1')).toHaveClass('text-lg', 'font-bold');
    expect(screen.getByText('Heading 2')).toHaveClass('text-base', 'font-bold');
    expect(screen.getByText('Heading 3')).toHaveClass('text-sm', 'font-bold');
  });

  it('should render links with proper attributes', () => {
    const content = '[Click here](https://example.com)';

    render(
      <MarkdownWithSources
        content={content}
        sources={[]}
        speakers={mockSpeakers}
        conversationId="test-conv"
        {...mockCallbacks}
      />
    );

    const link = screen.getByText('Click here');
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('should render blockquotes with proper styling', () => {
    const content = '> This is a quote';

    render(
      <MarkdownWithSources
        content={content}
        sources={[]}
        speakers={mockSpeakers}
        conversationId="test-conv"
        {...mockCallbacks}
      />
    );

    const quote = screen.getByText('This is a quote');
    expect(quote.parentElement).toHaveClass('border-l-4', 'italic');
  });

  it('should replace {{SOURCE_0}} with TimestampLink', () => {
    const content = 'Check this source {{SOURCE_0}} for details.';

    render(
      <MarkdownWithSources
        content={content}
        sources={mockSources}
        speakers={mockSpeakers}
        conversationId="test-conv"
        {...mockCallbacks}
      />
    );

    // TimestampLink should render timestamp and speaker
    expect(screen.getByText('0:01')).toBeInTheDocument(); // 1000ms = 0:01
    expect(screen.getByText('John Doe')).toBeInTheDocument();
  });

  it('should render first source inline', () => {
    const content = 'Only using first source {{SOURCE_0}} here.';

    render(
      <MarkdownWithSources
        content={content}
        sources={mockSources}
        speakers={mockSpeakers}
        conversationId="test-conv"
        {...mockCallbacks}
      />
    );

    // First source should be rendered as TimestampLink
    expect(screen.getByText('0:01')).toBeInTheDocument();
    expect(screen.getByText('John Doe')).toBeInTheDocument();
  });

  it('should handle out-of-range source indices gracefully', () => {
    const content = 'Bad source {{SOURCE_99}} here.';

    render(
      <MarkdownWithSources
        content={content}
        sources={mockSources}
        speakers={mockSpeakers}
        conversationId="test-conv"
        {...mockCallbacks}
      />
    );

    // The text includes the full sentence
    expect(screen.getByText(/Bad source \[Source unavailable\] here/)).toBeInTheDocument();
  });

  it('should render both sources inline when referenced', () => {
    const content = 'First {{SOURCE_0}} and second {{SOURCE_1}} sources.';

    render(
      <MarkdownWithSources
        content={content}
        sources={mockSources}
        speakers={mockSpeakers}
        conversationId="test-conv"
        {...mockCallbacks}
      />
    );

    // Both sources should be rendered
    expect(screen.getByText('0:01')).toBeInTheDocument();
    expect(screen.getByText('0:02')).toBeInTheDocument();
  });

  it('should support GFM strikethrough', () => {
    const content = '~~crossed out~~';

    render(
      <MarkdownWithSources
        content={content}
        sources={[]}
        speakers={mockSpeakers}
        conversationId="test-conv"
        {...mockCallbacks}
      />
    );

    const strikethrough = screen.getByText('crossed out');
    expect(strikethrough).toHaveClass('line-through');
  });

  it('should handle multiple inline sources in same paragraph', () => {
    const content = 'See {{SOURCE_0}} and also {{SOURCE_1}} for context.';

    render(
      <MarkdownWithSources
        content={content}
        sources={mockSources}
        speakers={mockSpeakers}
        conversationId="test-conv"
        {...mockCallbacks}
      />
    );

    // Both timestamps should be rendered inline
    expect(screen.getByText('0:01')).toBeInTheDocument();
    expect(screen.getByText('0:02')).toBeInTheDocument();
  });

  it('should preserve bold formatting around inline sources', () => {
    // The key test: bold should survive source replacement
    const content = '**Important:** see this {{SOURCE_0}} for proof.';

    render(
      <MarkdownWithSources
        content={content}
        sources={mockSources}
        speakers={mockSpeakers}
        conversationId="test-conv"
        {...mockCallbacks}
      />
    );

    // Bold text should be rendered with strong element
    const boldText = screen.getByText('Important:');
    expect(boldText.tagName.toLowerCase()).toBe('strong');

    // Source should also be rendered
    expect(screen.getByText('0:01')).toBeInTheDocument();
  });

  it('should preserve links around inline sources', () => {
    const content = 'Read [the docs](https://example.com) and see {{SOURCE_0}} for details.';

    render(
      <MarkdownWithSources
        content={content}
        sources={mockSources}
        speakers={mockSpeakers}
        conversationId="test-conv"
        {...mockCallbacks}
      />
    );

    // Link should be preserved
    const link = screen.getByText('the docs');
    expect(link).toHaveAttribute('href', 'https://example.com');

    // Source should also be rendered
    expect(screen.getByText('0:01')).toBeInTheDocument();
  });

  it('should preserve formatting when source is inside bold text', () => {
    // Edge case: source marker directly inside bold
    const content = '**Bold with source {{SOURCE_0}} inside.**';

    render(
      <MarkdownWithSources
        content={content}
        sources={mockSources}
        speakers={mockSpeakers}
        conversationId="test-conv"
        {...mockCallbacks}
      />
    );

    // The TimestampLink should render
    expect(screen.getByText('0:01')).toBeInTheDocument();

    // And "Bold with source" should be bold
    const boldStart = screen.getByText(/Bold with source/);
    // The parent or ancestor should be a strong element
    expect(boldStart.closest('strong') || boldStart.tagName.toLowerCase() === 'strong').toBeTruthy();
  });

  it('should strip markdown images for security', () => {
    const content = 'Some text ![alt text](https://example.com/image.png) more text.';

    render(
      <MarkdownWithSources
        content={content}
        sources={[]}
        speakers={mockSpeakers}
        conversationId="test-conv"
        {...mockCallbacks}
      />
    );

    // Image should NOT be rendered
    const images = document.querySelectorAll('img');
    expect(images.length).toBe(0);

    // The surrounding text should still be there
    expect(screen.getByText(/Some text/)).toBeInTheDocument();
    expect(screen.getByText(/more text/)).toBeInTheDocument();
  });

  it('should strip images when mixed with other content', () => {
    const content = '# Heading\n\n![image](https://evil.com/tracker.gif)\n\nParagraph with **bold**.';

    render(
      <MarkdownWithSources
        content={content}
        sources={[]}
        speakers={mockSpeakers}
        conversationId="test-conv"
        {...mockCallbacks}
      />
    );

    // Image should NOT be rendered
    expect(document.querySelectorAll('img').length).toBe(0);

    // But heading and bold should be preserved
    expect(screen.getByText('Heading')).toHaveClass('text-lg', 'font-bold');
    expect(screen.getByText('bold').tagName.toLowerCase()).toBe('strong');
  });
});
