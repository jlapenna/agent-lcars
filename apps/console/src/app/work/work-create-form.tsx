'use client';

import { PIPELINES, ulid } from '@agent-lcars/work';
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
import { useState, useTransition } from 'react';

/** Pipelines this console can dispatch — the same literal union
 *  `workRouter.create`'s `spec.pipeline` accepts (`workSpecSchema` in
 *  `spec.ts`). Derived from `PIPELINES` rather than duplicated so the two
 *  never drift. */
type Pipeline = (typeof PIPELINES)[number];

/**
 * Deliberately looser than the exact `ProcedureServerFunction` type
 * `actions.ts` exports (same reasoning as `work-actions.tsx`'s
 * `WorkActionResult`): real oRPC server functions pair an error with
 * `undefined` data, not `null` (`ServerFunctionResult` in `@orpc/next`),
 * and this component never reads the success payload — it navigates using
 * the id it minted itself — so `unknown` covers both the real
 * `createItem` and a plain test double.
 */
type CreateResult = readonly [
  { code: string; message: string } | null,
  unknown,
];

export type CreateItemAction = (input: {
  id: string;
  spec: {
    title: string;
    description: string;
    pipeline: Pipeline;
    target: { repo: string };
  };
}) => Promise<CreateResult>;

const REFUSALS: Record<string, string> = {
  FORBIDDEN:
    'Your grant does not cover that pipeline or repository (no grant for that pipeline or repository).',
  TOO_MANY_REQUESTS:
    'The live-run cap reached; redispatch or cancel a running item first.',
};

/**
 * The `/work` create form. The id is minted client-side so a retried
 * submission is idempotent (the API answers 201 with the existing item);
 * grants, the cap, and validation all live in `workRouter.create`.
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

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    const id = ulid();
    startTransition(async () => {
      const [err] = await create({
        id,
        spec: { title, description, pipeline, target: { repo } },
      });
      if (err) {
        setError(REFUSALS[err.code] ?? err.message);
        return;
      }
      router.push(`/work/${id}`);
    });
  }

  return (
    <form onSubmit={submit} aria-label="Create work item">
      <Stack gap="xs">
        <TextInput
          label="Title"
          required
          maxLength={256}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
        <Textarea
          label="Description"
          required
          autosize
          minRows={3}
          maxLength={16_384}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
        <Group grow>
          <TextInput
            label="Repository"
            required
            value={repo}
            onChange={(e) => setRepo(e.currentTarget.value)}
          />
          <Select
            label="Pipeline"
            data={[...pipelines]}
            value={pipeline}
            onChange={(value) => value && setPipeline(value as Pipeline)}
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
