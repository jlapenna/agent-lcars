import { logger } from '@agent-lcars/logging';

import { getAutoscalerStatuses } from '../lib/autoscaler-status';
import { getCliSessions } from '../lib/cli-sessions';
import { getCachedAgentActivity } from '../lib/dashboard-data';
import { repoKey } from '../lib/github-client';
import {
  getSessionArchive,
  parseSessionArchiveQuery,
} from '../lib/session-archive';
import { bridgeReadouts, fleetReadoutInput } from './bridge-readouts';
import type { ConsoleReadout } from './console-readouts';

/** What the readout row's reads could not vouch for, for the warnings band:
 * activity and autoscaler problems, and a failed spend read. */
export function fleetReadoutWarnings({
  activity,
  autoscaler,
  spendArchive,
}: {
  activity: { warnings: string[] };
  autoscaler: { warnings: string[] };
  spendArchive: unknown;
}): string[] {
  return [
    ...activity.warnings,
    ...autoscaler.warnings,
    ...(spendArchive === undefined ? [SPEND_READ_FAILED] : []),
  ];
}

export const SPEND_READ_FAILED =
  'Spend unavailable (session archive read failed).';

/**
 * The readout row the mockup opens Bridge and Costs with (runners online,
 * busy, queue depth, agents running, spend today), for routes that do not
 * already hold these reads. Scoped to `repo` (`owner/name`) when given.
 */
export async function loadFleetReadouts(
  repo?: string,
): Promise<{ readouts: ConsoleReadout[]; warnings: string[] }> {
  const [{ data: activity }, autoscaler, spendArchive, cli] = await Promise.all(
    [
      getCachedAgentActivity(),
      getAutoscalerStatuses(),
      getSessionArchive(parseSessionArchiveQuery({ days: '1', repo }), {
        includeSpend: true,
      }).catch((error: unknown) => {
        logger.error('agent-lcars: spend readout unavailable:', error);
        return undefined;
      }),
      getCliSessions({ exhaustive: true }),
    ],
  );
  const liveRuns = repo
    ? activity.liveRuns.filter((run) => repoKey(run.repo) === repo)
    : activity.liveRuns;
  return {
    readouts: bridgeReadouts(
      fleetReadoutInput({
        activity,
        liveRuns,
        repo,
        autoscaler,
        spendArchive,
        cliSessions:
          cli.warnings.length === 0
            ? cli.sessions.filter(
                (session) =>
                  !repo || (session.repo && repoKey(session.repo) === repo),
              )
            : undefined,
      }),
    ),
    warnings: [
      ...fleetReadoutWarnings({ activity, autoscaler, spendArchive }),
      ...cli.warnings,
    ],
  };
}
