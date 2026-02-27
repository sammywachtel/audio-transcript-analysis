import React, { useState, useCallback, useEffect, useRef } from 'react';

const STORAGE_KEY = 'sidebar-panel-width';
const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 280;
// Max is 50% of viewport — computed dynamically during drag

function loadWidth(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = Number(stored);
      if (Number.isFinite(parsed) && parsed >= MIN_WIDTH) return parsed;
    }
  } catch {
    // localStorage unavailable (private browsing, etc.) — not the end of the world
  }
  return DEFAULT_WIDTH;
}

function saveWidth(width: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Same as above — we tried
  }
}

/**
 * Drag-to-resize for a sidebar panel.
 *
 * Returns the current width, whether a drag is in progress, and a
 * `handleProps` object to spread onto the drag-handle element.
 *
 * Width is clamped between MIN_WIDTH and 50vw and persisted to localStorage.
 */
export function usePanelResize() {
  const [width, setWidth] = useState(loadWidth);
  const [isDragging, setIsDragging] = useState(false);

  // Refs let the pointermove handler read fresh values without re-subscribing
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  // Persist width whenever it settles (not on every pixel of drag)
  useEffect(() => {
    if (!isDragging) saveWidth(width);
  }, [isDragging, width]);

  // Kill text selection while dragging — nobody wants to highlight half the page mid-resize
  useEffect(() => {
    if (isDragging) {
      document.body.style.userSelect = 'none';
      return () => { document.body.style.userSelect = ''; };
    }
  }, [isDragging]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    // Handle moves left = sidebar grows (handle is on the left edge)
    const dx = startXRef.current - e.clientX;
    const maxWidth = window.innerWidth * 0.5;
    const next = Math.min(maxWidth, Math.max(MIN_WIDTH, startWidthRef.current + dx));
    setWidth(next);
  }, []);

  const onPointerUp = useCallback(() => {
    setIsDragging(false);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
  }, [onPointerMove]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      setIsDragging(true);
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    },
    [width, onPointerMove, onPointerUp],
  );

  // Safety net: clean up listeners if the component unmounts mid-drag
  useEffect(() => {
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  return {
    width,
    isDragging,
    handleProps: {
      onPointerDown,
      style: { cursor: 'col-resize' } as React.CSSProperties,
    },
  };
}
