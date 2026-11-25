import { fireEvent, render } from '@testing-library/react';
import { createContext, type ReactNode, useContext } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleNavRail } from './console-nav-rail';

// Each mocked Link tells useLinkStatus its own href, like Next's per-link
// status context, so a test can put exactly one navigation in flight.
const link = vi.hoisted(() => ({
  pendingHref: undefined as string | undefined,
}));
const HrefContext = createContext<string | undefined>(undefined);

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    prefetch,
    ...props
  }: {
    children: ReactNode;
    href: string;
    prefetch?: boolean | 'auto' | null;
  }) => (
    <HrefContext.Provider value={href}>
      <a href={href} data-prefetch={String(prefetch)} {...props}>
        {children}
      </a>
    </HrefContext.Provider>
  ),
  useLinkStatus: () => ({
    pending: useContext(HrefContext) === link.pendingHref,
  }),
}));

afterEach(() => {
  link.pendingHref = undefined;
});

describe('ConsoleNavRail pending signal', () => {
  it('shows nothing while no navigation is in flight', () => {
    const { container } = render(<ConsoleNavRail current="deck" />);
    expect(container.querySelector('.lcars-nav-pending')).toBeNull();
  });

  it('marks only the pill whose navigation is in flight', () => {
    link.pendingHref = '/work';
    const { container } = render(<ConsoleNavRail current="deck" />);
    const markers = [...container.querySelectorAll('.lcars-nav-pending')];
    expect(markers.map((m) => m.closest('a')?.getAttribute('href'))).toEqual([
      '/work',
    ]);
    expect(markers[0].getAttribute('aria-hidden')).toBe('true');
  });
});

describe('ConsoleNavRail prefetch', () => {
  const prefetchOf = (container: HTMLElement, href: string) =>
    container.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!.dataset[
      'prefetch'
    ];

  it('prefetches no section on sight', () => {
    const { container } = render(<ConsoleNavRail current="deck" />);
    const pills = [...container.querySelectorAll('a')];
    expect(pills.length).toBeGreaterThan(1);
    expect(pills.map((pill) => pill.dataset['prefetch'])).toEqual(
      pills.map(() => 'false'),
    );
  });

  it.each(['mouseEnter', 'focus', 'touchStart'] as const)(
    'restores the default prefetch for one section on %s',
    (event) => {
      const { container } = render(<ConsoleNavRail current="deck" />);
      fireEvent[event](container.querySelector('a[href="/work"]')!);
      expect(prefetchOf(container, '/work')).toBe('auto');
      expect(prefetchOf(container, '/inbox')).toBe('false');
    },
  );
});
