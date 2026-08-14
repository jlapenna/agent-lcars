'use client';

import {
  Anchor,
  Box,
  Button,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { startTransition, useEffect, useRef, useState } from 'react';

import type { QuickTaskRequest } from '../lib/quick-task-contract';
import {
  captureQuickTaskSource,
  composeQuickTaskIssueBody,
  deriveQuickTaskTitle,
  lowInformationQuickTaskGuidance,
  type QuickTaskSourceContext,
  type QuickTaskSourceIdentity,
} from '../lib/quick-task-evidence';
import {
  type AgentPipeline,
  repoDisplayName,
  repoKey,
  supportedAgentPipelines,
  taskRefKey,
  type WatchedRepo,
} from '../lib/watched-repo';
import { createQuickTask } from './actions';
import {
  readQuickTaskPreferences,
  writeQuickTaskPreferences,
} from './quick-task-preferences';
import { QuickTaskScreenshotField } from './quick-task-screenshot-field';
import { createRandomId } from './random-id';
import { showErrorToast } from './show-error-toast';

const PIPELINE_OPTIONS: { value: AgentPipeline; label: string }[] = [
  { value: 'claude', label: 'claude' },
  { value: 'codex', label: 'codex' },
  { value: 'opencode', label: 'opencode' },
];

const emptySourceContext = (): QuickTaskSourceContext => ({
  route: '',
  identities: '',
  capturedAt: '',
});

interface QuickTaskSubmission {
  requestId: string;
  evidenceId?: string;
  repository: { owner: string; name: string };
  pipeline: AgentPipeline;
  description: string;
  source: QuickTaskSourceContext;
  file?: File;
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
  sourceIdentities = [],
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
  /** Canonical identity already resolved by a detail page. It is folded into
   * the issue's auto-captured source context; browser code never guesses
   * PR/run identity from unrelated hidden page data. */
  sourceIdentities?: QuickTaskSourceIdentity[];
  size?: string;
}) {
  const [hydrated, setHydrated] = useState(false);
  const [opened, setOpened] = useState(false);
  const [description, setDescription] = useState('');
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [source, setSource] =
    useState<QuickTaskSourceContext>(emptySourceContext);
  const [repoIndex, setRepoIndex] = useState(() => {
    const index = watchedRepos.findIndex(
      (repo) => repoKey(repo) === initialRepoKey,
    );
    return String(index >= 0 ? index : 0);
  });
  const [pipeline, setPipeline] = useState<AgentPipeline>('claude');
  const submitInFlightRef = useRef(false);

  // The server-rendered trigger is visible before this client component's
  // click handler is attached. Keep it disabled for that brief window so a
  // fast click is queued by the browser/test runner instead of being lost.
  useEffect(() => {
    setHydrated(true);
  }, []);

  // The modal is closed during hydration, so applying browser-local defaults
  // in an effect is SSR-safe without flashing a different visible selection.
  // Stable owner/name identity is persisted instead of the array index so a
  // watched-repository reorder cannot silently select the wrong repository.
  useEffect(() => {
    const remembered = readQuickTaskPreferences();
    const initialIndex = watchedRepos.findIndex(
      (repo) => repoKey(repo) === initialRepoKey,
    );
    const rememberedIndex = watchedRepos.findIndex(
      (repo) => repoKey(repo) === remembered.repoKey,
    );
    const nextIndex = rememberedIndex >= 0 ? rememberedIndex : initialIndex;
    const resolvedIndex = nextIndex >= 0 ? nextIndex : 0;
    const nextRepo = watchedRepos[resolvedIndex];
    const nextPipelines = nextRepo ? supportedAgentPipelines(nextRepo) : [];

    setRepoIndex(String(resolvedIndex));
    setPipeline(
      remembered.pipeline && nextPipelines.includes(remembered.pipeline)
        ? remembered.pipeline
        : (nextPipelines[0] ?? 'claude'),
    );
  }, [initialRepoKey, watchedRepos]);

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

  const issueBody = selectedRepo
    ? composeQuickTaskIssueBody(
        { description, screenshot: '', source },
        {
          owner: selectedRepo.owner,
          name: selectedRepo.name,
        },
      )
    : '';
  const issueTitle = deriveQuickTaskTitle(description);
  const lowInformationGuidance = lowInformationQuickTaskGuidance(description);

  const close = () => setOpened(false);

  const open = () => {
    submitInFlightRef.current = false;
    // Preserve a draft when the modal is merely closed and reopened. A new
    // source snapshot is captured after each successful submission, when
    // handleCreate clears capturedAt along with the rest of the draft.
    if (!source.capturedAt) {
      setSource(
        captureQuickTaskSource(
          {
            pathname: window.location.pathname,
            search: window.location.search,
          },
          sourceIdentities,
        ),
      );
    }
    setOpened(true);
  };

  const submissionNotificationId = (request: QuickTaskSubmission) =>
    `quick-task:${request.requestId}`;

  const pendingNotification = (request: QuickTaskSubmission) => ({
    id: submissionNotificationId(request),
    message: 'Filing and dispatching quick task…',
    loading: true,
    autoClose: false as const,
    withCloseButton: false,
  });

  function showSubmissionFailure(
    request: QuickTaskSubmission,
    message: string,
  ): void {
    notifications.update({
      id: submissionNotificationId(request),
      message: (
        <Stack gap={6}>
          <Text size="sm">{message}</Text>
          <Button
            size="compact-xs"
            variant="light"
            onClick={() => {
              notifications.update(pendingNotification(request));
              launchSubmission(request);
            }}
          >
            Retry
          </Button>
        </Stack>
      ),
      color: 'red',
      loading: false,
      autoClose: false,
      withCloseButton: true,
    });
  }

  async function settleSubmission(request: QuickTaskSubmission): Promise<void> {
    try {
      const result = request.file
        ? await (async () => {
            const evidenceFile = request.file;
            if (!evidenceFile)
              throw new Error('Quick Task evidence is unavailable');
            const form = new FormData();
            form.set('intent', JSON.stringify(request));
            form.set('evidence', evidenceFile);
            const response = await fetch('/api/quick-task/v1', {
              method: 'POST',
              body: form,
            });
            const payload = (await response.json()) as {
              task?: {
                repository: { owner: string; name: string };
                issueNumber: number;
              };
              url?: string;
              error?: string;
            };
            if (!response.ok || !payload.task || !payload.url)
              throw new Error(payload.error ?? 'Quick Task submission failed');
            return { ok: true as const, ...payload };
          })()
        : await createQuickTask({
            requestId: request.requestId,
            repository: request.repository,
            pipeline: request.pipeline,
            description: composeQuickTaskIssueBody(
              {
                description: request.description,
                screenshot: '',
                source: request.source,
              },
              request.repository,
            ),
          } satisfies QuickTaskRequest);
      if (!result.ok || !result.task || !result.url)
        throw new Error(
          result.ok ? 'Quick Task submission failed' : result.message,
        );
      notifications.update({
        id: submissionNotificationId(request),
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
        loading: false,
        autoClose: 4000,
        withCloseButton: true,
      });
    } catch (error) {
      showSubmissionFailure(
        request,
        error instanceof Error
          ? error.message
          : 'Quick Task submission failed unexpectedly',
      );
    }
  }

  function launchSubmission(request: QuickTaskSubmission): void {
    startTransition(async () => {
      await settleSubmission(request);
    });
  }

  /** Ctrl+Enter (Cmd+Enter on Mac) submits from the description, mirroring
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
    let requestId: string;
    try {
      requestId = createRandomId();
    } catch {
      showErrorToast('This browser cannot generate a Quick Task request ID');
      return;
    }
    submitInFlightRef.current = true;
    let evidenceId: string | undefined;
    if (screenshot) {
      try {
        evidenceId = createRandomId();
      } catch {
        submitInFlightRef.current = false;
        showErrorToast('This browser cannot generate a Quick Task evidence ID');
        return;
      }
    }
    const request: QuickTaskSubmission = {
      requestId,
      evidenceId,
      repository: {
        owner: selectedRepo.owner,
        name: selectedRepo.name,
      },
      pipeline: effectivePipeline,
      description,
      source,
      ...(screenshot ? { file: screenshot } : {}),
    };
    setDescription('');
    setScreenshot(null);
    setSource(emptySourceContext());
    close();
    notifications.show(pendingNotification(request));
    launchSubmission(request);
  };

  return (
    <>
      <Button
        className="lcars-action-button"
        data-accent="amber"
        size={size}
        disabled={!hydrated}
        onClick={open}
      >
        Quick task
      </Button>
      <Modal
        opened={opened}
        onClose={close}
        title="File a quick task"
        size="lg"
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
                const nextIndex = value ?? '0';
                const nextRepo = watchedRepos[Number(nextIndex)];
                const nextPipelines = nextRepo
                  ? supportedAgentPipelines(nextRepo)
                  : [];
                const nextPipeline = nextPipelines.includes(pipeline)
                  ? pipeline
                  : nextPipelines[0];
                setRepoIndex(nextIndex);
                if (nextPipeline) {
                  setPipeline(nextPipeline);
                  writeQuickTaskPreferences({
                    repoKey: repoKey(nextRepo),
                    pipeline: nextPipeline,
                  });
                }
              }}
              allowDeselect={false}
            />
          )}
          <Select
            label="Agent"
            description="Which pipeline picks up the task"
            data={pipelineOptions}
            value={effectivePipeline ?? null}
            onChange={(value) => {
              const nextPipeline = (value as AgentPipeline) ?? 'claude';
              setPipeline(nextPipeline);
              if (selectedRepo) {
                writeQuickTaskPreferences({
                  repoKey: repoKey(selectedRepo),
                  pipeline: nextPipeline,
                });
              }
            }}
            allowDeselect={false}
            disabled={pipelineOptions.length === 0}
          />
          <Textarea
            label="Description"
            value={description}
            onChange={(e) => {
              setDescription(e.currentTarget.value);
            }}
            onKeyDown={handleSubmitShortcut}
            placeholder="Describe the task — this becomes the issue body"
            autosize
            minRows={5}
          />
          {lowInformationGuidance && (
            <Text size="xs" c="orange" role="status">
              {lowInformationGuidance} You can still file this task as-is.
            </Text>
          )}
          <QuickTaskScreenshotField
            value={screenshot ?? undefined}
            onChange={(file) => setScreenshot(file ?? null)}
          />

          <Button
            disabled={
              !description.trim() ||
              !selectedRepo ||
              pipelineOptions.length === 0
            }
            onClick={handleCreate}
          >
            File & dispatch
          </Button>

          {description.trim() && (
            <Paper withBorder p="sm" data-testid="quick-task-preview">
              <Stack gap="xs">
                <Text fw={700} size="sm">
                  Issue preview
                </Text>
                <Group gap="xs" align="flex-start" wrap="nowrap">
                  <Text fw={600} size="xs">
                    Title
                  </Text>
                  <Text size="xs" data-testid="quick-task-preview-title">
                    {issueTitle}
                  </Text>
                </Group>
                <Text fw={600} size="xs">
                  Body
                </Text>
                <Box
                  component="pre"
                  data-testid="quick-task-preview-body"
                  m={0}
                  p="xs"
                  style={{
                    fontFamily: 'monospace',
                    fontSize: 'var(--mantine-font-size-xs)',
                    overflowX: 'auto',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {issueBody}
                </Box>
                <Text size="xs" c="dimmed">
                  The server appends the hidden Quick Task identity marker; the
                  title and human-readable body above are otherwise sent
                  unchanged.
                </Text>
              </Stack>
            </Paper>
          )}
        </Stack>
      </Modal>
    </>
  );
}
