import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HowItWorks } from './HowItWorks';

/**
 * Locks the rendered output after the step copy was extracted into a typed
 * `STEPS` array (issue #1123) — the extraction must be purely structural.
 */
describe('HowItWorks', () => {
    it('renders each step number, title and description', () => {
        render(<HowItWorks />);

        expect(screen.getByText('01')).toBeInTheDocument();
        expect(screen.getByText('Connect & Configure')).toBeInTheDocument();
        expect(
            screen.getByText(/Link your treasury wallet and select the assets you want to stream/),
        ).toBeInTheDocument();

        expect(screen.getByText('02')).toBeInTheDocument();
        expect(screen.getByText('Define Parameters')).toBeInTheDocument();

        expect(screen.getByText('03')).toBeInTheDocument();
        expect(screen.getByText('Stream is Live')).toBeInTheDocument();
    });

    it('renders exactly three steps under the section anchor', () => {
        const { container } = render(<HowItWorks />);

        expect(container.querySelector('#how-it-works')).toBeInTheDocument();
        expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(3);
    });

    it('draws a connector after every step except the last', () => {
        const { container } = render(<HowItWorks />);

        // Three step SVG connectors minus the trailing one.
        expect(container.querySelectorAll('svg')).toHaveLength(2);
    });
});
