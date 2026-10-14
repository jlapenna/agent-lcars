import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DecisionSlaMeta, DecisionWaiting } from './decision-waiting';

describe('decision SLA readouts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks a row over SLA in the warn ink', () => {
    const { container } = render(
      <DecisionWaiting since="2026-10-14T08:48:00Z" />,
    );
    const span = container.firstElementChild;
    expect(span).toHaveTextContent('waiting 3h ago · over SLA');
    expect(span).toHaveClass('ops-inbox__late');
  });

  it('leaves an on-time row plain, then flags it once it crosses the SLA', () => {
    const { container } = render(
      <DecisionWaiting since="2026-10-14T10:01:00Z" />,
    );
    const span = container.firstElementChild;
    expect(span).toHaveTextContent('waiting 1h ago');
    expect(span).not.toHaveTextContent('over SLA');
    expect(span).not.toHaveClass('ops-inbox__late');

    act(() => {
      vi.advanceTimersByTime(90_000);
    });
    expect(span).toHaveTextContent('over SLA');
    expect(span).toHaveClass('ops-inbox__late');
  });

  it('summarises the panel as "N over SLA · oldest X"', () => {
    render(
      <DecisionSlaMeta
        waitingSince={[
          '2026-10-14T11:46:00Z',
          '2026-10-14T08:48:00Z',
          '2026-10-14T09:40:00Z',
        ]}
      />,
    );
    expect(screen.getByTestId('decision-sla-meta')).toHaveTextContent(
      '2 over SLA · oldest 3h ago',
    );
  });

  it('shows only the oldest age while nothing is late', () => {
    render(<DecisionSlaMeta waitingSince={['2026-10-14T11:46:00Z']} />);
    expect(screen.getByTestId('decision-sla-meta')).toHaveTextContent(
      /^oldest 14m ago$/,
    );
  });

  it('renders nothing when no decision waits', () => {
    const { container } = render(<DecisionSlaMeta waitingSince={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
