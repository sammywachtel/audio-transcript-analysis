import React, { useState } from 'react';
import { Library } from './pages/Library';
import { Viewer } from './pages/Viewer';
import { ConversationProvider, useConversations } from './contexts/ConversationContext';

/**
 * AppContent - Main app routing logic
 *
 * Simplified to just handle view switching. All state management
 * is delegated to ConversationContext. Much cleaner than before.
 */
function AppContent() {
  const [currentView, setCurrentView] = useState<'library' | 'viewer'>('library');
  const { isLoaded, activeConversation, setActiveConversationId } = useConversations();

  const handleOpen = (id: string) => {
    setActiveConversationId(id);
    setCurrentView('viewer');
  };

  const handleBack = () => {
    setCurrentView('library');
    setActiveConversationId(null);
  };

  if (!isLoaded) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-slate-50 text-slate-400">
        Loading...
      </div>
    );
  }

  if (currentView === 'viewer' && activeConversation) {
    return <Viewer onBack={handleBack} />;
  }

  return <Library onOpen={handleOpen} />;
}

/**
 * App - Root component with Context Provider
 *
 * Wraps everything in ConversationProvider so child components
 * can access conversation state via useConversations hook.
 */
function App() {
  return (
    <ConversationProvider>
      <AppContent />
    </ConversationProvider>
  );
}

export default App;
