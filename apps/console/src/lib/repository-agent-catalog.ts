import { logger } from '@agent-lcars/logging';

import type { DispatchTokenProvider } from './github-app-tokens';
import { agentKey, parseAgentDefinition } from './repository-agent-definition';
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
): Promise<void> {
  const existing = (await store.list()).filter(
    (agent) => agent.repository === repository,
  );
  // Never let a slower, older observation replace a newer one.
  const newer = (current: CatalogAgent | undefined) =>
    current !== undefined && Date.parse(current.refreshedAt) > now.getTime();
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
      const row: CatalogAgent = {
        id: agentKey(repository, name),
        repository,
        name,
        refreshedAt: now.toISOString(),
        enabled: false,
      };
      try {
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
        if (!manifest) throw new Error('Agent is missing agent.yaml');
        row.definition = parseAgentDefinition(
          repository,
          source.revision,
          name,
          files,
          (await source.readBlob(manifest.sha)).toString('utf8'),
        );
      } catch (error) {
        row.error =
          error instanceof Error ? error.message : 'Invalid definition';
      }
      rows.push(row);
    }
    // Publish after the complete read so a partial fetch cannot remove agents.
    for (const row of rows)
      await store.mutate(row.id, (current) => {
        if (newer(current)) return {};
        const vetoedBy = current?.vetoedBy ?? null;
        return {
          agent: {
            ...row,
            vetoedBy,
            enabled: row.definition !== undefined && vetoedBy === null,
          },
        };
      });
    for (const removed of existing.filter(
      (agent) => !rows.some((row) => row.id === agent.id),
    ))
      await store.mutate(removed.id, (current) =>
        newer(current) || current === undefined
          ? {}
          : {
              agent: {
                ...current,
                enabled: false,
                error: 'Definition removed',
                refreshedAt: now.toISOString(),
              },
            },
      );
  } catch (error) {
    for (const agent of existing)
      await store.mutate(agent.id, (current) =>
        newer(current) || current === undefined
          ? {}
          : {
              agent: {
                ...current,
                enabled: false,
                error: 'Source refresh failed',
                refreshedAt: now.toISOString(),
              },
            },
      );
    throw error;
  }
}

/** Refresh every control-plane repository's agents, four at a time, starting
 * a batch only while its 20-second fetch budget fits before `deadline`. */
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
  const ordered = [...known].sort();
  for (let offset = 0; offset < ordered.length; offset += 4) {
    if (Date.now() + 25_000 > deadline) break;
    await Promise.all(
      ordered.slice(offset, offset + 4).map(async (repository) => {
        try {
          await refreshAgentCatalog(store, repository, tokens(), new Date());
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
}
