import type { GithubAnchorProjection } from '@agent-lcars/orchestrator';
import type { SessionDoc } from '@agent-lcars/telemetry';

import { sessionPRCandidates, spendPRKey } from './session-spend';

/** Stored evidence only. Every referenced PR is read in batched point
 * lookups (`batchSize` anchors per read, eight reads outstanding) under a
 * shared five-second deadline. One read per PR made a busy window wait on
 * hundreds of sequential round trips. Late reads cannot mutate the returned
 * snapshot; identities unread by the deadline or in a failed batch stay
 * unknown and mark the snapshot incomplete. */
export async function loadSpendProjections(
  docs: SessionDoc[],
  readMany: (
    anchors: GithubAnchorProjection['anchor'][],
  ) => Promise<(GithubAnchorProjection | undefined)[]>,
  timeoutMs = 5000,
  canonicalRepositories: readonly { owner: string; name: string }[] = [],
  batchSize = 100,
) {
  const anchors = new Map<string, GithubAnchorProjection['anchor']>();
  const canonical = new Map(
    canonicalRepositories.map((repo) => [
      `${repo.owner}/${repo.name}`.toLowerCase(),
      `${repo.owner}/${repo.name}`,
    ]),
  );
  for (const doc of docs)
    for (const pr of sessionPRCandidates(doc)) {
      const repo = `${pr.repo.owner}/${pr.repo.name}`;
      anchors.set(spendPRKey(pr.repo, pr.number), {
        repo: canonical.get(repo.toLowerCase()) ?? repo,
        issue: pr.number,
      });
    }
  const selected = [...anchors.entries()];
  const batches: (typeof selected)[] = [];
  for (let offset = 0; offset < selected.length; offset += batchSize)
    batches.push(selected.slice(offset, offset + batchSize));
  const projections = new Map<string, GithubAnchorProjection>();
  let incomplete = false;
  let cursor = 0;
  const deadline = performance.now() + timeoutMs;
  await Promise.all(
    Array.from({ length: Math.min(8, batches.length) }, async () => {
      while (cursor < batches.length) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          incomplete = true;
          return;
        }
        const batch = batches[cursor++];
        if (batch === undefined) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const read = await Promise.race([
            readMany(batch.map(([, anchor]) => anchor)),
            new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), remaining);
            }),
          ]);
          if (read === undefined) {
            incomplete = true;
            continue;
          }
          batch.forEach(([key], index) => {
            const projection = read[index];
            if (projection === undefined) incomplete = true;
            else projections.set(key, projection);
          });
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
