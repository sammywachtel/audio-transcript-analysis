/**
 * TimeSeriesChart - Line/Area chart for daily metrics
 *
 * Renders time-series data with multiple optional series.
 * Uses Recharts under the hood but provides a simpler API.
 */

import React from 'react';
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend
} from 'recharts';
import { cn } from '../../utils';

// Color palette for multiple series - Tailwind-inspired
const CHART_COLORS = [
  '#3b82f6', // blue-500
  '#10b981', // emerald-500
  '#f59e0b', // amber-500
  '#ef4444', // red-500
  '#8b5cf6', // violet-500
  '#06b6d4', // cyan-500
];

interface DataPoint {
  date: string;  // X-axis label (YYYY-MM-DD or formatted)
  [key: string]: string | number;  // Dynamic series values
}

interface SeriesConfig {
  key: string;          // Key in data points
  name: string;         // Display name in legend
  color?: string;       // Override default color
  type?: 'line' | 'area';
}

interface TimeSeriesChartProps {
  data: DataPoint[];
  series: SeriesConfig[];
  title?: string;
  height?: number;
  showGrid?: boolean;
  showLegend?: boolean;
  formatValue?: (value: number) => string;
  formatDate?: (date: string) => string;
  className?: string;
}

export const TimeSeriesChart: React.FC<TimeSeriesChartProps> = ({
  data,
  series,
  title,
  height = 300,
  showGrid = true,
  showLegend = true,
  formatValue = (v) => v.toLocaleString(),
  formatDate = (d) => {
    // Format YYYY-MM-DD to shorter form
    const parts = d.split('-');
    if (parts.length === 3) {
      return `${parts[1]}/${parts[2]}`;
    }
    return d;
  },
  className
}) => {
  if (!data || data.length === 0) {
    return (
      <div className={cn('bg-white rounded-lg border border-slate-200 p-4', className)}>
        {title && <h3 className="text-sm font-medium text-slate-700 mb-4">{title}</h3>}
        <div className="flex items-center justify-center text-slate-400" style={{ height }}>
          No data available
        </div>
      </div>
    );
  }

  // Determine if we should use area or line chart based on series config
  const hasAreaSeries = series.some(s => s.type === 'area');
  const ChartComponent = hasAreaSeries ? AreaChart : LineChart;

  return (
    <div className={cn('bg-white rounded-lg border border-slate-200 p-4', className)}>
      {title && <h3 className="text-sm font-medium text-slate-700 mb-4">{title}</h3>}
      <ResponsiveContainer width="100%" height={height}>
        <ChartComponent data={data}>
          {showGrid && (
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          )}
          <XAxis
            dataKey="date"
            tickFormatter={formatDate}
            tick={{ fontSize: 12, fill: '#64748b' }}
            tickLine={false}
            axisLine={{ stroke: '#e2e8f0' }}
          />
          <YAxis
            tickFormatter={formatValue}
            tick={{ fontSize: 12, fill: '#64748b' }}
            tickLine={false}
            axisLine={{ stroke: '#e2e8f0' }}
            width={60}
          />
          <Tooltip
            formatter={(value: number, name: string) => [formatValue(value), name]}
            labelFormatter={(label) => `Date: ${label}`}
            contentStyle={{
              backgroundColor: 'white',
              border: '1px solid #e2e8f0',
              borderRadius: '8px',
              fontSize: '12px'
            }}
          />
          {showLegend && (
            <Legend
              wrapperStyle={{ fontSize: '12px' }}
            />
          )}
          {series.map((s, idx) => {
            const color = s.color || CHART_COLORS[idx % CHART_COLORS.length];
            if (s.type === 'area') {
              return (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.name}
                  stroke={color}
                  fill={color}
                  fillOpacity={0.1}
                  strokeWidth={2}
                />
              );
            }
            return (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.name}
                stroke={color}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            );
          })}
        </ChartComponent>
      </ResponsiveContainer>
    </div>
  );
};

/**
 * TimeSeriesChartSkeleton - Loading placeholder
 */
export const TimeSeriesChartSkeleton: React.FC<{ height?: number; className?: string }> = ({
  height = 300,
  className
}) => (
  <div className={cn('bg-white rounded-lg border border-slate-200 p-4 animate-pulse', className)}>
    <div className="h-4 bg-slate-200 rounded w-1/4 mb-4" />
    <div className="bg-slate-100 rounded" style={{ height }} />
  </div>
);
