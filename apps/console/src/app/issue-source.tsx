import type { TrackerIssue } from '@agent-lcars/dispatch-contracts';
import { Anchor, Group, Stack, Text } from '@mantine/core';

export function IssueSourceLink({ issue }: { issue: TrackerIssue }) {
  return (
    <Group gap="xs">
      <Anchor href={issue.url} target="_blank" rel="noreferrer" size="sm">
        {issue.reference.tracker === 'linear' ? 'Linear' : 'GitHub'} ·{' '}
        {issue.identifier}
      </Anchor>
      <Text size="xs" c="dimmed">
        {issue.status?.name ?? issue.state}
      </Text>
    </Group>
  );
}

export function IssueSourcePanel({ issue }: { issue: TrackerIssue }) {
  return (
    <Stack gap="sm" aria-label="Issue source">
      <IssueSourceLink issue={issue} />
      <Text fw={600}>{issue.title}</Text>
      <Text size="sm">
        {issue.assignees.map((assignee) => assignee.name).join(', ') ||
          'Unassigned'}
        {issue.labels.length
          ? ` · ${issue.labels.map((label) => label.name).join(', ')}`
          : ''}
      </Text>
      <details>
        <summary>Current issue description</summary>
        <Text style={{ whiteSpace: 'pre-wrap' }}>
          {issue.description || 'No description.'}
        </Text>
      </details>
      <Text size="xs" c="dimmed">
        Edit the issue in its tracker. Each execution keeps the source snapshot
        admitted for that run.
      </Text>
    </Stack>
  );
}
