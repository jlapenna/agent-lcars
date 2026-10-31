import { MantineProvider } from '@mantine/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { JobsPanel } from './jobs-panel';

afterEach(() => vi.unstubAllGlobals());

it('keeps a newer registry refresh when the initial request resolves late', async () => {
  let finishInitial!: (response: Response) => void;
  const initial = new Promise<Response>((resolve) => {
    finishInitial = resolve;
  });
  const registered = (id: string) => ({
    id,
    repository: 'owner/repo',
    name: id,
    enabled: false,
    error: 'Source unavailable',
  });
  const fetch = vi
    .fn()
    .mockReturnValueOnce(initial)
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify([registered('new-job'), registered('another-job')]),
      ),
    );
  vi.stubGlobal('fetch', fetch);
  render(
    <MantineProvider>
      <JobsPanel repositories={['owner/repo']} />
    </MantineProvider>,
  );
  expect(screen.getByRole('status')).toHaveTextContent(
    'Loading registered jobs',
  );
  expect(screen.queryByText('No jobs registered')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }));
  await screen.findByText('2 registered');
  await act(async () => {
    finishInitial(new Response(JSON.stringify([registered('old-job')])));
  });
  expect(screen.getByText('2 registered')).toBeInTheDocument();
  expect(screen.queryByText('Old job')).not.toBeInTheDocument();
});
