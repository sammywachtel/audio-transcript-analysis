import React, { useEffect } from 'react';
import { X, Play, SkipBack, SkipForward, HelpCircle, MousePointerClick } from 'lucide-react';

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * KeyboardShortcutsModal - Modal listing all keyboard shortcuts
 *
 * Organized by category for easy scanning.
 * Accessible via ? key from anywhere in the viewer.
 */
export const KeyboardShortcutsModal: React.FC<KeyboardShortcutsModalProps> = ({
  isOpen,
  onClose
}) => {
  // Close on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const shortcuts = [
    {
      category: 'Playback',
      items: [
        { keys: ['Space'], description: 'Play / Pause', icon: <Play size={16} /> },
        { keys: ['←', 'J'], description: 'Seek back 5 seconds', icon: <SkipBack size={16} /> },
        { keys: ['→', 'K'], description: 'Seek forward 5 seconds', icon: <SkipForward size={16} /> }
      ]
    },
    {
      category: 'Selection',
      items: [
        { keys: ['S'], description: 'Toggle selection mode', icon: <MousePointerClick size={16} /> },
        { keys: ['Esc'], description: 'Exit selection & clear', icon: <X size={16} /> }
      ]
    },
    {
      category: 'Help',
      items: [
        { keys: ['?'], description: 'Show this help', icon: <HelpCircle size={16} /> },
        { keys: ['Esc'], description: 'Close modal', icon: <X size={16} /> }
      ]
    }
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-white w-full max-w-md rounded-xl shadow-2xl p-6 scale-100 animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
      >
        {/* Header */}
        <div className="flex justify-between items-center mb-6">
          <h3 id="shortcuts-title" className="text-lg font-semibold text-slate-900">
            Keyboard Shortcuts
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 transition-colors"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Shortcuts by category */}
        <div className="space-y-6">
          {shortcuts.map((category) => (
            <div key={category.category}>
              <h4 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">
                {category.category}
              </h4>
              <div className="space-y-2">
                {category.items.map((item, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-slate-50"
                  >
                    <div className="flex items-center gap-3">
                      <div className="text-slate-400">{item.icon}</div>
                      <span className="text-sm text-slate-700">{item.description}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      {item.keys.map((key, keyIdx) => (
                        <React.Fragment key={keyIdx}>
                          {keyIdx > 0 && (
                            <span className="text-xs text-slate-400 mx-1">or</span>
                          )}
                          <kbd className="px-2 py-1 text-xs font-mono bg-slate-100 border border-slate-300 rounded shadow-sm">
                            {key}
                          </kbd>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer tip */}
        <div className="mt-6 pt-4 border-t border-slate-100">
          <p className="text-xs text-slate-500 text-center">
            Shortcuts work anywhere except when typing in text fields
          </p>
        </div>
      </div>
    </div>
  );
};
