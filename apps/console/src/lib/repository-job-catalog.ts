import { logger } from '@agent-lcars/logging';

import { FIRESTORE_DOCUMENT_MAX_BYTES } from './firestore-document-size';
import type { DispatchTokenProvider } from './github-app-tokens';
import {
  type JobDefinition,
  jobKey,
  parseJobDefinition,
} from './repository-job-definition';
import type { CatalogJob, JobStore } from './repository-job-store';
import { openRepositorySource } from './repository-source';

/** The principal an automatic activation is attributed to, or undefined when
 * the definition's execution profile does not admit automatic activation. */
export type JobActivation = (definition: JobDefinition) => string | undefined;

/** Whether `principal` still authorizes `definition` under its execution
 * profile, exactly as an enabling operator is checked. */
export type JobAuthorization = (
  principal: string,
  definition: JobDefinition,
) => boolean;

/** Fetch only committed regular blobs. One deadline covers the repository. */
export async function refreshJobCatalog(
  store: JobStore,
  repository: string,
  tokens: DispatchTokenProvider,
  now: Date,
  activate: JobActivation,
  authorizes?: JobAuthorization,
): Promise<void> {
  const existing = (await store.list()).filter(
    (job) => job.repository === repository,
  );
  const signal = AbortSignal.timeout(20000);
  try {
    const source = await openRepositorySource(
      repository,
      await tokens.tokenFor(repository),
      signal,
    );
    const jobsTree = await source.lcarsDirectory('jobs');
    const entries =
      jobsTree === undefined ? [] : await source.readTree(jobsTree, true);
    const manifests = entries.filter((entry) =>
      /^[^/]+\/job\.yaml$/u.test(entry.path),
    );
    const rows: CatalogJob[] = [];
    for (const manifest of manifests) {
      const jobName = manifest.path.split('/')[0]!;
      const id = jobKey(repository, jobName);
      const row: CatalogJob = {
        id,
        repository,
        name: jobName,
        refreshedAt: now.toISOString(),
        enabled: false,
      };
      try {
        const recipe = entries.find(
          (entry) => entry.path === `${jobName}/recipe.yaml`,
        );
        const blob = async (
          entry: typeof manifest | undefined,
        ): Promise<string> => {
          if (
            !entry ||
            entry.mode !== '100644' ||
            entry.type !== 'blob' ||
            entry.size === undefined ||
            // A larger file cannot fit the definition's Firestore document.
            entry.size > FIRESTORE_DOCUMENT_MAX_BYTES
          )
            throw new Error('Job files must be bounded regular blobs');
          return (await source.readBlob(entry.sha)).toString('utf8');
        };
        row.definition = parseJobDefinition(
          repository,
          source.revision,
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
        const vetoedBy = current?.vetoedBy ?? null;
        const unchanged = Boolean(
          current?.enabled &&
          !row.error &&
          current.definition?.digest === row.definition?.digest,
        );
        // An enabled, unchanged job whose principal no longer authorizes it
        // (the scheduler principal moved, #3217, or a grant was narrowed)
        // re-attributes to the current automation principal when the profile
        // admits it. It keeps its floor: nothing is backfilled or skipped.
        const reattribute =
          unchanged &&
          row.definition !== undefined &&
          authorizes !== undefined &&
          current?.enabledBy !== undefined &&
          !authorizes(current.enabledBy, row.definition);
        // A merged, authorized definition activates at this observation
        // unless the operator vetoed the job. The new floor admits only
        // schedule slots after now, so activation never backfills.
        const activatedBy = reattribute
          ? activate(row.definition!)
          : unchanged || vetoedBy !== null || !row.definition || row.error
            ? undefined
            : activate(row.definition);
        return {
          job: {
            ...current,
            ...row,
            error: row.error,
            definition: row.definition,
            vetoedBy,
            enabled: unchanged || activatedBy !== undefined,
            ...(activatedBy === undefined
              ? {}
              : reattribute
                ? { enabledBy: activatedBy }
                : {
                    enabledBy: activatedBy,
                    activationFloor: now.toISOString(),
                  }),
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
            vetoedBy: current?.vetoedBy ?? null,
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
            vetoedBy: current?.vetoedBy ?? null,
            enabled: false,
            error: 'Source refresh failed',
            refreshedAt: now.toISOString(),
          },
        };
      });
    throw error;
  } finally {
    // Ordering only: a lost write makes this source look older, never newer.
    await store
      .recordSourceRefresh(repository, now.toISOString())
      .catch((error: unknown) =>
        logger.error(
          'Repository job source refresh time not recorded: %s',
          repository,
          error,
        ),
      );
  }
}

/** Refresh every configured repository's catalog, oldest refresh first, at
 * most four network reads at once. Start a batch only with room for its
 * 20-second source fetch budget plus headroom; shared token/store operations
 * retain their own timeouts. Recorded refresh attempts persist fairness across
 * processes and ticks; a never-refreshed repository goes first. */
export async function refreshJobCatalogs(
  store: JobStore,
  repositories: readonly string[],
  tokens: () => DispatchTokenProvider,
  deadline: number,
  activate: JobActivation,
  authorizes?: JobAuthorization,
): Promise<void> {
  const refreshed = await store.sourceRefreshes();
  // Repositories with an enabled job come first so their catalogs stay
  // inside the admission freshness window; discovery fills later batches.
  // Repositories that only have stored jobs keep refreshing so removal and
  // source changes still reach those records.
  const enabled = new Set<string>();
  const known = new Set(repositories);
  for (const job of await store.list()) {
    known.add(job.repository);
    if (job.enabled) enabled.add(job.repository);
  }
  const ordered = [...known]
    .map((repository) => ({
      repository,
      enabled: enabled.has(repository),
      at: Date.parse(refreshed.get(repository) ?? '') || 0,
    }))
    .sort(
      (a, b) =>
        Number(b.enabled) - Number(a.enabled) ||
        a.at - b.at ||
        a.repository.localeCompare(b.repository),
    )
    .map(({ repository }) => repository);
  for (let offset = 0; offset < ordered.length; offset += 4) {
    if (Date.now() + 25_000 > deadline) break;
    await Promise.all(
      ordered.slice(offset, offset + 4).map(async (repository) => {
        try {
          await refreshJobCatalog(
            store,
            repository,
            tokens(),
            new Date(),
            activate,
            authorizes,
          );
        } catch (error) {
          logger.error(
            'Repository job source refresh failed: %s',
            repository,
            error,
          );
        }
      }),
    );
  }
}
