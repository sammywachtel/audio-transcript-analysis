import React, { useState, useRef, useEffect } from 'react';
import { X } from 'lucide-react';
import { Button } from '../Button';

interface RenameSpeakerModalProps {
  initialName: string;
  onClose: () => void;
  onSave: (name: string) => void;
}

/**
 * RenameSpeakerModal - Modal dialog for renaming a speaker
 *
 * Auto-focuses and selects the input text on open for quick editing.
 * Extracted from Viewer.tsx to reduce component complexity.
 */
export const RenameSpeakerModal: React.FC<RenameSpeakerModalProps> = ({
  initialName,
  onClose,
  onSave
}) => {
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
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Save Changes</Button>
          </div>
        </form>
      </div>
    </div>
  );
};
