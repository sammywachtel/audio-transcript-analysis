import React, { useState, useCallback, useEffect } from 'react';
import { Person } from '../types';
import { useConversations } from '../contexts/ConversationContext';
import { useAudioPlayer } from '../hooks/useAudioPlayer';
import { usePersonMentions } from '../hooks/usePersonMentions';
import { useTranscriptSelection } from '../hooks/useTranscriptSelection';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { ViewerHeader } from '../components/viewer/ViewerHeader';
import { TranscriptView } from '../components/viewer/TranscriptView';
import { Sidebar } from '../components/viewer/Sidebar';
import { AudioPlayer } from '../components/viewer/AudioPlayer';
import { RenameSpeakerModal } from '../components/viewer/RenameSpeakerModal';

interface ViewerProps {
  onBack: () => void;
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
export const Viewer: React.FC<ViewerProps> = ({ onBack }) => {
  const { activeConversation, updateConversation, getAudioUrl } = useConversations();

  // Bail if no active conversation (shouldn't happen, but TypeScript safety)
  if (!activeConversation) {
    return null;
  }

  const [conversation, setConversation] = useState(activeConversation);
  const [editingSpeakerId, setEditingSpeakerId] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

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

  /**
   * Handle speaker rename
   */
  const handleRenameSpeaker = useCallback((speakerId: string) => {
    setEditingSpeakerId(speakerId);
  }, []);

  const saveSpeakerName = useCallback((newName: string) => {
    if (editingSpeakerId && newName.trim()) {
      const updatedConversation = {
        ...conversation,
        speakers: {
          ...conversation.speakers,
          [editingSpeakerId]: {
            ...conversation.speakers[editingSpeakerId],
            displayName: newName.trim()
          }
        }
      };

      setConversation(updatedConversation);
      updateConversation(updatedConversation);
    }
    setEditingSpeakerId(null);
  }, [editingSpeakerId, conversation, updateConversation]);

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

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      {/* Header */}
      <ViewerHeader
        title={conversation.title}
        createdAt={conversation.createdAt}
        isSyncing={isSyncing}
        onBack={onBack}
        driftCorrectionApplied={driftCorrectionApplied}
        driftRatio={driftRatio}
        driftMs={driftMs}
        alignmentStatus={conversation.alignmentStatus}
        alignmentError={conversation.alignmentError}
      />

      {/* Main Content Split */}
      <div className="flex-1 flex overflow-hidden">
        {/* Transcript Area */}
        <TranscriptView
          conversation={conversation}
          activeSegmentIndex={activeSegmentIndex}
          selectedTermId={selectedTermId}
          selectedPersonId={selectedPersonId}
          personOccurrences={personOccurrences}
          onSeek={seek}
          onTermClick={handleTermClickInTranscript}
          onRenameSpeaker={handleRenameSpeaker}
        />

        {/* Sidebar (Desktop) */}
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
          />
        </div>
      </div>

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
    </div>
  );
};
