'use client';

import { Anchor, Button, Stack, Text, Textarea, Title } from '@mantine/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useEffectEvent, useState, useTransition } from 'react';

import { type NativeDecisionCard, nativeDecisionQuestion } from './inbox-card';
import { actionTypeMeta } from './queue-reason';
import { RelativeTime } from './relative-time';
import { replyAdmissionMessage } from './reply-admission-message';
import type { ReplyAction } from './work/work-actions';

export function NativeDecisionRow({
  card,
  href,
  selected,
  onNavigate,
  onSnooze,
}: {
  card: NativeDecisionCard;
  href: string;
  selected: boolean;
  onNavigate: () => void;
  onSnooze?: () => void;
}) {
  const { work } = card;
  return (
    <div
      className="queue-item-row"
      data-selected={selected ? '' : undefined}
      data-reason="needs-human"
      data-testid={`queue-row-${work.id}`}
    >
      <Link
        href={href}
        scroll={false}
        className="queue-item-row__link"
        aria-current={selected ? 'true' : undefined}
        onClick={onNavigate}
      >
        <div className="queue-item-row__text">
          <div className="ops-inbox__kind">
            {actionTypeMeta('needs-human').label}
          </div>
          <span className="ops-inbox__title queue-item-row__title">
            {work.spec.title}
          </span>
          <span className="queue-item-row__question">
            {nativeDecisionQuestion(work)}
          </span>
          <div className="ops-inbox__meta">
            <span className="ops-ref">
              {work.spec.target.repo} / {work.id}
            </span>
            <span>{work.spec.pipeline}</span>
            <span>
              waiting <RelativeTime iso={work.updatedAt} variant="compact" />
            </span>
          </div>
        </div>
        <span
          className="ops-row-action queue-item-row__respond"
          aria-hidden="true"
        >
          Respond
        </span>
      </Link>
      {onSnooze && (
        <Button
          variant="subtle"
          size="compact-xs"
          aria-label={`Snooze ${work.spec.title}`}
          onClick={onSnooze}
        >
          Snooze
        </Button>
      )}
    </div>
  );
}

export function NativeDecisionDetail({
  card,
  replyToWorkItem,
  onReplyAdmitted,
  onReplyDraftChange,
}: {
  card: NativeDecisionCard;
  replyToWorkItem?: ReplyAction;
  onReplyAdmitted?: (message: string) => void;
  onReplyDraftChange?: (hasDraft: boolean) => void;
}) {
  const { work, canReply } = card;
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState<string>();
  const [pending, startTransition] = useTransition();
  const notifyDraft = useEffectEvent((hasDraft: boolean) =>
    onReplyDraftChange?.(hasDraft),
  );
  useEffect(() => {
    notifyDraft(Boolean(text) || pending);
  }, [text, pending]);
  const router = useRouter();
  const reply = () =>
    startTransition(async () => {
      if (!replyToWorkItem || !canReply || !text.trim()) return;
      const [error, result] = await replyToWorkItem({
        id: work.anchor.workId,
        text: text.trim(),
      });
      if (error) {
        setFeedback(error.message);
        return;
      }
      setText('');
      const message = replyAdmissionMessage(result?.resumed === true);
      if (onReplyAdmitted) {
        setFeedback(undefined);
        onReplyAdmitted(message);
      } else setFeedback(message);
      router.refresh();
    });
  return (
    <Stack
      className="queue-detail-state"
      gap="md"
      data-testid="native-decision-detail"
    >
      <Title order={2} size="h3">
        {work.spec.title}
      </Title>
      <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
        {work.spec.target.repo} / {work.id}
      </Text>
      <Text size="sm" c="dimmed">
        {work.state === 'parked' ? 'Human needed' : work.state} ·{' '}
        <RelativeTime iso={work.updatedAt} />
      </Text>
      <Text style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {nativeDecisionQuestion(work)}
      </Text>
      <Anchor component={Link} href={`/work/${work.anchor.workId}`}>
        Full history
      </Anchor>
      {replyToWorkItem && (canReply || text || pending) ? (
        <>
          <Textarea
            style={{ width: '100%' }}
            label="Reply to the agent"
            placeholder="Reply to the agent..."
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            autosize
            minRows={3}
          />
          <Button
            onClick={reply}
            loading={pending}
            disabled={!canReply || pending || !text.trim()}
          >
            Reply
          </Button>
        </>
      ) : work.state === 'parked' ? (
        <Text size="sm" c="dimmed">
          Reply requires a Work operator grant for this pipeline.
        </Text>
      ) : (
        <Text size="sm" c="dimmed">
          This work no longer needs a decision.
        </Text>
      )}
      {feedback && (
        <Text role="status" size="sm">
          {feedback}
        </Text>
      )}
    </Stack>
  );
}
