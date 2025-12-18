import React, { useState, useCallback } from 'react';
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
import { alignmentService, fetchAudioBlob } from '../services/alignmentService';

type AlignmentStatus = 'idle' | 'aligning' | 'aligned' | 'error';

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
  const { activeConversation, updateConversation } = useConversations();

  // Bail if no active conversation (shouldn't happen, but TypeScript safety)
  if (!activeConversation) {
    return null;
  }

  const [conversation, setConversation] = useState(activeConversation);
  const [editingSpeakerId, setEditingSpeakerId] = useState<string | null>(null);
  const [alignmentStatus, setAlignmentStatus] = useState<AlignmentStatus>('idle');

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
    audioUrl: conversation.audioUrl,
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
    termOccurrences: conversation.termOccurrences
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

  /**
   * Improve timestamps using WhisperX alignment
   * Calls the alignment service to get precise timestamps from forced alignment
   */
  const handleImproveTimestamps = useCallback(async () => {
    if (!conversation.audioUrl) {
      console.error('[Alignment] No audio URL available');
      return;
    }

    setAlignmentStatus('aligning');
    console.log('[Alignment] Starting timestamp improvement...');

    try {
      // Fetch the audio blob from the blob URL
      const audioBlob = await fetchAudioBlob(conversation.audioUrl);
      console.log('[Alignment] Audio blob fetched:', audioBlob.size, 'bytes');

      // Call alignment service
      const alignedConversation = await alignmentService.align(conversation, audioBlob);

      console.log('[Alignment] Alignment complete, updating conversation');

      // Update state and persist
      setConversation(alignedConversation);
      updateConversation(alignedConversation);
      setAlignmentStatus('aligned');

    } catch (error) {
      console.error('[Alignment] Failed:', error);
      setAlignmentStatus('error');

      // Reset to idle after showing error briefly
      setTimeout(() => setAlignmentStatus('idle'), 3000);
    }
  }, [conversation, updateConversation]);

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
        alignmentStatus={alignmentStatus}
        onImproveTimestamps={handleImproveTimestamps}
        hasAudio={!!conversation.audioUrl}
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
