'use client';

import type { IssueReference } from '@agent-lcars/dispatch-contracts';
import { type WorkSpec } from '@agent-lcars/work';
import { Button, Group, NativeSelect, Stack, Text } from '@mantine/core';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';

import { dispatchSource, refreshSources } from './actions';

export function RefreshIssueSources({
  tracker,
  teams,
}: {
  tracker: 'github' | 'linear';
  teams: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [team, setTeam] = useState(teams[0]?.id ?? '');
  const [page, setPage] = useState<{
    tracker: string;
    team: string;
    cursor?: string;
  }>();
  const [message, setMessage] = useState('');
  const [pending, start] = useTransition();
  return (
    <Stack gap={4}>
      <Group gap="xs">
        {tracker === 'linear' && teams.length > 1 ? (
          <NativeSelect
            aria-label="Linear team"
            value={team}
            onChange={(event) => {
              setTeam(event.currentTarget.value);
              setPage(undefined);
            }}
            data={teams.map((item) => ({ value: item.id, label: item.name }))}
          />
        ) : null}
        <Button
          type="button"
          variant="default"
          loading={pending}
          onClick={() =>
            start(async () => {
              const [error, result] = await refreshSources({
                tracker,
                ...(tracker === 'linear' && team ? { teamId: team } : {}),
                ...(page?.tracker === tracker &&
                page.team === team &&
                page.cursor
                  ? { cursor: page.cursor }
                  : {}),
              });
              if (error) {
                setMessage(error.message);
                return;
              }
              setPage({ tracker, team, cursor: result.nextCursor });
              setMessage(
                `${result.refreshed} issues refreshed${result.nextCursor ? '; another page is available' : ''}.`,
              );
              router.refresh();
            })
          }
        >
          {page?.tracker === tracker && page.team === team && page.cursor
            ? 'Refresh next page'
            : 'Refresh issues'}
        </Button>
      </Group>
      {message ? (
        <Text size="xs" role="status">
          {message}
        </Text>
      ) : null}
    </Stack>
  );
}

export function RunIssue({
  issue,
  repository,
  choices,
}: {
  issue: IssueReference;
  repository?: string;
  choices: { repo: string; pipeline: WorkSpec['pipeline'] }[];
}) {
  const router = useRouter();
  const [repo, setRepo] = useState(repository ?? '');
  const [selectedPipeline, setPipeline] =
    useState<WorkSpec['pipeline']>('codex');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const receipt = useRef<{ selection: string; id: string } | undefined>(
    undefined,
  );
  const repos = [...new Set(choices.map((choice) => choice.repo))];
  const pipelines = [
    ...new Set(
      choices
        .filter((choice) => choice.repo === repo)
        .map((choice) => choice.pipeline),
    ),
  ];
  const pipeline = pipelines.includes(selectedPipeline)
    ? selectedPipeline
    : pipelines[0];
  return (
    <Stack gap={4}>
      <Group gap="xs">
        {!repository ? (
          <NativeSelect
            aria-label="Target repository"
            value={repo}
            onChange={(event) => setRepo(event.currentTarget.value)}
            data={[
              { value: '', label: 'Select repository' },
              ...repos.map((value) => ({ value, label: value })),
            ]}
          />
        ) : null}
        <NativeSelect
          aria-label="Issue agent"
          value={pipeline ?? ''}
          onChange={(event) =>
            setPipeline(event.currentTarget.value as WorkSpec['pipeline'])
          }
          data={pipelines}
          disabled={!pipeline || pending}
        />
        <Button
          type="button"
          disabled={!pipeline || !repo}
          loading={pending}
          onClick={() =>
            start(async () => {
              if (!pipeline || !repo) return;
              const selection = JSON.stringify([issue, repo, pipeline]);
              if (receipt.current?.selection !== selection)
                receipt.current = { selection, id: crypto.randomUUID() };
              const [failure, result] = await dispatchSource({
                issue,
                repo,
                pipeline,
                requestId: receipt.current.id,
              });
              if (failure) {
                setError(failure.message);
                return;
              }
              router.push(result.location);
              router.refresh();
            })
          }
        >
          Run
        </Button>
      </Group>
      {error ? (
        <Text c="red" size="xs" role="alert">
          {error}
        </Text>
      ) : null}
    </Stack>
  );
}
