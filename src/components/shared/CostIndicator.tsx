import React, { useState } from 'react';
import { DollarSign, Info } from 'lucide-react';
import { cn } from '@/utils';
import { formatUsd } from '../../services/metricsService';
import { EstimatedCost } from '../../services/metricsService';

interface CostIndicatorProps {
  cost: number | EstimatedCost;
  size?: 'sm' | 'md' | 'lg';
  showIcon?: boolean;
  showBreakdown?: boolean;
  className?: string;
}

/**
 * CostIndicator - Reusable cost display component
 *
 * Shows estimated or actual processing costs with color-coded thresholds:
 * - Green: $0 - $0.50
 * - Amber: $0.50 - $2.00
 * - Red: > $2.00
 *
 * Optional breakdown tooltip shows cost per service (Gemini, WhisperX, Diarization).
 */
export const CostIndicator: React.FC<CostIndicatorProps> = ({
  cost,
  size = 'md',
  showIcon = true,
  showBreakdown = true,
  className
}) => {
  const [showTooltip, setShowTooltip] = useState(false);

  // Extract total cost and breakdown
  const totalCost = typeof cost === 'number' ? cost : cost.totalUsd;
  const breakdown = typeof cost === 'object' ? cost : null;

  // Determine color based on threshold
  const getColorClass = () => {
    if (totalCost <= 0.50) {
      return 'text-emerald-700 bg-emerald-100 border-emerald-200';
    } else if (totalCost <= 2.00) {
      return 'text-amber-700 bg-amber-100 border-amber-200';
    } else {
      return 'text-red-700 bg-red-100 border-red-200';
    }
  };

  // Size variants
  const sizeClasses = {
    sm: 'text-xs px-2 py-0.5',
    md: 'text-sm px-2.5 py-1',
    lg: 'text-base px-3 py-1.5'
  };

  const iconSizes = {
    sm: 10,
    md: 14,
    lg: 16
  };

  return (
    <div className="relative inline-block">
      <div
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full font-medium border',
          getColorClass(),
          sizeClasses[size],
          showBreakdown && breakdown && 'cursor-help',
          className
        )}
        onMouseEnter={() => showBreakdown && breakdown && setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        {showIcon && <DollarSign size={iconSizes[size]} />}
        <span>{formatUsd(totalCost)}</span>
        {showBreakdown && breakdown && (
          <Info size={iconSizes[size]} className="opacity-60" />
        )}
      </div>

      {/* Breakdown Tooltip */}
      {showTooltip && breakdown && (
        <div
          className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 bg-slate-900 text-white text-xs rounded-lg p-3 shadow-xl animate-in fade-in slide-in-from-bottom-1 duration-150"
          role="tooltip"
        >
          <div className="font-semibold mb-2 pb-2 border-b border-slate-700">
            Cost Breakdown
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between">
              <span className="text-slate-300">Gemini Analysis:</span>
              <span className="font-mono">{formatUsd(breakdown.geminiUsd)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-300">WhisperX (incl. diarization):</span>
              <span className="font-mono">{formatUsd(breakdown.whisperxUsd)}</span>
            </div>
            <div className="flex justify-between pt-1.5 mt-1.5 border-t border-slate-700 font-semibold">
              <span>Total:</span>
              <span className="font-mono">{formatUsd(breakdown.totalUsd)}</span>
            </div>
          </div>
          {/* Tooltip arrow */}
          <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px">
            <div className="w-2 h-2 bg-slate-900 rotate-45"></div>
          </div>
        </div>
      )}
    </div>
  );
};
