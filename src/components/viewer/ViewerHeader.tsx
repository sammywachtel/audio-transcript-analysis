import React from 'react';
import { ArrowLeft, MoreHorizontal, Download, Share2, RefreshCw, CheckCircle2, AlertTriangle, Pencil } from 'lucide-react';
import { Button } from '../Button';
import { UserMenu } from '../auth/UserMenu';

// Server-side alignment status (set by Cloud Function)
type ServerAlignmentStatus = 'pending' | 'aligned' | 'fallback';

interface ViewerHeaderProps {
  title: string;
  createdAt: string;
  conversationId: string;
  isSyncing: boolean;
  onBack: () => void;
  onStatsClick?: () => void;
  onEditTitle?: () => void;
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
  conversationId,
  isSyncing,
  onBack,
  onStatsClick,
  onEditTitle,
  driftCorrectionApplied,
  driftRatio,
  driftMs,
  alignmentStatus,
  alignmentError
}) => {
  // Copy conversation ID to clipboard
  const copyConversationId = () => {
    navigator.clipboard.writeText(conversationId);
  };
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
    <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-2 sm:px-4 z-10 shrink-0">
      <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
        <button onClick={onBack} className="p-2 hover:bg-slate-100 rounded-full text-slate-500 shrink-0">
          <ArrowLeft size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 group">
              <h1 className="font-semibold text-slate-800 text-sm md:text-base truncate max-w-[120px] sm:max-w-[200px] md:max-w-md">
                {title}
              </h1>
              {onEditTitle && (
                <button
                  onClick={onEditTitle}
                  className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded opacity-0 group-hover:opacity-100 transition-all"
                  title="Edit title"
                >
                  <Pencil size={14} />
                </button>
              )}
            </div>
            {isSyncing && (
              <span className="hidden sm:flex items-center gap-1 text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full animate-pulse">
                <RefreshCw size={10} className="animate-spin" /> Auto-Syncing
              </span>
            )}
            {/* Show client-side drift correction badge only if no server-side alignment */}
            {!isSyncing && driftCorrectionApplied && !alignmentStatus && (
              <span
                className="hidden sm:flex items-center gap-1 text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full cursor-help"
                title={`Timestamps adjusted by ${formatDrift()} (${Math.round(driftMs || 0)}ms drift detected)`}
              >
                ⚡ Sync Adjusted
              </span>
            )}
            {/* Show server-side alignment status */}
            <div className="hidden sm:block">
              {renderAlignmentStatus()}
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-2 text-xs text-slate-500">
            <span className="bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">Processed</span>
            <span>• {new Date(createdAt).toLocaleDateString()}</span>
            <button
              onClick={copyConversationId}
              className="text-slate-400 hover:text-slate-600 font-mono text-[10px] hover:underline"
              title="Click to copy conversation ID"
            >
              {conversationId.slice(-6)}
            </button>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1 sm:gap-2 shrink-0">
        <Button variant="outline" size="sm" className="hidden md:flex gap-2">
          <Share2 size={14} /> Share
        </Button>
        <Button variant="ghost" size="sm" className="hidden md:flex gap-2">
          <Download size={14} /> Export
        </Button>
        <button className="hidden sm:block p-2 hover:bg-slate-100 rounded text-slate-500">
          <MoreHorizontal size={20} />
        </button>
        <div className="shrink-0">
          <UserMenu onStatsClick={onStatsClick} />
        </div>
      </div>
    </header>
  );
};
