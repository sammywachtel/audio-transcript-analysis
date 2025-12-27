/**
 * LLMUsageBreakdown - Pie/Donut chart showing LLM service cost breakdown
 *
 * Shows how costs are distributed across different AI services:
 * - Gemini Analysis
 * - Gemini Speaker Correction
 * - WhisperX Transcription
 * - Diarization (optional)
 */

import React from 'react';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  Legend
} from 'recharts';
import { cn } from '../../utils';
import { formatUsd } from '../../services/metricsService';

// Service colors
const SERVICE_COLORS: Record<string, string> = {
  'Gemini Analysis': '#3b82f6',        // blue-500
  'Gemini Speaker Correction': '#60a5fa', // blue-400
  'WhisperX': '#10b981',               // emerald-500
  'Diarization': '#f59e0b',            // amber-500
  'Other': '#94a3b8'                   // slate-400
};

interface LLMUsageData {
  geminiAnalysisUsd?: number;
  geminiSpeakerCorrectionUsd?: number;
  whisperxUsd?: number;
  diarizationUsd?: number;
}

interface LLMUsageBreakdownProps {
  data: LLMUsageData;
  title?: string;
  height?: number;
  showLegend?: boolean;
  className?: string;
}

export const LLMUsageBreakdown: React.FC<LLMUsageBreakdownProps> = ({
  data,
  title = 'Cost Breakdown by Service',
  height = 250,
  showLegend = true,
  className
}) => {
  // Transform data into pie chart format
  const chartData = [
    { name: 'Gemini Analysis', value: data.geminiAnalysisUsd || 0 },
    { name: 'Gemini Speaker Correction', value: data.geminiSpeakerCorrectionUsd || 0 },
    { name: 'WhisperX', value: data.whisperxUsd || 0 },
    { name: 'Diarization', value: data.diarizationUsd || 0 },
  ].filter(d => d.value > 0);

  const totalCost = chartData.reduce((sum, d) => sum + d.value, 0);

  if (chartData.length === 0 || totalCost === 0) {
    return (
      <div className={cn('bg-white rounded-lg border border-slate-200 p-4', className)}>
        {title && <h3 className="text-sm font-medium text-slate-700 mb-4">{title}</h3>}
        <div className="flex items-center justify-center text-slate-400" style={{ height }}>
          No cost data available
        </div>
      </div>
    );
  }

  // Custom label renderer
  const renderLabel = ({ name, percent }: { name: string; percent: number }) => {
    if (percent < 0.05) return null; // Hide tiny slices
    return `${(percent * 100).toFixed(0)}%`;
  };

  return (
    <div className={cn('bg-white rounded-lg border border-slate-200 p-4', className)}>
      {title && (
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-slate-700">{title}</h3>
          <span className="text-sm font-semibold text-slate-900">
            Total: {formatUsd(totalCost)}
          </span>
        </div>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie
            data={chartData}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            innerRadius={60}
            outerRadius={80}
            paddingAngle={2}
            label={renderLabel}
            labelLine={false}
          >
            {chartData.map((entry) => (
              <Cell
                key={entry.name}
                fill={SERVICE_COLORS[entry.name] || SERVICE_COLORS['Other']}
              />
            ))}
          </Pie>
          <Tooltip
            formatter={(value: number) => formatUsd(value)}
            contentStyle={{
              backgroundColor: 'white',
              border: '1px solid #e2e8f0',
              borderRadius: '8px',
              fontSize: '12px'
            }}
          />
          {showLegend && (
            <Legend
              layout="horizontal"
              align="center"
              verticalAlign="bottom"
              wrapperStyle={{ fontSize: '12px', paddingTop: '16px' }}
            />
          )}
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
};

/**
 * Alternative: Simple list breakdown (no chart)
 */
export const LLMUsageList: React.FC<LLMUsageBreakdownProps> = ({
  data,
  title = 'Cost Breakdown by Service',
  className
}) => {
  const items = [
    { name: 'Gemini Analysis', value: data.geminiAnalysisUsd || 0, color: SERVICE_COLORS['Gemini Analysis'] },
    { name: 'Gemini Speaker Correction', value: data.geminiSpeakerCorrectionUsd || 0, color: SERVICE_COLORS['Gemini Speaker Correction'] },
    { name: 'WhisperX', value: data.whisperxUsd || 0, color: SERVICE_COLORS['WhisperX'] },
    { name: 'Diarization', value: data.diarizationUsd || 0, color: SERVICE_COLORS['Diarization'] },
  ].filter(d => d.value > 0);

  const totalCost = items.reduce((sum, d) => sum + d.value, 0);

  return (
    <div className={cn('bg-white rounded-lg border border-slate-200 p-4', className)}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-slate-700">{title}</h3>
        <span className="text-sm font-semibold text-slate-900">
          {formatUsd(totalCost)}
        </span>
      </div>
      <div className="space-y-2">
        {items.map(item => (
          <div key={item.name} className="flex items-center justify-between">
            <div className="flex items-center">
              <div
                className="w-3 h-3 rounded-full mr-2"
                style={{ backgroundColor: item.color }}
              />
              <span className="text-sm text-slate-600">{item.name}</span>
            </div>
            <div className="flex items-center">
              <span className="text-sm font-medium text-slate-900 mr-2">
                {formatUsd(item.value)}
              </span>
              <span className="text-xs text-slate-400">
                ({((item.value / totalCost) * 100).toFixed(1)}%)
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
