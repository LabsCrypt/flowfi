import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';

// ─── LiveCounter ──────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

// Import after vi.mock registrations
import LiveCounter from '../components/Livecounter';
import { CancelConfirmModal } from '../components/stream-creation/CancelConfirmModal';
import { RecipientStep } from '../components/stream-creation/RecipientStep';
import { AmountStep } from '../components/stream-creation/AmountStep';

describe('LiveCounter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders the initial amount', () => {
    render(<LiveCounter initial={42} label="Streamed" />);
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('ticks up every second when not paused', () => {
    render(<LiveCounter initial={0} label="Streamed" />);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('does not tick when isPaused=true', () => {
    render(<LiveCounter initial={10} label="Streamed" isPaused />);
    act(() => { vi.advanceTimersByTime(5000); });
    // Amount should remain at initial value (not increment)
    expect(screen.queryByText('15')).not.toBeInTheDocument();
  });

  it('displays paused status indicator when isPaused', () => {
    render(<LiveCounter initial={0} isPaused pausedAt={new Date().toISOString()} />);
    // Component shows "Paused now" or similar text — not the counter label
    const label = screen.queryByText('Streamed');
    expect(label).not.toBeInTheDocument();
  });

  it('hides the streamed counter when isPaused becomes true', () => {
    const { rerender } = render(<LiveCounter initial={5} label="Streamed" />);
    act(() => { vi.advanceTimersByTime(3000); });
    rerender(<LiveCounter initial={5} label="Streamed" isPaused />);
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });
});

// ─── CancelConfirmModal ───────────────────────────────────────────────────────

// Stub Button so we don't need the full UI library in tests
vi.mock('../components/ui/Button', () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));

describe('CancelConfirmModal', () => {
  const baseProps = {
    streamId: 'stream-42',
    recipient: 'GDEF456ABC789GHI012JKL345MNO678PQR901STU234VWX567YZA123BCD',
    token: 'USDC',
    deposited: 1000,
    withdrawn: 200,
    onConfirm: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders stream details correctly', () => {
    render(<CancelConfirmModal {...baseProps} />);
    expect(screen.getByText('Cancel Stream?')).toBeInTheDocument();
    expect(screen.getByText('stream-42')).toBeInTheDocument();
  });

  it('calls onClose when "Keep Stream" button is clicked', () => {
    render(<CancelConfirmModal {...baseProps} />);
    fireEvent.click(screen.getByText('Keep Stream'));
    expect(baseProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onConfirm with streamId when "Yes, Cancel Stream" is clicked', async () => {
    render(<CancelConfirmModal {...baseProps} />);
    await act(async () => {
      fireEvent.click(screen.getByText('Yes, Cancel Stream'));
    });
    expect(baseProps.onConfirm).toHaveBeenCalledWith('stream-42');
  });

  it('calls onClose when Escape key is pressed', () => {
    render(<CancelConfirmModal {...baseProps} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(baseProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when Escape key is pressed while submitting', async () => {
    let resolveConfirm!: () => void;
    const slowConfirm = vi.fn(
      () => new Promise<void>((res) => { resolveConfirm = res; }),
    );
    render(<CancelConfirmModal {...baseProps} onConfirm={slowConfirm} />);

    // Trigger the submit to enter submitting state
    await act(async () => {
      fireEvent.click(screen.getByText('Yes, Cancel Stream'));
    });

    // Component is in submitting state — Escape should be ignored
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(baseProps.onClose).not.toHaveBeenCalled();

    // Resolve and clean up
    await act(async () => { resolveConfirm(); });
  });

  it('shows remaining = deposited - withdrawn', () => {
    render(<CancelConfirmModal {...baseProps} />);
    // remaining = 1000 - 200 = 800
    const matches = screen.getAllByText(/800/);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]).toBeInTheDocument();
  });
});

// ─── RecipientStep ────────────────────────────────────────────────────────────

describe('RecipientStep', () => {
  it('renders the input field', () => {
    render(<RecipientStep value="" onChange={vi.fn()} />);
    expect(screen.getByPlaceholderText(/GABCDEF/i)).toBeInTheDocument();
  });

  it('calls onChange when the user types', () => {
    const onChange = vi.fn();
    render(<RecipientStep value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'GABC' } });
    expect(onChange).toHaveBeenCalledWith('GABC');
  });

  it('shows the error message when error prop is provided', () => {
    render(<RecipientStep value="" onChange={vi.fn()} error="Invalid key" />);
    expect(screen.getByText('Invalid key')).toBeInTheDocument();
  });

  it('does not show an error when error prop is absent', () => {
    render(<RecipientStep value="" onChange={vi.fn()} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// ─── AmountStep ──────────────────────────────────────────────────────────────

describe('AmountStep', () => {
  it('renders the amount input', () => {
    render(<AmountStep value="" onChange={vi.fn()} token="USDC" />);
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();
  });

  it('calls onChange when value changes', () => {
    const onChange = vi.fn();
    render(<AmountStep value="" onChange={onChange} token="USDC" />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '50' } });
    expect(onChange).toHaveBeenCalledWith('50');
  });

  it('shows an error message when error prop is provided', () => {
    render(<AmountStep value="" onChange={vi.fn()} error="Amount too low" />);
    expect(screen.getByText('Amount too low')).toBeInTheDocument();
  });

  it('calls onSetMax when Max button is clicked', () => {
    const onSetMax = vi.fn();
    render(
      <AmountStep
        value=""
        onChange={vi.fn()}
        token="USDC"
        availableBalance="100"
        onSetMax={onSetMax}
      />,
    );
    fireEvent.click(screen.getByText('Max'));
    expect(onSetMax).toHaveBeenCalledTimes(1);
  });

  it('Max button is disabled when no balance is available', () => {
    render(<AmountStep value="" onChange={vi.fn()} token="USDC" availableBalance={null} />);
    expect(screen.getByText('Max')).toBeDisabled();
  });

  it('shows a preview when a positive amount is entered without errors', () => {
    render(<AmountStep value="25" onChange={vi.fn()} token="XLM" />);
    expect(screen.getByText(/25 XLM/i)).toBeInTheDocument();
  });
});
