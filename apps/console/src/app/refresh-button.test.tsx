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

function renderButton(props: { refreshesAuthoritativeQueue?: boolean } = {}) {
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
  it('refreshes the authoritative queue before rerendering pages that render it', async () => {
    refresh.mockClear();
    refreshDashboard.mockClear();
    renderButton({ refreshesAuthoritativeQueue: true });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    // Refresh has to invalidate the projection cache before rerendering, or
    // the button would appear not to have done anything.
    await waitFor(() => expect(refreshDashboard).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('only rerenders pages that do not render the authoritative queue', async () => {
    refresh.mockClear();
    refreshDashboard.mockClear();
    // Detail pages do not render the queue. Invalidating it here would cause
    // the next queue visit to repeat projection reads for unchanged state.
    renderButton();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(refreshDashboard).not.toHaveBeenCalled();
  });
});
