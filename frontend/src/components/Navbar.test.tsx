import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

vi.mock('@/context/wallet-context', () => ({
  useWallet: () => ({ session: null, status: 'disconnected' }),
}));

vi.mock('./ModeToggle', () => ({
  ModeToggle: () => <div data-testid="mode-toggle" />,
}));

vi.mock('./wallet/WalletButton', () => ({
  WalletButton: () => <button>Connect Wallet</button>,
}));

vi.mock('./NotificationDropdown', () => ({
  NotificationDropdown: () => <div data-testid="notification-dropdown" />,
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href}>{children}</a>
  ),
}));

import { Navbar } from './Navbar';

describe('Navbar mobile menu toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the mobile menu when the hamburger button is clicked', () => {
    render(<Navbar />);

    expect(screen.queryByTestId('mobile-menu')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));

    expect(screen.getByTestId('mobile-menu')).toBeInTheDocument();
  });

  it('closes the mobile menu when the hamburger button is clicked again', () => {
    render(<Navbar />);

    fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
    expect(screen.getByTestId('mobile-menu')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /close menu/i }));
    expect(screen.queryByTestId('mobile-menu')).not.toBeInTheDocument();
  });
});
