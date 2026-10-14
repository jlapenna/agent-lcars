import { logger } from '@agent-lcars/logging';

import { getAutoscalerStatuses } from '../lib/autoscaler-status';
import { getCachedAgentActivity } from '../lib/dashboard-data';
import { repoKey } from '../lib/github-client';
import {
  getSessionArchive,
  parseSessionArchiveQuery,
} from '../lib/session-archive';
import { bridgeReadouts, fleetReadoutInput } from './bridge-readouts';
import type { ConsoleReadout } from './console-readouts';

/**
 * The readout row the mockup opens Bridge and Costs with (runners online,
 * busy, queue depth, agents running, spend today), for routes that do not
 * already hold these reads. Scoped to `repo` (`owner/name`) when given.
 */
export async function loadFleetReadouts(
  repo?: string,
): Promise<ConsoleReadout[]> {
  const [{ data: activity }, autoscaler, spendArchive] = await Promise.all([
    getCachedAgentActivity(),
    getAutoscalerStatuses(),
    getSessionArchive(parseSessionArchiveQuery({ days: '1', repo }), {
      includeSpend: true,
    }).catch((error: unknown) => {
      logger.error('agent-lcars: spend readout unavailable:', error);
      return undefined;
    }),
  ]);
  const liveRuns = repo
    ? activity.liveRuns.filter((run) => repoKey(run.repo) === repo)
    : activity.liveRuns;
  return bridgeReadouts(
    fleetReadoutInput({ activity, liveRuns, repo, autoscaler, spendArchive }),
  );
}
