import { useEffect, useState } from 'react';

interface KeyboardShortcutsCallbacks {
  togglePlay?: () => void;
  seekBack?: () => void;
  seekForward?: () => void;
  openHelp?: () => void;
  toggleSelectionMode?: () => void;
  exitSelectionMode?: () => void;
}

/**
 * useKeyboardShortcuts - Centralized keyboard shortcut handling
 *
 * Handles global keyboard shortcuts for the viewer:
 * - Space: Play/Pause
 * - ← or J: Seek back 5s
 * - → or K: Seek forward 5s
 * - S: Toggle selection mode (for multi-segment speaker reassignment)
 * - ?: Open keyboard shortcuts help modal
 * - Escape: Exit selection mode + clear, or close modal
 *
 * Ignores events when user is typing in form fields.
 * Shows a first-time tooltip to introduce keyboard shortcuts.
 */
export const useKeyboardShortcuts = (callbacks: KeyboardShortcutsCallbacks) => {
  const [showFirstTimeTooltip, setShowFirstTimeTooltip] = useState(false);
  const [helpModalOpen, setHelpModalOpen] = useState(false);

  // Check if this is the first time seeing keyboard shortcuts
  useEffect(() => {
    const hasSeenTooltip = localStorage.getItem('keyboard-shortcuts-shown');
    if (!hasSeenTooltip) {
      // Show tooltip after a brief delay so it doesn't appear jarring on page load
      const timer = setTimeout(() => {
        setShowFirstTimeTooltip(true);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, []);

  // Mark tooltip as seen and hide it
  const dismissTooltip = () => {
    localStorage.setItem('keyboard-shortcuts-shown', 'true');
    setShowFirstTimeTooltip(false);
  };

  // Global keyboard event listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if user is typing in a form field
      const target = e.target as HTMLElement;
      const isFormField =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;

      if (isFormField) return;

      // Handle shortcuts
      switch (e.key) {
        case ' ':
          e.preventDefault(); // Prevent page scroll
          callbacks.togglePlay?.();
          if (showFirstTimeTooltip) {
            dismissTooltip();
          }
          break;

        case 'ArrowLeft':
        case 'j':
        case 'J':
          e.preventDefault();
          callbacks.seekBack?.();
          if (showFirstTimeTooltip) {
            dismissTooltip();
          }
          break;

        case 'ArrowRight':
        case 'k':
        case 'K':
          e.preventDefault();
          callbacks.seekForward?.();
          if (showFirstTimeTooltip) {
            dismissTooltip();
          }
          break;

        case 's':
        case 'S':
          e.preventDefault();
          callbacks.toggleSelectionMode?.();
          break;

        case '?':
          e.preventDefault();
          callbacks.openHelp?.();
          setHelpModalOpen(true);
          if (showFirstTimeTooltip) {
            dismissTooltip();
          }
          break;

        case 'Escape':
          // Help modal gets first dibs — close it before anything else
          if (helpModalOpen) {
            setHelpModalOpen(false);
          } else {
            callbacks.exitSelectionMode?.();
          }
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [callbacks, showFirstTimeTooltip, helpModalOpen]);

  return {
    showFirstTimeTooltip,
    dismissTooltip,
    helpModalOpen,
    openHelpModal: () => setHelpModalOpen(true),
    closeHelpModal: () => setHelpModalOpen(false)
  };
};
