import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: pushMock }),
}));

const useStreamEventsMock = vi.fn();
vi.mock('@/hooks/useStreamEvents', () => ({
    useStreamEvents: (...args: unknown[]) => useStreamEventsMock(...args),
}));

// Imported after the mock registrations above.
import { NotificationDropdown } from './NotificationDropdown';

const PUBLIC_KEY = 'GDQERNIEDLE6SCKEAPO3ULKK5QQKFM3UIJMJQNBMKXPQR6HDYQTM2WO';

const mockStream = (overrides: { events?: unknown[]; connected?: boolean } = {}) => {
    useStreamEventsMock.mockReturnValue({
        events: overrides.events ?? [],
        connected: overrides.connected ?? true,
        error: null,
        reconnecting: false,
        clearEvents: vi.fn(),
    });
};

const openDropdown = async () => {
    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));
    return screen.getByRole('dialog', { name: 'Notifications' });
};

describe('NotificationDropdown empty state', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('explains that there is nothing to show when the list is empty', async () => {
        mockStream();
        render(<NotificationDropdown publicKey={PUBLIC_KEY} />);

        await openDropdown();

        expect(screen.getByTestId('notifications-empty-state')).toBeInTheDocument();
        expect(screen.getByText('No notifications yet')).toBeInTheDocument();
        expect(
            screen.getByText(/You're all caught up\. Stream activity will show up here\./),
        ).toBeInTheDocument();
    });

    it('does not leave the dropdown body blank', async () => {
        mockStream();
        render(<NotificationDropdown publicKey={PUBLIC_KEY} />);

        const dialog = await openDropdown();

        // The header and footer always render; the point of this assertion is
        // that the scrollable list region itself carries explanatory copy.
        expect(screen.getByTestId('notifications-empty-state').textContent?.trim()).not.toBe('');
        expect(dialog).toHaveTextContent('Notifications');
        expect(dialog).toHaveTextContent('View All Activity');
    });

    it('disables the bell while the event stream is disconnected', () => {
        mockStream({ connected: false });
        render(<NotificationDropdown publicKey={PUBLIC_KEY} />);

        expect(screen.getByRole('button', { name: /notifications/i })).toBeDisabled();
    });

    it('renders notifications instead of the empty state once events arrive', async () => {
        mockStream({
            events: [
                {
                    type: 'created',
                    data: { streamId: 7 },
                    timestamp: 1_700_000_000_000,
                },
            ],
        });
        render(<NotificationDropdown publicKey={PUBLIC_KEY} />);

        await openDropdown();

        expect(await screen.findByText('New stream #7 created')).toBeInTheDocument();
        expect(screen.queryByTestId('notifications-empty-state')).not.toBeInTheDocument();
    });
});
