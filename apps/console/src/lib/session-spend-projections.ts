import type { GithubAnchorProjection } from '@agent-lcars/orchestrator';
import type { SessionDoc } from '@agent-lcars/telemetry';

import { sessionPRKeys } from './session-spend';

/** Stored evidence only. A single page has at most 200 point reads, eight
 * outstanding reads and a shared five-second deadline. Late reads cannot
 * mutate the returned snapshot; unavailable/capped identities stay unknown. */
export async function loadSpendProjections(
  docs: SessionDoc[],
  read: (
    anchor: GithubAnchorProjection['anchor'],
  ) => Promise<GithubAnchorProjection | undefined>,
  timeoutMs = 5000,
) {
  const keys = [...new Set(docs.flatMap(sessionPRKeys))];
  const selected = keys.slice(0, 200);
  const projections = new Map<string, GithubAnchorProjection>();
  let incomplete = keys.length > selected.length;
  let cursor = 0;
  const deadline = performance.now() + timeoutMs;
  await Promise.all(
    Array.from({ length: Math.min(8, selected.length) }, async () => {
      while (cursor < selected.length) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          incomplete = true;
          return;
        }
        const key = selected[cursor++];
        if (key === undefined) return;
        const [repo, issue] = key.split('#');
        if (repo === undefined) {
          incomplete = true;
          continue;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const projection = await Promise.race([
            read({ repo, issue: Number(issue) }),
            new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), remaining);
            }),
          ]);
          if (projection === undefined) incomplete = true;
          else projections.set(key, projection);
        } catch {
          incomplete = true;
        } finally {
          clearTimeout(timer);
        }
      }
    }),
  );
  return { projections, incomplete };
}
