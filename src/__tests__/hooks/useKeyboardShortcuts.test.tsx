import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('should show first-time tooltip when not previously shown', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useKeyboardShortcuts({
      togglePlay: vi.fn(),
      seekBack: vi.fn(),
      seekForward: vi.fn()
    }));

    expect(result.current.showFirstTimeTooltip).toBe(false);

    // Fast-forward past the 1s delay
    act(() => {
      vi.advanceTimersByTime(1100);
    });

    expect(result.current.showFirstTimeTooltip).toBe(true);

    vi.useRealTimers();
  });

  it('should not show tooltip if already shown before', () => {
    localStorage.setItem('keyboard-shortcuts-shown', 'true');
    vi.useFakeTimers();

    const { result } = renderHook(() => useKeyboardShortcuts({
      togglePlay: vi.fn(),
      seekBack: vi.fn(),
      seekForward: vi.fn()
    }));

    act(() => {
      vi.advanceTimersByTime(1100);
    });

    expect(result.current.showFirstTimeTooltip).toBe(false);

    vi.useRealTimers();
  });

  it('should call togglePlay on Space key', () => {
    const togglePlay = vi.fn();
    renderHook(() => useKeyboardShortcuts({
      togglePlay,
      seekBack: vi.fn(),
      seekForward: vi.fn()
    }));

    const event = new KeyboardEvent('keydown', { key: ' ' });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(togglePlay).toHaveBeenCalled();
  });

  it('should call seekBack on ArrowLeft key', () => {
    const seekBack = vi.fn();
    renderHook(() => useKeyboardShortcuts({
      togglePlay: vi.fn(),
      seekBack,
      seekForward: vi.fn()
    }));

    const event = new KeyboardEvent('keydown', { key: 'ArrowLeft' });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(seekBack).toHaveBeenCalled();
  });

  it('should call seekForward on ArrowRight key', () => {
    const seekForward = vi.fn();
    renderHook(() => useKeyboardShortcuts({
      togglePlay: vi.fn(),
      seekBack: vi.fn(),
      seekForward
    }));

    const event = new KeyboardEvent('keydown', { key: 'ArrowRight' });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(seekForward).toHaveBeenCalled();
  });

  it('should not trigger shortcuts when typing in input fields', () => {
    const togglePlay = vi.fn();
    renderHook(() => useKeyboardShortcuts({
      togglePlay,
      seekBack: vi.fn(),
      seekForward: vi.fn()
    }));

    const input = document.createElement('input');
    document.body.appendChild(input);

    const event = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true
    });
    Object.defineProperty(event, 'target', { value: input, enumerable: true });

    act(() => {
      document.dispatchEvent(event);
    });

    expect(togglePlay).not.toHaveBeenCalled();

    document.body.removeChild(input);
  });

  it('should dismiss tooltip and mark as shown', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useKeyboardShortcuts({
      togglePlay: vi.fn(),
      seekBack: vi.fn(),
      seekForward: vi.fn()
    }));

    act(() => {
      vi.advanceTimersByTime(1100);
    });

    expect(result.current.showFirstTimeTooltip).toBe(true);

    act(() => {
      result.current.dismissTooltip();
    });

    expect(result.current.showFirstTimeTooltip).toBe(false);
    expect(localStorage.getItem('keyboard-shortcuts-shown')).toBe('true');

    vi.useRealTimers();
  });

  it('should open and close help modal', () => {
    const { result } = renderHook(() => useKeyboardShortcuts({
      togglePlay: vi.fn(),
      seekBack: vi.fn(),
      seekForward: vi.fn()
    }));

    expect(result.current.helpModalOpen).toBe(false);

    // Open via ? key
    const openEvent = new KeyboardEvent('keydown', { key: '?' });
    act(() => {
      document.dispatchEvent(openEvent);
    });

    expect(result.current.helpModalOpen).toBe(true);

    // Close via Escape key
    const closeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
    act(() => {
      document.dispatchEvent(closeEvent);
    });

    expect(result.current.helpModalOpen).toBe(false);
  });

  it('should call toggleSelectionMode on S key', () => {
    const toggleSelectionMode = vi.fn();
    renderHook(() => useKeyboardShortcuts({
      togglePlay: vi.fn(),
      seekBack: vi.fn(),
      seekForward: vi.fn(),
      toggleSelectionMode
    }));

    const event = new KeyboardEvent('keydown', { key: 's' });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(toggleSelectionMode).toHaveBeenCalledTimes(1);
  });

  it('should call toggleSelectionMode on uppercase S key', () => {
    const toggleSelectionMode = vi.fn();
    renderHook(() => useKeyboardShortcuts({
      togglePlay: vi.fn(),
      seekBack: vi.fn(),
      seekForward: vi.fn(),
      toggleSelectionMode
    }));

    const event = new KeyboardEvent('keydown', { key: 'S' });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(toggleSelectionMode).toHaveBeenCalledTimes(1);
  });

  it('should not call toggleSelectionMode when typing in input field', () => {
    const toggleSelectionMode = vi.fn();
    renderHook(() => useKeyboardShortcuts({
      togglePlay: vi.fn(),
      seekBack: vi.fn(),
      seekForward: vi.fn(),
      toggleSelectionMode
    }));

    const input = document.createElement('input');
    document.body.appendChild(input);

    const event = new KeyboardEvent('keydown', { key: 's', bubbles: true });
    Object.defineProperty(event, 'target', { value: input, enumerable: true });

    act(() => {
      document.dispatchEvent(event);
    });

    expect(toggleSelectionMode).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it('should call exitSelectionMode on Escape when help modal is closed', () => {
    const exitSelectionMode = vi.fn();
    renderHook(() => useKeyboardShortcuts({
      togglePlay: vi.fn(),
      seekBack: vi.fn(),
      seekForward: vi.fn(),
      exitSelectionMode
    }));

    const event = new KeyboardEvent('keydown', { key: 'Escape' });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(exitSelectionMode).toHaveBeenCalledTimes(1);
  });

  it('should close help modal on Escape before calling exitSelectionMode', () => {
    const exitSelectionMode = vi.fn();
    const { result } = renderHook(() => useKeyboardShortcuts({
      togglePlay: vi.fn(),
      seekBack: vi.fn(),
      seekForward: vi.fn(),
      exitSelectionMode
    }));

    // Open help modal first
    const openEvent = new KeyboardEvent('keydown', { key: '?' });
    act(() => {
      document.dispatchEvent(openEvent);
    });
    expect(result.current.helpModalOpen).toBe(true);

    // Escape should close modal, NOT call exitSelectionMode
    const escEvent = new KeyboardEvent('keydown', { key: 'Escape' });
    act(() => {
      document.dispatchEvent(escEvent);
    });

    expect(result.current.helpModalOpen).toBe(false);
    expect(exitSelectionMode).not.toHaveBeenCalled();
  });
});
