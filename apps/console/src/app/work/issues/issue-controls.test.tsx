import type { IssueReference } from '@agent-lcars/dispatch-contracts';
import { MantineProvider } from '@mantine/core';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RunIssue } from './issue-controls';

const { dispatchSourceMock, pushMock, refreshMock } = vi.hoisted(() => ({
  dispatchSourceMock: vi.fn(),
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

vi.mock('./actions', () => ({
  dispatchSource: dispatchSourceMock,
  refreshSources: vi.fn(),
}));

const linearIssue: IssueReference = {
  tracker: 'linear',
  organizationId: '11111111-1111-4111-8111-111111111111',
  issueId: '22222222-2222-4222-8222-222222222222',
};

describe('RunIssue', () => {
  beforeEach(() => {
    dispatchSourceMock.mockReset();
    pushMock.mockReset();
    refreshMock.mockReset();
    dispatchSourceMock.mockResolvedValue([null, { location: '/work/ID1' }]);
  });

  it('submits the refreshed repository when a mounted row rerenders from one repository to another', async () => {
    const choices = [
      { repo: 'jlapenna/old', pipeline: 'codex' as const },
      { repo: 'jlapenna/new', pipeline: 'codex' as const },
    ];
    const { rerender } = render(
      <MantineProvider>
        <RunIssue
          issue={linearIssue}
          repository="jlapenna/old"
          choices={choices}
        />
      </MantineProvider>,
    );

    rerender(
      <MantineProvider>
        <RunIssue
          issue={linearIssue}
          repository="jlapenna/new"
          choices={choices}
        />
      </MantineProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    });

    await waitFor(() =>
      expect(dispatchSourceMock).toHaveBeenCalledWith({
        issue: linearIssue,
        repo: 'jlapenna/new',
        pipeline: 'codex',
        requestId: expect.any(String),
      }),
    );
    expect(pushMock).toHaveBeenCalledWith('/work/ID1');
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('hides the repository selector, enables Run, and submits the routed repository after refresh binds an unrouted row', async () => {
    const choices = [
      { repo: 'jlapenna/homelab', pipeline: 'codex' as const },
      { repo: 'jlapenna/agent-lcars', pipeline: 'codex' as const },
    ];
    const { rerender } = render(
      <MantineProvider>
        <RunIssue
          issue={linearIssue}
          repository={undefined}
          choices={choices}
        />
      </MantineProvider>,
    );

    expect(screen.getByLabelText('Target repository')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();

    rerender(
      <MantineProvider>
        <RunIssue
          issue={linearIssue}
          repository="jlapenna/agent-lcars"
          choices={choices}
        />
      </MantineProvider>,
    );

    expect(screen.queryByLabelText('Target repository')).toBeNull();
    const runButton = screen.getByRole('button', { name: 'Run' });
    expect(runButton).toBeEnabled();

    await act(async () => {
      fireEvent.click(runButton);
    });

    await waitFor(() =>
      expect(dispatchSourceMock).toHaveBeenCalledWith({
        issue: linearIssue,
        repo: 'jlapenna/agent-lcars',
        pipeline: 'codex',
        requestId: expect.any(String),
      }),
    );
  });

  it('clears the target until a manual choice is selected when refresh unbinds repository routing', async () => {
    const choices = [
      { repo: 'jlapenna/agent-lcars', pipeline: 'codex' as const },
      { repo: 'jlapenna/homelab', pipeline: 'claude' as const },
    ];
    const { rerender } = render(
      <MantineProvider>
        <RunIssue
          issue={linearIssue}
          repository="jlapenna/agent-lcars"
          choices={choices}
        />
      </MantineProvider>,
    );

    expect(screen.queryByLabelText('Target repository')).toBeNull();
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();

    rerender(
      <MantineProvider>
        <RunIssue
          issue={linearIssue}
          repository={undefined}
          choices={choices}
        />
      </MantineProvider>,
    );

    const repoSelect = screen.getByLabelText('Target repository');
    expect(repoSelect).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();

    fireEvent.change(repoSelect, { target: { value: 'jlapenna/homelab' } });
    expect(repoSelect).toHaveValue('jlapenna/homelab');
    const runButton = screen.getByRole('button', { name: 'Run' });
    expect(runButton).toBeEnabled();

    await act(async () => {
      fireEvent.click(runButton);
    });

    await waitFor(() =>
      expect(dispatchSourceMock).toHaveBeenCalledWith({
        issue: linearIssue,
        repo: 'jlapenna/homelab',
        pipeline: 'claude',
        requestId: expect.any(String),
      }),
    );
  });
});
