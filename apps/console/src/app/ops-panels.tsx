import {
  EXECUTION_PHASE_LABELS,
  type ExecutionPhase,
  executionPhase,
} from '@agent-lcars/dispatch-contracts';
import type { IssueAgentSessionDoc } from '@agent-lcars/telemetry';
import { Anchor } from '@mantine/core';
import type { ReactNode } from 'react';

import {
  type AgentRun,
  groupLiveRunsByIssue,
  MAX_TURNS_BUDGET,
  RUN_TIMEOUT_MINUTES,
} from '../lib/agent-activity';
import type { CliSession } from '../lib/cli-sessions';
import { classifyAgentRun } from '../lib/run-classification';
import { docCost } from '../lib/session-ledger';
import {
  budgetColor,
  CliSessionRow,
  duplicatePipelineSummary,
  internalRunHref,
  PipelineBadge,
  QueueHealthAlert,
  RowTitle,
  type RunItemRef,
  ScreenshotStableDuration,
  STATUS_LABELS,
  taskHrefForRun,
  titleHrefForRun,
  workHrefForRun,
} from './agent-activity-panel';
import { BridgePaneLink } from './bridge-pane-link';
import { DecisionSlaMeta, DecisionWaiting } from './decision-waiting';
import { ExecutionStatus } from './execution-status';
import { formatCost, formatDuration } from './format';
import { MobileHistoryDisclosure } from './mobile-history-disclosure';
import {
  formatTokens,
  Meter,
  OpsPanel,
  StateMark,
  UNAVAILABLE,
} from './ops-primitives';
import { RelativeTime } from './relative-time';

export {
  formatTokens,
  Meter,
  OpsPanel,
  StateMark,
  UNAVAILABLE,
} from './ops-primitives';
export { RunnerFleetPanel } from './runner-fleet-panel';

/**
 * The operations panels of design/fleet-console.html: Active dispatches,
 * Recent completions, Decision inbox and Runner fleet. Bridge, Inbox, Agents
 * and Shuttlebay compose them; each renders real data, and an element with no
 * source in this console says so instead of showing a number.
 */

function sessionTokens(session: IssueAgentSessionDoc): number {
  const t = session.tokens;
  return (
    t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens
  );
}

function meterTone(fraction: number): 'warn' | 'fail' | undefined {
  const color = budgetColor(fraction);
  return color === 'red' ? 'fail' : color === 'yellow' ? 'warn' : undefined;
}

// ---- Active dispatches ----

/** The run lifecycle the console actually observes, in order. These are the
 * five blocks of the phase readout. */
const PHASES: readonly ExecutionPhase[] = [
  'queued',
  'claimed',
  'waiting-for-placement',
  'bootstrapping',
  'provider-execution',
];

function runPhase(run: AgentRun): ExecutionPhase | undefined {
  return executionPhase({
    state: run.status === 'queued' ? 'pending' : run.status,
    queue: run.queue,
  });
}

function PhaseBlocks({ run }: { run: AgentRun }) {
  const phase = runPhase(run);
  const index = phase ? PHASES.indexOf(phase) : -1;
  // The running block fills with the wall-clock budget it has used.
  const progress =
    phase === 'provider-execution'
      ? Math.min(1, run.elapsedSeconds / (RUN_TIMEOUT_MINUTES * 60))
      : 0.5;
  return (
    <div
      className="ops-phase"
      aria-label={
        phase
          ? `Phase ${index + 1} of ${PHASES.length}: ${EXECUTION_PHASE_LABELS[phase]}`
          : 'Phase unavailable'
      }
    >
      {PHASES.map((step, i) => (
        <i
          key={step}
          data-state={i < index ? 'done' : i === index ? 'current' : undefined}
          style={
            i === index
              ? ({ '--p': `${Math.round(progress * 100)}%` } as never)
              : undefined
          }
        />
      ))}
    </div>
  );
}

/** The run's own execution log: a GitHub Actions run or the executor's. */
function RunLogLink({ run }: { run: AgentRun }) {
  return (
    <Anchor
      href={run.url}
      target="_blank"
      rel="noreferrer"
      size="xs"
      className="ops-subtle-link"
      data-testid="run-log-link"
    >
      {run.url.startsWith('https://github.com/')
        ? 'View run on GitHub ↗'
        : 'View run'}
    </Anchor>
  );
}

/** The ref line carries `repo#N`; the title need not repeat it. */
function bareTitle(title: string): string {
  return title.replace(/^#\d+:?\s*/, '');
}

function runRef(run: AgentRun, item?: RunItemRef): string {
  const number = item?.number ?? run.issueNumber;
  if (number !== undefined) return `${run.repo.name}#${number}`;
  return run.workId ? `work ${run.workId.slice(-6)}` : run.repo.name;
}

function DispatchRow({
  run,
  item,
  session,
  selectHref,
  showRunner,
}: {
  run: AgentRun;
  item?: RunItemRef;
  session?: IssueAgentSessionDoc;
  selectHref?: string;
  showRunner: boolean;
}) {
  const fraction = run.elapsedSeconds / (RUN_TIMEOUT_MINUTES * 60);
  const taskHref = taskHrefForRun(run, item);
  const actionHref = taskHref ?? internalRunHref(run);
  const title = bareTitle(item ? item.title : run.displayTitle);
  const cost = session ? docCost(session).costUsd : undefined;
  const runHref = taskHref ?? workHrefForRun(run);
  return (
    <tr data-testid="current-run-row" data-status={run.status}>
      <td>
        <PipelineBadge pipeline={run.pipeline} />
      </td>
      <td className="ops-cell-clip">
        <BridgePaneLink
          mobileHref={actionHref}
          paneHref={selectHref ?? actionHref}
          className="ops-ref"
          data-testid="current-run-primary-action"
        >
          {runRef(run, item)}
        </BridgePaneLink>
        {selectHref ? (
          <RowTitle
            text={title}
            mobileHref={titleHrefForRun(run, item)}
            selectHref={selectHref}
          />
        ) : (
          <Anchor
            href={titleHrefForRun(run, item)}
            className="ops-item-title"
            data-testid="live-run-issue-link"
          >
            {title}
          </Anchor>
        )}
        {runHref && (
          <Anchor
            size="xs"
            className="ops-subtle-link"
            href={`${runHref}#run-${encodeURIComponent(run.id)}`}
          >
            Task/run
          </Anchor>
        )}
        <RunLogLink run={run} />
      </td>
      <td>
        <PhaseBlocks run={run} />
        <div className="ops-phase-label">
          <ExecutionStatus
            run={{
              state: run.status === 'queued' ? 'pending' : run.status,
              queue: run.queue,
            }}
          />
        </div>
      </td>
      {showRunner && (
        <td className="ops-mono-dim">{run.queue?.claimedBy ?? UNAVAILABLE}</td>
      )}
      <td className="ops-num">
        <ScreenshotStableDuration seconds={run.elapsedSeconds} />
      </td>
      <td className="ops-budget-cell">
        {run.status === 'running' ? (
          <Meter
            fraction={fraction}
            tone={meterTone(fraction)}
            label="Run wall-clock budget"
          />
        ) : (
          <Meter fraction={0} label="Run wall-clock budget" />
        )}
        <div className="ops-budget" data-tone={meterTone(fraction)}>
          <b>{formatDuration(run.elapsedSeconds)}</b> / {RUN_TIMEOUT_MINUTES}m
          {session ? (
            <>
              {' · '}
              <span data-testid="live-run-cost">
                {cost === undefined ? UNAVAILABLE : formatCost(cost)}
              </span>
              {' · '}
              {formatTokens(sessionTokens(session))} tok
              {run.pipeline === 'claude' && (
                <span data-testid="live-run-turns">
                  {' · '}
                  {session.turns} of {MAX_TURNS_BUDGET} turns
                </span>
              )}
              {' · '}
              <Anchor
                href={`/sessions/${session.sessionId}`}
                size="xs"
                data-testid="live-run-session-link"
              >
                session
              </Anchor>
            </>
          ) : (
            ' · session unavailable'
          )}
        </div>
      </td>
    </tr>
  );
}

export function ActiveDispatchesPanel({
  liveRuns,
  itemsByRunId = {},
  sessionsByRunId = {},
  selectHrefFor,
  showRunner = false,
  showQueueHealth = true,
  testId = 'current-work',
  updatedAt,
}: {
  liveRuns: AgentRun[];
  /** When these runs were read: the mockup's `updated 4 s ago`. */
  updatedAt?: string;
  itemsByRunId?: Record<string, RunItemRef>;
  sessionsByRunId?: Record<string, IssueAgentSessionDoc>;
  selectHrefFor?: (run: AgentRun) => string;
  showRunner?: boolean;
  /** Off where the page already shows the queue-health alert above. */
  showQueueHealth?: boolean;
  testId?: string;
}) {
  const byPipeline = new Map<string, number>();
  for (const run of liveRuns) {
    byPipeline.set(run.pipeline, (byPipeline.get(run.pipeline) ?? 0) + 1);
  }
  const pipelines = [...byPipeline].map(([p, n]) => `${p} ${n}`).join(' · ');
  const columns = showRunner ? 6 : 5;
  return (
    <OpsPanel
      title="Active dispatches"
      count={liveRuns.length}
      meta={
        pipelines || updatedAt !== undefined ? (
          <>
            {pipelines}
            {updatedAt !== undefined && (
              <>
                {pipelines && ' · '}updated{' '}
                <RelativeTime iso={updatedAt} variant="compact" />
              </>
            )}
          </>
        ) : undefined
      }
      data-testid={testId}
    >
      {showQueueHealth && <QueueHealthAlert liveRuns={liveRuns} />}
      {liveRuns.length === 0 ? (
        <p className="ops-empty">No agent runs queued or running.</p>
      ) : (
        <table className="ops-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Work item</th>
              <th>Phase</th>
              {showRunner && <th>Runner</th>}
              <th className="ops-num">Elapsed</th>
              <th>Budget</th>
            </tr>
          </thead>
          {groupLiveRunsByIssue(liveRuns).map((group) => {
            const rows = group.runs.map((run) => (
              <DispatchRow
                key={run.id}
                run={run}
                item={itemsByRunId[run.id]}
                session={sessionsByRunId[run.id]}
                selectHref={selectHrefFor?.(run)}
                showRunner={showRunner}
              />
            ));
            if (group.runs.length === 1) {
              return <tbody key={group.key}>{rows}</tbody>;
            }
            const item = itemsByRunId[group.runs[0].id];
            const duplicate = duplicatePipelineSummary(group.runs);
            const repo = group.runs[0].repo;
            return (
              <tbody
                key={group.key}
                className="ops-run-group"
                data-duplicate={duplicate ? '' : undefined}
                data-testid={`live-run-group-${group.issueNumber}`}
              >
                <tr className="ops-group-head">
                  <td colSpan={columns}>
                    {item
                      ? `#${item.number} ${item.title}`
                      : `#${group.issueNumber}`}{' '}
                    · {group.runs.length} runs
                    {group.issueNumber !== undefined && (
                      <>
                        {' · '}
                        <Anchor
                          href={`/task/${repo.owner}/${repo.name}/${group.issueNumber}`}
                          size="xs"
                          data-testid={`live-run-group-${group.issueNumber}-history`}
                        >
                          attempt history
                        </Anchor>
                      </>
                    )}
                    {duplicate && (
                      <div
                        className="ops-group-alert"
                        role="alert"
                        data-testid={`live-run-group-${group.issueNumber}-duplicate`}
                      >
                        Duplicate attempts: {duplicate} queued/running for this
                        task at once.
                      </div>
                    )}
                  </td>
                </tr>
                {rows}
              </tbody>
            );
          })}
        </table>
      )}
    </OpsPanel>
  );
}

// ---- Recent completions ----

const OUTCOME_TONE: Record<string, 'ok' | 'fail' | 'warn' | 'neutral'> = {
  succeeded: 'ok',
  failed: 'fail',
  timeout: 'warn',
  'silent-error': 'warn',
  cancelled: 'neutral',
  running: 'neutral',
};

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function RecentCompletionsPanel({
  runs,
  sessionsByRunId = {},
  selectHrefFor,
  testId = 'latest-outcomes',
  title = 'Recent completions',
  footer,
  mobileInitialCount,
  merged,
}: {
  runs: AgentRun[];
  sessionsByRunId?: Record<string, IssueAgentSessionDoc>;
  selectHrefFor?: (run: AgentRun) => string;
  testId?: string;
  title?: string;
  footer?: ReactNode;
  /** Phones show this many rows first, the rest behind a disclosure. */
  mobileInitialCount?: number;
  /** The mockup's head count, "N merged · 24h", which the Bridge streams in
   * from GitHub. Absent, the head counts the listed runs instead. */
  merged?: ReactNode;
}) {
  const classified = runs.map((run) => ({
    run,
    session: sessionsByRunId[run.id],
    classification: classifyAgentRun(run, sessionsByRunId[run.id]),
  }));
  const succeeded = classified.filter(
    ({ classification }) => classification.status === 'succeeded',
  ).length;
  const failed = classified.filter(
    ({ classification }) => classification.status === 'failed',
  ).length;
  const cycle = median(runs.map((run) => run.elapsedSeconds));
  const table = (
    <table className="ops-table">
      <thead>
        <tr>
          <th>Outcome</th>
          <th>Item</th>
          <th>Agent</th>
          <th className="ops-num">Cycle</th>
          <th className="ops-num">Cost</th>
          <th className="ops-num">At</th>
        </tr>
      </thead>
      <tbody>
        {classified.map(({ run, session, classification }, index) => {
          const selectHref = selectHrefFor?.(run);
          const taskHref = taskHrefForRun(run);
          const actionHref = taskHref ?? internalRunHref(run);
          const cost = session ? docCost(session).costUsd : undefined;
          return (
            <tr
              key={run.id}
              data-testid="finished-run-row"
              data-status={classification.status}
              data-mobile-history-extra={
                mobileInitialCount !== undefined && index >= mobileInitialCount
                  ? 'true'
                  : undefined
              }
            >
              <td>
                <StateMark
                  tone={OUTCOME_TONE[classification.status] ?? 'neutral'}
                  data-testid="recent-run-conclusion"
                >
                  {STATUS_LABELS[classification.status]}
                </StateMark>
              </td>
              <td className="ops-cell-clip ops-cell-wide">
                <BridgePaneLink
                  mobileHref={actionHref}
                  paneHref={selectHref ?? actionHref}
                  className="ops-ref"
                  data-testid="outcome-primary-action"
                >
                  {runRef(run)}
                </BridgePaneLink>
                {selectHref ? (
                  <RowTitle
                    text={bareTitle(run.displayTitle)}
                    mobileHref={titleHrefForRun(run)}
                    selectHref={selectHref}
                  />
                ) : (
                  <Anchor
                    href={titleHrefForRun(run)}
                    className="ops-item-title"
                    data-testid="recent-run-issue-link"
                  >
                    {bareTitle(run.displayTitle)}
                  </Anchor>
                )}
                {classification.diagnosis && (
                  <span
                    className="ops-diagnosis"
                    data-testid="finished-run-diagnosis"
                  >
                    {classification.diagnosis}
                  </span>
                )}
                {session && (
                  <Anchor
                    href={`/sessions/${session.sessionId}`}
                    size="xs"
                    className="ops-subtle-link"
                    data-testid="finished-run-session-link"
                  >
                    session
                  </Anchor>
                )}
                <RunLogLink run={run} />
              </td>
              <td>
                <PipelineBadge pipeline={run.pipeline} />
              </td>
              <td className="ops-num">
                <ScreenshotStableDuration seconds={run.elapsedSeconds} />
              </td>
              <td className="ops-num">
                {cost === undefined ? UNAVAILABLE : formatCost(cost)}
              </td>
              <td className="ops-num ops-dim">
                <RelativeTime iso={run.updatedAt} variant="compact" />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <OpsPanel
      title={title}
      count={merged ?? `${succeeded} succeeded · last ${runs.length}`}
      meta={
        [
          merged === undefined
            ? undefined
            : `${succeeded} succeeded · last ${runs.length}`,
          cycle === undefined
            ? undefined
            : `median cycle ${formatDuration(cycle)} · ${failed} failed`,
        ]
          .filter(Boolean)
          .join(' · ') || undefined
      }
      data-testid={testId}
    >
      {runs.length === 0 ? (
        <p className="ops-empty">No finished agent runs yet.</p>
      ) : mobileInitialCount !== undefined ? (
        <MobileHistoryDisclosure
          hiddenCount={Math.max(0, runs.length - mobileInitialCount)}
          itemLabel="outcome"
          testId="recent-outcomes-disclosure"
        >
          {table}
        </MobileHistoryDisclosure>
      ) : (
        table
      )}
      {footer}
    </OpsPanel>
  );
}

// ---- Decision inbox ----

export interface DecisionRow {
  key: string;
  reason: string;
  title: string;
  ref: string;
  refHref: string;
  agent?: string;
  waitingSince: string;
  respondHref: string;
}

/**
 * The Bridge's decision panel: every waiting decision counts toward the
 * header's `N over SLA · oldest X`, and the first `limit` rows are listed.
 */
export function DecisionInboxPanel({
  rows: allRows,
  limit = 5,
  respondLabel = 'Open',
  testId = 'decision-inbox-panel',
}: {
  rows: DecisionRow[];
  limit?: number;
  respondLabel?: string;
  testId?: string;
}) {
  const rows = allRows.slice(0, limit);
  return (
    <OpsPanel
      title="Decision inbox"
      count={allRows.length}
      meta={
        <DecisionSlaMeta
          waitingSince={allRows.map((row) => row.waitingSince)}
        />
      }
      signalled
      data-testid={testId}
    >
      {rows.length === 0 ? (
        <p className="ops-empty">No decisions waiting.</p>
      ) : (
        <ul className="ops-inbox">
          {rows.map((row) => (
            <li key={row.key} data-testid="decision-row">
              <div className="ops-inbox__text">
                <div className="ops-inbox__kind">{row.reason}</div>
                <div className="ops-inbox__title">{row.title}</div>
                <div className="ops-inbox__meta">
                  <Anchor href={row.refHref} className="ops-ref">
                    {row.ref}
                  </Anchor>
                  {row.agent && <span>{row.agent}</span>}
                  <DecisionWaiting since={row.waitingSince} />
                </div>
              </div>
              <Anchor
                href={row.respondHref}
                className="ops-row-action"
                aria-label={`${respondLabel}: ${row.title}`}
              >
                {respondLabel}
              </Anchor>
            </li>
          ))}
        </ul>
      )}
    </OpsPanel>
  );
}

// ---- CLI sessions ----

/** Interactive sessions in flight (FE-BR-3), in the same panel language. */
export function CliSessionsPanel({
  sessions,
  selectHrefFor,
}: {
  sessions: CliSession[];
  selectHrefFor?: (session: CliSession) => string;
}) {
  return (
    <OpsPanel
      title="CLI sessions"
      count={sessions.length}
      className="operations-panel"
      data-testid="cli-sessions-panel"
    >
      {sessions.length === 0 ? (
        <p className="ops-empty">No interactive sessions live or idle.</p>
      ) : (
        <div className="ops-rows">
          {sessions.map((session) => (
            <CliSessionRow
              key={session.sessionId}
              session={session}
              variant="operations"
              selectHref={selectHrefFor?.(session)}
            />
          ))}
        </div>
      )}
    </OpsPanel>
  );
}
