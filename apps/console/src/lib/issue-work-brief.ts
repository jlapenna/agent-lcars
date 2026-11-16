import 'server-only';

import type { Run } from '@agent-lcars/orchestrator';
import {
  isSourceManagedWork,
  WORK_TITLE_MAX,
  workPayloadSchema,
} from '@agent-lcars/work';

import { normalizeWorkPayload } from './work-from-github';

/** Execution reads the snapshot attached to its own Run, never mutable Task
 * metadata. Internal triage/report instructions remain their admitted brief. */
export function workAtRun(run: Run, work: unknown): unknown {
  const parsed = workPayloadSchema.safeParse(work);
  if (!run.issue || !parsed.success || isSourceManagedWork(work)) return work;
  const issue = run.issue;
  // The issue grew past the tracker bounds after admission. Keep the admitted
  // brief whole rather than rebuilding it from a snapshot without its text.
  if (issue.oversized)
    return normalizeWorkPayload({
      origin: parsed.data.origin,
      spec: {
        ...parsed.data.spec,
        description: `${parsed.data.spec.description}\n\nNote: ${issue.identifier} has since grown past LCARS's tracker bounds, so this is its admitted text. Read the current issue at ${issue.url}.`,
      },
    });
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
