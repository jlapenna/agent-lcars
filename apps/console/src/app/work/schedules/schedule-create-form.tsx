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

export interface EditableSchedule {
  id: string;
  cron: string;
  spec?: WorkSpec;
  enabled: boolean;
  revision: number;
}
export type UpdateScheduleAction = (input: {
  id: string;
  expectedRevision: number;
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
  initial,
  onSaved,
  onPendingChange,
}: {
  create: CreateScheduleAction;
  defaultRepo: string;
  pipelines?: readonly WorkSpec['pipeline'][];
  initial?: EditableSchedule;
  onSaved?: () => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [title, setTitle] = useState(initial?.spec?.title ?? '');
  const [description, setDescription] = useState(
    initial?.spec?.description ?? '',
  );
  const [repo, setRepo] = useState(initial?.spec?.target.repo ?? defaultRepo);
  const [pipeline, setPipeline] = useState<WorkSpec['pipeline']>(
    initial?.spec?.pipeline ?? pipelines[0] ?? 'claude',
  );
  const [cron, setCron] = useState(initial?.cron ?? '0 * * * *');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
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
    onPendingChange?.(true);
    startTransition(async () => {
      try {
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
        if (initial === undefined) {
          setTitle('');
          setDescription('');
        }
        onSaved?.();
      } catch (error) {
        setError(
          error instanceof Error
            ? error.message
            : 'Could not save schedule. Please retry.',
        );
      } finally {
        onPendingChange?.(false);
      }
    });
  }

  return (
    <form
      onSubmit={submit}
      aria-label={initial ? 'Edit schedule' : 'Create schedule'}
    >
      <Stack gap="xs">
        <TextInput
          disabled={isPending}
          label="Title"
          required
          maxLength={256}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
        <Textarea
          disabled={isPending}
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
            disabled={isPending}
            label="Repository"
            required
            value={repo}
            onChange={(e) => setRepo(e.currentTarget.value)}
          />
          <Select
            disabled={isPending}
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
          disabled={isPending}
          label="Cron (UTC, 5-field: min hour dom mon dow)"
          required
          value={cron}
          onChange={(e) => setCron(e.currentTarget.value)}
        />
        <Switch
          disabled={isPending}
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
          <Button type="submit" loading={isPending} disabled={isPending}>
            {initial ? 'Save changes' : 'Create schedule'}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
