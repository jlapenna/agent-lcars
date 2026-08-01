'use client';

import {
  Anchor,
  Button,
  Modal,
  Select,
  Stack,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useState, useTransition } from 'react';

import type { Pipeline } from '../lib/primary-action';
import {
  repoDisplayName,
  repoKey,
  supportedAgentPipelines,
  type WatchedRepo,
} from '../lib/watched-repo';
import { createQuickTask } from './actions';

const PIPELINE_OPTIONS: { value: Pipeline; label: string }[] = [
  { value: 'claude', label: 'claude' },
  { value: 'codex', label: 'codex' },
  { value: 'opencode', label: 'opencode' },
];

/**
 * Files a new `intake:quick-task`-labeled issue from a free-text description and
 * hands it to the selected agent pipeline (that pipeline's own label is
 * added as a follow-up call so the centralized agent router receives the
 * label event - see createQuickTask in backend-actions.ts). No polling here: the new
 * issue shows up in the board / In Flight panel on the next refresh.
 *
 * A centered Modal rather than a Popover: an autosizing Popover grows and
 * shifts position as its content grows, so pasting a long description made
 * the whole dropdown jump around under the cursor - see #2773. A centered
 * Modal does not have that jump problem, so it does not need to be
 * full-screen - see #267.
 */
export function QuickTaskButton({
  watchedRepos = [],
  initialRepoKey,
  size = 'compact-sm',
}: {
  /** Passed down from the server component that already resolved
   * getWatchedRepos() - this is a client component, and AGENT_LCARS_
   * WATCHED_REPOS is a server-only env var, unreachable from browser code. */
  watchedRepos?: WatchedRepo[];
  /** Canonical owner/name identity for the repository already selected by
   * the surrounding page. The picker falls back to the first watched repo
   * only when that identity is absent or no longer configured. */
  initialRepoKey?: string;
  size?: string;
}) {
  const [opened, setOpened] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [repoIndex, setRepoIndex] = useState(() => {
    const index = watchedRepos.findIndex(
      (repo) => repoKey(repo) === initialRepoKey,
    );
    return String(index >= 0 ? index : 0);
  });
  const [pipeline, setPipeline] = useState<Pipeline>('claude');
  const [isPending, startTransition] = useTransition();
  const selectedRepo = watchedRepos[Number(repoIndex)] ?? watchedRepos[0];
  const supportedPipelines = selectedRepo
    ? supportedAgentPipelines(selectedRepo)
    : (PIPELINE_OPTIONS.map((option) => option.value) as Pipeline[]);
  const pipelineOptions = PIPELINE_OPTIONS.filter((option) =>
    supportedPipelines.includes(option.value),
  );
  const effectivePipeline = supportedPipelines.includes(pipeline)
    ? pipeline
    : supportedPipelines[0];

  const close = () => setOpened(false);

  const handleCreate = () => {
    const trimmed = description.trim();
    if (!trimmed || !effectivePipeline) return;
    close();
    startTransition(async () => {
      const result = await createQuickTask(
        trimmed,
        title.trim(),
        selectedRepo,
        effectivePipeline,
      );
      if (!result.ok) {
        notifications.show({ message: result.message, color: 'red' });
        return;
      }
      setTitle('');
      setDescription('');
      notifications.show({
        message: (
          <Anchor
            href={result.url}
            target="_blank"
            rel="noreferrer"
            c="inherit"
          >
            Quick task filed as #{result.number}
          </Anchor>
        ),
        color: 'green',
      });
    });
  };

  return (
    <>
      <Button
        className="lcars-action-button"
        data-accent="amber"
        size={size}
        disabled={isPending}
        onClick={() => setOpened(true)}
      >
        Quick task
      </Button>
      <Modal opened={opened} onClose={close} title="File a quick task">
        <Stack gap="sm">
          {watchedRepos.length > 1 && (
            <Select
              label="Repo"
              data={watchedRepos.map((repo, i) => ({
                value: String(i),
                label: repoDisplayName(repo),
              }))}
              value={repoIndex}
              onChange={(value) => setRepoIndex(value ?? '0')}
              allowDeselect={false}
            />
          )}
          <Select
            label="Agent"
            description="Which pipeline picks up the task"
            data={pipelineOptions}
            value={effectivePipeline ?? null}
            onChange={(value) => setPipeline((value as Pipeline) ?? 'claude')}
            allowDeselect={false}
            disabled={pipelineOptions.length === 0}
          />
          <TextInput
            label="Title"
            description="Optional — defaults to the first line of the description"
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            placeholder="Short summary for the issue title"
          />
          <Textarea
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            placeholder="Describe the task — this becomes the issue body"
            autosize
            minRows={12}
          />
          <Button
            disabled={
              isPending || !description.trim() || pipelineOptions.length === 0
            }
            onClick={handleCreate}
          >
            File & dispatch
          </Button>
        </Stack>
      </Modal>
    </>
  );
}
