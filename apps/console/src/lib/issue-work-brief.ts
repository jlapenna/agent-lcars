import 'server-only';

import type { TrackerIssue } from '@agent-lcars/dispatch-contracts';
import {
  isSourceManagedWork,
  WORK_TITLE_MAX,
  workPayloadSchema,
} from '@agent-lcars/work';

import { normalizeWorkPayload } from './work-from-github';

/** Execution reads the snapshot attached to its own Run, never mutable Task
 * metadata. Internal triage/report instructions remain their admitted brief. */
export function workAtRun(
  issue: TrackerIssue | undefined,
  work: unknown,
): unknown {
  const parsed = workPayloadSchema.safeParse(work);
  if (!issue || !parsed.success || isSourceManagedWork(work)) return work;
  // The issue grew past the tracker bounds after admission. Keep the
  // admitted payload byte-for-byte; any appended note could push it through
  // the description clamp. `lcars work source` reports `oversized` itself.
  if (issue.oversized) return work;
  return normalizeWorkPayload({
    origin: parsed.data.origin,
    spec: {
      ...parsed.data.spec,
      title: (issue.reference.tracker === 'linear'
        ? `${issue.identifier}: ${issue.title}`
        : issue.title
      ).slice(0, WORK_TITLE_MAX),
      description: `${issue.reference.tracker === 'linear' ? `Linear issue: ${issue.url}\n\n` : ''}${issue.description}`,
    },
  });
}
