/**
 * JobDetail - Detailed view of a single processing job
 *
 * Accessible at `/admin/jobs/:metricId`
 * Shows:
 * - Timing breakdown with visual bars
 * - Per-call token counts
 * - Pricing snapshot used
 * - Replicate prediction links
 * - Estimated vs Current cost comparison
 */

import React from 'react';
import { Button } from '../components/Button';
import { ArrowLeft, Clock, Zap, DollarSign, ExternalLink, CheckCircle2, XCircle } from 'lucide-react';
import { ProcessingMetric, formatDuration, formatUsd } from '../services/metricsService';
import { CostVerificationBadge } from '../components/metrics/CostVerificationBadge';

interface JobDetailProps {
  metric: ProcessingMetric;
  onBack: () => void;
}

export const JobDetail: React.FC<JobDetailProps> = ({ metric, onBack }) => {
  // Calculate timing percentages for visual bars
  const totalTime = metric.timingMs.total;
  const timingBreakdown = [
    { label: 'Download', value: metric.timingMs.download, color: 'bg-blue-500' },
    { label: 'WhisperX', value: metric.timingMs.whisperx, color: 'bg-purple-500' },
    { label: 'Build Segments', value: metric.timingMs.buildSegments, color: 'bg-cyan-500' },
    { label: 'Gemini Analysis', value: metric.timingMs.gemini, color: 'bg-green-500' },
    { label: 'Speaker Correction', value: metric.timingMs.speakerCorrection, color: 'bg-amber-500' },
    { label: 'Transform', value: metric.timingMs.transform, color: 'bg-orange-500' },
    { label: 'Firestore', value: metric.timingMs.firestore, color: 'bg-red-500' }
  ];

  const formatTimestamp = (timestamp: { toDate?: () => Date } | Date) => {
    const date = 'toDate' in timestamp ? timestamp.toDate() : timestamp;
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6 md:p-12">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <Button variant="ghost" onClick={onBack} className="gap-2">
            <ArrowLeft size={18} />
            Back
          </Button>
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-slate-900">Job Details</h1>
            <p className="text-sm text-slate-500 font-mono mt-1">
              {metric.conversationId}
            </p>
          </div>
          <div>
            {metric.status === 'success' ? (
              <div className="flex items-center gap-2 text-green-700 bg-green-50 px-3 py-1.5 rounded-lg border border-green-200">
                <CheckCircle2 size={16} />
                <span className="text-sm font-medium">Success</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-red-700 bg-red-50 px-3 py-1.5 rounded-lg border border-red-200">
                <XCircle size={16} />
                <span className="text-sm font-medium">Failed</span>
              </div>
            )}
          </div>
        </div>

        {/* Overview Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <div className="flex items-center gap-2 text-slate-500 text-sm mb-1">
              <Clock size={14} />
              Total Time
            </div>
            <div className="text-xl font-semibold text-slate-900">
              {formatDuration(totalTime)}
            </div>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <div className="flex items-center gap-2 text-slate-500 text-sm mb-1">
              <Zap size={14} />
              Audio Duration
            </div>
            <div className="text-xl font-semibold text-slate-900">
              {formatDuration(metric.durationMs)}
            </div>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <div className="flex items-center gap-2 text-slate-500 text-sm mb-1">
              <DollarSign size={14} />
              Estimated Cost
            </div>
            <div className="text-xl font-semibold text-slate-900">
              {metric.estimatedCost ? formatUsd(metric.estimatedCost.totalUsd) : '-'}
            </div>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <div className="flex items-center gap-2 text-slate-500 text-sm mb-1">
              Timestamp
            </div>
            <div className="text-sm font-medium text-slate-900">
              {formatTimestamp(metric.timestamp)}
            </div>
          </div>
        </div>

        {/* Timing Breakdown */}
        <div className="bg-white rounded-lg border border-slate-200 p-6 mb-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">Processing Timeline</h2>
          <div className="space-y-3">
            {timingBreakdown.map((item) => {
              const percentage = totalTime > 0 ? (item.value / totalTime) * 100 : 0;
              return (
                <div key={item.label}>
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-sm text-slate-700">{item.label}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-900">
                        {formatDuration(item.value)}
                      </span>
                      <span className="text-xs text-slate-400">
                        {percentage.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                  <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                    <div
                      className={`h-full ${item.color} transition-all duration-300`}
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* LLM Usage */}
        {metric.llmUsage && (
          <div className="bg-white rounded-lg border border-slate-200 p-6 mb-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">LLM Usage</h2>
            <div className="space-y-4">
              {/* Gemini Analysis */}
              {metric.llmUsage.geminiAnalysis && (
                <div className="border-b border-slate-100 pb-4 last:border-0 last:pb-0">
                  <h3 className="text-sm font-medium text-slate-700 mb-2">
                    Gemini Analysis ({metric.llmUsage.geminiAnalysis.model})
                  </h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-slate-500">Input Tokens:</span>
                      <span className="ml-2 font-mono text-slate-900">
                        {metric.llmUsage.geminiAnalysis.inputTokens.toLocaleString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500">Output Tokens:</span>
                      <span className="ml-2 font-mono text-slate-900">
                        {metric.llmUsage.geminiAnalysis.outputTokens.toLocaleString()}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Speaker Correction */}
              {metric.llmUsage.geminiSpeakerCorrection && (
                <div className="border-b border-slate-100 pb-4 last:border-0 last:pb-0">
                  <h3 className="text-sm font-medium text-slate-700 mb-2">
                    Speaker Correction ({metric.llmUsage.geminiSpeakerCorrection.model})
                  </h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-slate-500">Input Tokens:</span>
                      <span className="ml-2 font-mono text-slate-900">
                        {metric.llmUsage.geminiSpeakerCorrection.inputTokens.toLocaleString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500">Output Tokens:</span>
                      <span className="ml-2 font-mono text-slate-900">
                        {metric.llmUsage.geminiSpeakerCorrection.outputTokens.toLocaleString()}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* WhisperX */}
              {metric.llmUsage.whisperx && (
                <div className="border-b border-slate-100 pb-4 last:border-0 last:pb-0">
                  <h3 className="text-sm font-medium text-slate-700 mb-2">
                    WhisperX ({metric.llmUsage.whisperx.model})
                  </h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-slate-500">Compute Time:</span>
                      <span className="ml-2 font-mono text-slate-900">
                        {metric.llmUsage.whisperx.computeTimeSeconds.toFixed(2)}s
                      </span>
                    </div>
                    {metric.llmUsage.whisperx.predictionId && (
                      <div>
                        <a
                          href={`https://replicate.com/p/${metric.llmUsage.whisperx.predictionId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 transition-colors"
                        >
                          View on Replicate
                          <ExternalLink size={12} />
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Note: Diarization is now included in WhisperX (single Replicate model) */}
            </div>
          </div>
        )}

        {/* Pricing Snapshot */}
        {metric.pricingSnapshot && (
          <div className="bg-white rounded-lg border border-slate-200 p-6 mb-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">Pricing Snapshot</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-slate-500">Captured At:</span>
                <span className="ml-2 text-slate-900">
                  {formatTimestamp(metric.pricingSnapshot.capturedAt)}
                </span>
              </div>
              {metric.pricingSnapshot.rates?.geminiInputPerMillion !== undefined && (
                <div>
                  <span className="text-slate-500">Gemini Input:</span>
                  <span className="ml-2 font-mono text-slate-900">
                    ${metric.pricingSnapshot.rates.geminiInputPerMillion}/M tokens
                  </span>
                </div>
              )}
              {metric.pricingSnapshot.rates?.geminiOutputPerMillion !== undefined && (
                <div>
                  <span className="text-slate-500">Gemini Output:</span>
                  <span className="ml-2 font-mono text-slate-900">
                    ${metric.pricingSnapshot.rates.geminiOutputPerMillion}/M tokens
                  </span>
                </div>
              )}
              {metric.pricingSnapshot.rates?.whisperxPerSecond !== undefined && (
                <div>
                  <span className="text-slate-500">WhisperX:</span>
                  <span className="ml-2 font-mono text-slate-900">
                    ${metric.pricingSnapshot.rates.whisperxPerSecond}/second
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Cost Comparison */}
        {metric.estimatedCost && (
          <div className="bg-white rounded-lg border border-slate-200 p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">Cost Verification</h2>
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <div className="text-sm text-slate-500">
                  Compares original estimated cost against current pricing
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <div>
                    <span className="text-slate-600">Original:</span>
                    <span className="ml-2 font-mono font-medium text-slate-900">
                      {formatUsd(metric.estimatedCost.totalUsd)}
                    </span>
                  </div>
                  <div className="text-slate-300">vs</div>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-600">Current Pricing:</span>
                    <CostVerificationBadge metric={metric} showDetails={true} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Error Message (if failed) */}
        {metric.status === 'failed' && metric.errorMessage && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-6 mt-6">
            <h2 className="text-lg font-semibold text-red-900 mb-2">Error Details</h2>
            <p className="font-mono text-sm text-red-700">{metric.errorMessage}</p>
          </div>
        )}
      </div>
    </div>
  );
};
