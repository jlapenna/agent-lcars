import { MantineProvider } from '@mantine/core';
import { act, cleanup, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShellReadouts } from '../lib/shell-readouts';
import {
  AccountIdentity,
  ConsoleIdentity,
  ConsoleLiveStatus,
  RailEnvironment,
  RailReadouts,
  ReadoutStrip,
} from './console-frame-readouts';
import { ConsoleNavRail } from './console-nav-rail';
import { ConsoleNavigationProvider } from './console-navigation-context';
import {
  publishLiveState,
  resetShellStateForTests,
  ShellIdentityProvider,
} from './console-shell-state';

vi.mock('next/link', () => ({
  default: ({ children, ...props }: { children: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

const admin: ShellReadouts = {
  user: {
    login: 'jlapenna',
    initials: 'JL',
    grants: ['admin', 'work.operator'],
  },
  environment: 'lcars.example.test',
  fleet: { online: 11, capacity: 12 },
  queueDepth: 9,
  liveRuns: 7,
  decisions: 5,
  tokens24h: 3_180_000,
  merged24h: 14,
  observedAt: '2026-10-13T00:00:00.000Z',
};

function respond(body: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => body })),
  );
}

async function renderFrame() {
  render(
    <MantineProvider>
      <RailReadouts />
      <ConsoleIdentity />
      <ConsoleNavRail current="deck" />
    </MantineProvider>,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('console frame readouts', () => {
  beforeEach(() => resetShellStateForTests());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the maintainer figures, identity and destination counts', async () => {
    respond(admin);
    await renderFrame();
    expect(screen.getByTestId('rail-readout-fleet')).toHaveTextContent(
      '11/12CI runners online',
    );
    expect(screen.getByTestId('rail-readout-queue')).toHaveTextContent('09');
    expect(screen.getByTestId('rail-readout-tokens')).toHaveTextContent(
      '3.18M',
    );
    expect(screen.getByTestId('rail-readout-merged')).toHaveTextContent('14');
    expect(screen.getByTestId('console-identity')).toHaveTextContent(
      'jlapennaadmin · work.operator',
    );
    expect(screen.getByRole('link', { name: 'Inbox' })).toHaveTextContent(
      '02 · 5Inbox',
    );
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveTextContent(
      '03 · 7',
    );
    expect(screen.getByRole('link', { name: 'Work' })).toHaveTextContent(
      '05 · 9',
    );
  });

  it('marks a missing maintainer figure unavailable instead of zero', async () => {
    respond({ ...admin, fleet: undefined, merged24h: undefined });
    await renderFrame();
    expect(screen.getByTestId('rail-readout-fleet')).toHaveTextContent('—');
    expect(screen.getByTestId('rail-readout-merged')).toHaveTextContent('—');
  });

  it('marks a destination count it could not vouch for as unavailable', async () => {
    respond({ ...admin, decisions: undefined });
    await renderFrame();
    expect(screen.getByRole('link', { name: 'Inbox' })).toHaveTextContent(
      '02 · —',
    );
  });

  it('keeps a snapshot time fixed and shows no sync time before a sync', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
      respond(admin);
      render(<ConsoleLiveStatus />);
      await act(async () => {
        await Promise.resolve();
      });
      const status = screen.getByTestId('console-live-status');
      const loaded = status.textContent;
      expect(loaded).toContain('Snapshot');
      expect(loaded).toContain('loaded');
      await act(async () => {
        vi.advanceTimersByTime(5 * 60_000);
      });
      expect(status.textContent).toBe(loaded);

      act(() => publishLiveState({ mode: 'connecting', label: 'Connecting' }));
      expect(status).toHaveTextContent('Connecting');
      expect(status).not.toHaveTextContent('synced');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a cached snapshot data age instead of its load time', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
      respond(admin);
      render(<ConsoleLiveStatus dataAt="2026-10-12T08:00:00Z" />);
      await act(async () => {
        await Promise.resolve();
      });
      const status = screen.getByTestId('console-live-status');
      expect(status).toHaveTextContent('Snapshot · data 1d ago');
      expect(status).not.toHaveTextContent('loaded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives narrow headers the same status on one line', async () => {
    respond(admin);
    render(<ConsoleLiveStatus compact />);
    await act(async () => {
      await Promise.resolve();
    });
    const status = screen.getByTestId('console-live-status-compact');
    expect(status).toHaveTextContent('Snapshot');
    expect(status).not.toHaveTextContent('refresh to update');
    expect(status).toHaveClass('console-live-status--compact');
  });

  it('repeats the rail readouts on one line for narrow screens', async () => {
    respond(admin);
    render(<ReadoutStrip />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('strip-readout-fleet')).toHaveTextContent(
      '11/12 CI runners',
    );
    expect(screen.getByTestId('strip-readout-queue')).toHaveTextContent(
      '09 queue',
    );
    expect(screen.getByTestId('strip-readout-merged')).toHaveTextContent(
      '14 merged 24h',
    );
  });

  it('says from the first render whether the strip will carry figures', () => {
    const { container, rerender } = render(<ReadoutStrip />);
    // Outside a limited navigation (a maintainer): figures to reserve.
    expect(container.firstElementChild).toHaveAttribute('data-figures', '');
    rerender(
      <ConsoleNavigationProvider navigationKeys={['work']}>
        <ReadoutStrip />
      </ConsoleNavigationProvider>,
    );
    expect(container.firstElementChild).not.toHaveAttribute('data-figures');
  });

  it('draws no maintainer marks for a limited session whose read fails', async () => {
    respond({ error: 'Console readouts unavailable' }, false);
    render(
      <ConsoleNavigationProvider navigationKeys={['work']}>
        <ReadoutStrip />
      </ConsoleNavigationProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('strip-readout-fleet')).toBeNull();
  });

  it('holds the rail environment line before the readouts arrive', async () => {
    respond(admin);
    render(<RailEnvironment />);
    // A non-breaking space, so the bottom-aligned head does not move.
    expect(screen.getByTestId('rail-environment').textContent).toBe('\u00a0');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('rail-environment')).toHaveTextContent(
      'lcars.example.test',
    );
  });

  it('names the signed-in identity on the Settings page', async () => {
    respond(admin);
    render(<AccountIdentity />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const identity = screen.getByTestId('console-identity-account');
    expect(identity).toHaveTextContent('JL');
    expect(identity).toHaveTextContent('jlapenna admin · work.operator');
  });

  it('marks a partial token total as a lower bound', async () => {
    respond({ ...admin, tokens24hPartial: true });
    await renderFrame();
    expect(screen.getByTestId('rail-readout-tokens')).toHaveTextContent(
      '3.18M+',
    );
  });

  it('shows no maintainer figures to other sessions', async () => {
    respond({
      user: { login: 'operator', initials: 'OP', grants: ['work.operator'] },
      environment: 'lcars.example.test',
      observedAt: admin.observedAt,
    });
    await renderFrame();
    expect(screen.getByTestId('rail-readout-fleet')).toBeEmptyDOMElement();
    expect(screen.getByRole('link', { name: 'Inbox' })).not.toHaveTextContent(
      '·',
    );
  });

  it('marks every figure unavailable when the read fails', async () => {
    respond({}, false);
    await renderFrame();
    expect(screen.getByTestId('rail-readout-queue')).toHaveTextContent(
      '—Queue depth',
    );
    expect(screen.queryByTestId('console-identity')).toBeNull();
  });
});

describe('the frame at first paint', () => {
  beforeEach(() => resetShellStateForTests());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the served identity before the readouts arrive', () => {
    const html = renderToStaticMarkup(
      <ShellIdentityProvider identity={admin}>
        <RailEnvironment />
        <ConsoleIdentity />
        <AccountIdentity />
      </ShellIdentityProvider>,
    );
    expect(html).toContain('lcars.example.test');
    expect(html).toContain('data-testid="console-identity"');
    expect(html).toContain('data-testid="console-identity-account"');
    expect(html).toContain('admin · work.operator');
  });

  it('holds the load time slot until the page has loaded', () => {
    const html = renderToStaticMarkup(<ConsoleLiveStatus />);
    expect(html).toContain('console-live-status__reserve');
    expect(html).toContain(' · loaded 00:00:00');
  });

  it('lets the readouts replace the served identity', async () => {
    respond({
      ...admin,
      user: { login: 'operator', initials: 'OP', grants: ['work.operator'] },
    });
    render(
      <ShellIdentityProvider identity={admin}>
        <ConsoleIdentity />
        <ConsoleLiveStatus />
      </ShellIdentityProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('console-identity')).toHaveTextContent(
      'operator',
    );
    expect(screen.getByTestId('console-identity')).not.toHaveTextContent(
      'jlapenna',
    );
    expect(
      screen
        .getByTestId('console-live-status')
        .querySelector('.console-live-status__reserve'),
    ).toBeNull();
  });
});
