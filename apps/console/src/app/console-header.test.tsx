import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ConsoleHeader } from './console-header';

function renderHeader(current: 'queue' | 'agents' | 'sessions' | 'costs') {
  return render(
    <MantineProvider>
      <ConsoleHeader
        current={current}
        title="Cost Ledger"
        subtitle="last 14 days"
      />
    </MantineProvider>,
  );
}

describe('ConsoleHeader nav rail', () => {
  it('offers every console destination', () => {
    renderHeader('queue');

    expect(
      screen.getByRole('navigation', { name: 'Console sections' }),
    ).toBeTruthy();
    for (const [name, href] of [
      ['Queue', '/'],
      ['Agents', '/agents'],
      ['Sessions', '/sessions'],
      ['Costs', '/costs'],
    ]) {
      expect(screen.getByRole('link', { name }).getAttribute('href')).toBe(
        href,
      );
    }
  });

  // Costs is a destination of its own since #192 ("a whole separate page,
  // not embedded in sessions, even as a tab"), so it has to mark itself
  // current the same way the other three do rather than leaving Sessions
  // lit while the cost ledger is on screen.
  it('marks the page it is on as current, including Costs', () => {
    renderHeader('costs');

    expect(
      screen.getByRole('link', { name: 'Costs' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(
      screen
        .getByRole('link', { name: 'Sessions' })
        .getAttribute('aria-current'),
    ).toBeNull();
  });
});
