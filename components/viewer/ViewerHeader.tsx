import React from 'react';
import { ArrowLeft, MoreHorizontal, Download, Share2, RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Button } from '../Button';
import { UserMenu } from '../auth/UserMenu';

// Server-side alignment status (set by Cloud Function)
type ServerAlignmentStatus = 'pending' | 'aligned' | 'fallback';

interface ViewerHeaderProps {
  title: string;
  createdAt: string;
  isSyncing: boolean;
  onBack: () => void;
  // Drift correction metrics (for legacy display)
  driftCorrectionApplied?: boolean;
  driftRatio?: number;
  driftMs?: number;
  // Server-side alignment status
  alignmentStatus?: ServerAlignmentStatus;
  alignmentError?: string;
}

/**
 * ViewerHeader - Top navigation bar for the Viewer page
 *
 * Shows conversation title, creation date, sync status, and action buttons.
 * Extracted from Viewer.tsx to keep concerns separate.
 */
export const ViewerHeader: React.FC<ViewerHeaderProps> = ({
  title,
  createdAt,
  isSyncing,
  onBack,
  driftCorrectionApplied,
  driftRatio,
  driftMs,
  alignmentStatus,
  alignmentError
}) => {
  // Format drift info for display (e.g., "+2.3s" or "-1.5s")
  const formatDrift = () => {
    if (!driftMs || !driftRatio) return '';
    const sign = driftRatio > 1 ? '+' : '';
    const seconds = ((driftRatio - 1) * 100).toFixed(1);
    return `${sign}${seconds}%`;
  };

  // Render server-side alignment status indicator
  const renderAlignmentStatus = () => {
    switch (alignmentStatus) {
      case 'aligned':
        return (
          <span className="flex items-center gap-1 text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full">
            <CheckCircle2 size={10} /> Aligned
          </span>
        );
      case 'fallback':
        return (
          <span
            className="flex items-center gap-1 text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full cursor-help"
            title={alignmentError || 'Precise alignment unavailable - using approximate timestamps'}
          >
            <AlertTriangle size={10} /> Fallback Sync
          </span>
        );
      case 'pending':
        // During processing - shouldn't normally be seen in Viewer
        return null;
      default:
        return null;
    }
  };
  return (
    <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-4 z-10 shrink-0">
      <div className="flex items-center gap-4">
        <button onClick={onBack} className="p-2 hover:bg-slate-100 rounded-full text-slate-500">
          <ArrowLeft size={20} />
        </button>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-semibold text-slate-800 text-sm md:text-base truncate max-w-[200px] md:max-w-md">
              {title}
            </h1>
            {isSyncing && (
              <span className="flex items-center gap-1 text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full animate-pulse">
                <RefreshCw size={10} className="animate-spin" /> Auto-Syncing
              </span>
            )}
            {/* Show client-side drift correction badge only if no server-side alignment */}
            {!isSyncing && driftCorrectionApplied && !alignmentStatus && (
              <span
                className="flex items-center gap-1 text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full cursor-help"
                title={`Timestamps adjusted by ${formatDrift()} (${Math.round(driftMs || 0)}ms drift detected)`}
              >
                ⚡ Sync Adjusted
              </span>
            )}
            {/* Show server-side alignment status */}
            {renderAlignmentStatus()}
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">Processed</span>
            <span>• {new Date(createdAt).toLocaleDateString()}</span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" className="hidden sm:flex gap-2">
          <Share2 size={14} /> Share
        </Button>
        <Button variant="ghost" size="sm" className="hidden sm:flex gap-2">
          <Download size={14} /> Export
        </Button>
        <button className="p-2 hover:bg-slate-100 rounded text-slate-500">
          <MoreHorizontal size={20} />
        </button>
        <UserMenu />
      </div>
    </header>
  );
};
