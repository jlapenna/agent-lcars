import { MantineProvider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';

import { createQuickTask } from './actions';
import { QuickTaskButton } from './quick-task-button';

vi.mock('./actions', () => ({ createQuickTask: vi.fn() }));
vi.mock('@mantine/notifications', () => ({
  notifications: { show: vi.fn(), update: vi.fn() },
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
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

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
      expect(notifications.update).toHaveBeenCalledWith(
        expect.objectContaining({ color: 'green' }),
      ),
    );
    expect(createQuickTask).toHaveBeenCalledWith({
      requestId: expect.stringMatching(UUID_PATTERN),
      repository: REPO,
      pipeline: 'claude',
      description: expect.stringMatching(
        /^Fix the flaky test\n\n## Source context\n\n- Repository: `supersprinklesracing\/sprinkles`\n- Console route: `\/`\n- Captured: \d{4}-\d{2}-\d{2}T/u,
      ),
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), {
      timeout: 5000,
    });
    const success = (notifications.update as Mock).mock.calls.find(
      ([update]) => update.color === 'green',
    )![0];
    const { message } = success;
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

  it('derives the issue title server-side and forwards the selected pipeline', async () => {
    (createQuickTask as Mock).mockResolvedValue(receipt());
    renderButton();
    await openDialog();
    expect(screen.queryByLabelText('Title')).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }));
    fireEvent.click(await screen.findByText('opencode'));
    enterDescription();
    submit();

    await waitFor(() =>
      expect(createQuickTask).toHaveBeenCalledWith(
        expect.objectContaining({
          pipeline: 'opencode',
        }),
      ),
    );
    expect((createQuickTask as Mock).mock.calls[0][0]).not.toHaveProperty(
      'title',
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

  it('remembers the last repository and agent selection across instances', async () => {
    const repoA = { owner: 'org-a', name: 'repo-a' };
    const repoB = { owner: 'org-b', name: 'repo-b', alias: 'Repo B' };
    const first = render(
      <MantineProvider>
        <QuickTaskButton watchedRepos={[repoA, repoB]} />
      </MantineProvider>,
    );
    await openDialog();
    fireEvent.click(screen.getByRole('combobox', { name: 'Repo' }));
    fireEvent.click(await screen.findByText('Repo B'));
    fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }));
    fireEvent.click(await screen.findByText('opencode'));
    first.unmount();

    render(
      <MantineProvider>
        <QuickTaskButton watchedRepos={[repoA, repoB]} />
      </MantineProvider>,
    );
    await openDialog();

    await waitFor(() => {
      expect(
        (screen.getByRole('combobox', { name: 'Repo' }) as HTMLInputElement)
          .value,
      ).toBe('Repo B');
      expect(
        (screen.getByRole('combobox', { name: 'Agent' }) as HTMLInputElement)
          .value,
      ).toBe('opencode');
    });
  });

  it('closes immediately and retries a failed background submission with the same request ID', async () => {
    (createQuickTask as Mock)
      .mockRejectedValueOnce(new Error('socket timed out'))
      .mockResolvedValueOnce(receipt());
    renderButton();
    await openDialog();
    enterDescription();
    submit();
    await waitFor(() =>
      expect(notifications.update).toHaveBeenCalledWith(
        expect.objectContaining({ color: 'red' }),
      ),
    );
    const firstRequest = (createQuickTask as Mock).mock.calls[0][0];
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const failure = (notifications.update as Mock).mock.calls.find(
      ([update]) => update.color === 'red',
    )![0];
    render(<MantineProvider>{failure.message}</MantineProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(2));
    expect((createQuickTask as Mock).mock.calls[1][0].requestId).toBe(
      firstRequest.requestId,
    );
  });

  it('accepts a second task while the first submission is still pending', async () => {
    let resolveFirst!: (value: ReturnType<typeof receipt>) => void;
    let resolveSecond!: (value: ReturnType<typeof receipt>) => void;
    (createQuickTask as Mock)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
      );
    renderButton();
    await openDialog();
    enterDescription('First task');
    submit();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await openDialog();
    enterDescription('Second task');
    submit();
    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(2));
    const firstRequest = (createQuickTask as Mock).mock.calls[0][0];
    const secondRequest = (createQuickTask as Mock).mock.calls[1][0];
    expect(firstRequest.description).toMatch(
      /^First task\n\n## Source context/u,
    );
    expect(secondRequest.description).toMatch(
      /^Second task\n\n## Source context/u,
    );
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId);
    expect(notifications.show).toHaveBeenCalledTimes(2);

    resolveFirst(receipt(REPO, 99));
    resolveSecond(receipt(REPO, 100));
    await waitFor(() => {
      expect(
        (notifications.update as Mock).mock.calls.filter(
          ([update]) => update.color === 'green',
        ),
      ).toHaveLength(2);
    });
  });

  it('prevents duplicate events from submitting the same closing dialog twice', async () => {
    let resolveRequest!: (value: ReturnType<typeof receipt>) => void;
    (createQuickTask as Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    renderButton();
    await openDialog();
    enterDescription();
    const description = screen.getByLabelText('Description');
    fireEvent.keyDown(description, {
      key: 'Enter',
      ctrlKey: true,
    });
    fireEvent.keyDown(description, {
      key: 'Enter',
      ctrlKey: true,
    });
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
      expect(notifications.update).toHaveBeenCalledWith(
        expect.objectContaining({ color: 'green' }),
      ),
    );
    expect(createQuickTask).toHaveBeenCalledWith({
      requestId: expect.stringMatching(UUID_PATTERN),
      repository: REPO,
      pipeline: 'claude',
      description: expect.stringMatching(
        /^Fix the flaky test\n\n## Source context/u,
      ),
    });
  });

  it('previews and submits optional structured evidence plus editable canonical source identity', async () => {
    window.history.replaceState(
      null,
      '',
      '/task/supersprinklesracing/sprinkles/42?token=secret',
    );
    (createQuickTask as Mock).mockResolvedValue(receipt());
    render(
      <MantineProvider>
        <QuickTaskButton
          watchedRepos={[REPO]}
          sourceIdentities={[
            {
              label: 'Task',
              value: 'supersprinklesracing/sprinkles#42',
            },
          ]}
        />
      </MantineProvider>,
    );
    await openDialog();
    enterDescription('The task page hangs after refresh');
    fireEvent.click(screen.getByRole('button', { name: 'Add guided details' }));
    fireEvent.change(screen.getByLabelText('Observed'), {
      target: { value: 'The loading state never clears.' },
    });
    fireEvent.change(screen.getByLabelText('Expected'), {
      target: { value: 'The task card becomes visible.' },
    });
    fireEvent.change(screen.getByLabelText('Done when'), {
      target: { value: 'A browser regression test covers refresh.' },
    });
    fireEvent.change(screen.getByLabelText('Evidence links'), {
      target: { value: 'https://example.invalid/screenshot' },
    });

    expect(screen.getByLabelText('Console route')).toHaveValue(
      '/task/supersprinklesracing/sprinkles/42',
    );
    expect(screen.getByLabelText('Related identity')).toHaveValue(
      'Task: supersprinklesracing/sprinkles#42',
    );
    expect(screen.getByTestId('quick-task-preview-title')).toHaveTextContent(
      'The task page hangs after refresh',
    );
    const previewBody = screen.getByTestId(
      'quick-task-preview-body',
    ).textContent;
    expect(previewBody).toContain(
      '### Observed\nThe loading state never clears.',
    );
    expect(previewBody).toContain(
      '### Expected\nThe task card becomes visible.',
    );
    expect(previewBody).toContain(
      '### Done when\nA browser regression test covers refresh.',
    );
    expect(previewBody).toContain('- Task: supersprinklesracing/sprinkles#42');
    expect(previewBody).not.toContain('token=secret');

    submit();
    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(1));
    expect((createQuickTask as Mock).mock.calls[0][0].description).toBe(
      previewBody,
    );
  });

  it('keeps low-information guidance advisory', async () => {
    (createQuickTask as Mock).mockResolvedValue(receipt());
    renderButton();
    await openDialog();
    enterDescription('please fix:');

    expect(screen.getByRole('status')).toHaveTextContent(
      'You can still file this task as-is.',
    );
    expect(
      screen.getByRole('button', { name: 'File & dispatch' }),
    ).toBeEnabled();
    submit();
    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(1));
  });

  it('submits via cmd+enter (metaKey) in the description field', async () => {
    (createQuickTask as Mock).mockResolvedValue(receipt());
    renderButton();
    await openDialog();
    enterDescription();
    fireEvent.keyDown(screen.getByLabelText('Description'), {
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

  it('creates a new request ID for a new dialog after a failure', async () => {
    (createQuickTask as Mock)
      .mockResolvedValueOnce({ ok: false, message: 'try again' })
      .mockResolvedValueOnce(receipt());
    renderButton();
    await openDialog();
    enterDescription();
    submit();
    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(1));
    const firstId = (createQuickTask as Mock).mock.calls[0][0].requestId;

    await openDialog();
    enterDescription('A changed task');
    submit();
    await waitFor(() => expect(createQuickTask).toHaveBeenCalledTimes(2));
    expect((createQuickTask as Mock).mock.calls[1][0].requestId).not.toBe(
      firstId,
    );
  });
});
