import React, { useState, useEffect } from 'react';
import { Library } from './pages/Library';
import { Viewer } from './pages/Viewer';
import { MOCK_CONVERSATION } from './constants';
import { Conversation } from './types';
import { loadConversationsFromDB, saveConversationToDB, deleteConversationFromDB } from './db';

function App() {
  const [currentView, setCurrentView] = useState<'library' | 'viewer'>('library');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([MOCK_CONVERSATION]);
  const [isLoaded, setIsLoaded] = useState(false);

  // Load persistence on mount
  useEffect(() => {
    const loadData = async () => {
      try {
        const stored = await loadConversationsFromDB();
        if (stored.length > 0) {
          setConversations(stored);
        }
      } catch (e) {
        console.error("Failed to load history", e);
      } finally {
        setIsLoaded(true);
      }
    };
    loadData();
  }, []);

  const handleOpen = (id: string) => {
    setActiveId(id);
    setCurrentView('viewer');
  };

  const handleBack = () => {
    setCurrentView('library');
    setActiveId(null);
  };

  const handleUpload = async (newConversation: Conversation) => {
    try {
      // Persist first to ensure data safety
      await saveConversationToDB(newConversation);
      // Then update UI
      setConversations(prev => [newConversation, ...prev]);
    } catch (err) {
      console.error("Failed to save upload", err);
      alert("Failed to save conversation to database. Please try again.");
      throw err; // Re-throw so the modal knows it failed
    }
  };

  const handleDelete = async (id: string) => {
    try {
        setConversations(prev => prev.filter(c => c.conversationId !== id));
        await deleteConversationFromDB(id);
    } catch (err) {
        console.error("Failed to delete conversation", err);
        // revert if needed, but for now simple log
    }
  };

  const handleUpdateConversation = (updated: Conversation) => {
    setConversations(prev =>
      prev.map(c => c.conversationId === updated.conversationId ? updated : c)
    );
    saveConversationToDB(updated).catch(err =>
      console.error("Failed to save updates", err)
    );
  };

  // Find the active conversation
  const activeConversation = conversations.find(c => c.conversationId === activeId);

  if (!isLoaded) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-slate-50 text-slate-400">
        Loading...
      </div>
    );
  }

  if (currentView === 'viewer' && activeConversation) {
    return (
      <Viewer
        initialData={activeConversation}
        onBack={handleBack}
        onUpdate={handleUpdateConversation}
      />
    );
  }

  return (
    <Library
      conversations={conversations}
      onOpen={handleOpen}
      onUpload={handleUpload}
      onDelete={handleDelete}
    />
  );
}

export default App;
