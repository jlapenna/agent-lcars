'use client';

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
  'waiting-on-answer': '#3b82f6',
  'run-failed': '#ef4444',
  'review-requested': '#a855f7',
  'post-deploy-action': '#fbca04',
};

const TRUNCATION_THRESHOLD = 400;
const COLLAPSED_HEIGHT = 120;

// 'clean'/'unknown' need no callout; the rest explain why "Approve & Merge"
// might not work without a click through to GitHub.
const MERGEABLE_WARNINGS: Partial<Record<MergeableState, string>> = {
  dirty: '⚠ Merge conflicts',
  blocked: '⚠ Blocked (branch protection / required checks)',
  unstable: '⚠ Checks unstable',
  behind: '⚠ Base branch has moved',
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
    <div style={{ marginTop: 10 }}>
      <div style={{ position: 'relative' }}>
        <blockquote
          style={{
            margin: 0,
            padding: '8px 12px',
            borderLeft: '3px solid #374151',
            color: '#d1d5db',
            fontSize: 13,
            whiteSpace: 'pre-wrap',
            maxHeight: isCollapsed ? COLLAPSED_HEIGHT : 'none',
            overflow: 'hidden',
            cursor: 'text',
          }}
        >
          {body}
        </blockquote>
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
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}
      >
        {needsTruncation && (
          <button
            onClick={onToggle}
            style={{
              background: 'none',
              border: 'none',
              color: '#9ca3af',
              fontSize: 12,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            {expanded ? '▴ Show less' : '▾ Show full response'}
          </button>
        )}
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 12, color: '#9ca3af' }}
        >
          View on GitHub ↗
        </a>
      </div>
    </div>
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
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to post reply');
      }
    });
  };

  const handleMerge = () => {
    setError(undefined);
    startTransition(async () => {
      try {
        await mergePr(item.number);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to merge');
      }
    });
  };

  const handleRetrigger = () => {
    setError(undefined);
    startTransition(async () => {
      try {
        await retriggerIssue(item.number);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to retrigger');
      }
    });
  };

  return (
    <div
      style={{
        border: '1px solid #374151',
        borderRadius: 8,
        padding: 16,
        marginBottom: 12,
      }}
    >
      <div
        style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}
      >
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          style={{ fontWeight: 600, color: 'inherit', textDecoration: 'none' }}
        >
          #{item.number} {item.title}
        </a>
        <span
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            whiteSpace: 'nowrap',
          }}
        >
          {item.draft && (
            <span style={{ fontSize: 11, color: '#9ca3af' }}>Draft</span>
          )}
          <span style={{ fontSize: 12, color: '#9ca3af' }}>
            {item.kind === 'pr' ? 'PR' : 'Issue'}
          </span>
        </span>
      </div>

      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
        {item.author && <>by {item.author} · </>}
        updated {updatedAtLabel}
      </div>

      {(item.parentNumber || item.subIssues || item.linkedIssueNumbers) && (
        <div
          style={{
            fontSize: 12,
            color: '#9ca3af',
            marginTop: 6,
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          {item.parentNumber && (
            <a
              href={githubIssueUrl(item, item.parentNumber)}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'inherit' }}
            >
              ↳ part of #{item.parentNumber}
            </a>
          )}
          {item.subIssues && (
            <span>
              sub-issues: {item.subIssues.completed}/{item.subIssues.total} done
            </span>
          )}
          {item.linkedIssueNumbers && item.linkedIssueNumbers.length > 0 && (
            <span>
              Closes{' '}
              {item.linkedIssueNumbers.map((n, i) => (
                <span key={n}>
                  {i > 0 && ', '}
                  <a
                    href={githubIssueUrl(item, n)}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'inherit' }}
                  >
                    #{n}
                  </a>
                </span>
              ))}
            </span>
          )}
        </div>
      )}

      {item.actionTypes.length > 0 && (
        <div
          style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}
        >
          {item.actionTypes.map((type) => (
            <span
              key={type}
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 4,
                background: `${ACTION_COLORS[type]}22`,
                color: ACTION_COLORS[type],
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: 0.3,
              }}
            >
              {ACTION_LABELS[type]}
            </span>
          ))}
        </div>
      )}

      {item.failingChecks && item.failingChecks.length > 0 && (
        <div style={{ fontSize: 12, color: '#f87171', marginTop: 6 }}>
          Failed:{' '}
          {item.failingChecks.map((check, i) => (
            <span key={check.name}>
              {i > 0 && ', '}
              <a
                href={check.url}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'inherit' }}
              >
                {check.name}
              </a>
            </span>
          ))}
        </div>
      )}

      {item.mergeableState && MERGEABLE_WARNINGS[item.mergeableState] && (
        <div style={{ fontSize: 12, color: '#fbca04', marginTop: 6 }}>
          {MERGEABLE_WARNINGS[item.mergeableState]}
        </div>
      )}

      {item.lastCommentBody && item.lastCommentUrl && (
        <CommentPreview
          body={item.lastCommentBody}
          url={item.lastCommentUrl}
          expanded={expanded}
          onToggle={() => setExpanded((prev) => !prev)}
        />
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <input
          value={replyBody}
          onChange={(e) => setReplyBody(e.target.value)}
          placeholder="Reply with @claude ..."
          style={{
            flex: 1,
            minWidth: 200,
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid #374151',
            background: 'transparent',
            color: 'inherit',
          }}
        />
        <button disabled={isPending || !replyBody.trim()} onClick={handleReply}>
          Reply
        </button>
        {item.kind === 'issue' && (
          <button disabled={isPending} onClick={handleRetrigger}>
            Retrigger
          </button>
        )}
        {item.kind === 'pr' && (
          <button
            disabled={
              isPending ||
              (item.mergeableState !== undefined &&
                NOT_MERGEABLE_STATES.includes(item.mergeableState))
            }
            title={
              item.mergeableState && MERGEABLE_WARNINGS[item.mergeableState]
            }
            onClick={handleMerge}
          >
            Approve &amp; Merge
          </button>
        )}
      </div>

      {error && (
        <p style={{ color: '#ef4444', fontSize: 13, marginTop: 8 }}>{error}</p>
      )}
    </div>
  );
}
