'use client';

import { workRepository } from '@agent-lcars/work';
import { workTitle } from '@agent-lcars/work/derive';
import { Anchor, Button, Stack, Text, Textarea, Title } from '@mantine/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useTransition,
} from 'react';

import {
  humanAskFromHandoff,
  humanDecisionFromHandoff,
  humanDecisionReply,
} from '../lib/human-ask';
import { DecisionWaiting } from './decision-waiting';
import { HumanDecisionButtons } from './human-decision-buttons';
import { HumanNeededSummary } from './human-needed-summary';
import {
  nativeCardText,
  nativeCardTime,
  type NativeDecisionCard,
} from './inbox-card';
import { IssueSourceLink } from './issue-source';
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
  const report = card.kind === 'report';
  const reason = report ? 'report-ready' : 'needs-human';
  const original = nativeCardText(card);
  const ask = report ? undefined : humanAskFromHandoff(original);
  return (
    <div
      className="queue-item-row"
      data-selected={selected ? '' : undefined}
      data-reason={reason}
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
          <div className="ops-inbox__kind">{actionTypeMeta(reason).label}</div>
          <span className="ops-inbox__title queue-item-row__title">
            {workTitle(work)}
          </span>
          <span className="queue-item-row__question">
            {ask ?? card.decisionSummary ?? original}
          </span>
          <div className="ops-inbox__meta">
            <span className="ops-ref">
              {workRepository(work.spec)} / {work.id}
            </span>
            <span>{work.spec.pipeline}</span>
            {report ? (
              <span>
                settled <RelativeTime iso={nativeCardTime(card)} />
              </span>
            ) : (
              <DecisionWaiting since={work.updatedAt} />
            )}
          </div>
        </div>
        <span
          className="ops-row-action queue-item-row__respond"
          aria-hidden="true"
        >
          {report ? 'Read' : 'Respond'}
        </span>
      </Link>
      {onSnooze && (
        <Button
          variant="subtle"
          size="compact-xs"
          aria-label={`${report ? 'Dismiss' : 'Snooze'} ${workTitle(work)}`}
          onClick={onSnooze}
        >
          {report ? 'Dismiss' : 'Snooze'}
        </Button>
      )}
    </div>
  );
}

export function NativeDecisionDetail({
  card,
  trajectory,
  replyToWorkItem,
  onReplyAdmitted,
  onReplyDraftChange,
}: {
  card: NativeDecisionCard;
  trajectory?: React.ReactNode;
  replyToWorkItem?: ReplyAction;
  onReplyAdmitted?: (message: string) => void;
  onReplyDraftChange?: (hasDraft: boolean) => void;
}) {
  const { work, canReply } = card;
  const decision =
    work.state === 'parked'
      ? humanDecisionFromHandoff(nativeCardText(card))
      : undefined;
  const parkedRunId =
    work.state === 'parked' ? work.runs.at(-1)?.runId : undefined;
  const submitting = useRef(false);
  const [answeredRunId, setAnsweredRunId] = useState<string>();
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
  const reply = (body: string, decisionRunId?: string) => {
    if (!replyToWorkItem || !canReply || !body.trim() || submitting.current)
      return;
    submitting.current = true;
    startTransition(async () => {
      try {
        const [error, result] = await replyToWorkItem({
          id: work.anchor.workId,
          text: body.trim(),
          ...(decisionRunId === undefined
            ? {}
            : {
                requestId: `inbox-decision:${decisionRunId}`,
                expectedParkedRunId: decisionRunId,
              }),
        });
        if (error) {
          setFeedback(error.message);
          return;
        }
        setAnsweredRunId(parkedRunId);
        setText('');
        const message = replyAdmissionMessage(result?.resumed === true);
        if (onReplyAdmitted) {
          setFeedback(undefined);
          onReplyAdmitted(message);
        } else setFeedback(message);
        router.refresh();
      } finally {
        submitting.current = false;
      }
    });
  };
  return (
    <Stack
      className="queue-detail-state"
      gap="md"
      data-testid="native-decision-detail"
    >
      <Title order={2} size="h3">
        {workTitle(work)}
      </Title>
      {work.issue ? <IssueSourceLink issue={work.issue} /> : null}
      <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
        {workRepository(work.spec)} / {work.id}
      </Text>
      <Text size="sm" c="dimmed">
        {work.state === 'parked'
          ? 'Human needed'
          : card.kind === 'report'
            ? 'Report ready'
            : work.state}{' '}
        · <RelativeTime iso={nativeCardTime(card)} />
      </Text>
      {decision && (
        <Text size="sm" fw={600} aria-label="Human ask">
          {decision.ask}
        </Text>
      )}
      {decision && parkedRunId && (
        <HumanDecisionButtons
          decision={decision}
          disabled={
            !replyToWorkItem ||
            !canReply ||
            pending ||
            answeredRunId === parkedRunId
          }
          onChoose={(choice) =>
            reply(humanDecisionReply(decision.ask, choice), parkedRunId)
          }
        />
      )}
      {!decision && card.decisionSummary && (
        <Text size="sm" aria-label="Inbox summary">
          {card.decisionSummary}
        </Text>
      )}
      {work.state === 'parked' && (
        <HumanNeededSummary
          key={`${work.id}:${work.runs.at(-1)?.runId}`}
          actions={
            card.humanNeededActions ??
            work.runs.at(-1)?.result?.humanNeededActions
          }
          historical
        />
      )}
      {card.question ?? (
        <Text style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {nativeCardText(card)}
        </Text>
      )}
      <Anchor component={Link} href={`/work/${work.anchor.workId}`}>
        Full history
      </Anchor>
      {trajectory}
      {replyToWorkItem && (canReply || text || pending) ? (
        <>
          <Textarea
            style={{ width: '100%' }}
            label={
              card.kind === 'report' ? 'Ask a follow-up' : 'Reply to the agent'
            }
            placeholder={
              card.kind === 'report'
                ? 'Ask about this report...'
                : 'Reply to the agent...'
            }
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            autosize
            minRows={3}
          />
          <Button
            onClick={() => reply(text)}
            loading={pending}
            disabled={!canReply || pending || !text.trim()}
          >
            Reply
          </Button>
        </>
      ) : work.state === 'parked' || card.kind === 'report' ? (
        <Text size="sm" c="dimmed">
          {work.origin.principal === 'svc:fleet-triage' && work.issue
            ? 'Respond on the source issue; its next update will refresh triage.'
            : 'Reply requires a Work operator grant for this pipeline.'}
        </Text>
      ) : (
        <Text size="sm" c="dimmed">
          This work no longer needs a decision.
        </Text>
      )}
      {feedback && (
        <Text role="status" aria-label="Reply status" size="sm">
          {feedback}
        </Text>
      )}
    </Stack>
  );
}
