import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BridgePaneLink } from './bridge-pane-link';

function setDesktop(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function renderLink() {
  render(
    <MantineProvider>
      <BridgePaneLink
        mobileHref="/task/agent/lcars/42"
        paneHref="/?sel=run%3A42"
      >
        Open task
      </BridgePaneLink>
    </MantineProvider>,
  );
  return screen.getByRole('link', { name: 'Open task' });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BridgePaneLink', () => {
  it('points at the selection in the right pane on desktop', async () => {
    setDesktop(true);
    const link = renderLink();

    await waitFor(() => expect(link).toHaveAttribute('href', '/?sel=run%3A42'));
  });

  it('leaves mobile activation pointed at the canonical full-page view', () => {
    setDesktop(false);
    const link = renderLink();

    expect(link).toHaveAttribute('href', '/task/agent/lcars/42');
  });

  it('starts with the canonical destination until the viewport is known', () => {
    vi.unstubAllGlobals();
    const link = renderLink();
    expect(link).toHaveAttribute('href', '/task/agent/lcars/42');
  });
});
