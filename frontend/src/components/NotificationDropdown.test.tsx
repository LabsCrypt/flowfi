import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
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

describe('NotificationDropdown unread badge', () => {
    const bell = () => screen.getByRole('button', { name: /^notifications/i });

    // Event objects are reused between renders, exactly like useStreamEvents,
    // which prepends new events to the same buffered objects.
    const makeEvent = (streamId: number, timestamp = 1_700_000_000_000 + streamId) => ({
        type: 'created',
        data: { streamId },
        timestamp,
    });

    // Lets the queued notification updates settle.
    const flush = () => act(async () => {});

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('increments by exactly one per new event while closed', async () => {
        const first = makeEvent(1);
        mockStream({ events: [first] });
        const { rerender } = render(<NotificationDropdown publicKey={PUBLIC_KEY} />);
        await flush();
        expect(bell()).toHaveAccessibleName('Notifications, 1 unread');

        const second = makeEvent(2);
        mockStream({ events: [second, first] });
        rerender(<NotificationDropdown publicKey={PUBLIC_KEY} />);
        await flush();
        expect(bell()).toHaveAccessibleName('Notifications, 2 unread');

        const third = makeEvent(3);
        mockStream({ events: [third, second, first] });
        rerender(<NotificationDropdown publicKey={PUBLIC_KEY} />);
        await flush();
        expect(bell()).toHaveAccessibleName('Notifications, 3 unread');
    });

    it('does not resurrect cleared unread counts when the dropdown closes', async () => {
        mockStream({ events: [makeEvent(2), makeEvent(1)] });
        render(<NotificationDropdown publicKey={PUBLIC_KEY} />);
        await flush();
        expect(bell()).toHaveAccessibleName('Notifications, 2 unread');

        await openDropdown();
        expect(bell()).toHaveAccessibleName('Notifications');

        await userEvent.click(screen.getByRole('button', { name: 'Close notifications' }));
        await flush();
        expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument();
        expect(bell()).toHaveAccessibleName('Notifications');

        // Re-opening and closing again keeps the count at zero too.
        await openDropdown();
        await userEvent.click(bell());
        await flush();
        expect(bell()).toHaveAccessibleName('Notifications');
    });

    it('does not count events that arrive while the dropdown is open', async () => {
        const first = makeEvent(1);
        mockStream({ events: [first] });
        const { rerender } = render(<NotificationDropdown publicKey={PUBLIC_KEY} />);
        await flush();
        await openDropdown();

        const second = makeEvent(2);
        mockStream({ events: [second, first] });
        rerender(<NotificationDropdown publicKey={PUBLIC_KEY} />);
        await flush();
        expect(await screen.findByText('New stream #2 created')).toBeInTheDocument();

        await userEvent.click(screen.getByRole('button', { name: 'Close notifications' }));
        await flush();
        expect(bell()).toHaveAccessibleName('Notifications');

        mockStream({ events: [makeEvent(3), second, first] });
        rerender(<NotificationDropdown publicKey={PUBLIC_KEY} />);
        await flush();
        expect(bell()).toHaveAccessibleName('Notifications, 1 unread');
    });

    it('keeps every same-type event that shares a millisecond timestamp', async () => {
        const timestamp = 1_700_000_000_000;
        mockStream({
            events: [makeEvent(9, timestamp), makeEvent(8, timestamp), makeEvent(7, timestamp)],
        });
        render(<NotificationDropdown publicKey={PUBLIC_KEY} />);
        await flush();
        expect(bell()).toHaveAccessibleName('Notifications, 3 unread');

        await openDropdown();
        expect(screen.getByText('New stream #9 created')).toBeInTheDocument();
        expect(screen.getByText('New stream #8 created')).toBeInTheDocument();
        expect(screen.getByText('New stream #7 created')).toBeInTheDocument();
    });
});
