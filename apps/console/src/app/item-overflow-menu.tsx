'use client';

import {
  ActionIcon,
  Button,
  Group,
  Menu,
  Modal,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconDotsVertical } from '@tabler/icons-react';
import { type FormEvent, useState, useTransition } from 'react';

import type { ActionItem } from '../lib/action-items';
import { type Pipeline } from '../lib/primary-action';
import {
  matchingAgentPipelines,
  selectedAgentPipeline,
  supportedAgentPipelines,
} from '../lib/watched-repo';
import {
  assignPipeline,
  clearHumanNeeded,
  closeIssue,
  reassignPipeline,
  rebasePr,
  updateIssueContent,
} from './actions';
import { showErrorToast } from './show-error-toast';

/**
 * An overflow menu, shared by queue cards and compact rows, for secondary
 * actions (closing an item's loop, clearing a label, rebasing a PR,
 * reassigning to a different agent) without a trip to GitHub. Renders
 * nothing if no action applies to this item.
 */
export function ItemOverflowMenu({
  item,
  muted,
  onToggleMute,
}: {
  item: ActionItem;
  /** Current per-browser mute state (#59) - see use-muted-items.ts. Omit
   * `onToggleMute` entirely on rows that don't offer muting (only "Your
   * Queue" does today). */
  muted?: boolean;
  onToggleMute?: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [editOpened, setEditOpened] = useState(false);
  const [editTitle, setEditTitle] = useState(item.title);
  const [editBody, setEditBody] = useState(item.body ?? '');

  const canEdit = item.kind === 'issue';
  const canClose = item.kind === 'issue';
  const canClearHumanNeeded = item.actionTypes.includes('needs-human');
  const canMute = Boolean(onToggleMute);
  // 'behind' is the MERGEABLE_WARNINGS/action-item-card.tsx state for
  // "Base branch has moved" - the one mergeable_state a maintainer can
  // resolve with a single click rather than a trip to GitHub.
  const canRebase = item.kind === 'pr' && item.mergeableState === 'behind';
  // Only issues carry a pipeline label (claude.yml/codex.yml/opencode.yml
  // dispatch off `issues: labeled`, not PRs) - an issue with none of the
  // three has never been handed to an agent, so there's nothing to
  // reassign FROM.
  const pipelines = supportedAgentPipelines(item.repo);
  const currentPipeline = selectedAgentPipeline(item.repo, item.labels);
  const reassignTargets =
    item.kind === 'issue' && currentPipeline
      ? pipelines.filter((p) => p !== currentPipeline)
      : [];
  const canReassign = reassignTargets.length > 0;
  // Zero agent labels means "never assigned" - offer every pipeline. Two or
  // more is contradictory state (selectedAgentPipeline also reports
  // `undefined` here, but for the opposite reason): every "Assign to …"
  // option would fail backend-actions.ts's assignPipeline, which rejects an
  // issue that already carries an agent label, so the menu withholds
  // assignment rather than offering actions that can never succeed.
  const assignTargets =
    item.kind === 'issue' &&
    matchingAgentPipelines(item.repo, item.labels).length === 0
      ? pipelines
      : [];
  const canAssign = assignTargets.length > 0;
  if (
    !canEdit &&
    !canClose &&
    !canClearHumanNeeded &&
    !canMute &&
    !canRebase &&
    !canAssign &&
    !canReassign
  )
    return null;

  const handleClose = () => {
    startTransition(async () => {
      const result = await closeIssue(item.repo, item.number);
      if (!result.ok) {
        showErrorToast(result.message);
        return;
      }
      notifications.show({
        message: `#${item.number} closed`,
        color: 'green',
      });
    });
  };

  const openEdit = () => {
    setEditTitle(item.title);
    setEditBody(item.body ?? '');
    setEditOpened(true);
  };

  const handleEdit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = editTitle.trim();
    if (!title) return;

    startTransition(async () => {
      const result = await updateIssueContent(item.repo, item.number, {
        title,
        body: editBody,
      });
      if (!result.ok) {
        showErrorToast(result.message);
        return;
      }
      setEditOpened(false);
      notifications.show({
        message: `#${item.number} updated`,
        color: 'green',
      });
    });
  };

  const confirmClose = () =>
    modals.openConfirmModal({
      title: `Close #${item.number}?`,
      children: (
        <Text size="sm">
          This closes &ldquo;{item.title}&rdquo; on GitHub without posting a
          comment. This can&rsquo;t be undone from here.
        </Text>
      ),
      labels: { confirm: 'Close issue', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: handleClose,
    });

  const handleClearHumanNeeded = () => {
    startTransition(async () => {
      const result = await clearHumanNeeded(item.repo, item.number);
      if (!result.ok) {
        showErrorToast(result.message);
        return;
      }
      notifications.show({
        message: `Cleared needs-human on #${item.number}`,
        color: 'green',
      });
    });
  };

  const handleReassign = (target: Pipeline) => {
    startTransition(async () => {
      const result = await reassignPipeline(item.repo, item.number, target);
      if (!result.ok) {
        showErrorToast(result.message);
        return;
      }
      notifications.show({
        message: `#${item.number} reassigned to ${target}`,
        color: 'green',
      });
    });
  };

  const handleAssign = (target: Pipeline) => {
    startTransition(async () => {
      const result = await assignPipeline(item.repo, item.number, target);
      if (!result.ok) return showErrorToast(result.message);
      notifications.show({
        message: `#${item.number} assigned to ${target}`,
        color: 'green',
      });
    });
  };

  const handleRebase = () => {
    startTransition(async () => {
      const result = await rebasePr(item.repo, item.number);
      if (!result.ok) {
        showErrorToast(result.message);
        return;
      }
      notifications.show({
        message: `#${item.number} updated with the base branch`,
        color: 'green',
      });
    });
  };

  const editUnchanged =
    editTitle.trim() === item.title && editBody === (item.body ?? '');

  return (
    <>
      <Menu withinPortal position="bottom-end" shadow="md">
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            color="gray"
            disabled={isPending}
            loading={isPending}
            aria-label={`More actions for #${item.number}`}
            style={{ flexShrink: 0 }}
          >
            <IconDotsVertical aria-hidden="true" size={18} stroke={1.7} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          {canEdit && <Menu.Item onClick={openEdit}>Edit issue</Menu.Item>}
          {canRebase && (
            <Menu.Item onClick={handleRebase}>
              Rebase onto base branch
            </Menu.Item>
          )}
          {reassignTargets.map((target) => (
            <Menu.Item key={target} onClick={() => handleReassign(target)}>
              Reassign to {target}
            </Menu.Item>
          ))}
          {assignTargets.map((target) => (
            <Menu.Item key={target} onClick={() => handleAssign(target)}>
              Assign to {target}
            </Menu.Item>
          ))}
          {canClearHumanNeeded && (
            <Menu.Item onClick={handleClearHumanNeeded}>
              Clear needs-human
            </Menu.Item>
          )}
          {canMute && (
            <Menu.Item onClick={onToggleMute}>
              {muted ? 'Unmute' : 'Mute'}
            </Menu.Item>
          )}
          {canClose && (
            <Menu.Item color="red" onClick={confirmClose}>
              Close issue
            </Menu.Item>
          )}
        </Menu.Dropdown>
      </Menu>
      {canEdit && (
        <Modal
          opened={editOpened}
          onClose={() => {
            if (!isPending) setEditOpened(false);
          }}
          closeOnClickOutside={!isPending}
          title={`Edit #${item.number}`}
        >
          <form onSubmit={handleEdit}>
            <Stack gap="sm">
              <TextInput
                label="Title"
                required
                value={editTitle}
                onChange={(event) => setEditTitle(event.currentTarget.value)}
                disabled={isPending}
              />
              <Textarea
                label="Body"
                value={editBody}
                onChange={(event) => setEditBody(event.currentTarget.value)}
                autosize
                minRows={10}
                disabled={isPending}
              />
              <Group justify="flex-end" gap="xs">
                <Button
                  type="button"
                  variant="default"
                  disabled={isPending}
                  onClick={() => setEditOpened(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  loading={isPending}
                  disabled={!editTitle.trim() || editUnchanged}
                >
                  Save changes
                </Button>
              </Group>
            </Stack>
          </form>
        </Modal>
      )}
    </>
  );
}
