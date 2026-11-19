import { logger } from '@agent-lcars/logging';

import type { DispatchTokenProvider } from './github-app-tokens';
import {
  agentKey,
  parseAgentDefinition,
  REMOVED,
  SOURCE_FAILED,
} from './repository-agent-definition';
import { agentProfiles, repositoryProfile } from './repository-agent-runs';
import type { AgentStore, CatalogAgent } from './repository-agent-store';
import { openRepositorySource } from './repository-source';

/** Catalog `.lcars/agents/*` from `repository`'s default branch, with the
 * repository-job catalog's rules (docs/repository-agents.md): an invalid
 * definition stays visible with its error and cannot run, a removed one stops
 * admission, a failed refresh disables admission, and a merged valid
 * definition is enabled unless the operator vetoed it. */
export async function refreshAgentCatalog(
  store: AgentStore,
  repository: string,
  tokens: DispatchTokenProvider,
  now: Date,
  /** Collects this refresh's health writes for a caller that awaits them
   * once, after every batch; without it the refresh awaits its own. */
  pendingHealth?: Promise<unknown>[],
): Promise<void> {
  const profiles = agentProfiles();
  const at = now.toISOString();
  // Fairness bookkeeping only: a lost write makes this source look older.
  await store
    .recordAttempt(repository, at)
    .catch((error: unknown) =>
      logger.error('Agent source attempt not recorded: %s', repository, error),
    );
  const repositoryRows = async () =>
    (await store.list()).filter((agent) => agent.repository === repository);
  // Every write is fenced by this observation: once a newer refresh of the
  // repository has claimed publication, nothing below writes.
  const fence = { repository, at };
  // Never let a slower, older observation replace a newer one.
  const newer = (current: CatalogAgent | undefined) =>
    current !== undefined && Date.parse(current.refreshedAt) > now.getTime();
  // Health telemetry only: a lost write never fails the refresh.
  // Health telemetry only. Writes start without blocking the catalog:
  // publication and fail-closed disabling never wait on them. A standalone
  // refresh waits for them at most HEALTH_WRITE_MS at the very end; a
  // batched one hands them to its caller.
  const healthWrites = pendingHealth ?? [];
  const recordRead = (outcome: 'succeeded' | 'failed') => {
    healthWrites.push(
      store
        .recordSourceRead(repository, at, outcome)
        .catch((error: unknown) =>
          logger.error(
            'Agent source health not recorded: %s',
            repository,
            error,
          ),
        ),
    );
  };
  try {
    const source = await openRepositorySource(
      repository,
      await tokens.tokenFor(repository),
      AbortSignal.timeout(20000),
    );
    const agentsTree = await source.lcarsDirectory('agents');
    const entries =
      agentsTree === undefined ? [] : await source.readTree(agentsTree, true);
    const names = entries
      .filter((entry) => entry.type === 'tree' && !entry.path.includes('/'))
      .map((entry) => entry.path)
      .sort();
    const rows: CatalogAgent[] = [];
    for (const name of names) {
      // The key never validates: a malformed name is recorded with its
      // error here instead of failing every agent in the repository.
      const row: CatalogAgent = {
        id: agentKey(repository, name),
        repository,
        name,
        refreshedAt: now.toISOString(),
        enabled: false,
      };
      const prefix = `${name}/`;
      const files = entries
        .filter(
          (entry) => entry.path.startsWith(prefix) && entry.type !== 'tree',
        )
        .map((entry) => ({
          ...entry,
          path: entry.path.slice(prefix.length),
        }));
      const manifest = files.find((file) => file.path === 'agent.yaml');
      // Only a regular-file manifest is fetched: a submodule or symlink
      // named agent.yaml is this definition's own error, decided locally.
      const regular =
        manifest !== undefined &&
        manifest.type === 'blob' &&
        (manifest.mode === '100644' || manifest.mode === '100755');
      // Repository I/O stays outside the definition's own catch: a failed
      // read fails the refresh (agents unavailable), never marks one invalid.
      const manifestText = regular
        ? (await source.readBlob(manifest.sha)).toString('utf8')
        : undefined;
      try {
        if (manifest === undefined)
          throw new Error('Agent is missing agent.yaml');
        if (manifestText === undefined)
          throw new Error('agent.yaml must be a regular file');
        row.definition = parseAgentDefinition(
          repository,
          source.revision,
          name,
          files,
          manifestText,
        );
        repositoryProfile(row.definition, profiles);
      } catch (error) {
        row.error =
          error instanceof Error ? error.message : 'Invalid definition';
      }
      rows.push(row);
    }
    // Publish after the complete read so a partial fetch cannot remove agents,
    // and only while no newer observation of this repository has published.
    if (!(await store.claimObservation(repository, at))) return;
    const publish = (row: CatalogAgent) =>
      store.mutate(
        row.id,
        (current) => {
          if (newer(current)) return {};
          const vetoedBy = current?.vetoedBy ?? null;
          return {
            agent: {
              ...row,
              vetoedBy,
              enabled:
                row.definition !== undefined &&
                row.error === undefined &&
                vetoedBy === null,
            },
          };
        },
        fence,
      );
    for (const row of rows) {
      try {
        await publish(row);
      } catch (error) {
        // A definition storage cannot hold (for example a manifest larger
        // than one catalog document) is this agent's own error: record it
        // disabled without its definition, and keep publishing siblings.
        const { definition: _definition, ...rest } = row;
        await publish({
          ...rest,
          error: `Definition could not be stored: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
    // Re-read after claiming: a row an older overlapping refresh published
    // after this refresh started must still be swept if this newer commit
    // removed it.
    for (const removed of (await repositoryRows()).filter(
      (agent) => !rows.some((row) => row.id === agent.id),
    ))
      await store.mutate(
        removed.id,
        (current) =>
          newer(current) || current === undefined
            ? {}
            : {
                agent: {
                  ...current,
                  enabled: false,
                  error: REMOVED,
                  refreshedAt: now.toISOString(),
                },
              },
        fence,
      );
    // Success means the catalog now reflects this read: published, not
    // merely fetched. A refresh superseded by a newer one records nothing.
    recordRead('succeeded');
  } catch (error) {
    // Any failure, reading GitHub or publishing to the catalog, is a failed
    // refresh; the Console log line names which.
    recordRead('failed');
    if (!(await store.claimObservation(repository, at))) throw error;
    for (const agent of await repositoryRows())
      await store.mutate(
        agent.id,
        (current) =>
          newer(current) || current === undefined
            ? {}
            : {
                agent: {
                  ...current,
                  enabled: false,
                  error: SOURCE_FAILED,
                  refreshedAt: now.toISOString(),
                },
              },
        fence,
      );
    throw error;
  } finally {
    if (pendingHealth === undefined)
      await settleWithin(healthWrites, HEALTH_WRITE_MS);
  }
}

/** The longest a refresh waits, after its catalog work, for its health
 * telemetry writes; a slower write keeps going and is simply not awaited. */
const HEALTH_WRITE_MS = 5_000;

async function settleWithin(
  writes: readonly Promise<unknown>[],
  ms: number,
): Promise<void> {
  if (writes.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(writes),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

/** Refresh every control-plane repository's agents, least recently attempted
 * first (never-attempted repositories lead), four at a time, starting a batch
 * only while its 20-second fetch budget fits before `deadline`. Recorded
 * attempts persist the rotation across ticks and processes, so a bounded tick
 * cannot starve later repositories. */
export async function refreshAgentCatalogs(
  store: AgentStore,
  repositories: readonly string[],
  tokens: () => DispatchTokenProvider,
  deadline: number,
): Promise<void> {
  // Repositories that only have stored agents keep refreshing so removal
  // still reaches those records.
  const known = new Set(repositories);
  for (const agent of await store.list()) known.add(agent.repository);
  const attempted = new Map(
    (await store.sources()).map((source) => [
      source.repository,
      Date.parse(source.attemptedAt ?? '') || 0,
    ]),
  );
  const ordered = [...known].sort(
    (left, right) =>
      (attempted.get(left) ?? 0) - (attempted.get(right) ?? 0) ||
      left.localeCompare(right),
  );
  // Health writes from every batch are awaited once, after the last batch
  // and only within the time left, so they never cost a later batch its
  // start.
  const pendingHealth: Promise<unknown>[] = [];
  for (let offset = 0; offset < ordered.length; offset += 4) {
    if (Date.now() + 25_000 > deadline) break;
    await Promise.all(
      ordered.slice(offset, offset + 4).map(async (repository) => {
        try {
          await refreshAgentCatalog(
            store,
            repository,
            tokens(),
            new Date(),
            pendingHealth,
          );
        } catch (error) {
          logger.error(
            'Repository agent source refresh failed: %s',
            repository,
            error,
          );
        }
      }),
    );
  }
  await settleWithin(
    pendingHealth,
    Math.min(HEALTH_WRITE_MS, Math.max(0, deadline - Date.now())),
  );
}
