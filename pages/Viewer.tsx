import React, { useState, useEffect, useRef } from 'react';
import { Conversation, Person } from '../types';
import { TranscriptSegment } from '../components/viewer/TranscriptSegment';
import { Sidebar } from '../components/viewer/Sidebar';
import { AudioPlayer } from '../components/viewer/AudioPlayer';
import { TopicMarker } from '../components/viewer/TopicMarker';
import { ArrowLeft, MoreHorizontal, Download, Share2, X, RefreshCw } from 'lucide-react';
import { Button } from '../components/Button';
import { cn } from '../utils';

interface ViewerProps {
  initialData: Conversation;
  onBack: () => void;
  onUpdate?: (updatedConversation: Conversation) => void;
}

export const Viewer: React.FC<ViewerProps> = ({ initialData, onBack, onUpdate }) => {
  const [conversation, setConversation] = useState(initialData);

  // Audio State
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [realDuration, setRealDuration] = useState(initialData.durationMs); // Initialize with metadata duration
  const [isSyncing, setIsSyncing] = useState(false); // UI state for drift correction

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioIntervalRef = useRef<number | null>(null);

  // Selection State
  const [selectedTermId, setSelectedTermId] = useState<string | undefined>(undefined);
  const [selectedPersonId, setSelectedPersonId] = useState<string | undefined>(undefined);
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Edit State
  const [editingSpeakerId, setEditingSpeakerId] = useState<string | null>(null);

  // Update local state if initialData changes (e.g. via prop refresh, though unlikely in this flow)
  useEffect(() => {
    setConversation(initialData);
    // If we don't have an active audio element yet, reset duration to metadata
    if (!audioRef.current) {
        setRealDuration(initialData.durationMs);
    }
  }, [initialData.conversationId, initialData.durationMs]);

  // --- Audio Logic ---
  useEffect(() => {
    // If we have a real audio URL, setup the Audio object
    if (conversation.audioUrl) {
      const audio = new Audio(conversation.audioUrl);
      audioRef.current = audio;

      // Helper to safely update duration
      const handleMetadata = () => {
        const audioDurMs = audio.duration * 1000;
        if (!Number.isFinite(audioDurMs) || audioDurMs === 0) return;

        setRealDuration(audioDurMs);

        // --- DRIFT CORRECTION LOGIC ---
        // Check if the transcript is significantly shorter/longer than the audio.
        // This handles cases where sample rates caused linear time compression.
        const lastSeg = conversation.segments[conversation.segments.length - 1];
        if (lastSeg && !isSyncing) {
           const transcriptDurMs = lastSeg.endMs;
           const diff = Math.abs(audioDurMs - transcriptDurMs);
           const ratio = audioDurMs / transcriptDurMs;

           // Threshold: >5% difference AND >2 seconds (avoid tiny rounding jitter)
           if (diff > 2000 && (ratio < 0.95 || ratio > 1.05)) {
               console.log(`[Auto-Sync] Drift detected. Audio: ${audioDurMs}ms, Transcript: ${transcriptDurMs}ms. Ratio: ${ratio}`);
               setIsSyncing(true);

               // Apply linear scaling to all segments
               const scaledSegments = conversation.segments.map(seg => ({
                   ...seg,
                   startMs: Math.floor(seg.startMs * ratio),
                   endMs: Math.floor(seg.endMs * ratio)
               }));

               // Update state with fixed segments
               const fixedConversation = {
                   ...conversation,
                   segments: scaledSegments,
                   durationMs: audioDurMs // Sync metadata duration too
               };

               setConversation(fixedConversation);

               // Optional: Persist this fix immediately so it sticks
               if (onUpdate) onUpdate(fixedConversation);
           }
        }
      };

      // Check immediately (in case it's already cached/loaded)
      if (audio.readyState >= 1) { // HAVE_METADATA
          handleMetadata();
      }

      audio.addEventListener('loadedmetadata', handleMetadata);

      // Also listen to durationchange as it might update after loading more data
      audio.addEventListener('durationchange', () => {
         const d = audio.duration * 1000;
         if (d > 0) setRealDuration(d);
      });

      audio.addEventListener('timeupdate', () => {
        const nowMs = audio.currentTime * 1000;
        setCurrentTime(nowMs);
        // Fallback: If audio plays past duration, expand it for the UI
        setRealDuration(prev => (nowMs > prev ? nowMs : prev));
      });

      audio.addEventListener('ended', () => {
        setIsPlaying(false);
      });

      return () => {
        audio.pause();
        audio.src = '';
        audioRef.current = null;
      };
    } else {
        // Reset if no audio
        setRealDuration(conversation.durationMs);
    }
  }, [conversation.audioUrl]); // Depend on URL mainly

  // Handle Play/Pause
  const togglePlay = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play();
      }
      setIsPlaying(!isPlaying);
    } else {
      // Fallback for mock data (Simulated Timer)
      setIsPlaying(prev => !prev);
    }
  };

  // Fallback Simulation Effect
  useEffect(() => {
    if (!conversation.audioUrl && isPlaying) {
      audioIntervalRef.current = window.setInterval(() => {
        setCurrentTime(prev => {
          if (prev >= realDuration) {
            setIsPlaying(false);
            return realDuration;
          }
          return prev + 100; // Increment 100ms every 100ms
        });
      }, 100);
    } else {
      if (audioIntervalRef.current) clearInterval(audioIntervalRef.current);
    }
    return () => {
      if (audioIntervalRef.current) clearInterval(audioIntervalRef.current);
    };
  }, [isPlaying, conversation.audioUrl, realDuration]);

  // Just updates the visual state (scrubbing)
  const handleScrub = (ms: number) => {
    setCurrentTime(ms);
  };

  // Updates visual state AND audio position (commit)
  const handleSeek = (ms: number) => {
    setCurrentTime(ms);
    if (audioRef.current) {
      const seekTimeSec = ms / 1000;
      console.log(`[Seek] Requesting seek to ${ms}ms (${seekTimeSec}s)`);
      audioRef.current.currentTime = seekTimeSec;
      // Log what the audio element actually reports after setting
      setTimeout(() => {
        if (audioRef.current) {
          console.log(`[Seek] Audio currentTime after seek: ${audioRef.current.currentTime}s`);
        }
      }, 50);
    }
  };


  // --- Two-Way Sync Logic ---

  // 1. Transcript -> Sidebar
  const handleTermClick = (termId: string) => {
    setSelectedTermId(termId);
    // Scroll sidebar to card (Need to ensure Context tab is open, this might be a future improvement)
    const card = document.getElementById(`term-card-${termId}`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  // 2. Sidebar -> Transcript
  const handleSidebarTermSelect = (termId: string) => {
    setSelectedTermId(termId);
    // Find first occurrence segment
    const occurrence = conversation.termOccurrences.find(o => o.termId === termId);
    if (occurrence) {
        // Scroll transcript
        const segmentEl = document.getElementById(`segment-${occurrence.segmentId}`);
        if (segmentEl) {
            segmentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
  };

  const handleSidebarPersonSelect = (personId: string) => {
      setSelectedPersonId(personId);
      // Optional: Logic to scroll to first mention is handled by the navigation arrows in the card,
      // but clicking the card body could also trigger something if needed.
  }

  // --- Speaker Rename Logic ---
  const handleRenameSpeaker = (speakerId: string) => {
    setEditingSpeakerId(speakerId);
  };

  const saveSpeakerName = (newName: string) => {
    if (editingSpeakerId && newName.trim()) {
      const updatedConversation = {
        ...conversation,
        speakers: {
          ...conversation.speakers,
          [editingSpeakerId]: { ...conversation.speakers[editingSpeakerId], displayName: newName.trim() }
        }
      };

      setConversation(updatedConversation);
      // Propagate update to parent for persistence
      if (onUpdate) {
        onUpdate(updatedConversation);
      }
    }
    setEditingSpeakerId(null);
  };

  // --- People Update Logic ---
  const handleUpdatePerson = (updatedPerson: Person) => {
    const updatedConversation = {
        ...conversation,
        people: conversation.people.map(p =>
            p.personId === updatedPerson.personId ? updatedPerson : p
        )
    };
    setConversation(updatedConversation);
    if (onUpdate) {
        onUpdate(updatedConversation);
    }
  };

  // --- Person Mentions Logic ---
  const { mentionsMap, personOccurrences } = React.useMemo(() => {
    const map: Record<string, string[]> = {}; // personId -> list of segmentIds
    const occurrences: Record<string, { start: number, end: number, personId: string }[]> = {}; // segmentId -> list of ranges

    if (!conversation.people) return { mentionsMap: map, personOccurrences: occurrences };

    // Helper to escape regex special chars
    const escapeRegExp = (string: string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    conversation.people.forEach(person => {
      const personMentions: string[] = [];
      const safeName = escapeRegExp(person.name);

      // Match exact full name (case insensitive, word boundaries)
      const fullRegex = new RegExp(`\\b${safeName}\\b`, 'gi');

      // Optional fallback: First name
      let firstNameRegex: RegExp | null = null;
      if (person.name.trim().includes(' ')) {
         const parts = person.name.trim().split(' ');
         if (parts[0].length > 2) {
             firstNameRegex = new RegExp(`\\b${escapeRegExp(parts[0])}\\b`, 'gi');
         }
      }

      conversation.segments.forEach(seg => {
        let found = false;

        // Find all full name matches
        let match;
        // Reset lastIndex because we are reusing regex or recreating it
        fullRegex.lastIndex = 0;
        while ((match = fullRegex.exec(seg.text)) !== null) {
            found = true;
            if (!occurrences[seg.segmentId]) occurrences[seg.segmentId] = [];
            occurrences[seg.segmentId].push({
                start: match.index,
                end: match.index + match[0].length,
                personId: person.personId
            });
        }

        // If no full name matches, try first name
        if (!found && firstNameRegex) {
             firstNameRegex.lastIndex = 0;
             while ((match = firstNameRegex.exec(seg.text)) !== null) {
                found = true;
                if (!occurrences[seg.segmentId]) occurrences[seg.segmentId] = [];
                occurrences[seg.segmentId].push({
                    start: match.index,
                    end: match.index + match[0].length,
                    personId: person.personId
                });
             }
        }

        if (found) {
            // Add unique segment IDs
            if (!personMentions.includes(seg.segmentId)) {
                personMentions.push(seg.segmentId);
            }
        }
      });
      map[person.personId] = personMentions;
    });

    return { mentionsMap: map, personOccurrences: occurrences };
  }, [conversation.people, conversation.segments]);

  const handleNavigateToSegment = (segmentId: string) => {
     const el = document.getElementById(`segment-${segmentId}`);
     if (el) {
       el.scrollIntoView({ behavior: 'smooth', block: 'center' });
     }
  };

  // --- Active Segment Detection ---
  const activeSegmentIndex = conversation.segments.findIndex(
    seg => currentTime >= seg.startMs && currentTime < seg.endMs
  );

  // Auto-scroll transcript when playing
  useEffect(() => {
    if (isPlaying && activeSegmentIndex !== -1) {
        const el = document.getElementById(`segment-${conversation.segments[activeSegmentIndex].segmentId}`);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }
  }, [activeSegmentIndex, isPlaying, conversation.segments]);


  return (
    <div className="flex flex-col h-screen bg-slate-50">

      {/* Header */}
      <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-4 z-10 shrink-0">
        <div className="flex items-center gap-4">
          <button onClick={onBack} className="p-2 hover:bg-slate-100 rounded-full text-slate-500">
            <ArrowLeft size={20} />
          </button>
          <div>
            <div className="flex items-center gap-2">
                <h1 className="font-semibold text-slate-800 text-sm md:text-base truncate max-w-[200px] md:max-w-md">
                    {conversation.title}
                </h1>
                {isSyncing && (
                    <span className="flex items-center gap-1 text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full animate-pulse">
                        <RefreshCw size={10} className="animate-spin" /> Auto-Syncing
                    </span>
                )}
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
                <span className="bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">Processed</span>
                <span>• {new Date(conversation.createdAt).toLocaleDateString()}</span>
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
        </div>
      </header>

      {/* Main Content Split */}
      <div className="flex-1 flex overflow-hidden">

        {/* Transcript Area */}
        <div className="flex-1 overflow-y-auto relative" ref={transcriptRef}>
          <div className="max-w-3xl mx-auto px-4 py-8 pb-32">
            {conversation.segments.map((seg, idx) => {
              // Check if a topic starts here
              const topic = conversation.topics.find(t => t.startIndex === idx);
              const isActive = idx === activeSegmentIndex;

              // Find occurrences for this segment
              const segmentOccurrences = conversation.termOccurrences.filter(o => o.segmentId === seg.segmentId);
              const segmentPersonOccurrences = personOccurrences[seg.segmentId] || [];

              return (
                <div key={seg.segmentId} id={`segment-${seg.segmentId}`} className="mb-2">
                  {topic && (
                    <div className="mt-8 mb-4 px-4">
                      <TopicMarker topic={topic} />
                    </div>
                  )}

                  <TranscriptSegment
                    segment={seg}
                    speaker={conversation.speakers[seg.speakerId]}
                    occurrences={segmentOccurrences}
                    personOccurrences={segmentPersonOccurrences}
                    isActive={isActive}
                    activeTermId={selectedTermId}
                    activePersonId={selectedPersonId}
                    onSeek={handleSeek}
                    onTermClick={handleTermClick}
                    onRenameSpeaker={handleRenameSpeaker}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* Sidebar (Desktop) */}
        <div className="hidden lg:block w-80 shrink-0 z-10 shadow-xl shadow-slate-200/50">
           <Sidebar
             terms={Object.values(conversation.terms)}
             people={conversation.people || []}
             selectedTermId={selectedTermId}
             selectedPersonId={selectedPersonId}
             onTermSelect={handleSidebarTermSelect}
             onPersonSelect={handleSidebarPersonSelect}
             onUpdatePerson={handleUpdatePerson}
             personMentions={mentionsMap}
             onNavigateToSegment={handleNavigateToSegment}
           />
        </div>
      </div>

      {/* Footer Player */}
      <AudioPlayer
        currentTimeMs={currentTime}
        durationMs={realDuration}
        isPlaying={isPlaying}
        onPlayPause={togglePlay}
        onSeek={handleSeek}
        onScrub={handleScrub}
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

interface RenameSpeakerModalProps {
  initialName: string;
  onClose: () => void;
  onSave: (name: string) => void;
}

const RenameSpeakerModal: React.FC<RenameSpeakerModalProps> = ({ initialName, onClose, onSave }) => {
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(name);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
        <div className="bg-white w-full max-w-sm rounded-xl shadow-2xl p-6 scale-100 animate-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-semibold text-slate-900">Rename Speaker</h3>
                <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
                    <X size={20} />
                </button>
            </div>
            <form onSubmit={handleSubmit}>
                <input
                    ref={inputRef}
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 mb-6 text-slate-900"
                    placeholder="Speaker Name"
                />
                <div className="flex justify-end gap-2">
                    <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
                    <Button type="submit">Save Changes</Button>
                </div>
            </form>
        </div>
    </div>
  );
};
