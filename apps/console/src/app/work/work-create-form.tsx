'use client';

import {
  PIPELINES,
  ulid,
  WORK_DESCRIPTION_MAX,
  WORK_TITLE_MAX,
} from '@agent-lcars/work';
import {
  Button,
  Group,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';

import type { WorkActionResult } from './work-actions';

/** Pipelines this console can dispatch — the same literal union
 *  `workRouter.create`'s `spec.pipeline` accepts (`workSpecSchema` in
 *  `spec.ts`). Derived from `PIPELINES` rather than duplicated so the two
 *  never drift. */
type Pipeline = (typeof PIPELINES)[number];

/**
 * Reuses `work-actions.tsx`'s `WorkActionResult` tuple shape rather than
 * re-declaring it: real oRPC server functions pair an error with
 * `undefined` data, not `null` (`ServerFunctionResult` in `@orpc/next`),
 * and this component never reads the success payload — it navigates using
 * the id it minted itself — so `WorkActionResult`'s `unknown` data slot
 * covers both the real `createItem` and a plain test double.
 */
export type CreateItemAction = (input: {
  id: string;
  spec: {
    title: string;
    description: string;
    pipeline: Pipeline;
    target: { repo: string };
  };
}) => Promise<WorkActionResult>;

const REFUSALS: Record<string, string> = {
  FORBIDDEN: 'Your grant does not cover that pipeline or repository.',
};

/** Fallback wait before an automatic retry when a `TOO_MANY_REQUESTS`
 *  refusal carries no `data.retryAfterSeconds` (a plain test double, or a
 *  future error shape change) -- matches `work-mint.ts`'s
 *  `RETRY_AFTER_SECONDS` server default so the two stay in step without a
 *  client import (that module is `server-only`). */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

/**
 * `WorkActionResult`'s error entry types `data` as bare `unknown` -- it
 * mirrors the real `ServerFunctionResult`'s `ORPCErrorJSON`, whose `data`
 * is only narrowed per-error-code on the *contract* (`itemsContract.create`
 * declares `TOO_MANY_REQUESTS`'s `data` as `{ retryAfterSeconds: number }`
 * in `contract.ts`), not on this looser client-side tuple type. Read
 * defensively rather than widening the shared type for one caller.
 */
function retryAfterSecondsOf(errorData: unknown): number | undefined {
  if (typeof errorData !== 'object' || errorData === null) return undefined;
  const value = (errorData as { retryAfterSeconds?: unknown })
    .retryAfterSeconds;
  return typeof value === 'number' ? value : undefined;
}

/**
 * The `/work` create form. The id is minted client-side, lazily, on first
 * submit and held for the life of that spec: a retried submission after a
 * refusal (a fixable one - fix the field workRouter.create rejected and
 * resubmit) reuses the same id so the API sees a replay of the same
 * `{id, spec}` pair (idempotent - 201 with the existing item) rather than
 * minting a second orphaned item for one logical request. Editing any spec
 * field clears the held id: the next submit is then a genuinely new
 * request, not a replay under a stale id paired with a changed spec (which
 * `workRouter.create` would reject as a conflicting id - see `sameSpec` in
 * `work-router.ts`). Grants, the cap, and validation all live in
 * `workRouter.create`. The held id is exactly what makes the automatic
 * `TOO_MANY_REQUESTS` retry below safe: every queued attempt replays the
 * same `{id, spec}` pair, so a slot freeing up between attempts creates
 * the item exactly once.
 */
export function WorkCreateForm({
  create,
  defaultRepo,
  pipelines,
}: {
  create: CreateItemAction;
  defaultRepo: string;
  pipelines: readonly Pipeline[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [repo, setRepo] = useState(defaultRepo);
  const [pipeline, setPipeline] = useState<Pipeline>(pipelines[0] ?? 'claude');
  const [error, setError] = useState<string | undefined>();
  const [queued, setQueued] = useState(false);
  const idRef = useRef<string | undefined>(undefined);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  function clearRetryTimeout() {
    if (retryTimeoutRef.current !== undefined) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = undefined;
    }
  }
  function cancelQueuedRetry() {
    clearRetryTimeout();
    setQueued(false);
  }
  useEffect(() => clearRetryTimeout, []);

  function fieldChanged<T>(set: (value: T) => void) {
    return (value: T) => {
      idRef.current = undefined;
      cancelQueuedRetry();
      set(value);
    };
  }
  const onTitleChange = fieldChanged(setTitle);
  const onDescriptionChange = fieldChanged(setDescription);
  const onRepoChange = fieldChanged(setRepo);
  const onPipelineChange = fieldChanged(setPipeline);

  /**
   * Reused for both the user's own click and an automatic queued retry
   * (`attempt` reuses the id `submit` already minted). Issue #1862: the
   * fleet's live-run cap used to leave the operator stuck with a dead-end
   * error and a manual "resubmit later" burden. `TOO_MANY_REQUESTS` is
   * instead treated as "queued", not a terminal refusal -- the form keeps
   * retrying on its own, at the interval the server names in
   * `data.retryAfterSeconds`, until a slot frees up or a different error
   * (or success) ends the wait.
   */
  function attempt(id: string) {
    startTransition(async () => {
      const [err] = await create({
        id,
        spec: { title, description, pipeline, target: { repo } },
      });
      if (err) {
        if (err.code === 'TOO_MANY_REQUESTS') {
          setError(undefined);
          setQueued(true);
          const retryAfterSeconds =
            retryAfterSecondsOf(err.data) ?? DEFAULT_RETRY_AFTER_SECONDS;
          retryTimeoutRef.current = setTimeout(() => {
            retryTimeoutRef.current = undefined;
            attempt(id);
          }, retryAfterSeconds * 1000);
          return;
        }
        setQueued(false);
        setError(REFUSALS[err.code] ?? err.message);
        return;
      }
      setQueued(false);
      idRef.current = undefined;
      router.push(`/work/${id}`);
    });
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    cancelQueuedRetry();
    idRef.current ??= ulid();
    attempt(idRef.current);
  }

  return (
    <form onSubmit={submit} aria-label="Create work item">
      <Stack gap="xs">
        <TextInput
          label="Title"
          required
          maxLength={WORK_TITLE_MAX}
          value={title}
          onChange={(e) => onTitleChange(e.currentTarget.value)}
        />
        <Textarea
          label="Description"
          required
          autosize
          minRows={3}
          maxLength={WORK_DESCRIPTION_MAX}
          value={description}
          onChange={(e) => onDescriptionChange(e.currentTarget.value)}
        />
        <Group grow>
          <TextInput
            label="Repository"
            required
            value={repo}
            onChange={(e) => onRepoChange(e.currentTarget.value)}
          />
          <Select
            label="Pipeline"
            data={[...pipelines]}
            value={pipeline}
            onChange={(value) => value && onPipelineChange(value as Pipeline)}
            allowDeselect={false}
          />
        </Group>
        {error ? (
          <Text c="red" size="sm">
            {error}
          </Text>
        ) : null}
        {queued ? (
          <Text c="dimmed" size="sm" role="status">
            The fleet is at its live-run cap — this item is queued and will be
            created automatically once a slot frees up.
          </Text>
        ) : null}
        <Group justify="flex-end">
          <Button type="submit" loading={isPending}>
            Create work item
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
