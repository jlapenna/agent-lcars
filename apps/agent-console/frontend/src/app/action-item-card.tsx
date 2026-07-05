'use client';

import {
  Anchor,
  Badge,
  Blockquote,
  Button,
  Card,
  Group,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useState, useTransition } from 'react';

import type {
  ActionItem,
  ActionType,
  MergeableState,
} from '../lib/action-items';
import { mergePr, replyToItem, retriggerIssue } from './actions';
import { githubIssueUrl } from './format';

const ACTION_LABELS: Record<ActionType, string> = {
  'waiting-on-answer': 'Waiting on your answer',
  'run-failed': 'CI run failed',
  'review-requested': 'Review requested',
  'post-deploy-action': 'Needs post-deploy action',
};

const ACTION_COLORS: Record<ActionType, string> = {
  'waiting-on-answer': 'blue',
  'run-failed': 'red',
  'review-requested': 'grape',
  'post-deploy-action': 'yellow',
};

const TRUNCATION_THRESHOLD = 400;
const COLLAPSED_HEIGHT = 120;

// 'clean'/'unknown' need no callout; the rest explain why "Approve & Merge"
// might not work without a click through to GitHub.
const MERGEABLE_WARNINGS: Partial<Record<MergeableState, string>> = {
  dirty: 'Merge conflicts',
  blocked: 'Blocked (branch protection / required checks)',
  unstable: 'Checks unstable',
  behind: 'Base branch has moved',
};

const NOT_MERGEABLE_STATES: MergeableState[] = ['dirty', 'blocked'];

function CommentPreview({
  body,
  url,
  expanded,
  onToggle,
}: {
  body: string;
  url: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const needsTruncation = body.length > TRUNCATION_THRESHOLD;
  const isCollapsed = needsTruncation && !expanded;
  return (
    <Stack gap={6}>
      <div style={{ position: 'relative' }}>
        <Blockquote
          color="gray"
          styles={{
            root: {
              padding: '8px 12px',
              maxHeight: isCollapsed ? COLLAPSED_HEIGHT : 'none',
              overflow: 'hidden',
            },
          }}
        >
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {body}
          </Text>
        </Blockquote>
        {isCollapsed && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              height: 40,
              background:
                'linear-gradient(to bottom, rgba(0,0,0,0), rgba(0,0,0,0.55))',
              pointerEvents: 'none',
            }}
          />
        )}
      </div>
      <Group gap="md">
        {needsTruncation && (
          <Button
            variant="subtle"
            color="gray"
            size="compact-xs"
            onClick={onToggle}
          >
            {expanded ? '▴ Show less' : '▾ Show full response'}
          </Button>
        )}
        <Anchor
          href={url}
          target="_blank"
          rel="noreferrer"
          size="xs"
          c="dimmed"
        >
          View on GitHub ↗
        </Anchor>
      </Group>
    </Stack>
  );
}

export function ActionItemCard({
  item,
  updatedAtLabel,
}: {
  item: ActionItem;
  updatedAtLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [isPending, startTransition] = useTransition();

  const handleReply = () => {
    if (!replyBody.trim()) return;
    setError(undefined);
    startTransition(async () => {
      try {
        await replyToItem(item.number, replyBody);
        setReplyBody('');
        notifications.show({
          message: `Reply posted on #${item.number}`,
          color: 'green',
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to post reply');
      }
    });
  };

  const handleReplyKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleReply();
    }
  };

  const handleMerge = () => {
    setError(undefined);
    startTransition(async () => {
      try {
        await mergePr(item.number);
        notifications.show({
          message: `#${item.number} merged`,
          color: 'green',
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to merge');
      }
    });
  };

  const confirmMerge = () =>
    modals.openConfirmModal({
      title: `Merge #${item.number}?`,
      children: (
        <Text size="sm">
          This approves and squash-merges &ldquo;{item.title}&rdquo; into main.
          This can&rsquo;t be undone from here.
        </Text>
      ),
      labels: { confirm: 'Approve & Merge', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: handleMerge,
    });

  const handleRetrigger = () => {
    setError(undefined);
    startTransition(async () => {
      try {
        await retriggerIssue(item.number);
        notifications.show({
          message: `#${item.number} retriggered`,
          color: 'green',
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to retrigger');
      }
    });
  };

  return (
    <Card withBorder radius="md" padding="md">
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Anchor
            href={item.url}
            target="_blank"
            rel="noreferrer"
            fw={600}
            c="inherit"
            style={{ minWidth: 0, overflowWrap: 'break-word' }}
          >
            #{item.number} {item.title}
          </Anchor>
          <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
            {item.draft && (
              <Badge variant="outline" color="gray" size="sm">
                Draft
              </Badge>
            )}
            <Badge variant="outline" color="gray" size="sm">
              {item.kind === 'pr' ? 'PR' : 'Issue'}
            </Badge>
          </Group>
        </Group>

        <Text size="xs" c="dimmed">
          {item.author && <>by {item.author} · </>}
          updated {updatedAtLabel}
        </Text>

        {(item.parentNumber || item.subIssues || item.linkedIssueNumbers) && (
          <Group gap="md">
            {item.parentNumber && (
              <Anchor
                href={githubIssueUrl(item, item.parentNumber)}
                target="_blank"
                rel="noreferrer"
                size="xs"
                c="dimmed"
              >
                ↳ part of #{item.parentNumber}
              </Anchor>
            )}
            {item.subIssues && (
              <Text size="xs" c="dimmed">
                sub-issues: {item.subIssues.completed}/{item.subIssues.total}{' '}
                done
              </Text>
            )}
            {item.linkedIssueNumbers && item.linkedIssueNumbers.length > 0 && (
              <Text size="xs" c="dimmed">
                Closes{' '}
                {item.linkedIssueNumbers.map((n, i) => (
                  <span key={n}>
                    {i > 0 && ', '}
                    <Anchor
                      href={githubIssueUrl(item, n)}
                      target="_blank"
                      rel="noreferrer"
                      size="xs"
                      c="dimmed"
                      inherit
                    >
                      #{n}
                    </Anchor>
                  </span>
                ))}
              </Text>
            )}
          </Group>
        )}

        {item.actionTypes.length > 0 && (
          <Group gap={6}>
            {item.actionTypes.map((type) => (
              <Badge key={type} color={ACTION_COLORS[type]} variant="light">
                {ACTION_LABELS[type]}
              </Badge>
            ))}
          </Group>
        )}

        {item.failingChecks && item.failingChecks.length > 0 && (
          <Text size="xs" c="red">
            Failed:{' '}
            {item.failingChecks.map((check, i) => (
              <span key={check.name}>
                {i > 0 && ', '}
                <Anchor
                  href={check.url}
                  target="_blank"
                  rel="noreferrer"
                  size="xs"
                  c="red"
                  inherit
                >
                  {check.name}
                </Anchor>
              </span>
            ))}
          </Text>
        )}

        {item.mergeableState && MERGEABLE_WARNINGS[item.mergeableState] && (
          <Text size="xs" c="yellow">
            ⚠ {MERGEABLE_WARNINGS[item.mergeableState]}
          </Text>
        )}

        {item.lastCommentBody && item.lastCommentUrl && (
          <CommentPreview
            body={item.lastCommentBody}
            url={item.lastCommentUrl}
            expanded={expanded}
            onToggle={() => setExpanded((prev) => !prev)}
          />
        )}

        <Group gap="sm" wrap="wrap" mt={4}>
          <TextInput
            value={replyBody}
            onChange={(e) => setReplyBody(e.currentTarget.value)}
            onKeyDown={handleReplyKeyDown}
            placeholder="Reply with @claude…"
            style={{ flex: 1, minWidth: 200 }}
          />
          <Button
            variant="default"
            disabled={isPending || !replyBody.trim()}
            onClick={handleReply}
          >
            Reply
          </Button>
          {item.kind === 'issue' && (
            <Button
              variant="default"
              disabled={isPending}
              onClick={handleRetrigger}
            >
              Retrigger
            </Button>
          )}
          {item.kind === 'pr' && (
            <Button
              color="dark"
              disabled={
                isPending ||
                (item.mergeableState !== undefined &&
                  NOT_MERGEABLE_STATES.includes(item.mergeableState))
              }
              title={
                item.mergeableState && MERGEABLE_WARNINGS[item.mergeableState]
              }
              onClick={confirmMerge}
            >
              Approve &amp; Merge
            </Button>
          )}
        </Group>

        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}
      </Stack>
    </Card>
  );
}
