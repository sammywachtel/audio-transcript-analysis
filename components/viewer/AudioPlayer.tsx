import React, { useState, useRef, useEffect } from 'react';
import { Play, Pause, SkipBack, SkipForward, Volume2 } from 'lucide-react';
import { formatTime, cn } from '../../utils';

interface AudioPlayerProps {
  durationMs: number;
  currentTimeMs: number;
  isPlaying: boolean;
  onPlayPause: () => void;
  onSeek: (ms: number) => void;
  onScrub?: (ms: number) => void;
}

export const AudioPlayer: React.FC<AudioPlayerProps> = ({
  durationMs,
  currentTimeMs,
  isPlaying,
  onPlayPause,
  onSeek,
  onScrub
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [sliderValue, setSliderValue] = useState(0);
  const sliderRef = useRef<HTMLInputElement>(null);
  const isDraggingRef = useRef(false); // Ref to track dragging in event listeners

  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    setSliderValue(val);

    // While dragging, we update the visual scrub (if supported) but not the actual audio playback until release
    if (onScrub && isDraggingRef.current) {
      onScrub(val);
    }
  };

  // Store onSeek in a ref so the global listener always has the latest version
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  const commitSeek = (value: number) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    setIsDragging(false);
    onSeekRef.current(value);
  };

  const handlePointerDown = () => {
    isDraggingRef.current = true;
    setIsDragging(true);
    setSliderValue(currentTimeMs);
  };

  // onPointerUp on the element itself - best case scenario
  const handlePointerUp = (e: React.PointerEvent<HTMLInputElement>) => {
    commitSeek(Number(e.currentTarget.value));
  };

  // Fallback: global listener catches releases outside the slider bounds
  useEffect(() => {
    const handleGlobalPointerUp = () => {
      if (isDraggingRef.current && sliderRef.current) {
        isDraggingRef.current = false;
        setIsDragging(false);
        onSeekRef.current(Number(sliderRef.current.value));
      }
    };

    document.addEventListener('pointerup', handleGlobalPointerUp);
    document.addEventListener('pointercancel', handleGlobalPointerUp);

    return () => {
      document.removeEventListener('pointerup', handleGlobalPointerUp);
      document.removeEventListener('pointercancel', handleGlobalPointerUp);
    };
  }, []); // No dependencies - uses refs for latest values

  // Determine what value to show:
  // If dragging, show local state (smooth visual).
  // If not dragging, show prop (actual audio time).
  const displayValue = isDragging ? sliderValue : currentTimeMs;

  return (
    <div className="h-16 bg-white border-t border-slate-200 flex items-center px-4 md:px-8 gap-4 md:gap-8 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] z-20">

      {/* Controls */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => onSeek(Math.max(0, currentTimeMs - 5000))}
          className="p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-full transition-colors"
        >
          <SkipBack size={20} />
        </button>

        <button
          onClick={onPlayPause}
          className="w-10 h-10 flex items-center justify-center bg-blue-600 text-white rounded-full hover:bg-blue-700 transition-colors shadow-sm focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
        >
          {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" className="ml-0.5" />}
        </button>

        <button
          onClick={() => onSeek(Math.min(durationMs, currentTimeMs + 5000))}
          className="p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-full transition-colors"
        >
          <SkipForward size={20} />
        </button>
      </div>

      {/* Progress Bar (Native Range Input) */}
      <div className="flex-1 flex flex-col justify-center gap-1.5">
        <div className="flex justify-between text-xs font-medium text-slate-500 tabular-nums select-none">
          <span>{formatTime(displayValue)}</span>
          <span>{formatTime(durationMs)}</span>
        </div>

        <div className="relative w-full h-4 flex items-center">
            <input
                ref={sliderRef}
                type="range"
                min={0}
                max={durationMs || 1000} // Prevent 0 max
                value={displayValue}
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
                onChange={handleSeekChange}
                className="absolute w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                style={{
                    backgroundSize: `${(displayValue * 100) / (durationMs || 1)}% 100%`,
                    backgroundImage: 'linear-gradient(#2563eb, #2563eb)',
                    backgroundRepeat: 'no-repeat'
                }}
            />
        </div>
      </div>

      {/* Speed / Volume Placeholder */}
      <div className="hidden md:flex items-center gap-4 text-slate-500 text-sm font-medium">
         <div className="flex items-center gap-2 cursor-pointer hover:text-slate-800">
            <Volume2 size={18} />
         </div>
         <div className="cursor-pointer hover:text-slate-800 px-2 py-1 rounded hover:bg-slate-100">
            1.0x
         </div>
      </div>
    </div>
  );
};
