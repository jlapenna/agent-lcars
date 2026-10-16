import { PIPELINES } from '@agent-lcars/work';
import { Suspense } from 'react';

import { assertAdmin } from '@/lib/auth-guards';

import { auth } from '../../auth';
import { getWatchedRepos } from '../../lib/github-client';
import { getShuttlebayStatus } from '../../lib/shuttlebay-status';
import { fleetTokenRate, TOKEN_RATE_READ_FAILED } from '../../lib/token-rate';
import { getTokenRateSnapshot } from '../../lib/token-rate-data';
import { repoKey } from '../../lib/watched-repo';
import { ConsoleCommandUtilities } from '../console-command-utilities';
import {
  ConsoleToolbar,
  ToolbarApply,
  ToolbarSearch,
  ToolbarSelect,
  ToolbarWindow,
} from '../console-toolbar';
import { NavPageLoading, PageLoading } from '../page-loading';
import { RunnerAutoscalerStatus } from '../runner-autoscaler-status';
import { withConsolePageShell } from '../with-console-page-shell';
import {
  parseShuttlebayFilters,
  type ShuttlebayFilters,
} from './shuttlebay-view-filters';

async function ShuttlebayBody({ filters, watchedRepos }: ShuttlebayViewProps) {
  const [autoscaler, tokenRateSnapshot] = await Promise.all([
    getShuttlebayStatus(),
    getTokenRateSnapshot(),
  ]);

  return (
    <RunnerAutoscalerStatus
      initial={autoscaler}
      filters={filters}
      tokenRate={fleetTokenRate(tokenRateSnapshot, {
        repo: filters.repo,
        agent: filters.agent,
      })}
      readWarnings={tokenRateSnapshot ? [] : [TOKEN_RATE_READ_FAILED]}
      toolbar={
        // No primary: the mockup gives Shuttlebay none, and the header's
        // live status already says the page updates itself.
        <ConsoleToolbar
          action="/shuttlebay"
          folded={[filters.repo, filters.agent].filter(Boolean).length}
        >
          <ToolbarSelect
            name="repo"
            label="Repository"
            value={filters.repo ?? ''}
            options={[
              { value: '', label: `All repositories (${watchedRepos.length})` },
              ...watchedRepos.map((repo) => ({
                value: repoKey(repo),
                label: repoKey(repo),
              })),
            ]}
          />
          <ToolbarSelect
            name="agent"
            label="Agent"
            value={filters.agent ?? ''}
            options={[
              { value: '', label: 'All agents' },
              ...PIPELINES.map((pipeline) => ({
                value: pipeline,
                label: pipeline,
              })),
            ]}
          />
          <ToolbarWindow
            name="window"
            label="Window"
            value="30m"
            options={SHUTTLEBAY_WINDOWS}
            note="Runner telemetry keeps the last 30 minutes"
          />
          <ToolbarSearch
            name="q"
            label="Find"
            placeholder="runner lane"
            value={filters.q}
          />
          {/* Controls apply on change; Apply is for browsers without JavaScript (<noscript>). */}
          <ToolbarApply label="Apply" />
        </ConsoleToolbar>
      }
    />
  );
}

/**
 * The mockup's window control. Every Shuttlebay readout is live or covers
 * the last 30 minutes (the autoscaler and session windows keep no more), so
 * that is the one choosable window; the longer ones are drawn and say why
 * they cannot be chosen, in a note beside the control, rather than
 * silently showing 30 minutes as 24 hours.
 */
const SHUTTLEBAY_WINDOWS = [
  { value: '30m', label: '30m' },
  ...['1h', '24h', '7d'].map((value) => ({
    value,
    label: value,
    disabled: true,
  })),
];

interface ShuttlebayViewProps {
  watchedRepos: ReturnType<typeof getWatchedRepos>;
  filters: ShuttlebayFilters;
}

function ShuttlebayViewContent(props: ShuttlebayViewProps) {
  return (
    <Suspense fallback={<PageLoading rows={4} header={false} />}>
      <ShuttlebayBody {...props} />
    </Suspense>
  );
}

const ShuttlebayView = withConsolePageShell(
  ShuttlebayViewContent,
  ({ watchedRepos }: ShuttlebayViewProps) => ({
    className: 'shuttlebay-page-shell',
    current: 'shuttlebay',
    title: 'Shuttlebay',
    subtitle: 'Runner fleet · live runners and queue status',
    utilities: (
      <>
        <div className="shuttlebay-utilities shuttlebay-utilities--desktop console-utilities--desktop">
          <ConsoleCommandUtilities watchedRepos={watchedRepos} />
        </div>
        <div className="shuttlebay-utilities shuttlebay-utilities--mobile console-utilities--mobile">
          <ConsoleCommandUtilities
            watchedRepos={watchedRepos}
            includeNavigation
          />
        </div>
      </>
    ),
  }),
);

interface PageProps {
  searchParams: Promise<{
    repo?: string | string[];
    agent?: string | string[];
    q?: string | string[];
  }>;
}

async function ShuttlebayPageShell({ searchParams }: PageProps) {
  const session = await auth();
  assertAdmin(session, '/login');
  const watchedRepos = getWatchedRepos();
  const filters = parseShuttlebayFilters(await searchParams);

  return <ShuttlebayView watchedRepos={watchedRepos} filters={filters} />;
}

// Keep authentication and the uncached Firestore snapshot below the same
// streaming boundaries as every other console destination. The header is
// immediately recognizable while the runner projection resolves.
export default function ShuttlebayPage({ searchParams }: PageProps) {
  return (
    <Suspense
      fallback={
        <NavPageLoading
          current="shuttlebay"
          title="Shuttlebay"
          className="shuttlebay-page-shell"
          rows={4}
        />
      }
    >
      <ShuttlebayPageShell searchParams={searchParams} />
    </Suspense>
  );
}
