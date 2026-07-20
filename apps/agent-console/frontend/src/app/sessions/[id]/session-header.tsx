import {
  Anchor,
  Badge,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import type { SessionDoc } from '@repo/agent-telemetry';
import { displayLiveness, sessionAgent } from '@repo/agent-telemetry';
import type { ReactNode } from 'react';

import { REPO_NAME, REPO_OWNER } from '../../../lib/github-client';
import { sessionDurationSeconds } from '../../../lib/session-archive';
import {
  AgentBadge,
  LIVENESS_COLORS,
  LIVENESS_LABELS,
} from '../../agent-activity-panel';
import { ArtifactPreviewToggle } from '../../artifact-viewer';
import {
  formatCost,
  formatDuration,
  formatRelativeTime,
  shareArtifactUrl,
} from '../../format';
import { TakeoverCommand } from '../../takeover-command';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap={0}>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text size="sm">{children}</Text>
    </Stack>
  );
}

function formatTokens(doc: SessionDoc): string {
  const total = doc.tokens.inputTokens + doc.tokens.outputTokens;
  const parts = [
    `in ${doc.tokens.inputTokens.toLocaleString('en-US')}`,
    `out ${doc.tokens.outputTokens.toLocaleString('en-US')}`,
  ];
  if (doc.tokens.cacheCreationTokens > 0) {
    parts.push(
      `cache-create ${doc.tokens.cacheCreationTokens.toLocaleString('en-US')}`,
    );
  }
  if (doc.tokens.cacheReadTokens > 0) {
    parts.push(
      `cache-read ${doc.tokens.cacheReadTokens.toLocaleString('en-US')}`,
    );
  }
  return `${total.toLocaleString('en-US')} total (${parts.join(', ')})`;
}

/**
 * The detail page's header: everything about a session that isn't the
 * transcript itself - identity, liveness, cost/token totals, and
 * source-specific fields (cli: host/cwd/worktree/branch + artifacts;
 * issue-agent: run/issue links). Renders unconditionally (never gated on
 * the transcript load succeeding) so a GCS failure never takes down the
 * whole page - see session-detail.ts/session-transcript.ts.
 */
export function SessionHeader({ doc, now }: { doc: SessionDoc; now: string }) {
  const liveness = displayLiveness(doc.liveness, doc.lastActivityAt, now);
  const durationSeconds = sessionDurationSeconds(
    doc.startedAt,
    doc.lastActivityAt,
  );
  const cliHost = doc.source === 'cli' ? doc.host : undefined;
  const cliArtifacts = doc.source === 'cli' ? (doc.artifacts ?? []) : [];
  const hasDeliverables =
    doc.deliverables.prNumbers.length > 0 ||
    doc.deliverables.commitShas.length > 0 ||
    Boolean(doc.deliverables.branch);

  return (
    <Stack gap="md" mb="xl" data-testid="session-header">
      <Group gap="sm" wrap="wrap" align="center">
        <Badge
          variant="outline"
          color={doc.source === 'cli' ? 'blue' : 'violet'}
        >
          {doc.source === 'cli' ? 'cli' : 'agent'}
        </Badge>
        <Badge
          variant="light"
          color={LIVENESS_COLORS[liveness]}
          data-testid="session-header-liveness"
        >
          {LIVENESS_LABELS[liveness]}
        </Badge>
        <AgentBadge agent={sessionAgent(doc)} />
        <Title order={1} size="h3">
          {doc.title ?? doc.sessionId}
        </Title>
      </Group>

      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md">
        {doc.model && <Field label="Model">{doc.model}</Field>}
        {doc.permissionMode && (
          <Field label="Permission mode">{doc.permissionMode}</Field>
        )}
        <Field label="Turns">{doc.turns}</Field>
        <Field label="Tokens">{formatTokens(doc)}</Field>
        <Field label="Cost">
          {doc.totalCostUsd !== undefined ? formatCost(doc.totalCostUsd) : '—'}
        </Field>
        <Field label="Started">{formatRelativeTime(doc.startedAt)}</Field>
        <Field label="Last activity">
          {formatRelativeTime(doc.lastActivityAt)}
        </Field>
        <Field label="Duration">{formatDuration(durationSeconds)}</Field>

        {doc.source === 'cli' && doc.host && (
          <Field label="Host">{doc.host}</Field>
        )}
        {doc.source === 'cli' && doc.cwd && (
          <Field label="Cwd">{doc.cwd}</Field>
        )}
        {doc.source === 'cli' && doc.worktree && (
          <Field label="Worktree">{doc.worktree}</Field>
        )}
        {doc.source === 'cli' && doc.branch && (
          <Field label="Branch">{doc.branch}</Field>
        )}

        {doc.source === 'issue-agent' && doc.runId && (
          <Field label="Run">
            <Anchor
              href={`https://github.com/${REPO_OWNER}/${REPO_NAME}/actions/runs/${doc.runId}`}
              target="_blank"
              rel="noreferrer"
              size="sm"
            >
              #{doc.runId} ↗
            </Anchor>
          </Field>
        )}
        {doc.source === 'issue-agent' && doc.issueNumber !== undefined && (
          <Field label="Issue">
            <Anchor
              href={`https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/${doc.issueNumber}`}
              target="_blank"
              rel="noreferrer"
              size="sm"
            >
              #{doc.issueNumber}
            </Anchor>
          </Field>
        )}
      </SimpleGrid>

      {hasDeliverables && (
        <Stack gap={4}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            Deliverables
          </Text>
          <Group gap="sm" wrap="wrap">
            {doc.deliverables.branch && (
              <Text size="sm">branch: {doc.deliverables.branch}</Text>
            )}
            {doc.deliverables.prNumbers.map((number) => (
              <Anchor
                key={number}
                href={`https://github.com/${REPO_OWNER}/${REPO_NAME}/pull/${number}`}
                target="_blank"
                rel="noreferrer"
                size="sm"
              >
                PR #{number} ↗
              </Anchor>
            ))}
            {doc.deliverables.commitShas.length > 0 && (
              <Text size="sm" c="dimmed">
                commits: {doc.deliverables.commitShas.join(', ')}
              </Text>
            )}
          </Group>
        </Stack>
      )}

      {cliHost && cliArtifacts.length > 0 && (
        <Stack gap={4}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            Artifacts
          </Text>
          <Group gap={6} wrap="wrap">
            {cliArtifacts.map((filename) => {
              const url = shareArtifactUrl(cliHost, doc.sessionId, filename);
              return (
                <Group key={filename} gap={4} wrap="nowrap">
                  <Anchor href={url} target="_blank" rel="noreferrer" size="xs">
                    {filename} ↗
                  </Anchor>
                  <ArtifactPreviewToggle url={url} filename={filename} />
                </Group>
              );
            })}
          </Group>
        </Stack>
      )}

      {doc.source === 'issue-agent' && doc.transcriptGcsUri && (
        <Stack gap={4}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            Resume from archive
          </Text>
          <Text size="xs" c="dimmed">
            This runner&apos;s container is gone, but its transcript is archived
            — run this on a workstation checkout to resume it there.
          </Text>
          <TakeoverCommand
            command={`~/p/members/tools/claude-agent-session.sh resume-archive ${doc.transcriptGcsUri}`}
          />
        </Stack>
      )}

      {doc.source === 'cli' && (
        <Text size="xs" c="dimmed" data-testid="cli-summary-note">
          CLI sessions ship summaries only — no full transcript is archived for
          this session.
        </Text>
      )}
    </Stack>
  );
}
