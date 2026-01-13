import React from 'react';
import { ProcessingProgress as ProcessingProgressType, ProcessingStep, StepMeta } from '@/config/types';
import { Loader2, Upload, Mic, Brain, Activity, CheckCircle2, AlertCircle, Sparkles, Users, Search } from 'lucide-react';
import { cn } from '@/utils';

interface ProcessingProgressProps {
  progress?: ProcessingProgressType;
  compact?: boolean; // For use in list view vs. full view
}

// Category-based styling for dynamic progress display (StepMeta-driven)
const CATEGORY_STYLES: Record<StepMeta['category'], {
  textClass: string;
  bgClass: string;
  progressClass: string;
}> = {
  pending: {
    textClass: 'text-slate-600',
    bgClass: 'bg-slate-100',
    progressClass: 'bg-slate-500'
  },
  active: {
    textClass: 'text-blue-600',
    bgClass: 'bg-blue-100',
    progressClass: 'bg-blue-500'
  },
  success: {
    textClass: 'text-emerald-600',
    bgClass: 'bg-emerald-100',
    progressClass: 'bg-emerald-500'
  },
  error: {
    textClass: 'text-red-600',
    bgClass: 'bg-red-100',
    progressClass: 'bg-red-500'
  }
};

// Category-based icons for dynamic progress display
const CATEGORY_ICONS: Record<StepMeta['category'], typeof Loader2> = {
  pending: Loader2,
  active: Activity,
  success: CheckCircle2,
  error: AlertCircle
};

/**
 * Infer category from step for backward compatibility with legacy data
 * (when stepMeta is not present)
 */
function _inferCategory(step: ProcessingStep): StepMeta['category'] {
  switch (step) {
    case ProcessingStep.PENDING:
      return 'pending';
    case ProcessingStep.UPLOADING:
    case ProcessingStep.OPTIMIZING:
    case ProcessingStep.CHUNKING:
    case ProcessingStep.TRANSCRIBING:
    case ProcessingStep.ANALYZING:
    case ProcessingStep.ALIGNING:
    case ProcessingStep.FINALIZING:
      return 'active';
    case ProcessingStep.COMPLETE:
      return 'success';
    case ProcessingStep.FAILED:
      return 'error';
    default:
      return 'pending';
  }
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

  const { currentStep, percentComplete, errorMessage, stepMeta } = progress;

  // Legacy step configuration for backward compatibility (when stepMeta not present)
  // Preserves original per-step icons and multi-color styling
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
    [ProcessingStep.OPTIMIZING]: {
      icon: Activity,
      label: 'Optimizing Audio',
      textClass: 'text-teal-600',
      bgClass: 'bg-teal-100',
      progressClass: 'bg-teal-500'
    },
    [ProcessingStep.CHUNKING]: {
      icon: Activity,
      label: 'Chunking',
      textClass: 'text-orange-600',
      bgClass: 'bg-orange-100',
      progressClass: 'bg-orange-500'
    },
    [ProcessingStep.PRE_ANALYZING]: {
      icon: Search,
      label: 'Pre-analyzing',
      textClass: 'text-cyan-600',
      bgClass: 'bg-cyan-100',
      progressClass: 'bg-cyan-500'
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
    [ProcessingStep.REASSIGNING]: {
      icon: Users,
      label: 'Reassigning Speakers',
      textClass: 'text-amber-600',
      bgClass: 'bg-amber-100',
      progressClass: 'bg-amber-500'
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

  // Dynamic display logic: use stepMeta if present, fallback to legacy stepConfig
  const useDynamicDisplay = !!stepMeta;

  let label: string;
  let Icon: typeof Loader2;
  let styles: { textClass: string; bgClass: string; progressClass: string };

  if (useDynamicDisplay) {
    // Dynamic mode: use stepMeta label and category-based styling
    label = stepMeta.label;
    const category = stepMeta.category;
    Icon = CATEGORY_ICONS[category];
    styles = CATEGORY_STYLES[category];
  } else {
    // Legacy mode: use hardcoded stepConfig for exact backward compatibility
    const config = stepConfig[currentStep];
    label = config.label;
    Icon = config.icon;
    styles = {
      textClass: config.textClass,
      bgClass: config.bgClass,
      progressClass: config.progressClass
    };
  }

  const isProcessing = ![ProcessingStep.COMPLETE, ProcessingStep.FAILED].includes(currentStep);

  if (compact) {
    // Compact view for Library list
    return (
      <div className="flex flex-col gap-2 min-w-0">
        <div className="flex items-center gap-2">
          <Icon
            size={14}
            className={cn(
              styles.textClass,
              isProcessing && 'animate-spin'
            )}
          />
          <span className="text-xs font-medium text-slate-700">
            {label}
          </span>
          <span className={cn("text-xs", styles.textClass)}>
            {percentComplete}%
          </span>
        </div>
        {/* Progress bar */}
        <div className="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              styles.progressClass
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
            styles.bgClass
          )}>
            <Icon
              size={20}
              className={cn(
                styles.textClass,
                isProcessing && 'animate-spin'
              )}
            />
          </div>
          <div>
            <h4 className="text-sm font-medium text-slate-900">{label}</h4>
            <p className="text-xs text-slate-500">Processing your audio</p>
          </div>
        </div>
        <div className={cn(
          "text-2xl font-bold",
          styles.textClass
        )}>
          {percentComplete}%
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            styles.progressClass
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
