import { renderHook, act, render } from '@testing-library/react';
import { useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useModalDialog } from './useModalDialog';

describe('useModalDialog', () => {
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onClose = vi.fn();
    document.body.style.overflow = '';
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.style.overflow = '';
    document.body.innerHTML = '';
  });

  it('should set body overflow to hidden on mount and restore on unmount', () => {
    const { unmount } = renderHook(() =>
      useModalDialog({ onClose })
    );

    expect(document.body.style.overflow).toBe('hidden');

    unmount();

    expect(document.body.style.overflow).toBe('');
  });

  it('should call onClose when Escape is pressed', async () => {
    renderHook(() => useModalDialog({ onClose }));

    await act(async () => {
      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      window.dispatchEvent(event);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('should NOT call onClose when Escape is pressed and isCloseDisabled is true', async () => {
    renderHook(() =>
      useModalDialog({ onClose, isCloseDisabled: true })
    );

    await act(async () => {
      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      window.dispatchEvent(event);
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('should wrap focus from last to first element on Tab', async () => {
    function TestComponent() {
      const dialogRef = useModalDialog({ onClose });
      return (
        <div ref={dialogRef}>
          <button>First</button>
          <button>Last</button>
        </div>
      );
    }

    render(<TestComponent />);

    const buttons = document.querySelectorAll('button');
    const lastButton = buttons[1];
    const firstButton = buttons[0];

    if (!lastButton || !firstButton) throw new Error('buttons not found');

    lastButton.focus();
    expect(document.activeElement).toBe(lastButton);

    await act(async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
      });
      window.dispatchEvent(event);
    });

    expect(document.activeElement).toBe(firstButton);
  });

  it('should wrap focus from first to last element on Shift+Tab', async () => {
    function TestComponent() {
      const dialogRef = useModalDialog({ onClose });
      return (
        <div ref={dialogRef}>
          <button>First</button>
          <button>Last</button>
        </div>
      );
    }

    render(<TestComponent />);

    const buttons = document.querySelectorAll('button');
    const firstButton = buttons[0];
    const lastButton = buttons[1];

    if (!firstButton || !lastButton) throw new Error('buttons not found');

    firstButton.focus();
    expect(document.activeElement).toBe(firstButton);

    await act(async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
      });
      window.dispatchEvent(event);
    });

    expect(document.activeElement).toBe(lastButton);
  });

  it('should restore focus to previously focused element on unmount', () => {
    const previouslyFocused = document.createElement('button');
    previouslyFocused.textContent = 'Previously focused';
    document.body.appendChild(previouslyFocused);
    previouslyFocused.focus();
    expect(document.activeElement).toBe(previouslyFocused);

    const { unmount } = renderHook(() => useModalDialog({ onClose }));

    unmount();

    expect(document.activeElement).toBe(previouslyFocused);
  });
});
