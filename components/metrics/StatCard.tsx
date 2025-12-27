/**
 * StatCard - Displays a single statistic with label and optional trend
 *
 * A clean card component for displaying key metrics in dashboards.
 * Supports icons, trend indicators, and custom formatting.
 */

import React from 'react';
import { cn } from '../../utils';

interface StatCardProps {
  label: string;
  value: string | number;
  icon?: React.ReactNode;
  trend?: {
    value: number;      // Percentage change
    isPositive: boolean; // Whether increase is good
  };
  sublabel?: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export const StatCard: React.FC<StatCardProps> = ({
  label,
  value,
  icon,
  trend,
  sublabel,
  className,
  size = 'md'
}) => {
  const sizeStyles = {
    sm: 'p-3',
    md: 'p-4',
    lg: 'p-6'
  };

  const valueSizes = {
    sm: 'text-xl',
    md: 'text-2xl',
    lg: 'text-3xl'
  };

  return (
    <div className={cn(
      'bg-white rounded-lg border border-slate-200 shadow-sm',
      sizeStyles[size],
      className
    )}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm font-medium text-slate-500 mb-1">{label}</p>
          <p className={cn('font-semibold text-slate-900', valueSizes[size])}>
            {value}
          </p>
          {sublabel && (
            <p className="text-xs text-slate-400 mt-1">{sublabel}</p>
          )}
        </div>
        {icon && (
          <div className="text-slate-400 ml-2">
            {icon}
          </div>
        )}
      </div>

      {trend && (
        <div className={cn(
          'mt-2 flex items-center text-xs font-medium',
          trend.value >= 0
            ? (trend.isPositive ? 'text-green-600' : 'text-red-600')
            : (trend.isPositive ? 'text-red-600' : 'text-green-600')
        )}>
          <span className="mr-1">
            {trend.value >= 0 ? '↑' : '↓'}
          </span>
          <span>{Math.abs(trend.value).toFixed(1)}%</span>
          <span className="text-slate-400 ml-1">vs last period</span>
        </div>
      )}
    </div>
  );
};

/**
 * StatCardSkeleton - Loading placeholder for StatCard
 */
export const StatCardSkeleton: React.FC<{ className?: string }> = ({ className }) => (
  <div className={cn(
    'bg-white rounded-lg border border-slate-200 shadow-sm p-4 animate-pulse',
    className
  )}>
    <div className="h-4 bg-slate-200 rounded w-1/2 mb-2" />
    <div className="h-8 bg-slate-200 rounded w-3/4" />
  </div>
);
