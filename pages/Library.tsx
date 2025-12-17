import React, { useState, useRef, useCallback } from 'react';
import { Conversation } from '../types';
import { formatTime, cn } from '../utils';
import { transcriptionService } from '../services/transcriptionService';
import { useConversations } from '../contexts/ConversationContext';
import { FileAudio, Calendar, Clock, ChevronRight, UploadCloud, X, Loader2, File as FileIcon, AlertCircle, Trash2, Database } from 'lucide-react';
import { Button } from '../components/Button';

interface LibraryProps {
  onOpen: (id: string) => void;
}

export const Library: React.FC<LibraryProps> = ({ onOpen }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { conversations, addConversation, deleteConversation } = useConversations();

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (confirm('Are you sure you want to delete this conversation?')) {
      deleteConversation(id);
    }
  };

  const handleUpload = async (conversation: Conversation) => {
    await addConversation(conversation);
    setIsModalOpen(false);
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6 md:p-12">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
             <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold text-slate-900">Library</h1>
                <span className="px-2 py-0.5 rounded-full bg-slate-200/60 text-slate-600 text-[10px] font-medium border border-slate-300/50 flex items-center gap-1.5 cursor-help" title="Data is stored locally in this browser/origin. It does not sync across devices or different URLs.">
                    <Database size={10} />
                    Local Storage
                </span>
             </div>
             <p className="text-slate-500 mt-1">Your transcribed conversations and meetings.</p>
          </div>
          <Button
            onClick={() => setIsModalOpen(true)}
            className="gap-2 shadow-lg shadow-blue-500/20"
          >
             <UploadCloud size={18} />
             Upload Audio
          </Button>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            {/* Table Header */}
            <div className="grid grid-cols-12 gap-4 p-4 border-b border-slate-100 bg-slate-50/50 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                <div className="col-span-6 md:col-span-5">Name</div>
                <div className="col-span-3 md:col-span-2">Date</div>
                <div className="col-span-3 md:col-span-2 text-right md:text-left">Duration</div>
                <div className="hidden md:block col-span-2">Status</div>
                <div className="hidden md:block col-span-1"></div>
            </div>

            {/* List */}
            <div className="divide-y divide-slate-100">
                {conversations.length === 0 ? (
                  <div className="p-12 text-center text-slate-500">
                    <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
                      <FileAudio size={32} className="opacity-50" />
                    </div>
                    <p className="font-medium">No conversations yet</p>
                    <p className="text-sm mt-1">Upload an audio file to get started</p>
                  </div>
                ) : (
                  conversations.map(conv => (
                    <div
                        key={conv.conversationId}
                        onClick={() => onOpen(conv.conversationId)}
                        className="grid grid-cols-12 gap-4 p-4 items-center hover:bg-blue-50/30 transition-colors cursor-pointer group"
                    >
                        <div className="col-span-6 md:col-span-5 flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center shrink-0">
                                <FileAudio size={20} />
                            </div>
                            <div className="min-w-0">
                                <h3 className="font-medium text-slate-900 truncate group-hover:text-blue-700 transition-colors">
                                    {conv.title}
                                </h3>
                                <p className="text-xs text-slate-500 truncate">
                                    {Object.values(conv.speakers).length} speakers • {conv.topics.length} topics
                                </p>
                            </div>
                        </div>
                        <div className="col-span-3 md:col-span-2 flex items-center gap-2 text-sm text-slate-600">
                            <Calendar size={14} className="text-slate-400" />
                            {new Date(conv.createdAt).toLocaleDateString()}
                        </div>
                        <div className="col-span-3 md:col-span-2 flex items-center gap-2 text-sm text-slate-600 justify-end md:justify-start">
                             <Clock size={14} className="text-slate-400" />
                             {formatTime(conv.durationMs)}
                        </div>
                        <div className="hidden md:flex col-span-2 items-center">
                            <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
                                {conv.status}
                            </span>
                        </div>
                        <div className="hidden md:flex col-span-1 justify-end items-center gap-2">
                             <button
                                onClick={(e) => handleDelete(e, conv.conversationId)}
                                className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors opacity-0 group-hover:opacity-100"
                                title="Delete conversation"
                             >
                                <Trash2 size={16} />
                             </button>
                             <div className="text-slate-400 group-hover:text-blue-500">
                                <ChevronRight size={20} />
                             </div>
                        </div>
                    </div>
                ))
              )}
            </div>
        </div>
      </div>

      {isModalOpen && (
        <UploadModal
          onClose={() => setIsModalOpen(false)}
          onUpload={handleUpload}
        />
      )}
    </div>
  );
};

// --- Upload Modal Component ---

const UploadModal: React.FC<{ onClose: () => void; onUpload: (conv: Conversation) => Promise<void> }> = ({ onClose, onUpload }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [uploadState, setUploadState] = useState<'idle' | 'uploading' | 'saving' | 'done' | 'error'>('idle');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (file.type.startsWith('audio/') || file.type.startsWith('video/')) {
        setSelectedFile(file);
        setErrorMessage(null);
      } else {
        setErrorMessage("Please upload a valid audio or video file.");
      }
    }
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
       const file = e.target.files[0];
       setSelectedFile(file);
       setErrorMessage(null);
    }
  };

  const handleStartUpload = async () => {
    if (!selectedFile) return;
    setUploadState('uploading');
    setErrorMessage(null);

    try {
      const conversation = await transcriptionService.processAudio(selectedFile);

      setUploadState('saving');
      await onUpload(conversation);

      setUploadState('done');
    } catch (error) {
      console.error(error);
      setUploadState('error');
      setErrorMessage("Failed to process audio. Please check your API key and try again.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="bg-white w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden scale-100 animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h2 className="text-lg font-semibold text-slate-900">Upload Conversation</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {uploadState === 'idle' || uploadState === 'error' ? (
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "border-2 border-dashed rounded-xl p-10 flex flex-col items-center justify-center text-center cursor-pointer transition-all duration-200 relative",
                isDragging
                  ? "border-blue-500 bg-blue-50"
                  : selectedFile
                    ? "border-emerald-500 bg-emerald-50"
                    : "border-slate-300 hover:border-blue-400 hover:bg-slate-50",
                uploadState === 'error' && "border-red-300 bg-red-50"
              )}
            >
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileSelect}
                className="hidden"
                accept="audio/*,video/*"
              />

              {selectedFile ? (
                <div className="text-emerald-700 animate-in fade-in slide-in-from-bottom-2">
                  <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-3">
                    <FileIcon size={24} />
                  </div>
                  <p className="font-medium text-sm">{selectedFile.name}</p>
                  <p className="text-xs opacity-75 mt-1">{(selectedFile.size / (1024 * 1024)).toFixed(2)} MB</p>
                  <p className="text-xs text-emerald-600 font-medium mt-4">Click to change file</p>
                </div>
              ) : (
                <div className="text-slate-500">
                  <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-3">
                    <UploadCloud size={24} />
                  </div>
                  <p className="font-medium text-slate-900">Click to upload or drag and drop</p>
                  <p className="text-sm mt-1">MP3, M4A, WAV (Max 20MB)</p>
                </div>
              )}
            </div>
          ) : (
            <div className="py-12 flex flex-col items-center justify-center text-center">
              {uploadState === 'uploading' ? (
                <>
                  <Loader2 size={40} className="text-blue-500 animate-spin mb-4" />
                  <h3 className="text-lg font-medium text-slate-900">Processing with Gemini...</h3>
                  <p className="text-slate-500 text-sm mt-1">Transcribing and analyzing speakers</p>
                </>
              ) : uploadState === 'saving' ? (
                <>
                  <Loader2 size={40} className="text-blue-500 animate-spin mb-4" />
                  <h3 className="text-lg font-medium text-slate-900">Saving to Library...</h3>
                  <p className="text-slate-500 text-sm mt-1">Storing audio and metadata</p>
                </>
              ) : (
                <>
                  <div className="w-12 h-12 bg-green-100 text-green-600 rounded-full flex items-center justify-center mb-4 animate-in zoom-in">
                    <FileAudio size={24} />
                  </div>
                  <h3 className="text-lg font-medium text-slate-900">Ready!</h3>
                </>
              )}
            </div>
          )}

          {errorMessage && (
            <div className="mt-4 flex items-center gap-2 text-red-600 text-sm bg-red-50 p-3 rounded-lg animate-in fade-in slide-in-from-top-1">
              <AlertCircle size={16} />
              {errorMessage}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="bg-slate-50 px-6 py-4 flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose} disabled={uploadState === 'uploading' || uploadState === 'saving'}>
            Cancel
          </Button>
          <Button
            onClick={handleStartUpload}
            disabled={!selectedFile || (uploadState !== 'idle' && uploadState !== 'error')}
            className={cn((uploadState === 'uploading' || uploadState === 'saving' || uploadState === 'done') && "opacity-0 hidden")}
          >
            Process Recording
          </Button>
        </div>
      </div>
    </div>
  );
};
