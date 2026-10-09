import { Anchor, Button, Group, NativeSelect } from '@mantine/core';

import { repoKey, type WatchedRepo } from '@/lib/watched-repo';

/** GET navigation keeps repository scope shareable and works without JS. */
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
    <form action={action} className="console-repository-selector">
      <Group align="end" gap="xs" wrap="wrap">
        <NativeSelect
          label="Repository"
          name="repo"
          defaultValue={selected ?? ''}
          data={[
            { value: '', label: 'All repositories' },
            ...repos.map((repo) => ({
              value: repoKey(repo),
              label: repoKey(repo),
            })),
          ]}
          style={{ flex: '1 1 180px', minWidth: 0 }}
        />
        <Button type="submit" size="sm">
          Apply repository
        </Button>
        {selected && (
          <Anchor href={action} size="sm">
            Clear repository
          </Anchor>
        )}
      </Group>
    </form>
  );
}
