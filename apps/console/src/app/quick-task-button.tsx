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
import { useRef, useState, useTransition } from 'react';

import {
  type AgentPipeline,
  repoDisplayName,
  repoKey,
  supportedAgentPipelines,
  taskRefKey,
  type WatchedRepo,
} from '../lib/watched-repo';
import { createQuickTask } from './actions';

const PIPELINE_OPTIONS: { value: AgentPipeline; label: string }[] = [
  { value: 'claude', label: 'claude' },
  { value: 'codex', label: 'codex' },
  { value: 'opencode', label: 'opencode' },
];

function createRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    try {
      return cryptoApi.randomUUID();
    } catch {
      // randomUUID is restricted to secure contexts in some browsers. The
      // older getRandomValues primitive remains available to HTTP LAN pages.
    }
  }
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('Cryptographic randomness is unavailable');
  }

  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Files a new `intake:quick-task`-labeled issue from a free-text description and
 * hands it to the selected agent pipeline. The intake and pipeline labels
 * are part of the issue-creation write so a successful issue is immediately
 * dispatchable. No polling here: the new issue shows up in the board / In
 * Flight panel on the next refresh.
 *
 * A centered Modal rather than a Popover: an autosizing Popover grows and
 * shifts position as its content grows, so pasting a long description made
 * the whole dropdown jump around under the cursor - see #2773. A centered
 * Modal does not have that jump problem, so it does not need to be
 * full-screen - see #267.
 */
export function QuickTaskButton({
  watchedRepos,
  initialRepoKey,
  size = 'compact-sm',
}: {
  /** Passed down from the server component that already resolved
   * getWatchedRepos() - this is a client component, and AGENT_LCARS_
   * WATCHED_REPOS is a server-only env var, unreachable from browser code. */
  watchedRepos: WatchedRepo[];
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
  const [pipeline, setPipeline] = useState<AgentPipeline>('claude');
  const [isPending, startTransition] = useTransition();
  const requestIdRef = useRef<string | undefined>(undefined);
  const submitInFlightRef = useRef(false);
  const selectedRepo = watchedRepos[Number(repoIndex)];
  const supportedPipelines = selectedRepo
    ? supportedAgentPipelines(selectedRepo)
    : [];
  const pipelineOptions = PIPELINE_OPTIONS.filter((option) =>
    supportedPipelines.includes(option.value),
  );
  const effectivePipeline = supportedPipelines.includes(pipeline)
    ? pipeline
    : supportedPipelines[0];

  const close = () => setOpened(false);
  const changeIntent = () => {
    requestIdRef.current = undefined;
  };

  /** Ctrl+Enter (Cmd+Enter on Mac) submits from either text field, mirroring
   * the "File & dispatch" button click. `handleCreate` already guards
   * against an empty description, a missing repo/pipeline, and a submission
   * already in flight, so this reuses that same guard rather than
   * duplicating the button's `disabled` logic. */
  const handleSubmitShortcut = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      handleCreate();
    }
  };

  const handleCreate = () => {
    const trimmed = description.trim();
    if (
      !trimmed ||
      !effectivePipeline ||
      !selectedRepo ||
      submitInFlightRef.current
    ) {
      return;
    }
    let requestId = requestIdRef.current;
    if (!requestId) {
      try {
        requestId = createRequestId();
      } catch {
        notifications.show({
          message: 'This browser cannot generate a Quick Task request ID',
          color: 'red',
        });
        return;
      }
      requestIdRef.current = requestId;
    }
    submitInFlightRef.current = true;
    startTransition(async () => {
      try {
        const result = await createQuickTask({
          requestId,
          repository: {
            owner: selectedRepo.owner,
            name: selectedRepo.name,
          },
          pipeline: effectivePipeline,
          title: title.trim(),
          description: trimmed,
        });
        if (!result.ok) {
          notifications.show({ message: result.message, color: 'red' });
          return;
        }
        requestIdRef.current = undefined;
        setTitle('');
        setDescription('');
        close();
        notifications.show({
          message: (
            <Anchor
              href={result.url}
              target="_blank"
              rel="noreferrer"
              c="inherit"
            >
              Quick task filed as {taskRefKey(result.task)}
            </Anchor>
          ),
          color: 'green',
        });
      } finally {
        submitInFlightRef.current = false;
      }
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
      <Modal
        opened={opened}
        onClose={() => {
          if (!isPending) close();
        }}
        closeOnClickOutside={!isPending}
        title="File a quick task"
      >
        <Stack gap="sm">
          {watchedRepos.length > 1 && (
            <Select
              label="Repo"
              data={watchedRepos.map((repo, i) => ({
                value: String(i),
                label: repoDisplayName(repo),
              }))}
              value={repoIndex}
              onChange={(value) => {
                changeIntent();
                setRepoIndex(value ?? '0');
              }}
              allowDeselect={false}
              disabled={isPending}
            />
          )}
          <Select
            label="Agent"
            description="Which pipeline picks up the task"
            data={pipelineOptions}
            value={effectivePipeline ?? null}
            onChange={(value) => {
              changeIntent();
              setPipeline((value as AgentPipeline) ?? 'claude');
            }}
            allowDeselect={false}
            disabled={isPending || pipelineOptions.length === 0}
          />
          <TextInput
            label="Title"
            description="Optional — defaults to the first line of the description"
            value={title}
            onChange={(e) => {
              changeIntent();
              setTitle(e.currentTarget.value);
            }}
            onKeyDown={handleSubmitShortcut}
            placeholder="Short summary for the issue title"
            disabled={isPending}
          />
          <Textarea
            label="Description"
            value={description}
            onChange={(e) => {
              changeIntent();
              setDescription(e.currentTarget.value);
            }}
            onKeyDown={handleSubmitShortcut}
            placeholder="Describe the task — this becomes the issue body"
            autosize
            minRows={12}
            disabled={isPending}
          />
          <Button
            disabled={
              isPending ||
              !description.trim() ||
              !selectedRepo ||
              pipelineOptions.length === 0
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
