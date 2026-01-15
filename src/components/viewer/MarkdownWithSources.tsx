/**
 * MarkdownWithSources Component
 *
 * Renders markdown content with inline timestamp source buttons.
 * Replaces {{SOURCE_n}} placeholders with clickable TimestampLink components.
 *
 * Features:
 * - Full markdown support (bold, italic, lists, code blocks, headings, quotes, links)
 * - GitHub Flavored Markdown (tables, strikethrough, task lists)
 * - Inline source replacement for {{SOURCE_n}} tokens
 * - Safe rendering (no dangerous HTML like <img>, <iframe>)
 * - Accessible code blocks with overflow scroll
 * - Returns unconsumed sources for fallback display
 *
 * Implementation Note:
 * We use AST-preserving replacement via transformChildren() rather than
 * extractText() + string manipulation. This ensures markdown formatting
 * (bold, links, etc.) survives even when {{SOURCE_n}} placeholders
 * appear in the same paragraph.
 */

import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Components } from 'react-markdown';
import { TimestampLink } from './TimestampLink';
import { Speaker } from '@/config/types';

export interface TimestampSource {
  segmentIndex: number;
  segmentId: string;
  startMs: number;
  speaker?: string;
}

export interface MarkdownWithSourcesProps {
  /** Markdown content with optional {{SOURCE_n}} placeholders */
  content: string;
  /** Array of timestamp sources (0-indexed) */
  sources: TimestampSource[];
  /** Speaker lookup for names */
  speakers: Record<string, Speaker>;
  /** Conversation ID for analytics */
  conversationId: string;
  /** Callback to seek audio */
  onSeek?: (timeMs: number) => void;
  /** Callback to trigger playback */
  onPlay?: () => void;
  /** Callback to set highlighted segment */
  onHighlight?: (segmentId: string | null) => void;
  /** Callback to receive unconsumed sources */
  onUnconsumedSources?: (sources: TimestampSource[]) => void;
}

interface ProcessedContent {
  /** Content with [segment N] replaced by unique markers */
  processedContent: string;
  /** Set of segment indices that were consumed (matched to sources) */
  consumedSegmentIndices: Set<number>;
}

/**
 * Expand comma-separated segment lists into individual references.
 * e.g. "[segment 3, segment 4, segment 9]" -> "[segment 3] [segment 4] [segment 9]"
 *
 * LLMs sometimes output grouped citations - this normalizes them for parsing.
 */
function expandSegmentLists(content: string): string {
  // Match [segment N, segment M, ...] patterns (comma-separated)
  const listPattern = /\[segment\s+\d+(?:\s*,\s*segment\s+\d+)+\]/gi;

  return content.replace(listPattern, (match) => {
    const numbers = match.match(/\d+/g);
    if (numbers) {
      return numbers.map(n => `[segment ${n}]`).join(' ');
    }
    return match;
  });
}

/**
 * Pre-process content to track which sources are used inline.
 * Replaces [segment N] with §§SEGMENT_n§§ markers (markdown won't process §).
 * Uses segmentIndex to match sources, not array position.
 */
function preprocessContent(content: string, sources: TimestampSource[]): ProcessedContent {
  const consumedSegmentIndices = new Set<number>();
  // Build a set of valid segment indices from sources
  const validSegmentIndices = new Set(sources.map(s => s.segmentIndex));

  // First expand comma-separated lists: [segment 3, segment 4] -> [segment 3] [segment 4]
  const expandedContent = expandSegmentLists(content);

  // Pattern matches [segment N] or [Segment N] (case insensitive)
  const segmentPattern = /\[segment\s+(\d+)\]/gi;

  const processedContent = expandedContent.replace(segmentPattern, (match, indexStr) => {
    const segmentIndex = parseInt(indexStr, 10);
    if (validSegmentIndices.has(segmentIndex)) {
      consumedSegmentIndices.add(segmentIndex);
      return `§§SEGMENT_${segmentIndex}§§`;
    }
    // Segment not in sources - leave as-is (might be invalid citation)
    return match;
  });

  return { processedContent, consumedSegmentIndices };
}

/**
 * Context for source replacement - passed down through transformChildren.
 * Avoids prop drilling while keeping the transform function pure-ish.
 */
interface SourceContext {
  /** Map from segment index to source data */
  sourcesByIndex: Map<number, TimestampSource>;
  speakers: Record<string, Speaker>;
  conversationId: string;
  onSeek?: (timeMs: number) => void;
  onPlay?: () => void;
  onHighlight?: (segmentId: string | null) => void;
}

/**
 * Recursively transform React children, replacing §§SEGMENT_n§§ markers
 * in text nodes with TimestampLink components while preserving the
 * structure of other elements (bold, links, etc.).
 *
 * The magic here: we only touch text nodes. Everything else passes through
 * unchanged, so <strong>bold text [segment 5]</strong> becomes
 * <strong>bold text <TimestampLink/></strong> instead of losing the bold.
 */
function transformChildren(
  children: React.ReactNode,
  ctx: SourceContext,
  keyPrefix = ''
): React.ReactNode {
  if (children === null || children === undefined) {
    return children;
  }

  // Plain string - split by markers and replace
  if (typeof children === 'string') {
    if (!children.includes('§§SEGMENT_')) {
      return children;
    }
    return splitAndReplace(children, ctx, keyPrefix);
  }

  // Numbers pass through
  if (typeof children === 'number') {
    return children;
  }

  // Arrays - transform each element
  if (Array.isArray(children)) {
    return children.map((child, idx) =>
      transformChildren(child, ctx, `${keyPrefix}-${idx}`)
    );
  }

  // React elements - clone with transformed children
  if (React.isValidElement(children)) {
    const element = children as React.ReactElement<{ children?: React.ReactNode }>;
    if (element.props.children !== undefined) {
      return React.cloneElement(
        element,
        { key: element.key ?? `${keyPrefix}-el` },
        transformChildren(element.props.children, ctx, `${keyPrefix}-ch`)
      );
    }
    return children;
  }

  // Fallback for other types (symbols, etc.)
  return children;
}

/**
 * Split a text string by §§SEGMENT_n§§ markers and return an array
 * of text fragments and TimestampLink components.
 */
function splitAndReplace(
  text: string,
  ctx: SourceContext,
  keyPrefix: string
): React.ReactNode[] {
  const parts = text.split(/(§§SEGMENT_\d+§§)/);

  return parts.map((part, idx) => {
    const segmentMatch = part.match(/^§§SEGMENT_(\d+)§§$/);
    if (segmentMatch) {
      const segmentIndex = parseInt(segmentMatch[1], 10);
      const source = ctx.sourcesByIndex.get(segmentIndex);
      if (!source) {
        // This shouldn't happen if preprocessContent worked correctly
        return <span key={`${keyPrefix}-seg-${idx}`}>[segment {segmentIndex}]</span>;
      }

      const speaker = source.speaker ? ctx.speakers[source.speaker] : null;
      const speakerName = speaker?.displayName || source.speaker || 'Unknown';

      return (
        <TimestampLink
          key={`${keyPrefix}-seg-${idx}`}
          segmentId={source.segmentId}
          startMs={source.startMs}
          speakerName={speakerName}
          conversationId={ctx.conversationId}
          analyticsSource="chat"
          onSeek={ctx.onSeek}
          onPlay={ctx.onPlay}
          onHighlight={ctx.onHighlight}
          autoPlay={true}
        />
      );
    }
    // Empty strings can be skipped
    if (part === '') return null;
    return <React.Fragment key={`${keyPrefix}-txt-${idx}`}>{part}</React.Fragment>;
  }).filter(Boolean);
}

/**
 * MarkdownWithSources - renders markdown with inline timestamp sources
 */
export const MarkdownWithSources: React.FC<MarkdownWithSourcesProps> = ({
  content,
  sources,
  speakers,
  conversationId,
  onSeek,
  onPlay,
  onHighlight,
  onUnconsumedSources
}) => {
  // Build map from segment index to source for O(1) lookup
  const sourcesByIndex = useMemo(() => {
    const map = new Map<number, TimestampSource>();
    for (const source of sources) {
      map.set(source.segmentIndex, source);
    }
    return map;
  }, [sources]);

  const { processedContent, consumedSegmentIndices } = useMemo(
    () => preprocessContent(content, sources),
    [content, sources]
  );

  // Build source context once for the transform function
  const sourceCtx: SourceContext = useMemo(() => ({
    sourcesByIndex,
    speakers,
    conversationId,
    onSeek,
    onPlay,
    onHighlight
  }), [sourcesByIndex, speakers, conversationId, onSeek, onPlay, onHighlight]);

  // Custom component renderers for markdown elements
  // Uses transformChildren to preserve formatting while replacing source markers
  const components: Components = useMemo(() => ({
    // Paragraphs - transform children to replace source markers
    p: ({ children }) => (
      <p className="mb-3 last:mb-0">
        {transformChildren(children, sourceCtx, 'p')}
      </p>
    ),

    // List items - transform children to replace source markers
    li: ({ children }) => (
      <li className="ml-4">
        {transformChildren(children, sourceCtx, 'li')}
      </li>
    ),

    // Code - inline or block based on className presence
    // Block code (fenced with ```) gets className="language-xxx"
    // Inline code (single backticks) has no className
    code: ({ className, children }) => {
      const isBlock = className?.startsWith('language-');
      if (isBlock) {
        return (
          <code className="block bg-slate-100 rounded p-2 overflow-x-auto text-xs font-mono my-2">
            {children}
          </code>
        );
      }
      return (
        <code className="bg-slate-100 rounded px-1 py-0.5 text-xs font-mono">
          {children}
        </code>
      );
    },

    // Pre-formatted blocks - minimal wrapper since code handles styling
    pre: ({ children }) => (
      <pre className="my-2">
        {children}
      </pre>
    ),

    // Headings - size hierarchy (transform children for source replacement)
    h1: ({ children }) => (
      <h1 className="text-lg font-bold mb-2 mt-3">
        {transformChildren(children, sourceCtx, 'h1')}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-base font-bold mb-2 mt-3">
        {transformChildren(children, sourceCtx, 'h2')}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-sm font-bold mb-2 mt-2">
        {transformChildren(children, sourceCtx, 'h3')}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className="text-sm font-semibold mb-1 mt-2">
        {transformChildren(children, sourceCtx, 'h4')}
      </h4>
    ),
    h5: ({ children }) => (
      <h5 className="text-xs font-semibold mb-1 mt-2">
        {transformChildren(children, sourceCtx, 'h5')}
      </h5>
    ),
    h6: ({ children }) => (
      <h6 className="text-xs font-semibold mb-1 mt-1">
        {transformChildren(children, sourceCtx, 'h6')}
      </h6>
    ),

    // Lists
    ul: ({ children }) => <ul className="list-disc pl-5 mb-3 space-y-1">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-5 mb-3 space-y-1">{children}</ol>,

    // Block quotes - transform children
    blockquote: ({ children }) => (
      <blockquote className="border-l-4 border-slate-300 pl-3 italic text-slate-600 my-2">
        {transformChildren(children, sourceCtx, 'bq')}
      </blockquote>
    ),

    // Horizontal rules
    hr: () => <hr className="border-t border-slate-200 my-3" />,

    // Links - blue with underline on hover (transform children)
    a: ({ href, children }) => (
      <a
        href={href}
        className="text-blue-600 hover:underline"
        target="_blank"
        rel="noopener noreferrer"
      >
        {transformChildren(children, sourceCtx, 'a')}
      </a>
    ),

    // Images - explicitly disallowed for security
    // Returns null to strip images entirely from rendered output
    img: () => null,

    // Tables (GFM)
    table: ({ children }) => (
      <table className="border-collapse border border-slate-300 my-2 text-xs">
        {children}
      </table>
    ),
    th: ({ children }) => (
      <th className="border border-slate-300 px-2 py-1 bg-slate-100 font-semibold">
        {transformChildren(children, sourceCtx, 'th')}
      </th>
    ),
    td: ({ children }) => (
      <td className="border border-slate-300 px-2 py-1">
        {transformChildren(children, sourceCtx, 'td')}
      </td>
    ),

    // Strong/emphasis - transform children for nested source markers
    strong: ({ children }) => (
      <strong className="font-semibold">
        {transformChildren(children, sourceCtx, 'strong')}
      </strong>
    ),
    em: ({ children }) => (
      <em className="italic">
        {transformChildren(children, sourceCtx, 'em')}
      </em>
    ),

    // Strikethrough (GFM)
    del: ({ children }) => (
      <del className="line-through text-slate-500">
        {transformChildren(children, sourceCtx, 'del')}
      </del>
    ),
  }), [sourceCtx]);

  // Calculate unconsumed sources and notify parent via callback
  // Filter sources whose segmentIndex wasn't referenced in the content
  const unconsumedSources = useMemo(() => {
    return sources.filter(s => !consumedSegmentIndices.has(s.segmentIndex));
  }, [sources, consumedSegmentIndices]);

  // Track previous unconsumed sources to avoid infinite loops
  const prevUnconsumedRef = React.useRef<string>('');

  // Notify parent component of unconsumed sources (only when actually changed)
  React.useEffect(() => {
    if (onUnconsumedSources) {
      // Compare by stringified value to detect actual changes
      const currentKey = JSON.stringify(unconsumedSources.map(s => s.segmentId));
      if (currentKey !== prevUnconsumedRef.current) {
        prevUnconsumedRef.current = currentKey;
        onUnconsumedSources(unconsumedSources);
      }
    }
  }, [unconsumedSources, onUnconsumedSources]);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={components}
      // Disable HTML rendering for security (react-markdown does this by default)
      skipHtml={true}
    >
      {processedContent}
    </ReactMarkdown>
  );
};
