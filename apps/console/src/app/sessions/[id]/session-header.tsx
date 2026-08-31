import type { SessionDoc } from '@agent-lcars/telemetry';
import { displayLiveness, totalTokens } from '@agent-lcars/telemetry';
import { Anchor, Badge, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';

import {
  agentSessionResumeScript,
  shareArtifactUrl,
} from '../../../lib/deployment';
import { sessionDurationSeconds } from '../../../lib/session-archive';
import {
  AgentBadge,
  LIVENESS_COLORS,
  LIVENESS_LABELS,
  SourceBadge,
} from '../../agent-activity-panel';
import { ArtifactPreviewToggle } from '../../artifact-viewer';
import { Eyebrow } from '../../eyebrow';
import { formatCost, formatDuration } from '../../format';
import { RelativeTime } from '../../relative-time';
import { SessionStatusLine } from '../../session-status-line';
import { TakeoverCommand } from '../../takeover-command';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap={0}>
      <Eyebrow>{label}</Eyebrow>
      <Text size="sm">{children}</Text>
    </Stack>
  );
}

function formatTokens(doc: SessionDoc): string {
  const total = totalTokens(doc.tokens);
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
  return `${total.toLocaleString('en-US')} cost-weighted total (${parts.join(', ')})`;
}

/**
 * The detail page's session summary: everything below the shared page header
 * that isn't the transcript itself - identity, liveness, cost/token totals, and
 * source-specific fields (cli: host/cwd/worktree/branch + artifacts;
 * issue-agent: run/issue links). Renders unconditionally (never gated on
 * the transcript load succeeding) so a GCS failure never takes down the
 * whole page - see session-detail.ts/session-transcript.ts.
 */
export function SessionHeader({ doc, now }: { doc: SessionDoc; now: string }) {
  const liveness = displayLiveness(
    doc.liveness,
    doc.lastActivityAt,
    now,
    doc.observedAt,
  );
  const durationSeconds = sessionDurationSeconds(
    doc.startedAt,
    doc.lastActivityAt,
  );
  const cliHost = doc.source === 'cli' ? doc.host : undefined;
  const cliArtifacts = doc.source === 'cli' ? (doc.artifacts ?? []) : [];
  const repo = doc.repo;
  const hasDeliverables =
    doc.deliverables.prNumbers.length > 0 ||
    doc.deliverables.commitShas.length > 0 ||
    Boolean(doc.deliverables.branch);

  return (
    <Stack gap="md" mb="xl" data-testid="session-header">
      <Group gap="sm" wrap="wrap" align="center">
        <SourceBadge source={doc.source} />
        <Badge
          variant="light"
          color={LIVENESS_COLORS[liveness]}
          data-testid="session-header-liveness"
        >
          {LIVENESS_LABELS[liveness]}
        </Badge>
        <AgentBadge agent={doc.agent} />
      </Group>

      <SessionStatusLine
        status={doc.status}
        statusUpdatedAt={doc.statusUpdatedAt}
        liveness={liveness}
      />

      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md">
        {doc.model && <Field label="Model">{doc.model}</Field>}
        {doc.permissionMode && (
          <Field label="Permission mode">{doc.permissionMode}</Field>
        )}
        <Field label="Turns">{doc.turns}</Field>
        <Field label="Cost-weighted tokens">{formatTokens(doc)}</Field>
        <Field label="Cost">
          {doc.totalCostUsd !== undefined ? formatCost(doc.totalCostUsd) : '—'}
        </Field>
        <Field label="Started">
          <RelativeTime iso={doc.startedAt} />
        </Field>
        <Field label="Last activity">
          <RelativeTime iso={doc.lastActivityAt} />
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
            {/^[1-9][0-9]*$/u.test(doc.runId) ? (
              <Anchor
                href={`https://github.com/${doc.repo.owner}/${doc.repo.name}/actions/runs/${doc.runId}`}
                target="_blank"
                rel="noreferrer"
                size="sm"
              >
                #{doc.runId} ↗
              </Anchor>
            ) : (
              doc.runId
            )}
          </Field>
        )}
        {doc.source === 'issue-agent' && doc.issueNumber !== undefined && (
          <Field label="Issue">
            <Anchor
              href={`https://github.com/${doc.repo.owner}/${doc.repo.name}/issues/${doc.issueNumber}`}
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
          <Eyebrow>Deliverables</Eyebrow>
          <Group gap="sm" wrap="wrap">
            {doc.deliverables.branch && (
              <Text size="sm">branch: {doc.deliverables.branch}</Text>
            )}
            {repo &&
              doc.deliverables.prNumbers.map((number) => (
                <Anchor
                  key={number}
                  href={`https://github.com/${repo.owner}/${repo.name}/pull/${number}`}
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
          <Eyebrow>Artifacts</Eyebrow>
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

      {/* Gated on the agent, not just the source: `resume-archive` installs
          the JSONL under ~/.claude/projects and runs `claude --resume`, so
          it cannot resume a Codex rollout. Native session records include a
          transcript URI for every provider, so offering this unconditionally
          would hand out a command that silently cannot work for the session
          shown. */}
      {doc.source === 'issue-agent' &&
        doc.transcriptGcsUri &&
        doc.agent === 'claude-code' && (
          <Stack gap={4}>
            <Eyebrow>Resume from archive</Eyebrow>
            <Text size="xs" c="dimmed">
              This runner&apos;s container is gone, but its transcript is
              archived — run this on a workstation checkout to resume it there.
            </Text>
            <TakeoverCommand
              command={`${agentSessionResumeScript()} resume-archive ${doc.transcriptGcsUri}`}
            />
          </Stack>
        )}

      {doc.source === 'issue-agent' &&
        doc.transcriptGcsUri &&
        doc.agent !== 'claude-code' && (
          <Stack gap={4}>
            <Eyebrow>Archived transcript</Eyebrow>
            <Text size="xs" c="dimmed" data-testid="archive-no-resume-note">
              Archived at <code>{doc.transcriptGcsUri}</code>. No resume command
              yet for {doc.agent} sessions — the existing one is
              Claude-specific.
            </Text>
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
