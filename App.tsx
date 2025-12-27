import React, { useState } from 'react';
import { Library } from './pages/Library';
import { Viewer } from './pages/Viewer';
import { AdminDashboard } from './pages/AdminDashboard';
import { UserStats } from './pages/UserStats';
import { AuthProvider } from './contexts/AuthContext';
import { ConversationProvider, useConversations } from './contexts/ConversationContext';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { AdminRoute } from './components/auth/AdminRoute';

/**
 * AppContent - Main app routing logic
 *
 * Handles view switching between Library, Viewer, Admin Dashboard, and User Stats.
 * Admin dashboard is gated by AdminRoute component.
 */
function AppContent() {
  const [currentView, setCurrentView] = useState<'library' | 'viewer' | 'admin' | 'stats'>('library');
  const { isLoaded, activeConversation, setActiveConversationId } = useConversations();

  const handleOpen = (id: string) => {
    setActiveConversationId(id);
    setCurrentView('viewer');
  };

  const handleBack = () => {
    setCurrentView('library');
    setActiveConversationId(null);
  };

  const handleAdminClick = () => {
    setCurrentView('admin');
  };

  const handleAdminBack = () => {
    setCurrentView('library');
  };

  const handleStatsClick = () => {
    setCurrentView('stats');
  };

  const handleStatsBack = () => {
    setCurrentView('library');
  };

  if (!isLoaded) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-slate-50 text-slate-400">
        Loading...
      </div>
    );
  }

  if (currentView === 'admin') {
    return (
      <AdminRoute fallback={<Library onOpen={handleOpen} onAdminClick={handleAdminClick} onStatsClick={handleStatsClick} />}>
        <AdminDashboard onBack={handleAdminBack} />
      </AdminRoute>
    );
  }

  if (currentView === 'stats') {
    return <UserStats onBack={handleStatsBack} />;
  }

  if (currentView === 'viewer' && activeConversation) {
    return <Viewer onBack={handleBack} />;
  }

  return <Library onOpen={handleOpen} onAdminClick={handleAdminClick} onStatsClick={handleStatsClick} />;
}

/**
 * App - Root component with nested Context Providers
 *
 * Provider hierarchy (outer to inner):
 * 1. AuthProvider - Manages user authentication state
 * 2. ConversationProvider - Manages conversation state (depends on auth)
 * 3. ProtectedRoute - Gates access to app content (requires auth)
 * 4. AppContent - Main app UI
 *
 * This structure ensures:
 * - Auth state is available to ConversationProvider
 * - Conversations are filtered by authenticated user
 * - Users must sign in before accessing the app
 */
function App() {
  return (
    <AuthProvider>
      <ConversationProvider>
        <ProtectedRoute>
          <AppContent />
        </ProtectedRoute>
      </ConversationProvider>
    </AuthProvider>
  );
}

export default App;
