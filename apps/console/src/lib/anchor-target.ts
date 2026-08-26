import 'server-only';

import { isWorkAnchor, type Run, type Task } from '@agent-lcars/orchestrator';
import { z } from 'zod';

export interface AnchorTarget {
  repo: string;
  /** Present for GitHub anchors only. */
  issue?: number;
}

export class UnresolvableAnchor extends Error {
  override readonly name = 'UnresolvableAnchor';
}

/** The slice of a native task's opaque `work` payload the console needs.
 *  `libs/work` (Plan 2) owns the full shape; this pick is deliberately
 *  loose about everything else. */
const targetPick = z.object({
  spec: z.object({ target: z.object({ repo: z.string().min(1) }) }),
});

/**
 * The one place the console turns an anchor into a repository (and, for
 * GitHub anchors, an issue). Every `run.task.repo` / `run.task.issue` read
 * goes through here so a native anchor cannot reach a GitHub URL builder
 * with `undefined` in it.
 */
export function anchorTarget(
  run: Pick<Run, 'task'>,
  task?: Pick<Task, 'work'>,
): AnchorTarget {
  if (!isWorkAnchor(run.task)) {
    return { repo: run.task.repo, issue: run.task.issue };
  }
  const parsed = targetPick.safeParse(task?.work);
  if (!parsed.success) {
    throw new UnresolvableAnchor(
      `native task work:${run.task.workId} has no spec.target.repo`,
    );
  }
  return { repo: parsed.data.spec.target.repo };
}
