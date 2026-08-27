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
import { useRef, useState, useTransition } from 'react';

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
  TOO_MANY_REQUESTS:
    'The fleet is at its live-run cap — wait for a run to finish, or cancel one first.',
};

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
 * `workRouter.create`.
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
  const idRef = useRef<string | undefined>(undefined);

  function fieldChanged<T>(set: (value: T) => void) {
    return (value: T) => {
      idRef.current = undefined;
      set(value);
    };
  }
  const onTitleChange = fieldChanged(setTitle);
  const onDescriptionChange = fieldChanged(setDescription);
  const onRepoChange = fieldChanged(setRepo);
  const onPipelineChange = fieldChanged(setPipeline);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    idRef.current ??= ulid();
    const id = idRef.current;
    startTransition(async () => {
      const [err] = await create({
        id,
        spec: { title, description, pipeline, target: { repo } },
      });
      if (err) {
        setError(REFUSALS[err.code] ?? err.message);
        return;
      }
      idRef.current = undefined;
      router.push(`/work/${id}`);
    });
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
        <Group justify="flex-end">
          <Button type="submit" loading={isPending}>
            Create work item
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
