import { MantineProvider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { createQuickTask } from './actions';
import { QuickTaskButton } from './quick-task-button';

vi.mock('./actions', () => ({ createQuickTask: vi.fn() }));
vi.mock('@mantine/notifications', () => ({
  notifications: { show: vi.fn() },
}));

const REPO = { owner: 'supersprinklesracing', name: 'sprinkles' };
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function receipt(repository = REPO, issueNumber = 99) {
  return {
    ok: true as const,
    requestId: '11111111-1111-4111-8111-111111111111',
    task: { repository, issueNumber },
    url: `https://github.com/${repository.owner}/${repository.name}/issues/${issueNumber}`,
  };
}

function renderButton() {
  render(
    <MantineProvider>
      <QuickTaskButton watchedRepos={[REPO]} />
    </MantineProvider>,
  );
}

function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Quick task' }));
  return screen.findByRole('dialog');
}

function enterDescription(value = 'Fix the flaky test') {
  fireEvent.change(screen.getByLabelText('Description'), {
    target: { value },
  });
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'File & dispatch' }));
}

describe('QuickTaskButton', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens a centered dialog rather than a full-screen one', async () => {
    renderButton();
    const dialog = await openDialog();
    expect(screen.getByText('File a quick task')).toBeTruthy();
    expect(dialog.getAttribute('data-full-screen')).toBeNull();
  });

  it('disables submission until a description is entered', async () => {
    renderButton();
    await openDialog();
    const button = screen.getByRole('button', {
      name: 'File & dispatch',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    enterDescription();
    expect(button.disabled).toBe(false);
  });

  it('files a repository-explicit request and renders its canonical TaskRef', async () => {
    (createQuickTask as Mock).mockResolvedValue(receipt());
    renderButton();
    await openDialog();
    enterDescription();
    submit();

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: 'green' }),
      ),
    );
    expect(createQuickTask).toHaveBeenCalledWith({
      requestId: expect.stringMatching(UUID_PATTERN),
      repository: REPO,
      pipeline: 'claude',
      title: '',
      description: 'Fix the flaky test',
    });
    // handleCreate's setOpened(false) runs inside the same startTransition as
    // the notifications.show call above, so the mock being called does not
    // guarantee the dialog's own React update has flushed yet. Wait for the
    // dialog to actually be gone before rendering the captured message into a
    // second tree, same guard already used elsewhere in this file for the
    // identical close-transition timing (agent-lcars#420). The default
    // waitFor timeout (1000ms) still wasn't enough for the Mantine portal to
    // unmount on a loaded CI runner (agent-lcars#533), so this one gets a
    // more generous explicit timeout.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), {
      timeout: 5000,
    });
    const { message } = (notifications.show as Mock).mock.calls[0][0];
    render(<MantineProvider>{message}</MantineProvider>);
    const link = screen.getByRole('link', {
      name: 'Quick task filed as supersprinklesracing/sprinkles#99',
    }) as HTMLAnchorElement;
    expect(link.href).toBe(
      'https://github.com/supersprinklesracing/sprinkles/issues/99',
    );
  });

  it('generates a request ID on an insecure HTTP context', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        return bytes;
      },
    });
    (createQuickTask as Mock).mockResolvedValue(receipt());
    renderButton();
    await openDialog();
    enterDescription();
    submit();

    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(1));
    expect((createQuickTask as Mock).mock.calls[0][0].requestId).toBe(
      '00010203-0405-4607-8809-0a0b0c0d0e0f',
    );
  });

  it('forwards an explicit title and selected pipeline', async () => {
    (createQuickTask as Mock).mockResolvedValue(receipt());
    renderButton();
    await openDialog();
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Custom title' },
    });
    fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }));
    fireEvent.click(await screen.findByText('opencode'));
    enterDescription();
    submit();

    await waitFor(() =>
      expect(createQuickTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Custom title',
          pipeline: 'opencode',
        }),
      ),
    );
  });

  it('offers no repo picker with one watched repo', async () => {
    renderButton();
    await openDialog();
    expect(screen.queryByLabelText('Repo')).toBeNull();
  });

  it('uses the repo selected by the surrounding page', async () => {
    const repoA = { owner: 'org-a', name: 'repo-a' };
    const repoB = { owner: 'org-b', name: 'repo-b' };
    (createQuickTask as Mock).mockResolvedValue(receipt(repoB, 1));
    render(
      <MantineProvider>
        <QuickTaskButton
          watchedRepos={[repoA, repoB]}
          initialRepoKey="org-b/repo-b"
        />
      </MantineProvider>,
    );
    await openDialog();
    expect(
      (screen.getByRole('combobox', { name: 'Repo' }) as HTMLInputElement)
        .value,
    ).toBe('org-b/repo-b');
    enterDescription('Fix this repository');
    submit();

    await waitFor(() =>
      expect(createQuickTask).toHaveBeenCalledWith(
        expect.objectContaining({ repository: repoB }),
      ),
    );
  });

  it('offers aliases while preserving canonical repo identity', async () => {
    const repoA = { owner: 'org-a', name: 'repo-a' };
    const repoB = { owner: 'org-b', name: 'repo-b', alias: 'Repo B' };
    (createQuickTask as Mock).mockResolvedValue(receipt(repoB, 1));
    render(
      <MantineProvider>
        <QuickTaskButton watchedRepos={[repoA, repoB]} />
      </MantineProvider>,
    );
    await openDialog();
    fireEvent.click(screen.getByRole('combobox', { name: 'Repo' }));
    fireEvent.click(await screen.findByText('Repo B'));
    enterDescription();
    submit();

    await waitFor(() =>
      expect(createQuickTask).toHaveBeenCalledWith(
        expect.objectContaining({
          repository: { owner: 'org-b', name: 'repo-b' },
        }),
      ),
    );
  });

  it('keeps the dialog open and reuses the request ID after failure', async () => {
    (createQuickTask as Mock)
      .mockResolvedValueOnce({ ok: false, message: 'socket timed out' })
      .mockResolvedValueOnce(receipt());
    renderButton();
    await openDialog();
    enterDescription();
    submit();
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith({
        message: 'socket timed out',
        color: 'red',
      }),
    );
    const firstRequest = (createQuickTask as Mock).mock.calls[0][0];
    expect(screen.getByRole('dialog')).toBeTruthy();
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: 'File & dispatch',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );

    submit();
    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(2));
    expect((createQuickTask as Mock).mock.calls[1][0].requestId).toBe(
      firstRequest.requestId,
    );
  });

  it('locks the submitted intent until its request finishes', async () => {
    let resolveRequest!: (value: ReturnType<typeof receipt>) => void;
    (createQuickTask as Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    renderButton();
    await openDialog();
    enterDescription();
    submit();

    await waitFor(() =>
      expect(
        (screen.getByLabelText('Description') as HTMLTextAreaElement).disabled,
      ).toBe(true),
    );
    expect((screen.getByLabelText('Title') as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('combobox', { name: 'Agent' }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    submit();
    expect(createQuickTask).toHaveBeenCalledTimes(1);

    resolveRequest(receipt());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('submits via ctrl+enter in the description field, same as clicking the button', async () => {
    (createQuickTask as Mock).mockResolvedValue(receipt());
    renderButton();
    await openDialog();
    enterDescription();
    fireEvent.keyDown(screen.getByLabelText('Description'), {
      key: 'Enter',
      ctrlKey: true,
    });

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: 'green' }),
      ),
    );
    expect(createQuickTask).toHaveBeenCalledWith({
      requestId: expect.stringMatching(UUID_PATTERN),
      repository: REPO,
      pipeline: 'claude',
      title: '',
      description: 'Fix the flaky test',
    });
  });

  it('submits via cmd+enter (metaKey) in the title field', async () => {
    (createQuickTask as Mock).mockResolvedValue(receipt());
    renderButton();
    await openDialog();
    enterDescription();
    fireEvent.keyDown(screen.getByLabelText('Title'), {
      key: 'Enter',
      metaKey: true,
    });

    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(1));
  });

  it('ignores plain enter (no modifier) in the description field', async () => {
    renderButton();
    await openDialog();
    enterDescription();
    fireEvent.keyDown(screen.getByLabelText('Description'), {
      key: 'Enter',
    });

    expect(createQuickTask).not.toHaveBeenCalled();
  });

  it('ignores ctrl+enter while the form is invalid, reusing the button guard', async () => {
    renderButton();
    await openDialog();
    fireEvent.keyDown(screen.getByLabelText('Description'), {
      key: 'Enter',
      ctrlKey: true,
    });

    expect(createQuickTask).not.toHaveBeenCalled();
  });

  it('ignores ctrl+enter while a submission is already in flight', async () => {
    let resolveRequest!: (value: ReturnType<typeof receipt>) => void;
    (createQuickTask as Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    renderButton();
    await openDialog();
    enterDescription();
    submit();

    await waitFor(() =>
      expect(
        (screen.getByLabelText('Description') as HTMLTextAreaElement).disabled,
      ).toBe(true),
    );
    fireEvent.keyDown(screen.getByLabelText('Description'), {
      key: 'Enter',
      ctrlKey: true,
    });
    expect(createQuickTask).toHaveBeenCalledTimes(1);

    resolveRequest(receipt());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('creates a new request ID when the intent changes after failure', async () => {
    (createQuickTask as Mock)
      .mockResolvedValueOnce({ ok: false, message: 'try again' })
      .mockResolvedValueOnce(receipt());
    renderButton();
    await openDialog();
    enterDescription();
    submit();
    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(1));
    const firstId = (createQuickTask as Mock).mock.calls[0][0].requestId;

    enterDescription('A changed task');
    submit();
    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(2));
    expect((createQuickTask as Mock).mock.calls[1][0].requestId).not.toBe(
      firstId,
    );
  });
});
