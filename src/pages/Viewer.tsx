import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Person } from '@/config/types';
import { useConversations } from '../contexts/ConversationContext';
import { useAudioPlayer } from '../hooks/useAudioPlayer';
import { usePersonMentions } from '../hooks/usePersonMentions';
import { useTranscriptSelection } from '../hooks/useTranscriptSelection';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useChat } from '../hooks/useChat';
import { useChatHistory } from '../hooks/useChatHistory';
import { useSpeakerCorrections } from '../hooks/useSpeakerCorrections';
import { ViewerHeader } from '../components/viewer/ViewerHeader';
import { TranscriptView } from '../components/viewer/TranscriptView';
import { Sidebar } from '../components/viewer/Sidebar';
import { AudioPlayer } from '../components/viewer/AudioPlayer';
import { RenameSpeakerModal } from '../components/viewer/RenameSpeakerModal';
import { SpeakerMergeModal } from '../components/viewer/SpeakerMergeModal';
import { EditTitleModal } from '../components/viewer/EditTitleModal';
import { KeyboardShortcutsModal } from '../components/viewer/KeyboardShortcutsModal';
import { ToastContainer, useToasts } from '../components/shared/Toast';
import { exportTranscript } from '../utils/exportTranscript';
import { HelpCircle, X, PanelRight, AlertTriangle } from 'lucide-react';

interface ViewerProps {
  onBack: () => void;
  onStatsClick?: () => void;
  targetSegmentId?: string;
}

/**
 * Viewer - Main transcript viewing page
 *
 * REFACTORED: Stripped down to orchestration logic only.
 * - State management → ConversationContext
 * - Audio sync → useAudioPlayer hook
 * - Person mentions → usePersonMentions hook
 * - Selection state → useTranscriptSelection hook
 * - Auto-scroll → useAutoScroll hook
 * - Header → ViewerHeader component
 * - Transcript → TranscriptView component
 * - Speaker rename → RenameSpeakerModal component
 *
 * This went from 516 lines to ~130 lines. Much easier to reason about.
 */
export const Viewer: React.FC<ViewerProps> = ({ onBack, onStatsClick, targetSegmentId }) => {
  const { activeConversation, updateConversation, getAudioUrl } = useConversations();

  // Bail if no active conversation (shouldn't happen, but TypeScript safety)
  if (!activeConversation) {
    return null;
  }

  const [conversation, setConversation] = useState(activeConversation);
  const [editingSpeakerId, setEditingSpeakerId] = useState<string | null>(null);
  const [mergingSpeakerId, setMergingSpeakerId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [highlightedSegmentId, setHighlightedSegmentId] = useState<string | null>(null);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [warningBannerDismissed, setWarningBannerDismissed] = useState(false);

  // Fetch audio URL from Firebase Storage on mount
  // The URL is generated on-demand because Storage download URLs expire
  useEffect(() => {
    const fetchUrl = async () => {
      if (!activeConversation.conversationId) return;

      console.log('[Viewer] Fetching audio URL for conversation:', activeConversation.conversationId);
      const url = await getAudioUrl(activeConversation.conversationId);
      if (url) {
        console.log('[Viewer] Audio URL fetched successfully');
        setAudioUrl(url);
      } else {
        console.log('[Viewer] No audio URL available (audioStoragePath may be missing)');
      }
    };

    fetchUrl();
  }, [activeConversation.conversationId, getAudioUrl]);

  // Audio playback logic (drift correction, play/pause, seeking)
  const {
    isPlaying,
    currentTime,
    duration,
    activeSegmentIndex,
    isSyncing,
    driftCorrectionApplied,
    driftRatio,
    driftMs,
    syncOffset,
    togglePlay,
    seek,
    scrub,
    setSyncOffset
  } = useAudioPlayer(conversation, {
    audioUrl: audioUrl ?? undefined,
    initialDuration: conversation.durationMs,
    segments: conversation.segments,
    onDriftCorrected: (fixedConversation) => {
      setConversation(fixedConversation);
      updateConversation(fixedConversation);
    }
  });

  // Person mention detection (regex-based)
  const { mentionsMap, personOccurrences } = usePersonMentions(
    conversation.people,
    conversation.segments
  );

  // Selection state and two-way sync (transcript ↔ sidebar)
  const {
    selectedTermId,
    selectedPersonId,
    handleTermClickInTranscript,
    handleTermClickInSidebar,
    handlePersonClickInSidebar
  } = useTranscriptSelection({
    termOccurrences: conversation.termOccurrences,
    personMentions: mentionsMap
  });

  // Auto-scroll to active segment during playback
  useAutoScroll(isPlaying, activeSegmentIndex, conversation.segments);

  // Scroll to target segment if provided (from search deep-link)
  useEffect(() => {
    if (targetSegmentId) {
      // Small delay to ensure DOM is ready
      const timer = setTimeout(() => {
        const el = document.getElementById(`segment-${targetSegmentId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Briefly highlight the target segment
          el.classList.add('ring-2', 'ring-blue-400', 'bg-blue-50');
          setTimeout(() => {
            el.classList.remove('ring-2', 'ring-blue-400', 'bg-blue-50');
          }, 2000);
        }
      }, 300);

      return () => clearTimeout(timer);
    }
  }, [targetSegmentId]);

  // Keyboard shortcuts (Space, ←/→, J/K, ?, Escape)
  const {
    showFirstTimeTooltip,
    dismissTooltip,
    helpModalOpen,
    closeHelpModal
  } = useKeyboardShortcuts({
    togglePlay,
    seekBack: () => seek(currentTime - 5000),
    seekForward: () => seek(currentTime + 5000),
    openHelp: () => {} // Modal state handled by hook
  });

  // Chat history persistence
  const {
    messages: chatMessages,
    isLoading: chatHistoryLoading,
    hasOlder: chatHasOlder,
    messageCount: chatMessageCount,
    loadOlder: chatLoadOlder,
    refreshCount: chatRefreshCount
  } = useChatHistory({
    conversationId: conversation.conversationId,
    enabled: true
  });

  // Chat sending logic
  const {
    draftInput: chatDraftInput,
    setDraftInput: chatSetDraftInput,
    isLoading: chatIsLoading,
    error: chatError,
    sendMessage: chatSendMessage,
    clearError: chatClearError,
    isAtLimit: chatIsAtLimit,
    cumulativeCostUsd: chatCumulativeCostUsd,
    suggestions: chatSuggestions,
    costWarningLevel: chatCostWarningLevel
  } = useChat({
    conversationId: conversation.conversationId,
    messageCount: chatMessageCount,
    messages: chatMessages
  });

  // Toast notifications for speaker corrections
  const { toasts, addToast, dismissToast } = useToasts();

  // Speaker corrections (manual merge, reassign, and rename)
  const {
    correctedSpeakers,
    correctedSegments,
    canUndo,
    undoStackSize,
    mergeSpeakers,
    reassignSegments,
    renameSpeaker,
    undoLastCorrection,
    isLoading: correctionsLoading,
    error: _correctionsError,
    clearError: _clearCorrectionsError,
    pendingToast,
    clearPendingToast,
    recentMerge,
    recentReassignSegmentIds
  } = useSpeakerCorrections({
    conversationId: conversation.conversationId,
    originalSpeakers: conversation.speakers,
    originalSegments: conversation.segments
  });

  // Compute segment counts per speaker from corrected segments
  const speakerSegmentCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const segment of correctedSegments) {
      counts[segment.speakerId] = (counts[segment.speakerId] || 0) + 1;
    }
    return counts;
  }, [correctedSegments]);

  // Display toast when a correction is made
  useEffect(() => {
    if (pendingToast) {
      addToast({
        message: pendingToast.message,
        type: 'info',
        duration: 10000,
        action: {
          label: 'Undo',
          onClick: () => {
            undoLastCorrection().catch(err => {
              console.error('[Viewer] Undo failed:', err);
            });
          }
        }
      });
      clearPendingToast();
    }
  }, [pendingToast, addToast, clearPendingToast, undoLastCorrection]);

  /**
   * Handle speaker rename
   */
  const handleRenameSpeaker = useCallback((speakerId: string) => {
    setEditingSpeakerId(speakerId);
  }, []);

  /**
   * Handle segment speaker reassignment (single segment)
   * Uses the apply-on-read correction pattern via Cloud Function
   */
  const handleReassignSpeaker = useCallback(async (segmentId: string, newSpeakerId: string) => {
    try {
      await reassignSegments([segmentId], newSpeakerId);
      console.log('[Viewer] Reassigned segment speaker:', {
        segmentId,
        newSpeakerId,
        newSpeakerName: conversation.speakers[newSpeakerId]?.displayName
      });
    } catch (err) {
      console.error('[Viewer] Reassignment failed:', err);
    }
  }, [reassignSegments, conversation.speakers]);

  /**
   * Handle bulk segment reassignment (multiple segments)
   * Uses the apply-on-read correction pattern via Cloud Function
   */
  const handleReassignSegments = useCallback(async (segmentIds: string[], toSpeakerId: string) => {
    try {
      await reassignSegments(segmentIds, toSpeakerId);
      console.log('[Viewer] Bulk reassigned segments:', {
        segmentCount: segmentIds.length,
        toSpeakerId,
        toSpeakerName: conversation.speakers[toSpeakerId]?.displayName
      });
    } catch (err) {
      console.error('[Viewer] Bulk reassignment failed:', err);
    }
  }, [reassignSegments, conversation.speakers]);

  const saveSpeakerName = useCallback(async (newName: string) => {
    if (editingSpeakerId && newName.trim()) {
      try {
        await renameSpeaker(editingSpeakerId, newName.trim());
      } catch (err) {
        console.error('[Viewer] Rename via modal failed:', err);
      }
    }
    setEditingSpeakerId(null);
  }, [editingSpeakerId, renameSpeaker]);

  /**
   * Handle title edit - update local state and persist to Firestore
   */
  const saveTitle = useCallback((newTitle: string) => {
    if (newTitle.trim() && newTitle !== conversation.title) {
      const updatedConversation = {
        ...conversation,
        title: newTitle.trim()
      };

      setConversation(updatedConversation);
      updateConversation(updatedConversation);
    }
    setEditingTitle(false);
  }, [conversation, updateConversation]);

  /**
   * Handle person note updates
   */
  const handleUpdatePerson = useCallback((updatedPerson: Person) => {
    const updatedConversation = {
      ...conversation,
      people: conversation.people.map(p =>
        p.personId === updatedPerson.personId ? updatedPerson : p
      )
    };
    setConversation(updatedConversation);
    updateConversation(updatedConversation);
  }, [conversation, updateConversation]);

  /**
   * Navigate to specific segment (from person mentions)
   */
  const handleNavigateToSegment = useCallback((segmentId: string) => {
    const el = document.getElementById(`segment-${segmentId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  /**
   * Handle timestamp click from chat messages
   * Navigates to segment, seeks audio, highlights segment, and auto-plays
   */
  const handleChatTimestampSeek = useCallback((timeMs: number) => {
    seek(timeMs);
  }, [seek]);

  /**
   * Handle chat timestamp auto-play
   * Starts playback if not already playing
   */
  const handleChatTimestampPlay = useCallback(() => {
    if (!isPlaying) {
      togglePlay();
    }
  }, [isPlaying, togglePlay]);

  /**
   * Handle segment highlighting from chat timestamp clicks
   * Highlights segment for 2 seconds
   */
  const handleChatTimestampHighlight = useCallback((segmentId: string | null) => {
    setHighlightedSegmentId(segmentId);
  }, []);

  /**
   * Handle speaker merge - open modal to select target
   */
  const handleMergeSpeaker = useCallback((speakerId: string) => {
    setMergingSpeakerId(speakerId);
  }, []);

  /**
   * Confirm merge - call Cloud Function via hook
   */
  const handleConfirmMerge = useCallback(async (targetSpeakerId: string) => {
    if (!mergingSpeakerId) return;

    try {
      await mergeSpeakers(mergingSpeakerId, targetSpeakerId);
      setMergingSpeakerId(null); // Close modal on success
    } catch (err) {
      // Error is handled by the hook and exposed via mergeError
      console.error('[Viewer] Merge failed:', err);
    }
  }, [mergingSpeakerId, mergeSpeakers]);

  /**
   * Handle undo (for any correction type)
   */
  const handleUndo = useCallback(async () => {
    try {
      await undoLastCorrection();
    } catch (err) {
      // Error is handled by the hook and exposed via correctionsError
      console.error('[Viewer] Undo correction failed:', err);
    }
  }, [undoLastCorrection]);

  /**
   * Handle speaker rename via correction (inline edit in sidebar)
   * Uses the apply-on-read correction pattern via Cloud Function
   */
  const handleRenameSpeakerCorrection = useCallback(async (speakerId: string, newName: string) => {
    try {
      await renameSpeaker(speakerId, newName);
      console.log('[Viewer] Renamed speaker via correction:', {
        speakerId,
        newName
      });
    } catch (err) {
      console.error('[Viewer] Rename failed:', err);
      throw err; // Re-throw so SpeakerCard can show validation error
    }
  }, [renameSpeaker]);

  return (
    <div className="flex flex-col h-screen-safe bg-slate-50">
      {/* Header */}
      <ViewerHeader
        title={conversation.title}
        createdAt={conversation.createdAt}
        conversationId={conversation.conversationId}
        isSyncing={isSyncing}
        onBack={onBack}
        onStatsClick={onStatsClick}
        onEditTitle={() => setEditingTitle(true)}
        onExport={() => exportTranscript({
          ...conversation,
          speakers: correctedSpeakers,
          segments: correctedSegments
        })}
        driftCorrectionApplied={driftCorrectionApplied}
        driftRatio={driftRatio}
        driftMs={driftMs}
        alignmentStatus={conversation.alignmentStatus}
        alignmentError={conversation.alignmentError}
      />

      {/* Quality Warnings Banner */}
      {conversation.warnings && conversation.warnings.length > 0 && !warningBannerDismissed && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-3">
          <div className="max-w-5xl mx-auto flex items-start gap-3">
            <AlertTriangle size={18} className="text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-amber-800">
                Quality Notice
              </p>
              <div className="text-sm text-amber-700 mt-1 space-y-1">
                {conversation.warnings.map((warning, idx) => (
                  <p key={warning.warningId || idx}>
                    {warning.message}
                    {warning.details && (
                      <span className="text-amber-600"> {warning.details}</span>
                    )}
                  </p>
                ))}
              </div>
            </div>
            <button
              onClick={() => setWarningBannerDismissed(true)}
              className="p-1 text-amber-600 hover:text-amber-800 hover:bg-amber-100 rounded transition-colors shrink-0"
              aria-label="Dismiss warning"
            >
              <X size={18} />
            </button>
          </div>
        </div>
      )}

      {/* First-time keyboard shortcuts tooltip */}
      {showFirstTimeTooltip && (
        <div className="fixed top-20 right-4 z-40 bg-slate-900 text-white text-sm rounded-lg p-4 shadow-xl max-w-xs animate-in fade-in slide-in-from-right duration-300">
          <div className="flex items-start gap-3">
            <HelpCircle size={20} className="text-blue-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold mb-1">Keyboard Shortcuts Available</p>
              <p className="text-slate-300 text-xs mb-3">
                Use Space to play/pause, arrow keys to seek, and ? to see all shortcuts.
              </p>
              <button
                onClick={dismissTooltip}
                className="text-xs bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded transition-colors"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Split */}
      <div className="flex-1 flex overflow-hidden">
        {/* Transcript Area - use corrected speakers/segments */}
        <TranscriptView
          conversation={{
            ...conversation,
            speakers: correctedSpeakers,
            segments: correctedSegments
          }}
          activeSegmentIndex={activeSegmentIndex}
          selectedTermId={selectedTermId}
          selectedPersonId={selectedPersonId}
          personOccurrences={personOccurrences}
          highlightedSegmentId={highlightedSegmentId}
          recentReassignSegmentIds={recentReassignSegmentIds}
          onSeek={seek}
          onTermClick={handleTermClickInTranscript}
          onRenameSpeaker={handleRenameSpeaker}
          onReassignSpeaker={handleReassignSpeaker}
          onReassignSegments={handleReassignSegments}
        />

        {/* Sidebar (Desktop) - use corrected speakers */}
        <div className="hidden lg:block w-80 shrink-0 z-10 shadow-xl shadow-slate-200/50">
          <Sidebar
            terms={Object.values(conversation.terms)}
            people={conversation.people || []}
            selectedTermId={selectedTermId}
            selectedPersonId={selectedPersonId}
            onTermSelect={handleTermClickInSidebar}
            onPersonSelect={handlePersonClickInSidebar}
            onUpdatePerson={handleUpdatePerson}
            personMentions={mentionsMap}
            onNavigateToSegment={handleNavigateToSegment}
            // Chat props
            conversationId={conversation.conversationId}
            chatMessages={chatMessages}
            chatMessageCount={chatMessageCount}
            chatDraftInput={chatDraftInput}
            chatSetDraftInput={chatSetDraftInput}
            chatOnSendMessage={chatSendMessage}
            chatIsLoading={chatIsLoading}
            chatIsAtLimit={chatIsAtLimit}
            chatError={chatError}
            chatOnClearError={chatClearError}
            chatOnClearHistoryComplete={chatRefreshCount}
            chatHasOlderMessages={chatHasOlder}
            chatOnLoadOlder={chatLoadOlder}
            chatIsLoadingOlder={chatHistoryLoading}
            conversationTitle={conversation.title}
            conversationDurationMs={conversation.durationMs}
            speakers={correctedSpeakers}
            chatOnSeek={handleChatTimestampSeek}
            chatOnPlay={handleChatTimestampPlay}
            chatOnHighlight={handleChatTimestampHighlight}
            chatSuggestions={chatSuggestions}
            chatCumulativeCostUsd={chatCumulativeCostUsd}
            chatCostWarningLevel={chatCostWarningLevel}
            // Speaker corrections
            canUndo={canUndo}
            undoStackSize={undoStackSize}
            onUndo={handleUndo}
            onMergeSpeaker={handleMergeSpeaker}
            onRenameSpeaker={handleRenameSpeakerCorrection}
            isCorrectionsLoading={correctionsLoading}
            recentMerge={recentMerge}
            speakerSegmentCounts={speakerSegmentCounts}
          />
        </div>

        {/* Mobile Sidebar Panel - full sidebar with Context/People/Chat tabs */}
        {mobileChatOpen && (
          <div className="lg:hidden fixed inset-0 z-40 flex flex-col bg-white">
            {/* Mobile Panel Header with close button */}
            <div
              className="flex items-center justify-between p-4 border-b border-slate-200 bg-slate-50"
              style={{
                /* Add top padding for devices with notches (iOS safe area) */
                paddingTop: 'max(1rem, env(safe-area-inset-top))'
              }}
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
                  <PanelRight size={16} className="text-blue-600" />
                </div>
                <div>
                  <h2 className="font-semibold text-sm text-slate-900 truncate max-w-[200px]">{conversation.title}</h2>
                  <p className="text-xs text-slate-500">Context • People • Chat</p>
                </div>
              </div>
              <button
                onClick={() => setMobileChatOpen(false)}
                className="w-11 h-11 flex items-center justify-center rounded-full hover:bg-slate-200 transition-colors"
                aria-label="Close panel"
              >
                <X size={24} className="text-slate-600" />
              </button>
            </div>

            {/* Mobile Chat Sidebar Content */}
            <div className="flex-1 overflow-hidden">
              <Sidebar
                terms={Object.values(conversation.terms)}
                people={conversation.people || []}
                selectedTermId={selectedTermId}
                selectedPersonId={selectedPersonId}
                onTermSelect={handleTermClickInSidebar}
                onPersonSelect={handlePersonClickInSidebar}
                onUpdatePerson={handleUpdatePerson}
                personMentions={mentionsMap}
                onNavigateToSegment={(segmentId) => {
                  handleNavigateToSegment(segmentId);
                  setMobileChatOpen(false); // Close chat when navigating to segment
                }}
                // Chat props
                conversationId={conversation.conversationId}
                chatMessages={chatMessages}
                chatMessageCount={chatMessageCount}
                chatDraftInput={chatDraftInput}
                chatSetDraftInput={chatSetDraftInput}
                chatOnSendMessage={chatSendMessage}
                chatIsLoading={chatIsLoading}
                chatIsAtLimit={chatIsAtLimit}
                chatError={chatError}
                chatOnClearError={chatClearError}
                chatOnClearHistoryComplete={chatRefreshCount}
                chatHasOlderMessages={chatHasOlder}
                chatOnLoadOlder={chatLoadOlder}
                chatIsLoadingOlder={chatHistoryLoading}
                conversationTitle={conversation.title}
                conversationDurationMs={conversation.durationMs}
                speakers={correctedSpeakers}
                chatOnSeek={(timeMs) => {
                  handleChatTimestampSeek(timeMs);
                  setMobileChatOpen(false); // Close chat when seeking
                }}
                chatOnPlay={handleChatTimestampPlay}
                chatOnHighlight={handleChatTimestampHighlight}
                chatSuggestions={chatSuggestions}
                chatCumulativeCostUsd={chatCumulativeCostUsd}
                chatCostWarningLevel={chatCostWarningLevel}
                // Speaker corrections
                canUndo={canUndo}
                undoStackSize={undoStackSize}
                onUndo={handleUndo}
                onMergeSpeaker={handleMergeSpeaker}
                onRenameSpeaker={handleRenameSpeakerCorrection}
                isCorrectionsLoading={correctionsLoading}
                recentMerge={recentMerge}
                speakerSegmentCounts={speakerSegmentCounts}
                defaultTab="context"
              />
            </div>
          </div>
        )}
      </div>

      {/* Mobile Sidebar FAB - opens panel with Context/People/Chat tabs */}
      {!mobileChatOpen && (
        <button
          id="mobile-sidebar-fab"
          data-testid="mobile-sidebar-fab"
          onClick={() => setMobileChatOpen(true)}
          aria-label="Open sidebar panel"
          className="lg:hidden fixed z-30 w-14 h-14 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white rounded-full shadow-lg hover:shadow-xl transition-all duration-200 flex items-center justify-center touch-manipulation"
          style={{
            /* Explicit positioning to prevent layout shift issues on mobile
             * AudioPlayer is 64px (h-16), add 16px gap = 80px from bottom
             * Using inline styles + important classes ensures positioning sticks after refresh
             */
            position: 'fixed',
            bottom: 'calc(4rem + 1rem)', /* 64px (AudioPlayer) + 16px (gap) */
            right: '1rem',
          }}
        >
          <PanelRight size={24} />
        </button>
      )}

      {/* Footer Player */}
      <AudioPlayer
        currentTimeMs={currentTime}
        durationMs={duration}
        isPlaying={isPlaying}
        onPlayPause={togglePlay}
        onSeek={seek}
        onScrub={scrub}
        syncOffset={syncOffset}
        onSyncOffsetChange={setSyncOffset}
      />

      {/* Rename Speaker Modal */}
      {editingSpeakerId && (
        <RenameSpeakerModal
          initialName={conversation.speakers[editingSpeakerId].displayName}
          onClose={() => setEditingSpeakerId(null)}
          onSave={saveSpeakerName}
        />
      )}

      {/* Speaker Merge Modal */}
      {mergingSpeakerId && (
        <SpeakerMergeModal
          sourceSpeaker={correctedSpeakers[mergingSpeakerId]}
          targetSpeakers={Object.values(correctedSpeakers).filter(s => s.speakerId !== mergingSpeakerId)}
          onClose={() => setMergingSpeakerId(null)}
          onConfirm={handleConfirmMerge}
        />
      )}

      {/* Edit Title Modal */}
      {editingTitle && (
        <EditTitleModal
          initialTitle={conversation.title}
          onClose={() => setEditingTitle(false)}
          onSave={saveTitle}
        />
      )}

      {/* Keyboard Shortcuts Modal */}
      <KeyboardShortcutsModal
        isOpen={helpModalOpen}
        onClose={closeHelpModal}
      />

      {/* Toast Notifications */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
};
