import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RefreshButton } from './refresh-button';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

const refreshDashboard = vi.fn().mockResolvedValue(undefined);
vi.mock('./refresh-action', () => ({
  refreshDashboard: () => refreshDashboard(),
}));

function renderButton(props: { bustsGithubCache?: boolean } = {}) {
  return render(
    <MantineProvider>
      <RefreshButton
        generatedAt={new Date().toISOString()}
        initialLabel="just now"
        {...props}
      />
    </MantineProvider>,
  );
}

describe('RefreshButton', () => {
  it('drops the cached GitHub read on the pages that render it', async () => {
    refresh.mockClear();
    refreshDashboard.mockClear();
    renderButton({ bustsGithubCache: true });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    // Refresh has to mean "go ask GitHub again" - re-rendering off the cache
    // would look like a dead button.
    await waitFor(() => expect(refreshDashboard).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('leaves the GitHub cache alone on pages that do not read it', async () => {
    refresh.mockClear();
    refreshDashboard.mockClear();
    // The session pages read Firestore/GCS only. Busting the GitHub tag from
    // there would force the next Queue visit to repeat ~30 requests for
    // state that never changed.
    renderButton();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(refreshDashboard).not.toHaveBeenCalled();
  });
});
