import React, { useState, useRef, useEffect } from 'react';
import { Play, Pause, SkipBack, SkipForward, Volume2, SlidersHorizontal } from 'lucide-react';
import { formatTime, cn } from '../../utils';

interface AudioPlayerProps {
  durationMs: number;
  currentTimeMs: number;
  isPlaying: boolean;
  onPlayPause: () => void;
  onSeek: (ms: number) => void;
  onScrub?: (ms: number) => void;
  // Manual sync offset control
  syncOffset?: number;
  onSyncOffsetChange?: (offset: number) => void;
}

export const AudioPlayer: React.FC<AudioPlayerProps> = ({
  durationMs,
  currentTimeMs,
  isPlaying,
  onPlayPause,
  onSeek,
  onScrub,
  syncOffset = 0,
  onSyncOffsetChange
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [sliderValue, setSliderValue] = useState(0);
  const [showSyncControls, setShowSyncControls] = useState(false);
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

      {/* Sync Offset Controls */}
      <div className="hidden md:flex items-center gap-2 text-slate-500 text-sm font-medium">
        {onSyncOffsetChange && (
          <div className="relative">
            <button
              onClick={() => setShowSyncControls(!showSyncControls)}
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded transition-colors",
                showSyncControls ? "bg-blue-100 text-blue-700" : "hover:bg-slate-100 hover:text-slate-800",
                syncOffset !== 0 && "text-amber-600"
              )}
              title="Adjust transcript sync offset"
            >
              <SlidersHorizontal size={16} />
              <span className="tabular-nums text-xs">
                {syncOffset === 0 ? 'Sync' : `${syncOffset > 0 ? '+' : ''}${(syncOffset / 1000).toFixed(1)}s`}
              </span>
            </button>

            {/* Sync offset popup */}
            {showSyncControls && (
              <div className="absolute bottom-full right-0 mb-2 p-3 bg-white rounded-lg shadow-lg border border-slate-200 w-64 z-50">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-semibold text-slate-700">Sync Offset</span>
                  <button
                    onClick={() => onSyncOffsetChange(0)}
                    className="text-xs text-blue-600 hover:text-blue-800"
                  >
                    Reset
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onSyncOffsetChange(syncOffset - 1000)}
                    className="px-2 py-1 bg-slate-100 hover:bg-slate-200 rounded text-xs font-medium"
                  >
                    -1s
                  </button>
                  <button
                    onClick={() => onSyncOffsetChange(syncOffset - 500)}
                    className="px-1.5 py-1 bg-slate-100 hover:bg-slate-200 rounded text-xs"
                  >
                    -0.5s
                  </button>
                  <span className="flex-1 text-center tabular-nums font-medium text-slate-800">
                    {syncOffset > 0 ? '+' : ''}{(syncOffset / 1000).toFixed(1)}s
                  </span>
                  <button
                    onClick={() => onSyncOffsetChange(syncOffset + 500)}
                    className="px-1.5 py-1 bg-slate-100 hover:bg-slate-200 rounded text-xs"
                  >
                    +0.5s
                  </button>
                  <button
                    onClick={() => onSyncOffsetChange(syncOffset + 1000)}
                    className="px-2 py-1 bg-slate-100 hover:bg-slate-200 rounded text-xs font-medium"
                  >
                    +1s
                  </button>
                </div>
                <input
                  type="range"
                  min={-30000}
                  max={30000}
                  step={500}
                  value={syncOffset}
                  onChange={(e) => onSyncOffsetChange(Number(e.target.value))}
                  className="w-full h-1.5 mt-3 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                />
                <div className="flex justify-between text-[10px] text-slate-400 mt-1">
                  <span>-30s</span>
                  <span>0</span>
                  <span>+30s</span>
                </div>
                <p className="text-[10px] text-slate-500 mt-2">
                  {syncOffset > 0
                    ? "Transcript highlights later (audio is behind)"
                    : syncOffset < 0
                      ? "Transcript highlights earlier (audio is ahead)"
                      : "No offset applied"}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Volume placeholder */}
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
