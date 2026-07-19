'use client';

import {
  ActionIcon,
  Anchor,
  Badge,
  Blockquote,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconLink } from '@tabler/icons-react';
import { useState, useTransition } from 'react';

import type {
  ActionItem,
  ActionType,
  MergeableState,
} from '../lib/action-items';
import { pipelineForLabels, type PrimaryAction } from '../lib/primary-action';
import { mergePr, replyToItem } from './actions';
import { CancelRunButton } from './cancel-run-button';
import { githubIssueUrl } from './format';
import { ItemOverflowMenu } from './item-overflow-menu';
import { RetriggerButton } from './retrigger-button';
import { UnstickPrsButton } from './unstick-prs-button';

const ACTION_LABELS: Record<ActionType, string> = {
  'human-needed': 'Needs a human',
  'run-failed': 'CI run failed',
  'review-requested': 'Review requested',
  'post-deploy-action': 'Awaiting next deploy',
};

const ACTION_COLORS: Record<ActionType, string> = {
  'human-needed': 'blue',
  'run-failed': 'red',
  'review-requested': 'grape',
  'post-deploy-action': 'gray',
};

const TRUNCATION_THRESHOLD = 400;
const COLLAPSED_HEIGHT = 120;

// 'clean'/'unknown' need no callout; the rest explain why "Approve & Merge"
// might not work without a click through to GitHub.
//
// 'blocked' is deliberately absent: it's GitHub's catch-all "can't merge
// yet" state, and for a review-requested item its overwhelmingly common
// cause is simply the maintainer's own outstanding required approval -
// exactly what clicking "Approve & Merge" submits before merging (see
// approveAndMergePr). Treating it as a hard stop disabled the button for
// every single review-requested PR in the queue, permanently (#2751). A
// still-running required check is tracked separately via `ciRunning`; any
// other real leftover block (a second required reviewer, etc.) surfaces as
// a GitHub error from the merge call itself.
const MERGEABLE_WARNINGS: Partial<Record<MergeableState, string>> = {
  dirty: 'Merge conflicts',
  unstable: 'Checks unstable',
  behind: 'Base branch has moved',
  draft: 'Draft — mark it ready for review first',
};

const NOT_MERGEABLE_STATES: MergeableState[] = ['dirty', 'draft'];

function mergeableWarning(item: {
  mergeableState?: MergeableState;
}): string | undefined {
  return item.mergeableState && MERGEABLE_WARNINGS[item.mergeableState];
}

/** Preformatted live-run info; built server-side in page.tsx. */
export interface LiveRunSummary {
  id: number;
  status: 'queued' | 'running';
  label: string;
  url: string;
}

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

/**
 * A full-weight card, rendered ONLY for items in "Your Queue". It leads
 * with one primary action derived from why the item needs the maintainer
 * (see derivePrimaryAction); everything else on the card is context for
 * making that one decision.
 */
export function ActionItemCard({
  item,
  updatedAtLabel,
  primaryAction,
  liveRun,
}: {
  item: ActionItem;
  updatedAtLabel: string;
  primaryAction?: PrimaryAction;
  liveRun?: LiveRunSummary;
}) {
  const [expanded, setExpanded] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  // The reply input renders already open when replying IS the task; on
  // other cards it stays behind a "Reply…" toggle.
  const [replyOpen, setReplyOpen] = useState(primaryAction?.kind === 'reply');
  const [error, setError] = useState<string | undefined>();
  const [isPending, startTransition] = useTransition();

  // Which pipeline a reply/retrigger on this item routes to (claude vs the
  // experimental opencode.yml, #2988/#2994) - see pipelineForLabels.
  const pipeline = pipelineForLabels(item.labels);
  const replyMention = pipeline === 'opencode' ? '/oc' : '@claude';

  const handleReply = () => {
    if (!replyBody.trim()) return;
    setError(undefined);
    startTransition(async () => {
      const result = await replyToItem(item.number, replyBody, item.labels);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setReplyBody('');
      notifications.show({
        message: `Reply posted on #${item.number}`,
        color: 'green',
      });
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
      const result = await mergePr(item.number);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      notifications.show({
        message: `#${item.number} merged`,
        color: 'green',
      });
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

  const mergeDisabled =
    isPending ||
    item.draft ||
    item.ciRunning ||
    (item.mergeableState !== undefined &&
      NOT_MERGEABLE_STATES.includes(item.mergeableState));

  return (
    <Card withBorder radius="md" padding="md">
      <Stack gap={6}>
        <Group justify="space-between" align="flex-start" gap="sm">
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
          <Group gap={6} wrap="wrap" style={{ flexShrink: 0 }}>
            {item.actionTypes.map((type) => (
              <Badge
                key={type}
                color={ACTION_COLORS[type]}
                variant="light"
                size="sm"
              >
                {ACTION_LABELS[type]}
              </Badge>
            ))}
            <ItemOverflowMenu item={item} />
          </Group>
        </Group>

        {/* One dimmed context line replaces the previous stack of label
            badges and relationship rows - context, not work, so it gets
            one line of visual weight. */}
        <Text size="xs" c="dimmed">
          {item.kind === 'pr' ? 'PR' : 'Issue'}
          {item.draft ? ' (draft)' : ''}
          {item.author && <> · by {item.author}</>} · updated {updatedAtLabel}
          {item.parentNumber && (
            <>
              {' · '}
              <Anchor
                href={githubIssueUrl(item, item.parentNumber)}
                target="_blank"
                rel="noreferrer"
                c="dimmed"
                inherit
              >
                part of #{item.parentNumber}
              </Anchor>
            </>
          )}
          {item.subIssues && (
            <>
              {' '}
              · sub-issues {item.subIssues.completed}/{item.subIssues.total}
            </>
          )}
          {item.linkedIssueNumbers && item.linkedIssueNumbers.length > 0 && (
            <>
              {' '}
              · closes {item.linkedIssueNumbers.map((n) => `#${n}`).join(', ')}
            </>
          )}
          {item.labels.length > 0 && <> · {item.labels.join(', ')}</>}
        </Text>

        {liveRun && (
          <Group gap={6}>
            <Badge
              variant="filled"
              color={liveRun.status === 'running' ? 'blue' : 'gray'}
              size="sm"
            >
              {liveRun.status === 'running'
                ? 'Agent working now'
                : 'Agent run queued'}
            </Badge>
            <Text size="xs" c="dimmed">
              {liveRun.label}
            </Text>
            <Anchor
              href={liveRun.url}
              target="_blank"
              rel="noreferrer"
              size="xs"
              c="dimmed"
            >
              View run ↗
            </Anchor>
            <CancelRunButton runId={liveRun.id} label={item.title} />
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

        {item.ciRunning && (
          <Text size="xs" c="dimmed">
            CI running…
          </Text>
        )}

        {mergeableWarning(item) && (
          <Text size="xs" c="yellow">
            ⚠ {mergeableWarning(item)}
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

        {item.takeoverCommand && (
          <Group gap={6} wrap="nowrap">
            <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
              Takeover:
            </Text>
            <Code
              style={{
                overflowX: 'auto',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
            >
              {item.takeoverCommand}
            </Code>
            <CopyButton value={item.takeoverCommand}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? 'Copied' : 'Copy takeover command'}>
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    color={copied ? 'teal' : 'gray'}
                    onClick={copy}
                    aria-label="Copy takeover command"
                    style={{ flexShrink: 0 }}
                  >
                    {copied ? <IconCheck size={14} /> : <IconLink size={14} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          </Group>
        )}

        {replyOpen && (
          <Group gap="sm" wrap="nowrap" mt={4}>
            <TextInput
              value={replyBody}
              onChange={(e) => setReplyBody(e.currentTarget.value)}
              onKeyDown={handleReplyKeyDown}
              placeholder={`Reply with ${replyMention}…`}
              autoFocus={primaryAction?.kind !== 'reply'}
              style={{ flex: 1, minWidth: 200 }}
            />
            <Button
              variant={primaryAction?.kind === 'reply' ? 'filled' : 'default'}
              disabled={isPending || !replyBody.trim()}
              onClick={handleReply}
            >
              Reply
            </Button>
          </Group>
        )}

        <Group gap="sm" wrap="wrap" mt={4}>
          {primaryAction?.kind === 'approve-merge' && (
            <Button
              color="dark"
              // item.draft is belt-and-suspenders for the 'draft'
              // mergeable_state: merging a draft always 405s.
              disabled={mergeDisabled}
              title={
                item.draft ? MERGEABLE_WARNINGS.draft : mergeableWarning(item)
              }
              onClick={confirmMerge}
            >
              Approve &amp; Merge
            </Button>
          )}
          {primaryAction?.kind === 'fix-ci' && (
            <Button
              component="a"
              href={primaryAction.checkUrl}
              target="_blank"
              rel="noreferrer"
              color="red"
              variant="light"
            >
              Open failing check ↗
            </Button>
          )}
          {!replyOpen && (
            <Button
              variant="default"
              onClick={() => setReplyOpen(true)}
              disabled={isPending}
            >
              Reply…
            </Button>
          )}
          {item.kind === 'issue' &&
            (item.labels.includes('claude') ||
              item.labels.includes('opencode')) && (
              <RetriggerButton
                issueNumber={item.number}
                pipeline={pipeline}
                disabled={Boolean(liveRun)}
                disabledReason="An agent run is already in flight for this item"
                onError={setError}
                size="sm"
              />
            )}
          {item.kind === 'pr' && item.actionTypes.includes('run-failed') && (
            <UnstickPrsButton
              size="sm"
              label="Unstick"
              defaultContext={`#${item.number} ${item.title}`}
            />
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
