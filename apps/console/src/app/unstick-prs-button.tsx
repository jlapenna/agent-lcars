'use client';

import { Button, Popover, Stack, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useEffect, useEffectEvent, useState, useTransition } from 'react';

import { dispatchUnstickPrs } from './actions';
import { beginOperatorReauth, takePendingDraft } from './operator-reauth';
import { showErrorToast } from './show-error-toast';

/**
 * Finds or creates the repository's audit anchor, then admits the Claude
 * runbook through the Work API. GitHub stores the human-readable incident
 * thread; it is not an execution hop.
 *
 * `defaultContext` lets a queue card prefill "#N title" so a maintainer can
 * dispatch scoped to one stuck item in a single click instead of retyping
 * it into the header's blank popover.
 */
export function UnstickPrsButton({
  size = 'compact-sm',
  label = 'Run unstick-prs',
  defaultContext = '',
  repo,
}: {
  size?: string;
  label?: string;
  defaultContext?: string;
  /** Repository whose pull-request queue should be unstuck. */
  repo: { owner: string; name: string };
}) {
  const [opened, setOpened] = useState(false);
  const [context, setContext] = useState(defaultContext);
  const [isPending, startTransition] = useTransition();

  // Context typed before GitHub refused the operator's token comes back with
  // the page, in an open popover, ready to send. `defaultContext` tells the
  // header button from a queue card's prefilled one.
  const draftKey = `unstick:${repo.owner}/${repo.name}:${defaultContext}`;
  const restoreRefusedContext = useEffectEvent(() => {
    const refused = takePendingDraft(draftKey);
    if (refused === undefined) return;
    setContext(refused);
    setOpened(true);
  });
  useEffect(() => restoreRefusedContext(), [draftKey]);

  const handleDispatch = () => {
    setOpened(false);
    startTransition(async () => {
      const result = await dispatchUnstickPrs(
        context.trim() || undefined,
        repo,
      );
      if (!result.ok) {
        if (
          result.reauth &&
          beginOperatorReauth({ draft: { key: draftKey, text: context } })
        ) {
          notifications.show({
            message:
              'Refreshing your GitHub sign-in. Run unstick-prs again when the page returns; your context is kept.',
            loading: true,
          });
          return;
        }
        showErrorToast(result.message);
        return;
      }
      setContext(defaultContext);
      notifications.show({
        message: 'unstick-prs runbook dispatched',
        color: 'green',
      });
    });
  };

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      width={340}
      position="bottom-end"
      withArrow
    >
      <Popover.Target>
        <Button
          className="lcars-action-button"
          data-accent="violet"
          size={size}
          disabled={isPending}
          loading={isPending}
          onClick={() => setOpened((prev) => !prev)}
        >
          {label}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Textarea
            value={context}
            onChange={(e) => setContext(e.currentTarget.value)}
            aria-label="Optional context — PR numbers, symptoms — posted on the anchor issue"
            placeholder="Optional context — PR numbers, symptoms — posted on the anchor issue"
            autosize
            minRows={2}
          />
          <Button
            disabled={isPending}
            loading={isPending}
            onClick={handleDispatch}
            fullWidth
          >
            Dispatch
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
