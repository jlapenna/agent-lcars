import type { IssueAgentSessionDoc } from '@agent-lcars/telemetry';
import type { WorkSummary } from '@agent-lcars/work/derive';

import type { AgentRun } from '../lib/agent-activity';
import type { CliSession } from '../lib/cli-sessions';
import type { BoardCard } from './board-card';
import {
  type BridgeSelectionKey,
  itemKey,
  parkedWorkKey,
  runKey,
  sessionKey,
} from './bridge-selection';

/**
 * The right-hand detail pane of the Bridge's desktop two-panel view. It is
 * resolved server-side from a `?sel=` key against the same records the left
 * column renders, so the detail is the *same* projection the row came from -
 * never a second source of truth. The kinds mirror the five row shapes the
 * Bridge's unified left column already shows.
 */
export type BridgeDetail =
  | { kind: 'none' }
  | { kind: 'item'; card: BoardCard; multiRepo: boolean }
  | {
      kind: 'liveRun';
      run: AgentRun;
      item?: RunItemRef;
      session?: IssueAgentSessionDoc;
    }
  | { kind: 'recentRun'; run: AgentRun; session?: IssueAgentSessionDoc }
  | { kind: 'session'; session: CliSession }
  | { kind: 'parkedWork'; item: WorkSummary };

/** Imported here rather than from agent-activity-panel.tsx to keep this module
 * free of the panel's server-only `getWatchedRepos` transitive import. */
interface RunItemRef {
  number: number;
  title: string;
  url: string;
}

/**
 * Resolve the selected row. Only `selectedKey` gates what renders; every other
 * argument is simply the set the left column is already showing, so a stale or
 * filtered-out selection resolves to `none` rather than rendering detail the
 * list no longer offers.
 */
export function resolveBridgeDetail({
  selectedKey,
  liveRuns,
  recentRuns,
  cliSessions,
  waitingOnDeploy,
  blocked = [],
  parkedWork = [],
  itemsByRunId = {},
  sessionsByRunId = {},
  multiRepo = false,
}: {
  selectedKey: BridgeSelectionKey | undefined;
  liveRuns: AgentRun[];
  recentRuns: AgentRun[];
  cliSessions: CliSession[];
  waitingOnDeploy: BoardCard[];
  blocked?: BoardCard[];
  parkedWork?: WorkSummary[];
  itemsByRunId?: Record<string, RunItemRef>;
  sessionsByRunId?: Record<string, IssueAgentSessionDoc>;
  multiRepo?: boolean;
}): BridgeDetail {
  if (!selectedKey) return { kind: 'none' };

  const parked = parkedWork.find(
    (candidate) => parkedWorkKey(candidate) === selectedKey,
  );
  if (parked) return { kind: 'parkedWork', item: parked };

  const liveRun = liveRuns.find((run) => runKey(run) === selectedKey);
  if (liveRun) {
    return {
      kind: 'liveRun',
      run: liveRun,
      item: itemsByRunId[liveRun.id],
      session: sessionsByRunId[liveRun.id],
    };
  }

  const recentRun = recentRuns.find((run) => runKey(run) === selectedKey);
  if (recentRun) {
    return {
      kind: 'recentRun',
      run: recentRun,
      session: sessionsByRunId[recentRun.id],
    };
  }

  const session = cliSessions.find(
    (candidate) => sessionKey(candidate) === selectedKey,
  );
  if (session) return { kind: 'session', session };

  const card = [...waitingOnDeploy, ...blocked].find(
    (candidate) => itemKey(candidate.item) === selectedKey,
  );
  if (card) return { kind: 'item', card, multiRepo };

  return { kind: 'none' };
}
