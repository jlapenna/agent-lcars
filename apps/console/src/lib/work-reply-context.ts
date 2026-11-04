import 'server-only';

import type { ScheduleStore } from '@agent-lcars/orchestrator';

import type { OrchestratorRouteDeps } from './orchestrator-routes';
import type { WorkPrincipal } from './work-auth';
import type { WorkContext } from './work-mint';
import {
  sessionDocsForRuns,
  sessionForResume,
  sessionsForRuns,
} from './work-sessions';

/** Replies never read schedules. Fail locally if that contract changes. */
const unreachableScheduleStore: ScheduleStore = {
  readSchedule: () => {
    throw new Error('tagged-reply: scheduleStore is not available here');
  },
  mutateSchedule: () => {
    throw new Error('tagged-reply: scheduleStore is not available here');
  },
  listTickSchedules: () => {
    throw new Error('tagged-reply: scheduleStore is not available here');
  },
  writeSchedule: () => {
    throw new Error('tagged-reply: scheduleStore is not available here');
  },
  listSchedules: () => {
    throw new Error('tagged-reply: scheduleStore is not available here');
  },
  listEnabledSchedules: () => {
    throw new Error('tagged-reply: scheduleStore is not available here');
  },
};

/** Builds the authenticated context required by `requestReply`. */
export function createReplyContext(
  runtime: OrchestratorRouteDeps,
  principal: WorkPrincipal,
): WorkContext {
  return {
    principal,
    runtime,
    sessionsFor: sessionsForRuns,
    getSessionDoc: sessionForResume,
    sessionDocsForRuns,
    cliSessions: async () => {
      throw new Error('tagged-reply: cliSessions is not available here');
    },
    scheduleStore: unreachableScheduleStore,
    grants: () => [],
    now: () => new Date(),
  };
}
