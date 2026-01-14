/**
 * CostVerificationBadge - Shows cost variance status for a metric
 *
 * Recomputes stored cost against current pricing and displays:
 * - ✓ (green) for match (<1% variance)
 * - ⚠️ (yellow) for minor variance (1-5%)
 * - ❌ (red) for significant variance (>5%)
 *
 * Memoized to avoid redundant recalculation on every render.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { cn } from '@/utils';
import {
  ProcessingMetric,
  ChatMetric,
  recalculateCostWithCurrentPricing,
  VarianceStatus,
  formatUsd
} from '@/services/metricsService';
import { CheckCircle2, AlertTriangle, XCircle, Loader2 } from 'lucide-react';

interface CostVerificationBadgeProps {
  metric: ProcessingMetric | ChatMetric;
  showDetails?: boolean;  // Show variance details on hover
  className?: string;
}

export const CostVerificationBadge: React.FC<CostVerificationBadgeProps> = ({
  metric,
  showDetails = true,
  className
}) => {
  const [loading, setLoading] = useState(true);
  const [verification, setVerification] = useState<{
    originalUsd: number;
    recalculatedUsd: number;
    variance: number;
    variancePercent: number;
    status: VarianceStatus;
  } | null>(null);

  // Memoize the metric to avoid recalculating when parent re-renders
  const metricKey = useMemo(() => {
    if ('type' in metric && metric.type === 'chat') {
      return `chat-${metric.conversationId}-${metric.timestamp}`;
    }
    return `processing-${metric.conversationId}-${metric.timestamp}`;
  }, [metric]);

  useEffect(() => {
    let cancelled = false;

    const verify = async () => {
      setLoading(true);
      try {
        const result = await recalculateCostWithCurrentPricing(metric);
        if (!cancelled) {
          setVerification(result);
          setLoading(false);
        }
      } catch (error) {
        console.error('[CostVerificationBadge] Verification failed:', error);
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    verify();

    return () => {
      cancelled = true;
    };
  }, [metricKey, metric]);

  if (loading) {
    return (
      <span className={cn('inline-flex items-center text-slate-400', className)}>
        <Loader2 size={14} className="animate-spin" />
      </span>
    );
  }

  if (!verification) {
    return (
      <span className={cn('inline-flex items-center text-slate-300', className)}>
        -
      </span>
    );
  }

  // Determine badge appearance based on status
  const getBadgeConfig = (status: VarianceStatus) => {
    switch (status) {
      case 'match':
        return {
          icon: CheckCircle2,
          color: 'text-green-600',
          bg: 'bg-green-50',
          border: 'border-green-200'
        };
      case 'minor':
        return {
          icon: AlertTriangle,
          color: 'text-amber-600',
          bg: 'bg-amber-50',
          border: 'border-amber-200'
        };
      case 'significant':
        return {
          icon: XCircle,
          color: 'text-red-600',
          bg: 'bg-red-50',
          border: 'border-red-200'
        };
    }
  };

  const config = getBadgeConfig(verification.status);
  const Icon = config.icon;

  // Format variance for display
  const varianceDisplay = verification.variance >= 0
    ? `+${formatUsd(verification.variance)}`
    : formatUsd(verification.variance);

  // Show percentage with sign
  const percentDisplay = verification.variancePercent >= 0
    ? `+${verification.variancePercent.toFixed(1)}%`
    : `${verification.variancePercent.toFixed(1)}%`;

  return (
    <div className={cn('inline-flex items-center gap-1.5 group relative', className)}>
      <span className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border',
        config.color,
        config.bg,
        config.border
      )}>
        <Icon size={12} className="mr-1" />
        {percentDisplay}
      </span>

      {/* Hover details tooltip */}
      {showDetails && (
        <div className={cn(
          'absolute z-10 invisible group-hover:visible',
          'bottom-full mb-2 right-0',
          'bg-slate-900 text-white text-xs rounded-lg shadow-lg',
          'px-3 py-2 whitespace-nowrap'
        )}>
          <div className="space-y-1">
            <div className="flex justify-between gap-4">
              <span className="text-slate-400">Original:</span>
              <span className="font-mono">{formatUsd(verification.originalUsd)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-slate-400">Current Pricing:</span>
              <span className="font-mono">{formatUsd(verification.recalculatedUsd)}</span>
            </div>
            <div className="flex justify-between gap-4 border-t border-slate-700 pt-1">
              <span className="text-slate-400">Variance:</span>
              <span className={cn(
                'font-mono font-medium',
                verification.variance > 0 ? 'text-red-300' : verification.variance < 0 ? 'text-green-300' : ''
              )}>
                {varianceDisplay} ({verification.variancePercent.toFixed(2)}%)
              </span>
            </div>
          </div>
          {/* Tooltip arrow */}
          <div className="absolute top-full right-4 w-0 h-0 border-4 border-transparent border-t-slate-900" />
        </div>
      )}
    </div>
  );
};
