'use client';

import {
  Button,
  Group,
  Modal,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import type { FormEvent } from 'react';

import type { SnoozeDecisionInput } from '../lib/decision-snooze-contract';
import { SNOOZE_DURATIONS } from '../lib/decision-snooze-values';
import { type InboxCard, inboxCardKey, inboxCardSignature } from './inbox-card';

export interface EditDialogProps {
  number: number;
  title: string;
  body: string;
  pending: boolean;
  unchanged: boolean;
  onTitle: (title: string) => void;
  onBody: (body: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}

export function EditDialog(props: EditDialogProps) {
  return (
    <Modal
      opened
      returnFocus={false}
      onClose={props.onClose}
      closeOnClickOutside={!props.pending}
      title={`Edit #${props.number}`}
    >
      <form onSubmit={props.onSubmit}>
        <Stack gap="sm">
          <TextInput
            label="Title"
            required
            value={props.title}
            onChange={(event) => props.onTitle(event.currentTarget.value)}
            disabled={props.pending}
          />
          <Textarea
            label="Body"
            value={props.body}
            onChange={(event) => props.onBody(event.currentTarget.value)}
            autosize
            minRows={10}
            disabled={props.pending}
          />
          <Group justify="flex-end" gap="xs">
            <Button
              type="button"
              variant="default"
              disabled={props.pending}
              onClick={props.onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              loading={props.pending}
              disabled={!props.title.trim() || props.unchanged}
            >
              Save changes
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export interface SnoozeDialogProps {
  card: InboxCard;
  pending: boolean;
  error?: string;
  snooze: (input: SnoozeDecisionInput) => Promise<boolean>;
  onClose: () => void;
}

export function SnoozeDialog({
  card,
  pending,
  error,
  snooze,
  onClose,
}: SnoozeDialogProps) {
  return (
    <Modal
      opened
      returnFocus={false}
      onClose={onClose}
      title="Snooze decision"
      size="sm"
      closeOnClickOutside={!pending}
      closeOnEscape={!pending}
      withCloseButton={!pending}
    >
      <Stack gap="sm">
        <Text size="sm">
          Hide this decision only for your account, across devices. New activity
          or a changed decision brings it back sooner. No work or GitHub labels
          are changed.
        </Text>
        {error && (
          <Text role="alert" size="sm">
            {error}
          </Text>
        )}
        {SNOOZE_DURATIONS.map((duration) => (
          <Button
            key={duration.minutes}
            variant="default"
            disabled={pending}
            onClick={async () => {
              if (
                await snooze({
                  anchor: inboxCardKey(card),
                  signature: inboxCardSignature(card),
                  minutes: duration.minutes,
                })
              )
                onClose();
            }}
          >
            {duration.label}
          </Button>
        ))}
      </Stack>
    </Modal>
  );
}
