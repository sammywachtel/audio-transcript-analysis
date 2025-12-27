/**
 * MetricsTable - Table component for displaying processing job history
 *
 * Shows a list of processing metrics with sortable columns,
 * status indicators, and expandable details.
 */

import React, { useState } from 'react';
import { cn } from '../../utils';
import { ProcessingMetric, formatDuration, formatUsd } from '../../services/metricsService';

interface MetricsTableProps {
  metrics: ProcessingMetric[];
  title?: string;
  showUserId?: boolean;  // Show userId column (for admin view)
  onRowClick?: (metric: ProcessingMetric) => void;
  className?: string;
}

export const MetricsTable: React.FC<MetricsTableProps> = ({
  metrics,
  title = 'Processing History',
  showUserId = false,
  onRowClick,
  className
}) => {
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  if (metrics.length === 0) {
    return (
      <div className={cn('bg-white rounded-lg border border-slate-200 p-4', className)}>
        {title && <h3 className="text-sm font-medium text-slate-700 mb-4">{title}</h3>}
        <div className="text-center text-slate-400 py-8">
          No processing jobs found
        </div>
      </div>
    );
  }

  const formatTimestamp = (timestamp: { toDate?: () => Date } | Date) => {
    const date = 'toDate' in timestamp ? timestamp.toDate() : timestamp;
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const handleRowClick = (metric: ProcessingMetric) => {
    if (onRowClick) {
      onRowClick(metric);
    } else {
      setExpandedRow(expandedRow === metric.conversationId ? null : metric.conversationId);
    }
  };

  return (
    <div className={cn('bg-white rounded-lg border border-slate-200 overflow-hidden', className)}>
      {title && (
        <div className="px-4 py-3 border-b border-slate-200">
          <h3 className="text-sm font-medium text-slate-700">{title}</h3>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                Status
              </th>
              {showUserId && (
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                  User ID
                </th>
              )}
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                Timestamp
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                Duration
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                Processing
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                Cost
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                Alignment
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {metrics.map((metric) => (
              <React.Fragment key={metric.conversationId}>
                <tr
                  onClick={() => handleRowClick(metric)}
                  className={cn(
                    'hover:bg-slate-50 cursor-pointer transition-colors',
                    expandedRow === metric.conversationId && 'bg-slate-50'
                  )}
                >
                  <td className="px-4 py-3">
                    <StatusBadge status={metric.status} />
                  </td>
                  {showUserId && (
                    <td className="px-4 py-3 text-slate-600 font-mono text-xs">
                      {metric.userId.slice(0, 8)}...
                    </td>
                  )}
                  <td className="px-4 py-3 text-slate-600">
                    {formatTimestamp(metric.timestamp)}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-600">
                    {formatDuration(metric.durationMs)}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-600">
                    {formatDuration(metric.timingMs?.total || 0)}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-slate-900">
                    {metric.estimatedCost ? formatUsd(metric.estimatedCost.totalUsd) : '-'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <AlignmentBadge status={metric.alignmentStatus} />
                  </td>
                </tr>

                {/* Expanded details row */}
                {expandedRow === metric.conversationId && (
                  <tr>
                    <td colSpan={showUserId ? 7 : 6} className="px-4 py-4 bg-slate-50">
                      <MetricDetails metric={metric} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/**
 * Status badge component
 */
const StatusBadge: React.FC<{ status: 'success' | 'failed' }> = ({ status }) => (
  <span className={cn(
    'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
    status === 'success'
      ? 'bg-green-100 text-green-800'
      : 'bg-red-100 text-red-800'
  )}>
    {status === 'success' ? '✓ Success' : '✗ Failed'}
  </span>
);

/**
 * Alignment status badge
 */
const AlignmentBadge: React.FC<{ status?: 'aligned' | 'fallback' }> = ({ status }) => {
  if (!status) return <span className="text-slate-300">-</span>;

  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
      status === 'aligned'
        ? 'bg-blue-100 text-blue-800'
        : 'bg-amber-100 text-amber-800'
    )}>
      {status === 'aligned' ? 'Aligned' : 'Fallback'}
    </span>
  );
};

/**
 * Expanded metric details
 */
const MetricDetails: React.FC<{ metric: ProcessingMetric }> = ({ metric }) => (
  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
    <div>
      <p className="text-slate-500 mb-1">Segments</p>
      <p className="font-medium text-slate-900">{metric.segmentCount}</p>
    </div>
    <div>
      <p className="text-slate-500 mb-1">Speakers</p>
      <p className="font-medium text-slate-900">{metric.speakerCount}</p>
    </div>
    <div>
      <p className="text-slate-500 mb-1">Topics</p>
      <p className="font-medium text-slate-900">{metric.topicCount}</p>
    </div>
    <div>
      <p className="text-slate-500 mb-1">Terms</p>
      <p className="font-medium text-slate-900">{metric.termCount}</p>
    </div>

    {metric.timingMs && (
      <>
        <div className="col-span-2 md:col-span-4 mt-2">
          <p className="text-slate-500 mb-1">Processing Breakdown</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span>Download: {formatDuration(metric.timingMs.download)}</span>
            <span>WhisperX: {formatDuration(metric.timingMs.whisperx)}</span>
            <span>Gemini: {formatDuration(metric.timingMs.gemini)}</span>
            <span>Speaker Correction: {formatDuration(metric.timingMs.speakerCorrection)}</span>
            <span>Transform: {formatDuration(metric.timingMs.transform)}</span>
            <span>Firestore: {formatDuration(metric.timingMs.firestore)}</span>
          </div>
        </div>
      </>
    )}

    {metric.llmUsage && (
      <div className="col-span-2 md:col-span-4 mt-2">
        <p className="text-slate-500 mb-1">LLM Usage</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {metric.llmUsage.geminiAnalysis && (
            <span>
              Gemini Analysis: {metric.llmUsage.geminiAnalysis.inputTokens.toLocaleString()} in /
              {metric.llmUsage.geminiAnalysis.outputTokens.toLocaleString()} out
            </span>
          )}
          {metric.llmUsage.whisperx && (
            <span>
              WhisperX: {metric.llmUsage.whisperx.computeTimeSeconds.toFixed(1)}s
            </span>
          )}
        </div>
      </div>
    )}

    {metric.errorMessage && (
      <div className="col-span-2 md:col-span-4 mt-2">
        <p className="text-slate-500 mb-1">Error</p>
        <p className="font-mono text-red-600 text-xs">{metric.errorMessage}</p>
      </div>
    )}
  </div>
);

/**
 * MetricsTableSkeleton - Loading placeholder
 */
export const MetricsTableSkeleton: React.FC<{ rows?: number; className?: string }> = ({
  rows = 5,
  className
}) => (
  <div className={cn('bg-white rounded-lg border border-slate-200 overflow-hidden animate-pulse', className)}>
    <div className="px-4 py-3 border-b border-slate-200">
      <div className="h-4 bg-slate-200 rounded w-1/4" />
    </div>
    <div className="divide-y divide-slate-100">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="px-4 py-3 flex gap-4">
          <div className="h-4 bg-slate-200 rounded w-16" />
          <div className="h-4 bg-slate-200 rounded w-24" />
          <div className="h-4 bg-slate-200 rounded flex-1" />
          <div className="h-4 bg-slate-200 rounded w-16" />
        </div>
      ))}
    </div>
  </div>
);
