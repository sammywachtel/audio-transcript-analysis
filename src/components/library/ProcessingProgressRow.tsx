import React, { useState } from 'react';
import { ProcessingProgress, ProcessingStep } from '@/config/types';
import { ChevronDown, ChevronRight, StopCircle, Loader2, Clock } from 'lucide-react';
import { cn } from '@/utils';
import { Button } from '../Button';

interface ProcessingProgressRowProps {
  progress?: ProcessingProgress;
  onAbort: () => void;
  abortRequested?: boolean;
}

/**
 * ProcessingProgressRow - Expandable progress row for library view
 *
 * Shows current step, percent, ETA, and ratio (if available).
 * Expands to show detailed info and Abort button.
 */
export const ProcessingProgressRow: React.FC<ProcessingProgressRowProps> = ({
  progress,
  onAbort,
  abortRequested = false
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Fallback for legacy data or when progress is not yet available
  if (!progress) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Loader2 size={14} className={cn(
            "animate-spin",
            abortRequested ? "text-amber-500" : "text-blue-500"
          )} />
          <span className={cn(
            "text-xs font-medium",
            abortRequested ? "text-amber-600" : "text-blue-600"
          )}>
            {abortRequested ? 'Cancelling...' : 'Processing...'}
          </span>
          {!abortRequested && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAbort();
              }}
              className="ml-auto text-xs text-amber-600 hover:text-amber-700 hover:underline"
            >
              Cancel
            </button>
          )}
        </div>
        {abortRequested && (
          <p className="text-xs text-amber-500 ml-6">
            Waiting for checkpoint...
          </p>
        )}
      </div>
    );
  }

  const { currentStep, percentComplete, estimatedRemainingMs, stepMeta } = progress;

  // Get step label (prefer stepMeta, fallback to step enum)
  const getStepLabel = () => {
    if (stepMeta?.label) return stepMeta.label;

    // Fallback labels
    const labels: Record<ProcessingStep, string> = {
      [ProcessingStep.PENDING]: 'Queued',
      [ProcessingStep.UPLOADING]: 'Uploading',
      [ProcessingStep.OPTIMIZING]: 'Optimizing Audio',
      [ProcessingStep.CHUNKING]: 'Splitting Audio',
      [ProcessingStep.PRE_ANALYZING]: 'Pre-analyzing',
      [ProcessingStep.TRANSCRIBING]: 'Transcribing',
      [ProcessingStep.ANALYZING]: 'Analyzing',
      [ProcessingStep.REASSIGNING]: 'Reassigning Speakers',
      [ProcessingStep.ALIGNING]: 'Aligning',
      [ProcessingStep.FINALIZING]: 'Finalizing',
      [ProcessingStep.COMPLETE]: 'Complete',
      [ProcessingStep.FAILED]: 'Failed'
    };

    return labels[currentStep] || 'Processing';
  };

  // Calculate ETA display
  const getEtaDisplay = () => {
    if (!estimatedRemainingMs || estimatedRemainingMs <= 0) {
      return 'Calculating...';
    }

    const seconds = Math.ceil(estimatedRemainingMs / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  };

  const isProcessing = ![ProcessingStep.COMPLETE, ProcessingStep.FAILED].includes(currentStep);

  return (
    <div className="flex flex-col gap-2">
      {/* Collapsed view - always visible */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="p-1 hover:bg-slate-100 rounded transition-colors"
          aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
        >
          {isExpanded ? (
            <ChevronDown size={14} className="text-slate-500" />
          ) : (
            <ChevronRight size={14} className="text-slate-500" />
          )}
        </button>

        <Loader2
          size={14}
          className={cn(
            isProcessing && 'animate-spin',
            abortRequested ? 'text-amber-500' : 'text-blue-500'
          )}
        />

        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className={cn(
            "text-xs font-medium truncate",
            abortRequested ? "text-amber-700" : "text-slate-700"
          )}>
            {abortRequested ? 'Cancelling...' : getStepLabel()}
          </span>
          <span className={cn(
            "text-xs font-medium shrink-0",
            abortRequested ? "text-amber-600" : "text-blue-600"
          )}>
            {percentComplete}%
          </span>
        </div>

        {/* ETA badge */}
        {estimatedRemainingMs && estimatedRemainingMs > 0 && (
          <div className="flex items-center gap-1 text-xs text-slate-500 shrink-0">
            <Clock size={12} />
            <span>{getEtaDisplay()}</span>
          </div>
        )}
      </div>

      {/* Progress bar */}
      <div className="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden ml-6">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            abortRequested ? "bg-amber-500" : "bg-blue-500"
          )}
          style={{ width: `${percentComplete}%` }}
        />
      </div>

      {/* Expanded details */}
      {isExpanded && (
        <div
          className="ml-6 mt-1 p-3 bg-slate-50 rounded-lg border border-slate-200 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200"
        >
          {/* Step details */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-slate-500">Current Step:</span>
              <p className="font-medium text-slate-900 mt-0.5">{getStepLabel()}</p>
            </div>
            <div>
              <span className="text-slate-500">Progress:</span>
              <p className="font-medium text-slate-900 mt-0.5">{percentComplete}%</p>
            </div>
            {estimatedRemainingMs && estimatedRemainingMs > 0 && (
              <div>
                <span className="text-slate-500">Est. Remaining:</span>
                <p className="font-medium text-slate-900 mt-0.5">{getEtaDisplay()}</p>
              </div>
            )}
            {stepMeta?.description && (
              <div className="col-span-2">
                <span className="text-slate-500">Details:</span>
                <p className="text-slate-700 mt-0.5">{stepMeta.description}</p>
              </div>
            )}
          </div>

          {/* Abort button */}
          <div className="pt-2 border-t border-slate-200">
            {abortRequested ? (
              <div className="w-full py-2 px-3 text-center text-sm text-amber-700 bg-amber-50 rounded-lg border border-amber-200">
                <div className="flex items-center justify-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  <span>Cancel requested - waiting for checkpoint...</span>
                </div>
                <p className="text-xs text-amber-600 mt-1">
                  Processing will stop at the next safe point
                </p>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onAbort();
                }}
                className="w-full gap-2 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
              >
                <StopCircle size={14} />
                Cancel Processing
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
