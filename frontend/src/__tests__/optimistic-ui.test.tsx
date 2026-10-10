import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import type { CachedStream } from '@/lib/storage/stream-cache';

const mocks = vi.hoisted(() => {
  const stream: CachedStream = {
    id: 'stream-1',
    sender: '0xSender',
    recipient: '0xRecipient',
    tokenAddress: '0xUSDC',
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
    depositedAmount: '1000000000',
    withdrawnAmount: '0',
    claimableAmount: '500000000',
    status: 'active',
    updatedAt: 1_700_000_000_000,
  };
  return {
    stream,
    getCachedStreams: vi.fn(async () => [stream]),
    getOptimisticMutations: vi.fn(async () => []),
    putCachedStream: vi.fn(async () => undefined),
    putCachedStreams: vi.fn(async () => undefined),
    putOptimisticMutation: vi.fn(async () => undefined),
    deleteOptimisticMutation: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/storage/stream-cache', () => ({
  getCachedStreams: mocks.getCachedStreams,
  getOptimisticMutations: mocks.getOptimisticMutations,
  putCachedStream: mocks.putCachedStream,
  putCachedStreams: mocks.putCachedStreams,
  putOptimisticMutation: mocks.putOptimisticMutation,
  deleteOptimisticMutation: mocks.deleteOptimisticMutation,
}));

import { StreamProvider } from '@/context/StreamContext';
import { StreamCard } from '@/components/dashboard/StreamCard';

function renderCard(commit?: (ctx: unknown) => Promise<unknown>) {
  return render(
    <StreamProvider>
      <StreamCard streamId="stream-1" commit={commit as never} />
    </StreamProvider>,
  );
}

describe('optimistic ui + IndexedDB cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hydrates from IndexedDB immediately without a blocking spinner', async () => {
    renderCard();
    const card = await screen.findByTestId('stream-card-stream-1');
    expect(card).toBeInTheDocument();
    expect(screen.queryByTestId('stream-skeleton')).not.toBeInTheDocument();
    expect(mocks.getCachedStreams).toHaveBeenCalledTimes(1);
    expect(mocks.getOptimisticMutations).toHaveBeenCalledTimes(1);
  });

  it('optimistically updates withdrawn + claimable on withdraw', async () => {
    const commit = vi.fn(async () => ({}));
    renderCard(commit);

    await screen.findByTestId('stream-card-stream-1');
    expect(screen.getByTestId('stream-withdrawn').textContent).toMatch(/^0$/);
    expect(screen.getByTestId('stream-claimable').textContent).toMatch(/^500$/);

    await act(async () => {
      fireEvent.click(screen.getByTestId('stream-withdraw-btn'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('stream-withdrawn').textContent).toMatch(/^500$/);
    });
    expect(screen.getByTestId('stream-claimable').textContent).toMatch(/^0$/);
  });

  it('shows the pending ledger badge while the mutation is in flight', async () => {
    let resolveCommit: (value: unknown) => void = () => undefined;
    const commit = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCommit = resolve;
        }),
    );
    renderCard(commit);

    await screen.findByTestId('stream-card-stream-1');
    await act(async () => {
      fireEvent.click(screen.getByTestId('stream-withdraw-btn'));
    });

    expect(await screen.findByTestId('pending-badge')).toHaveTextContent(
      /Pending Ledger Confirmation/i,
    );

    await act(async () => {
      resolveCommit({});
    });

    await waitFor(() => {
      expect(screen.queryByTestId('pending-badge')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('stream-withdrawn').textContent).toMatch(/^500$/);
  });

  it('rolls back on transaction failure and surfaces an error', async () => {
    const commit = vi.fn(async () => {
      throw new Error('reverted on-chain');
    });
    renderCard(commit);

    await screen.findByTestId('stream-card-stream-1');
    await act(async () => {
      fireEvent.click(screen.getByTestId('stream-withdraw-btn'));
    });

    expect(await screen.findByTestId('stream-error')).toHaveTextContent(/reverted on-chain/i);

    await waitFor(() => {
      expect(screen.getByTestId('stream-withdrawn').textContent).toMatch(/^0$/);
    });
    expect(screen.getByTestId('stream-claimable').textContent).toMatch(/^500$/);
    expect(screen.queryByTestId('pending-badge')).not.toBeInTheDocument();
  });

  it('cancels the stream optimistically', async () => {
    let resolveCommit: (value: unknown) => void = () => undefined;
    const commit = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCommit = resolve;
        }),
    );
    renderCard(commit);

    await screen.findByTestId('stream-card-stream-1');
    await act(async () => {
      fireEvent.click(screen.getByTestId('stream-cancel-btn'));
    });

    // Badge visible while pending.
    expect(await screen.findByTestId('pending-badge')).toBeInTheDocument();

    // Resolve — badge clears, card remains.
    await act(async () => {
      resolveCommit({});
    });

    await waitFor(() => {
      expect(screen.queryByTestId('pending-badge')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('stream-card-stream-1')).toBeInTheDocument();
  });
});
