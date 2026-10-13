import { Anchor } from '@mantine/core';

import { repoKey, type WatchedRepo } from '@/lib/watched-repo';

import { ToolbarSelect } from './console-toolbar';

/**
 * The workspace toolbar's repository control (design/fleet-console.html):
 * a select that navigates on change. GET navigation keeps the scope
 * shareable; without script the fallback Apply button submits it.
 */
export function RepositorySelector({
  repos,
  selected,
  action,
}: {
  repos: WatchedRepo[];
  selected?: string;
  action: string;
}) {
  return (
    <form
      method="get"
      action={action}
      className="console-toolbar__filters console-repository-selector"
    >
      <ToolbarSelect
        name="repo"
        label="Repository"
        value={selected ?? ''}
        options={[
          { value: '', label: `All repositories (${repos.length})` },
          ...repos.map((repo) => ({
            value: repoKey(repo),
            label: repoKey(repo),
          })),
        ]}
      />
      <noscript>
        <button type="submit">Apply repository</button>
      </noscript>
      {selected ? (
        <Anchor href={action} size="sm">
          Clear repository
        </Anchor>
      ) : null}
    </form>
  );
}
