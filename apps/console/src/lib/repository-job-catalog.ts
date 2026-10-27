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
    const response = await fetch(
      `https://api.github.com/repos/${repository}/${path}`,
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
    for (const row of rows)
      await store.mutate(row.id, undefined, (current) => ({
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
      }));
    for (const removed of existing.filter(
      (job) => !rows.some((row) => row.id === job.id),
    ))
      await store.mutate(removed.id, undefined, (current) => ({
        job: {
          ...current!,
          enabled: false,
          error: 'Definition removed',
          refreshedAt: now.toISOString(),
        },
      }));
  } catch (error) {
    for (const job of existing)
      await store.mutate(job.id, undefined, (current) => ({
        job: {
          ...current!,
          enabled: false,
          error: 'Source refresh failed',
          refreshedAt: now.toISOString(),
        },
      }));
    throw error;
  }
}
