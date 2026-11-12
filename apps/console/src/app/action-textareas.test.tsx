import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dispatchUnstickPrs,
  refreshGithubSignIn,
  retriggerIssue,
} from './actions';
import { RetriggerButton } from './retrigger-button';
import { UnstickPrsButton } from './unstick-prs-button';

vi.mock('./actions', () => ({
  dispatchUnstickPrs: vi.fn(),
  refreshGithubSignIn: vi.fn(),
  retriggerIssue: vi.fn(),
}));

function renderAction(action: React.ReactNode) {
  return render(<MantineProvider>{action}</MantineProvider>);
}

describe('action textarea labels', () => {
  it('labels the optional retrigger steering note without changing its name', async () => {
    renderAction(
      <RetriggerButton repo={{ owner: 'o', name: 'r' }} issueNumber={42} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retrigger' }));

    expect(
      await screen.findByRole('textbox', {
        name: 'Optional steering note — posted on the issue before the fresh run starts',
      }),
    ).toBeTruthy();
  });

  it('labels the optional unstick context without changing its name', async () => {
    renderAction(<UnstickPrsButton repo={{ owner: 'o', name: 'r' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run unstick-prs' }));

    expect(
      await screen.findByRole('textbox', {
        name: 'Optional context — PR numbers, symptoms — posted on the anchor issue',
      }),
    ).toBeTruthy();
  });

  // GitHub invalidates the operator's user token on its own schedule; the
  // renewal is a full page load, and what the operator typed must survive it.
  describe('after GitHub refuses the operator token', () => {
    const REFUSED = {
      ok: false as const,
      message:
        'GitHub authorization failed. Sign out and sign in again, then retry.',
      reauth: true as const,
    };

    beforeEach(() => {
      window.sessionStorage.clear();
      vi.mocked(refreshGithubSignIn).mockReset().mockResolvedValue(undefined);
    });

    it('renews the sign-in and brings the retrigger note back with the page', async () => {
      vi.mocked(retriggerIssue).mockResolvedValue(REFUSED);
      const repo = { owner: 'o', name: 'r' };
      const first = renderAction(
        <RetriggerButton repo={repo} issueNumber={42} />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Retrigger' }));
      fireEvent.change(await screen.findByRole('textbox'), {
        target: { value: 'Rebase first' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Retrigger now' }));
      await waitFor(() => expect(refreshGithubSignIn).toHaveBeenCalledOnce());
      first.unmount();

      renderAction(<RetriggerButton repo={repo} issueNumber={42} />);

      expect(
        ((await screen.findByRole('textbox')) as HTMLTextAreaElement).value,
      ).toBe('Rebase first');
      // Restored, not re-sent: the operator decides.
      expect(retriggerIssue).toHaveBeenCalledOnce();
    });

    it('renews the sign-in and brings the unstick context back with the page', async () => {
      vi.mocked(dispatchUnstickPrs).mockResolvedValue(REFUSED);
      const repo = { owner: 'o', name: 'r' };
      const first = renderAction(<UnstickPrsButton repo={repo} />);
      fireEvent.click(screen.getByRole('button', { name: 'Run unstick-prs' }));
      fireEvent.change(await screen.findByRole('textbox'), {
        target: { value: '#12 is stuck behind main' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Dispatch' }));
      await waitFor(() => expect(refreshGithubSignIn).toHaveBeenCalledOnce());
      first.unmount();

      renderAction(<UnstickPrsButton repo={repo} />);

      expect(
        ((await screen.findByRole('textbox')) as HTMLTextAreaElement).value,
      ).toBe('#12 is stuck behind main');
      expect(dispatchUnstickPrs).toHaveBeenCalledOnce();
    });
  });
});
