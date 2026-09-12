import type { WorkSummary } from '@agent-lcars/work/derive';
import { Anchor, Card, Group, Stack, Text, Title } from '@mantine/core';

import { formatRelativeTime } from './format';
import { type WorkAction, WorkActions } from './work/work-actions';

function summaryHref(item: WorkSummary): string {
  if ('workId' in item.anchor) return `/work/${item.anchor.workId}`;
  const [owner, repo] = item.anchor.repo.split('/');
  return `/task/${owner}/${repo}/${item.anchor.issue}`;
}

/** A GitHub-anchored parked item has no native `workId` for `redispatch`
 *  (see `workIdSchema`), so it never gets the native `WorkActions` button
 *  a native item does -- it can look, at a glance, like redispatch is
 *  broken for every row but the last (#1816). Point at the one recovery
 *  step that actually works for this anchor instead of rendering nothing. */
function githubIssueHref(anchor: { repo: string; issue: number }): string {
  return `https://github.com/${anchor.repo}/issues/${anchor.issue}`;
}

/** Pure renderer: hidden only when no parked work is present or truncated.
 *
 * Every control here acts on exactly one row, and that was not visible: the
 * rows were an undivided stack and every button read just "Redispatch", so a
 * section headed "Stopped work (4)" showing one button read as one control
 * over all of it (#1816). Each row is delimited and its controls name their
 * own item; the sibling half of that report - rows whose anchor has no native
 * work id rendering nothing at all - is answered by `githubIssueHref` above. */
export function ParkedWorkPanel({
  items,
  hasMoreTasks,
  cancel,
  redispatch,
}: {
  items: WorkSummary[];
  hasMoreTasks: boolean;
  cancel: WorkAction;
  redispatch: WorkAction;
}) {
  const parked = items
    .filter((item) => item.state === 'parked' || item.state === 'failed')
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  if (parked.length === 0 && !hasMoreTasks) return null;
  return (
    <Card
      withBorder
      padding="md"
      mb="xl"
      component="section"
      aria-label="Stopped work"
      className="lcars-panel"
      data-testid="parked-work-panel"
    >
      <Title order={3} size="h5">
        Stopped work ({parked.length})
      </Title>
      {parked.length === 0 ? (
        <Text size="sm" c="dimmed" mt="xs">
          No stopped work in the 200 most recently updated tasks.
        </Text>
      ) : (
        <Stack gap={0} mt="xs">
          {parked.map((item) => {
            const latest = item.runs[item.runs.length - 1];
            return (
              <Group
                key={item.id}
                className="parked-work-row"
                justify="space-between"
                wrap="wrap"
                gap="sm"
              >
                <Stack gap={2}>
                  <Anchor href={summaryHref(item)} size="sm" fw={600}>
                    {item.spec.title}
                  </Anchor>
                  <Text size="xs" c="dimmed">
                    {item.spec.target.repo} ·{' '}
                    <span>{latest?.result?.summary ?? 'lost'}</span> ·{' '}
                    {item.state} {formatRelativeTime(item.updatedAt)}
                  </Text>
                </Stack>
                {'workId' in item.anchor ? (
                  <WorkActions
                    id={item.anchor.workId}
                    state={item.state}
                    label={item.spec.title}
                    cancel={cancel}
                    redispatch={redispatch}
                  />
                ) : (
                  <Anchor
                    href={githubIssueHref(item.anchor)}
                    target="_blank"
                    rel="noreferrer"
                    size="xs"
                    c="dimmed"
                  >
                    Redispatch on GitHub (remove and re-add its{' '}
                    <code>agent:*</code> label) ↗
                  </Anchor>
                )}
              </Group>
            );
          })}
        </Stack>
      )}
      {hasMoreTasks && (
        <Text size="xs" c="dimmed" mt="xs">
          Older tasks may contain stopped work.
        </Text>
      )}
    </Card>
  );
}
