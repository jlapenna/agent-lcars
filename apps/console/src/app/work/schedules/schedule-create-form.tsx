'use client';

import { parseCron, PIPELINES, ulid, type WorkSpec } from '@agent-lcars/work';
import {
  Button,
  Group,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useState, useTransition } from 'react';

/**
 * Deliberately looser than the exact `ProcedureServerFunction` type
 * `actions.ts` exports -- same reasoning as `work-actions.tsx`'s
 * `WorkAction`: this only needs the `[error, data]` tuple shape, not its
 * precise error/data union, so the real `createSchedule` server function
 * and a plain test double both satisfy it.
 */
type CreateResult = readonly [
  { code: string; message: string } | null,
  unknown,
];

export type CreateScheduleAction = (input: {
  id: string;
  cron: string;
  spec: WorkSpec;
  enabled: boolean;
}) => Promise<CreateResult>;

const REFUSALS: Record<string, string> = {
  FORBIDDEN: 'no grant for that pipeline or repository',
};

/**
 * The `/work/schedules` create form. The id is minted client-side (`ulid`
 * from `@agent-lcars/work`, the same helper `work-create-form.tsx` uses) so
 * a retried submission is idempotent -- the API answers 201 with the
 * existing schedule; the cron expression is checked client-side with the
 * same `parseCron` the server uses, so a typo is caught before the round
 * trip.
 */
export function ScheduleCreateForm({
  create,
  defaultRepo,
  pipelines = PIPELINES,
}: {
  create: CreateScheduleAction;
  defaultRepo: string;
  pipelines?: readonly WorkSpec['pipeline'][];
}) {
  const [isPending, startTransition] = useTransition();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [repo, setRepo] = useState(defaultRepo);
  const [pipeline, setPipeline] = useState<WorkSpec['pipeline']>(
    pipelines[0] ?? 'claude',
  );
  const [cron, setCron] = useState('0 * * * *');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | undefined>();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      parseCron(cron);
    } catch {
      // `parseCron`'s thrown message describes the specific parse failure
      // (field count, out-of-range value, ...); the inline error shown
      // here is instead the same fixed wording as the server's
      // `cronExpressionSchema` refine message (not exported from
      // `@agent-lcars/work`'s `contract.ts`, so duplicated verbatim) so a
      // caller sees one consistent "what's wrong" message regardless of
      // which side of the round trip caught it.
      setError('must be a valid 5-field UTC cron expression');
      return;
    }
    const id = ulid();
    startTransition(async () => {
      const [err] = await create({
        id,
        cron,
        spec: { title, description, pipeline, target: { repo } },
        enabled,
      });
      if (err) {
        setError(REFUSALS[err.code] ?? err.message);
        return;
      }
      setTitle('');
      setDescription('');
    });
  }

  return (
    <form onSubmit={submit} aria-label="Create schedule">
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
            onChange={(value) =>
              value && setPipeline(value as WorkSpec['pipeline'])
            }
            allowDeselect={false}
          />
        </Group>
        <TextInput
          label="Cron (UTC, 5-field: min hour dom mon dow)"
          required
          value={cron}
          onChange={(e) => setCron(e.currentTarget.value)}
        />
        <Switch
          label="Enabled"
          checked={enabled}
          onChange={(e) => setEnabled(e.currentTarget.checked)}
        />
        {error ? (
          <Text c="red" size="sm">
            {error}
          </Text>
        ) : null}
        <Group justify="flex-end">
          <Button type="submit" loading={isPending}>
            Create schedule
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
