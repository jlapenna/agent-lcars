import { logger } from '@agent-lcars/logging';
import { z } from 'zod';

import type { DispatchTokenProvider } from './github-app-tokens';
import { readJobBody } from './repository-job-body';
import { jobKey, parseJobDefinition } from './repository-job-definition';
import type { CatalogJob, JobStore } from './repository-job-store';

/** Fetch only committed regular blobs. One deadline covers the repository. */
export async function refreshJobCatalog(
  store: JobStore,
  repository: string,
  tokens: DispatchTokenProvider,
  now: Date,
): Promise<void> {
  const existing = (await store.list()).filter(
    (job) => job.repository === repository,
  );
  const signal = AbortSignal.timeout(20000);
  let token: string;
  const get = async (path: string): Promise<unknown> => {
    // GitHub answers `/repos/{owner}/{repo}/` (trailing slash) with 404, so
    // the repository metadata request must omit the separator.
    const response = await fetch(
      `https://api.github.com/repos/${repository}${path ? `/${path}` : ''}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
        signal,
        cache: 'no-store',
      },
    );
    if (!response.ok) throw new Error(`Catalog source HTTP ${response.status}`);
    const text = await readJobBody(response, 2 * 1024 * 1024);
    return JSON.parse(text);
  };
  try {
    token = await tokens.tokenFor(repository);
    const metadata = z
      .object({ default_branch: z.string() })
      .parse(await get(''));
    const commit = z
      .object({
        sha: z.string().regex(/^[a-f0-9]{40}$/u),
        commit: z.object({ tree: z.object({ sha: z.string() }) }),
      })
      .parse(
        await get(`commits/${encodeURIComponent(metadata.default_branch)}`),
      );
    const treeSchema = z.object({
      truncated: z.boolean().optional(),
      tree: z.array(
        z.object({
          path: z.string(),
          mode: z.string(),
          type: z.string(),
          sha: z.string(),
          size: z.number().optional(),
        }),
      ),
    });
    const tree = treeSchema.parse(
      await get(`git/trees/${commit.commit.tree.sha}?recursive=1`),
    );
    if (tree.truncated) throw new Error('Catalog tree truncated');
    const manifests = tree.tree.filter((entry) =>
      /^\.lcars\/jobs\/[^/]+\/job.yaml$/u.test(entry.path),
    );
    if (manifests.length > 50) throw new Error('Repository exceeds 50 jobs');
    const rows: CatalogJob[] = [];
    for (const manifest of manifests) {
      const jobName = manifest.path.split('/')[2]!;
      const id = jobKey(repository, jobName);
      const row: CatalogJob = {
        id,
        repository,
        name: jobName,
        refreshedAt: now.toISOString(),
        enabled: false,
      };
      try {
        const recipe = tree.tree.find(
          (entry) => entry.path === `.lcars/jobs/${jobName}/recipe.yaml`,
        );
        const blob = async (
          entry: typeof manifest | undefined,
        ): Promise<string> => {
          if (
            !entry ||
            entry.mode !== '100644' ||
            entry.type !== 'blob' ||
            entry.size === undefined ||
            entry.size > 65536
          )
            throw new Error('Job files must be bounded regular blobs');
          const data = z
            .object({
              encoding: z.literal('base64'),
              content: z.string().max(100000),
            })
            .parse(await get(`git/blobs/${entry.sha}`));
          return Buffer.from(data.content, 'base64').toString('utf8');
        };
        row.definition = parseJobDefinition(
          repository,
          commit.sha,
          jobName,
          await blob(manifest),
          await blob(recipe),
        );
      } catch (error) {
        row.error =
          error instanceof Error
            ? error.message.slice(0, 2048)
            : 'Invalid definition';
      }
      rows.push(row);
    }
    // Publish after the complete read so a partial fetch cannot remove jobs.
    // A slow older refresh must not replace a newer source observation.
    for (const row of rows)
      await store.mutate(row.id, undefined, (current) => {
        if (current && Date.parse(current.refreshedAt) > now.getTime())
          return {};
        return {
          job: {
            ...current,
            ...row,
            error: row.error,
            definition: row.definition,
            enabled: Boolean(
              current?.enabled &&
              !row.error &&
              current.definition?.digest === row.definition?.digest,
            ),
          },
        };
      });
    for (const removed of existing.filter(
      (job) => !rows.some((row) => row.id === job.id),
    ))
      await store.mutate(removed.id, undefined, (current) => {
        if (current && Date.parse(current.refreshedAt) > now.getTime())
          return {};
        return {
          job: {
            ...current!,
            enabled: false,
            error: 'Definition removed',
            refreshedAt: now.toISOString(),
          },
        };
      });
  } catch (error) {
    for (const job of existing)
      await store.mutate(job.id, undefined, (current) => {
        if (current && Date.parse(current.refreshedAt) > now.getTime())
          return {};
        return {
          job: {
            ...current!,
            enabled: false,
            error: 'Source refresh failed',
            refreshedAt: now.toISOString(),
          },
        };
      });
    throw error;
  }
}

/** Refresh oldest enabled repositories first, at most four network reads at
 * once. Start a batch only with room for its 20-second source fetch budget
 * plus headroom; shared token/store operations retain their own timeouts.
 * Successful refresh timestamps persist fairness across processes and ticks. */
export async function refreshEnabledJobCatalogs(
  store: JobStore,
  tokens: () => DispatchTokenProvider,
  deadline: number,
): Promise<void> {
  const oldest = new Map<string, number>();
  for (const job of await store.list()) {
    if (!job.enabled) continue;
    const at = Date.parse(job.refreshedAt);
    oldest.set(job.repository, Math.min(oldest.get(job.repository) ?? at, at));
  }
  const repositories = [...oldest]
    .sort(([a, at], [b, bt]) => at - bt || a.localeCompare(b))
    .map(([repository]) => repository);
  for (let offset = 0; offset < repositories.length; offset += 4) {
    if (Date.now() + 25_000 > deadline) break;
    await Promise.all(
      repositories.slice(offset, offset + 4).map(async (repository) => {
        try {
          await refreshJobCatalog(store, repository, tokens(), new Date());
        } catch {
          logger.error('Repository job source refresh failed: %s', repository);
        }
      }),
    );
  }
}
