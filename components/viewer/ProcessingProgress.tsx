import React from 'react';
import { ProcessingProgress as ProcessingProgressType, ProcessingStep } from '../../types';
import { Loader2, Upload, Mic, Brain, Activity, CheckCircle2, AlertCircle, Sparkles } from 'lucide-react';
import { cn } from '../../utils';

interface ProcessingProgressProps {
  progress?: ProcessingProgressType;
  compact?: boolean; // For use in list view vs. full view
}

/**
 * ProcessingProgress - Visual feedback for multi-stage audio processing
 *
 * Shows the current processing step with icons, progress bar, and percentage.
 * Gracefully handles missing data for backward compatibility with legacy records.
 *
 * Progress percentages by step:
 * - PENDING: 0%
 * - UPLOADING: 15%
 * - TRANSCRIBING: 40%
 * - ANALYZING: 60%
 * - ALIGNING: 85%
 * - FINALIZING: 95%
 * - COMPLETE: 100%
 * - FAILED: 0%
 */
export const ProcessingProgress: React.FC<ProcessingProgressProps> = ({ progress, compact = false }) => {
  // Fallback for legacy data without progressive status
  if (!progress) {
    return (
      <div className="flex items-center gap-2">
        <Loader2 size={16} className="text-blue-500 animate-spin" />
        <span className="text-xs text-blue-600 font-medium">Processing audio...</span>
      </div>
    );
  }

  const { currentStep, percentComplete, errorMessage } = progress;

  // Step configuration with icons, labels, and specific Tailwind classes
  const stepConfig: Record<ProcessingStep, {
    icon: typeof Loader2;
    label: string;
    textClass: string;
    bgClass: string;
    progressClass: string;
  }> = {
    [ProcessingStep.PENDING]: {
      icon: Loader2,
      label: 'Queued',
      textClass: 'text-slate-600',
      bgClass: 'bg-slate-100',
      progressClass: 'bg-slate-500'
    },
    [ProcessingStep.UPLOADING]: {
      icon: Upload,
      label: 'Uploading',
      textClass: 'text-blue-600',
      bgClass: 'bg-blue-100',
      progressClass: 'bg-blue-500'
    },
    [ProcessingStep.TRANSCRIBING]: {
      icon: Mic,
      label: 'Transcribing',
      textClass: 'text-purple-600',
      bgClass: 'bg-purple-100',
      progressClass: 'bg-purple-500'
    },
    [ProcessingStep.ANALYZING]: {
      icon: Brain,
      label: 'Analyzing',
      textClass: 'text-indigo-600',
      bgClass: 'bg-indigo-100',
      progressClass: 'bg-indigo-500'
    },
    [ProcessingStep.ALIGNING]: {
      icon: Activity,
      label: 'Aligning timestamps',
      textClass: 'text-violet-600',
      bgClass: 'bg-violet-100',
      progressClass: 'bg-violet-500'
    },
    [ProcessingStep.FINALIZING]: {
      icon: Sparkles,
      label: 'Finalizing',
      textClass: 'text-blue-600',
      bgClass: 'bg-blue-100',
      progressClass: 'bg-blue-500'
    },
    [ProcessingStep.COMPLETE]: {
      icon: CheckCircle2,
      label: 'Complete',
      textClass: 'text-emerald-600',
      bgClass: 'bg-emerald-100',
      progressClass: 'bg-emerald-500'
    },
    [ProcessingStep.FAILED]: {
      icon: AlertCircle,
      label: 'Failed',
      textClass: 'text-red-600',
      bgClass: 'bg-red-100',
      progressClass: 'bg-red-500'
    }
  };

  const config = stepConfig[currentStep];
  const Icon = config.icon;
  const isProcessing = ![ProcessingStep.COMPLETE, ProcessingStep.FAILED].includes(currentStep);

  if (compact) {
    // Compact view for Library list
    return (
      <div className="flex flex-col gap-2 min-w-0">
        <div className="flex items-center gap-2">
          <Icon
            size={14}
            className={cn(
              config.textClass,
              isProcessing && 'animate-spin'
            )}
          />
          <span className="text-xs font-medium text-slate-700">
            {config.label}
          </span>
          <span className={cn("text-xs", config.textClass)}>
            {percentComplete}%
          </span>
        </div>
        {/* Progress bar */}
        <div className="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              config.progressClass
            )}
            style={{ width: `${percentComplete}%` }}
          />
        </div>
        {errorMessage && (
          <p className="text-xs text-red-600 truncate" title={errorMessage}>
            {errorMessage}
          </p>
        )}
      </div>
    );
  }

  // Full view (future use in viewer page or detailed status)
  return (
    <div className="flex flex-col gap-3 p-4 bg-white rounded-lg border border-slate-200">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={cn(
            "w-10 h-10 rounded-lg flex items-center justify-center",
            config.bgClass
          )}>
            <Icon
              size={20}
              className={cn(
                config.textClass,
                isProcessing && 'animate-spin'
              )}
            />
          </div>
          <div>
            <h4 className="text-sm font-medium text-slate-900">{config.label}</h4>
            <p className="text-xs text-slate-500">Processing your audio</p>
          </div>
        </div>
        <div className={cn(
          "text-2xl font-bold",
          config.textClass
        )}>
          {percentComplete}%
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            config.progressClass
          )}
          style={{ width: `${percentComplete}%` }}
        />
      </div>

      {errorMessage && (
        <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 p-3 rounded-lg">
          <AlertCircle size={16} />
          <p className="text-xs">{errorMessage}</p>
        </div>
      )}
    </div>
  );
};
