import React, { useState, useRef, useEffect } from 'react';
import { Term, Person, Speaker } from '@/config/types';
import { cn } from '@/utils';
import { BookOpen, Search, Users, User, StickyNote, ChevronLeft, ChevronRight, MessageSquare, Mic, Undo2, Check, X } from 'lucide-react';
import { ChatSidebar } from './ChatSidebar';
import { ChatHistoryMessage } from '@/services/chatHistoryService';
import { Button } from '../Button';

interface SidebarProps {
  terms: Term[];
  people: Person[];
  selectedTermId?: string;
  selectedPersonId?: string;
  onTermSelect: (termId: string) => void;
  onPersonSelect?: (personId: string) => void;
  onUpdatePerson: (person: Person) => void;
  personMentions?: Record<string, string[]>; // personId -> array of segmentIds
  onNavigateToSegment?: (segmentId: string) => void;
  // Chat props
  conversationId?: string;
  chatMessages?: ChatHistoryMessage[];
  chatMessageCount?: number;
  chatDraftInput?: string;
  chatSetDraftInput?: (input: string) => void;
  chatOnSendMessage?: (message: string) => void;
  chatIsLoading?: boolean;
  chatIsAtLimit?: boolean;
  chatError?: string | null;
  chatOnClearError?: () => void;
  chatOnClearHistoryComplete?: () => void;
  chatHasOlderMessages?: boolean;
  chatOnLoadOlder?: () => Promise<void>;
  chatIsLoadingOlder?: boolean;
  conversationTitle?: string;
  conversationDurationMs?: number;
  speakers?: Record<string, Speaker>;
  // Enhanced chat props
  chatOnSeek?: (timeMs: number) => void;
  chatOnPlay?: () => void;
  chatOnHighlight?: (segmentId: string | null) => void;
  chatSuggestions?: string[];
  chatCumulativeCostUsd?: number;
  chatCostWarningLevel?: 'none' | 'primary' | 'escalated';
  // Speaker corrections props
  canUndo?: boolean;
  undoStackSize?: number;
  onUndo?: () => void;
  onMergeSpeaker?: (speakerId: string) => void;
  onRenameSpeaker?: (speakerId: string, newName: string) => Promise<void>;
  isCorrectionsLoading?: boolean;
  recentMerge?: { sourceSpeakerId: string; targetSpeakerId: string } | null;
  speakerSegmentCounts?: Record<string, number>;
  // Mobile support
  defaultTab?: 'context' | 'people' | 'speakers' | 'chat';
}

export const Sidebar: React.FC<SidebarProps> = ({
  terms,
  people,
  selectedTermId,
  selectedPersonId,
  onTermSelect,
  onPersonSelect,
  onUpdatePerson,
  personMentions,
  onNavigateToSegment,
  // Chat props
  conversationId = '',
  chatMessages = [],
  chatMessageCount = 0,
  chatDraftInput = '',
  chatSetDraftInput = () => {},
  chatOnSendMessage = () => {},
  chatIsLoading = false,
  chatIsAtLimit = false,
  chatError = null,
  chatOnClearError = () => {},
  chatOnClearHistoryComplete = () => {},
  chatHasOlderMessages = false,
  chatOnLoadOlder = async () => {},
  chatIsLoadingOlder = false,
  conversationTitle = '',
  conversationDurationMs = 0,
  speakers = {},
  chatOnSeek,
  chatOnPlay,
  chatOnHighlight,
  chatSuggestions = [],
  chatCumulativeCostUsd = 0,
  chatCostWarningLevel = 'none',
  // Speaker corrections
  canUndo = false,
  undoStackSize = 0,
  onUndo = () => {},
  onMergeSpeaker = () => {},
  onRenameSpeaker,
  isCorrectionsLoading = false,
  recentMerge = null,
  speakerSegmentCounts = {},
  defaultTab = 'context'
}) => {
  const [activeTab, setActiveTab] = useState<'context' | 'people' | 'speakers' | 'chat'>(defaultTab);
  const [searchTerm, setSearchTerm] = useState('');

  // Filtering based on active tab
  const filteredTerms = terms.filter(t =>
    t.display.toLowerCase().includes(searchTerm.toLowerCase()) ||
    t.aliases.some(a => a.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const filteredPeople = people.filter(p =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (p.affiliation && p.affiliation.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  return (
    <div className="h-full flex flex-col bg-white border-l border-slate-200">

      {/* Search Header (hide for chat and speakers tabs) */}
      {activeTab !== 'chat' && activeTab !== 'speakers' && (
        <div className="p-4 border-b border-slate-200 bg-slate-50/50">
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
            <input
              type="text"
              placeholder={activeTab === 'context' ? "Search terms..." : "Search people..."}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 text-sm bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-slate-900 placeholder:text-slate-400"
            />
          </div>

          {/* Tabs */}
          <div className="grid grid-cols-4 p-1 bg-slate-200/60 rounded-lg gap-1">
            <button
              onClick={() => setActiveTab('context')}
              className={cn(
                "flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded-md transition-all",
                activeTab === 'context'
                  ? "bg-white text-blue-600 shadow-sm"
                  : "text-slate-500 hover:text-slate-700 hover:bg-slate-200/50"
              )}
            >
              <BookOpen size={14} />
              <span className="hidden sm:inline">Context</span>
            </button>
            <button
              onClick={() => setActiveTab('people')}
              className={cn(
                "flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded-md transition-all",
                activeTab === 'people'
                  ? "bg-white text-blue-600 shadow-sm"
                  : "text-slate-500 hover:text-slate-700 hover:bg-slate-200/50"
              )}
            >
              <Users size={14} />
              <span className="hidden sm:inline">People</span>
            </button>
            <button
              onClick={() => setActiveTab('speakers')}
              className="flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded-md transition-all text-slate-500 hover:text-slate-700 hover:bg-slate-200/50"
            >
              <Mic size={14} />
              <span className="hidden sm:inline">Speakers</span>
            </button>
            <button
              onClick={() => setActiveTab('chat')}
              className="flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded-md transition-all relative text-slate-500 hover:text-slate-700 hover:bg-slate-200/50"
            >
              <MessageSquare size={14} />
              <span className="hidden sm:inline">Chat</span>
              {chatMessageCount > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-blue-600 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                  {chatMessageCount > 9 ? '9+' : chatMessageCount}
                </span>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Tab Header for Chat and Speakers (replaces search header when active) */}
      {(activeTab === 'chat' || activeTab === 'speakers') && (
        <div className="p-4 border-b border-slate-200 bg-slate-50/50">
          <div className="grid grid-cols-4 p-1 bg-slate-200/60 rounded-lg gap-1">
            <button
              onClick={() => setActiveTab('context')}
              className={cn(
                "flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded-md transition-all",
                "text-slate-500 hover:text-slate-700 hover:bg-slate-200/50"
              )}
            >
              <BookOpen size={14} />
              <span className="hidden sm:inline">Context</span>
            </button>
            <button
              onClick={() => setActiveTab('people')}
              className={cn(
                "flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded-md transition-all",
                "text-slate-500 hover:text-slate-700 hover:bg-slate-200/50"
              )}
            >
              <Users size={14} />
              <span className="hidden sm:inline">People</span>
            </button>
            <button
              onClick={() => setActiveTab('speakers')}
              className={cn(
                "flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded-md transition-all",
                activeTab === 'speakers'
                  ? "bg-white text-blue-600 shadow-sm"
                  : "text-slate-500 hover:text-slate-700 hover:bg-slate-200/50"
              )}
            >
              <Mic size={14} />
              <span className="hidden sm:inline">Speakers</span>
            </button>
            <button
              onClick={() => setActiveTab('chat')}
              className={cn(
                "flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded-md transition-all relative",
                activeTab === 'chat'
                  ? "bg-white text-blue-600 shadow-sm"
                  : "text-slate-500 hover:text-slate-700 hover:bg-slate-200/50"
              )}
            >
              <MessageSquare size={14} />
              <span className="hidden sm:inline">Chat</span>
              {chatMessageCount > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-blue-600 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                  {chatMessageCount > 9 ? '9+' : chatMessageCount}
                </span>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Content Area */}
      {activeTab === 'chat' ? (
        // --- Chat Tab ---
        <div className="flex-1 overflow-hidden">
          <ChatSidebar
            conversationId={conversationId}
            title={conversationTitle}
            durationMs={conversationDurationMs}
            messages={chatMessages}
            messageCount={chatMessageCount}
            draftInput={chatDraftInput}
            setDraftInput={chatSetDraftInput}
            onSendMessage={chatOnSendMessage}
            isLoading={chatIsLoading}
            isAtLimit={chatIsAtLimit}
            error={chatError}
            onClearError={chatOnClearError}
            speakers={speakers}
            onSeek={chatOnSeek}
            onPlay={chatOnPlay}
            onHighlight={chatOnHighlight}
            onClearHistoryComplete={chatOnClearHistoryComplete}
            hasOlderMessages={chatHasOlderMessages}
            onLoadOlder={chatOnLoadOlder}
            isLoadingOlder={chatIsLoadingOlder}
            suggestions={chatSuggestions}
            cumulativeCostUsd={chatCumulativeCostUsd}
            costWarningLevel={chatCostWarningLevel}
          />
        </div>
      ) : activeTab === 'speakers' ? (
        // --- Speakers Tab ---
        <div className="flex-1 flex flex-col">
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {Object.values(speakers).length === 0 ? (
              <div className="text-center text-slate-500 py-8">
                <Mic size={32} className="mx-auto mb-2 text-slate-300" />
                <p className="text-sm">No speakers identified.</p>
              </div>
            ) : (
              Object.values(speakers).map(speaker => (
                <SpeakerCard
                  key={speaker.speakerId}
                  speaker={speaker}
                  segmentCount={speakerSegmentCounts[speaker.speakerId] || 0}
                  onMerge={() => onMergeSpeaker(speaker.speakerId)}
                  onRename={onRenameSpeaker}
                  isLoading={isCorrectionsLoading}
                  isMergeSource={recentMerge?.sourceSpeakerId === speaker.speakerId}
                  isMergeTarget={recentMerge?.targetSpeakerId === speaker.speakerId}
                />
              ))
            )}
          </div>

          {/* Undo Button at bottom */}
          {canUndo && (
            <div className="p-4 border-t border-slate-200 bg-slate-50/50">
              <Button
                variant="outline"
                onClick={onUndo}
                disabled={isCorrectionsLoading}
                className="w-full flex items-center justify-center gap-2"
              >
                <Undo2 size={14} />
                Undo Last Change{undoStackSize > 1 ? ` (${undoStackSize})` : ''}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {activeTab === 'context' ? (
            // --- Context / Terms List ---
            filteredTerms.length === 0 ? (
               <div className="text-center text-slate-500 py-8">
                 <p className="text-sm">No terms found.</p>
               </div>
            ) : (
              filteredTerms.map(term => (
                <div
                  key={term.termId}
                  id={`term-card-${term.termId}`}
                  onClick={() => onTermSelect(term.termId)}
                  className={cn(
                    "p-3 rounded-lg border transition-all cursor-pointer shadow-sm hover:shadow-md",
                    selectedTermId === term.termId
                      ? "bg-blue-50 border-blue-200 ring-1 ring-blue-300"
                      : "bg-white border-slate-200 hover:border-blue-200"
                  )}
                >
                  <div className="flex justify-between items-start mb-1">
                    <h3 className="font-semibold text-slate-800">{term.display}</h3>
                    <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">DEF</span>
                  </div>
                  <p className="text-sm text-slate-600 leading-snug">
                    {term.definition}
                  </p>
                  {term.aliases.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-slate-100">
                      <p className="text-xs text-slate-400">
                        AKA: {term.aliases.join(', ')}
                      </p>
                    </div>
                  )}
                </div>
              ))
            )
          ) : (
            // --- People List ---
            filteredPeople.length === 0 ? (
              <div className="text-center text-slate-500 py-8">
                <p className="text-sm">No people identified.</p>
              </div>
            ) : (
              filteredPeople.map(person => (
                <PersonCard
                  key={person.personId}
                  person={person}
                  isActive={selectedPersonId === person.personId}
                  onClick={() => onPersonSelect?.(person.personId)}
                  onUpdate={onUpdatePerson}
                  mentions={personMentions ? personMentions[person.personId] : []}
                  onNavigate={onNavigateToSegment}
                />
              ))
            )
          )}
        </div>
      )}
    </div>
  );
};

// Sub-component for Person Card with editable notes and navigation
const PersonCard: React.FC<{
    person: Person;
    isActive?: boolean;
    onClick?: () => void;
    onUpdate: (p: Person) => void;
    mentions?: string[];
    onNavigate?: (segmentId: string) => void;
}> = ({ person, isActive, onClick, onUpdate, mentions = [], onNavigate }) => {
  const [note, setNote] = useState(person.userNotes || '');
  const [currentMentionIdx, setCurrentMentionIdx] = useState(0);

  const handleBlur = () => {
    if (note !== person.userNotes) {
      onUpdate({ ...person, userNotes: note });
    }
  };

  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (mentions.length === 0) return;
    const nextIdx = (currentMentionIdx - 1 + mentions.length) % mentions.length;
    setCurrentMentionIdx(nextIdx);
    onNavigate?.(mentions[nextIdx]);
  };

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (mentions.length === 0) return;
    const nextIdx = (currentMentionIdx + 1) % mentions.length;
    setCurrentMentionIdx(nextIdx);
    onNavigate?.(mentions[nextIdx]);
  };

  // If user just clicks the counter, jump to current without advancing
  const handleJumpToCurrent = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (mentions.length > 0) {
        onNavigate?.(mentions[currentMentionIdx]);
    }
  }

  // When card is clicked, reset to first mention and navigate
  const handleCardClick = () => {
    setCurrentMentionIdx(0);
    onClick?.();
  }

  return (
    <div
        onClick={handleCardClick}
        className={cn(
            "p-3 rounded-lg border transition-all shadow-sm hover:shadow-md cursor-pointer",
            isActive
                ? "bg-purple-50 border-purple-200 ring-1 ring-purple-300"
                : "bg-white border-slate-200 hover:border-purple-200"
        )}
    >
      <div className="flex justify-between items-start mb-2">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 shrink-0">
              <User size={16} />
            </div>
            <div>
              <h3 className="font-semibold text-slate-800 text-sm">{person.name}</h3>
              {person.affiliation && (
                <p className="text-xs text-slate-500 font-medium">{person.affiliation}</p>
              )}
            </div>
          </div>

          {/* Mentions Navigation */}
          {mentions.length > 0 && (
             <div className="flex items-center gap-0.5 bg-slate-50 border border-slate-100 rounded-md p-0.5" title={`${mentions.length} mentions found`}>
                <button
                    onClick={handlePrev}
                    type="button"
                    className="p-1 hover:bg-white hover:text-blue-600 hover:shadow-sm rounded transition-all text-slate-400"
                >
                    <ChevronLeft size={12} />
                </button>
                <button
                    onClick={handleJumpToCurrent}
                    type="button"
                    className="text-[10px] font-medium text-slate-500 px-1 min-w-[30px] text-center hover:text-blue-600 tabular-nums cursor-pointer"
                    title="Jump to current mention"
                >
                    {currentMentionIdx + 1} / {mentions.length}
                </button>
                 <button
                    onClick={handleNext}
                    type="button"
                    className="p-1 hover:bg-white hover:text-blue-600 hover:shadow-sm rounded transition-all text-slate-400"
                >
                    <ChevronRight size={12} />
                </button>
             </div>
          )}
      </div>

      <div className="mt-3 relative">
        <div className="absolute top-2 left-2 text-slate-400 pointer-events-none">
          <StickyNote size={12} />
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onClick={(e) => e.stopPropagation()} // Prevent card selection when clicking textarea
          onBlur={handleBlur}
          placeholder="Add a note..."
          className="w-full text-xs pl-6 p-2 bg-slate-50 border border-slate-100 rounded focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-300 resize-none text-slate-900 placeholder:text-slate-400"
          rows={2}
        />
      </div>
    </div>
  );
};

// Sub-component for Speaker Card with merge button and inline rename
const SpeakerCard: React.FC<{
  speaker: Speaker;
  segmentCount: number;
  onMerge: () => void;
  onRename?: (speakerId: string, newName: string) => Promise<void>;
  isLoading?: boolean;
  isMergeSource?: boolean;
  isMergeTarget?: boolean;
}> = ({ speaker, segmentCount, onMerge, onRename, isLoading = false, isMergeSource = false, isMergeTarget = false }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(speaker.displayName);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [animatingCount, setAnimatingCount] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Reset edit value when speaker changes (e.g., after undo)
  useEffect(() => {
    if (!isEditing) {
      setEditValue(speaker.displayName);
    }
  }, [speaker.displayName, isEditing]);

  // Animate segment count when this speaker is the merge target
  useEffect(() => {
    if (isMergeTarget) {
      setAnimatingCount(true);
      const timer = setTimeout(() => setAnimatingCount(false), 300);
      return () => clearTimeout(timer);
    }
  }, [isMergeTarget, segmentCount]);

  // Get color class for speaker badge
  const getSpeakerColorClass = (colorIndex: number): string => {
    const colors = [
      'bg-blue-100 text-blue-800 border-blue-200',
      'bg-purple-100 text-purple-800 border-purple-200',
      'bg-green-100 text-green-800 border-green-200',
      'bg-orange-100 text-orange-800 border-orange-200',
      'bg-pink-100 text-pink-800 border-pink-200',
      'bg-teal-100 text-teal-800 border-teal-200',
      'bg-yellow-100 text-yellow-800 border-yellow-200',
      'bg-red-100 text-red-800 border-red-200'
    ];
    return colors[colorIndex % colors.length];
  };

  const handleDoubleClick = () => {
    if (onRename && !isLoading) {
      setIsEditing(true);
      setEditValue(speaker.displayName);
      setValidationError(null);
    }
  };

  const validateName = (name: string): string | null => {
    const trimmed = name.trim();
    if (!trimmed) return 'Name cannot be empty';
    if (trimmed.length >= 50) return 'Name must be less than 50 characters';
    return null;
  };

  const handleSave = async () => {
    const trimmed = editValue.trim();
    const error = validateName(trimmed);

    if (error) {
      setValidationError(error);
      return;
    }

    // Don't save if name hasn't changed
    if (trimmed === speaker.displayName) {
      setIsEditing(false);
      return;
    }

    try {
      await onRename?.(speaker.speakerId, trimmed);
      setIsEditing(false);
      setValidationError(null);
    } catch (_err) {
      setValidationError('Failed to rename speaker');
    }
  };

  const handleCancel = () => {
    setIsEditing(false);
    setEditValue(speaker.displayName);
    setValidationError(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  };

  return (
    <div className={cn(
      "p-3 rounded-lg border border-slate-200 bg-white shadow-sm hover:shadow-md transition-all",
      isMergeSource && "opacity-50 scale-95",
      isMergeTarget && "ring-2 ring-green-400 animate-pulse"
    )}>
      <div className="flex justify-between items-center gap-2">
        {/* Speaker info */}
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 shrink-0">
            <Mic size={16} />
          </div>
          <div className="flex-1 min-w-0">
            {isEditing ? (
              // Inline edit mode
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-1">
                  <input
                    ref={inputRef}
                    type="text"
                    value={editValue}
                    onChange={(e) => {
                      setEditValue(e.target.value);
                      setValidationError(null);
                    }}
                    onKeyDown={handleKeyDown}
                    onBlur={() => {
                      // Small delay to allow button clicks to register
                      setTimeout(() => {
                        if (isEditing) handleCancel();
                      }, 150);
                    }}
                    maxLength={50}
                    className={cn(
                      "flex-1 px-2 py-1 text-xs font-medium border rounded focus:outline-none focus:ring-2",
                      validationError
                        ? "border-red-300 focus:ring-red-500"
                        : "border-slate-300 focus:ring-blue-500"
                    )}
                    disabled={isLoading}
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSave();
                    }}
                    disabled={isLoading}
                    className="p-1 text-green-600 hover:bg-green-50 rounded transition-colors"
                    title="Save (Enter)"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCancel();
                    }}
                    disabled={isLoading}
                    className="p-1 text-slate-500 hover:bg-slate-100 rounded transition-colors"
                    title="Cancel (Escape)"
                  >
                    <X size={14} />
                  </button>
                </div>
                {validationError && (
                  <p className="text-[10px] text-red-500">{validationError}</p>
                )}
              </div>
            ) : (
              // Display mode - double-click to edit
              <div className="flex items-center gap-2">
                <div
                  onDoubleClick={handleDoubleClick}
                  className={cn(
                    "px-2 py-1 rounded text-xs font-medium border truncate",
                    getSpeakerColorClass(speaker.colorIndex),
                    onRename && "cursor-text hover:ring-1 hover:ring-blue-300"
                  )}
                  title={onRename ? "Double-click to rename" : undefined}
                >
                  {speaker.displayName}
                </div>
                <span
                  className={cn(
                    "text-[10px] text-slate-400 tabular-nums whitespace-nowrap transition-all duration-300",
                    animatingCount && "text-green-600 font-semibold scale-110"
                  )}
                >
                  {segmentCount} {segmentCount === 1 ? 'segment' : 'segments'}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Merge button - hide during editing */}
        {!isEditing && (
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              onMerge();
            }}
            disabled={isLoading}
            className="text-xs shrink-0"
          >
            Merge
          </Button>
        )}
      </div>
    </div>
  );
};
