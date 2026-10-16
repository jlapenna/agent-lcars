import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { GithubAnchorProjection } from '@agent-lcars/orchestrator';
import {
  buildSessionDoc,
  claudeCodeAdapter,
  type CliSessionDoc,
} from '@agent-lcars/telemetry';
import { describe, expect, it, vi } from 'vitest';

import { aggregateSessionSpend } from './session-spend';
import { loadSpendProjections } from './session-spend-projections';

const repo = { owner: 'jlapenna', name: 'agent-lcars' };
const key = 'jlapenna/agent-lcars#42';
const start = '2026-10-14T10:00:00.000Z';
const end = '2026-10-14T11:00:00.000Z';

function session(
  command = `cd /worktree && gh pr create --body "$(cat <<'EOF'\nbody\nEOF\n)"`,
  options: { failed?: boolean; consumed?: boolean } = {},
): CliSessionDoc {
  const summary = claudeCodeAdapter.reduce(
    [
      {
        type: 'assistant',
        sessionId: 'session_test',
        timestamp: start,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'create',
              name: 'Bash',
              input: { command },
            },
          ],
        },
      },
      ...(options.consumed
        ? [
            {
              type: 'user',
              sessionId: 'session_test',
              timestamp: end,
              message: {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'create',
                    content: 'No PR created',
                  },
                ],
              },
            },
          ]
        : []),
      {
        type: 'user',
        sessionId: 'session_test',
        timestamp: end,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'create',
              ...(options.failed && { is_error: true }),
              content: 'https://github.com/jlapenna/agent-lcars/pull/42',
            },
          ],
        },
      },
    ].map((row) => JSON.stringify(row)),
  )[0];
  if (!summary) throw new Error('missing adapter summary');
  return buildSessionDoc(
    {
      ...summary,
      repo,
      branch: 'fix/42',
      githubActor: 'jlapenna',
      totalCostUsd: 6,
    },
    'ended',
  ) as CliSessionDoc;
}
function record(
  overrides: Partial<GithubAnchorProjection> = {},
): GithubAnchorProjection {
  return {
    anchor: { repo: 'jlapenna/agent-lcars', issue: 42 },
    kind: 'pr',
    state: 'closed',
    title: 'Delivered',
    body: 'Claude-Session: https://claude.ai/code/session_test',
    url: 'https://github.com/jlapenna/agent-lcars/pull/42',
    author: 'jlapenna',
    createdAt: '2026-10-14T10:30:00.000Z',
    headRefName: 'fix/42',
    headRepository: 'jlapenna/agent-lcars',
    mergedAt: end,
    labels: [],
    assigneeLogins: [],
    observedAt: end,
    sourceUpdatedAt: end,
    ...overrides,
  };
}
function spend(doc = session(), projection = record()) {
  return aggregateSessionSpend([doc], new Map([[key, projection]]));
}

describe('GitHub-record spend attribution (#2730)', () => {
  it('retains the captured native 2834 compound publication shape across local and public identities', () => {
    const summary = claudeCodeAdapter.reduce(
      readFileSync(
        path.join(
          import.meta.dirname,
          '../../../../libs/telemetry/src/lib/fixtures/claude-bridged-publication.jsonl',
        ),
        'utf8',
      )
        .trim()
        .split('\n'),
    )[0];
    const observedAt = '2026-10-16T21:11:06.226Z';
    const doc = buildSessionDoc(
      {
        ...summary,
        githubActor: 'jlapenna',
        repo,
        branch: 'main',
        deliverables: {
          ...summary.deliverables,
          publicationCheckouts: [
            {
              repo,
              githubActor: 'jlapenna',
              branch: 'ux/work-sources-verdict',
              head: 'c'.repeat(40),
              observedAt,
            },
          ],
        },
      },
      'live',
    ) as CliSessionDoc;
    doc.observer = {
      kind: 'hook',
      runtime: 'claude-code',
      host: 'laforge',
      seq: 1,
      eventId: 'fixture',
      occurredAt: observedAt,
    };
    expect(doc.deliverables.qualifiedPRs).toBeUndefined();
    expect(doc.deliverables.publicationCandidates).toEqual([
      { repo, number: 2834 },
    ]);
    const projection = record({
      anchor: { repo: 'jlapenna/agent-lcars', issue: 2834 },
      createdAt: '2026-10-16T21:10:47.000Z',
      headRefName: 'ux/work-sources-verdict',
      headSha: 'c'.repeat(40),
      mergedAt: null,
      body: 'https://claude.ai/code/session_01M3e8hqz5EbT75xWPGsS42j',
    });
    expect(
      aggregateSessionSpend(
        [doc],
        new Map([['jlapenna/agent-lcars#2834', projection]]),
      ).unmergedPRs,
    ).toBe(1);
  });
  function bridged() {
    const doc = session();
    doc.sessionId = '7de2bec1-aab8-4766-b834-cb6c1a9169a0';
    doc.branch = 'main';
    doc.deliverables.claudeSessionId = 'session_01M3e8hqz5EbT75xWPGsS42j';
    doc.deliverables.publicationCheckouts = [
      {
        repo,
        githubActor: 'jlapenna',
        branch: 'fix/42',
        head: 'a'.repeat(40),
        observedAt: end,
      },
    ];
    doc.observer = {
      kind: 'hook',
      runtime: 'claude-code',
      host: 'fixture',
      seq: 1,
      eventId: 'event-1',
      occurredAt: end,
    };
    return doc;
  }
  const bridgedRecord = () =>
    record({
      headSha: 'a'.repeat(40),
      body: 'https://claude.ai/code/session_01M3e8hqz5EbT75xWPGsS42j',
    });

  it('qualifies a real bridge-shaped compound creator using immutable checkout corroboration', () => {
    expect(spend(bridged(), bridgedRecord())).toMatchObject({
      mergedPRs: 1,
      costPerMergedDeliverableUsd: 6,
    });
  });
  it.each([
    { headSha: 'b'.repeat(40) },
    { headSha: undefined },
    { headRefName: 'other' },
    { author: 'other' },
    { headRepository: 'foreign/repo' },
    { createdAt: '2026-10-14T11:00:00.001Z' },
    { body: 'https://claude.ai/code/session_other' },
    {
      body: '```\nhttps://claude.ai/code/session_01M3e8hqz5EbT75xWPGsS42j\n```',
    },
    {
      body: '<!-- https://claude.ai/code/session_01M3e8hqz5EbT75xWPGsS42j -->',
    },
    {
      body: 'https://claude.ai/code/session_01M3e8hqz5EbT75xWPGsS42j\nClaude-Session: https://claude.ai/code/session_other',
    },
  ])(
    'rejects contradictory bridge or immutable GitHub evidence: %j',
    (patch) => {
      expect(
        spend(bridged(), record({ ...bridgedRecord(), ...patch })).mergedPRs,
      ).toBe(0);
    },
  );
  it('never substitutes current main, a foreign checkout or a future observation', () => {
    for (const patch of [
      { branch: 'main' },
      { repo: { owner: 'foreign', name: 'repo' } },
      { githubActor: 'other' },
      { observedAt: '2026-10-14T11:00:00.001Z' },
      { observedAt: '2026-10-14T09:59:59.999Z' },
    ]) {
      const doc = bridged();
      doc.deliverables.publicationCheckouts = [
        { ...doc.deliverables.publicationCheckouts![0], ...patch },
      ];
      expect(spend(doc, bridgedRecord()).mergedPRs).toBe(0);
    }
    const doc = bridged();
    delete doc.deliverables.publicationCheckouts;
    expect(spend(doc, bridgedRecord()).mergedPRs).toBe(0);
  });
  it.each([
    `cd /worktree && gh pr create --draft --body "$(cat <<'EOF'\nbody\nEOF\n)"`,
    'cd /worktree; gh pr create --draft --body-file /tmp/body.md',
  ])(
    'qualifies an actual merged PR independently of shell syntax: %s',
    async (command) => {
      const doc = session(command);
      expect(doc.deliverables.prNumbers).toEqual([42]);
      expect(doc.deliverables.qualifiedPRs).toBeUndefined();
      const read = vi.fn(async () => record());
      const loaded = await loadSpendProjections([doc], read);
      expect(read).toHaveBeenCalledWith({
        repo: 'jlapenna/agent-lcars',
        issue: 42,
      });
      const result = aggregateSessionSpend([doc], loaded.projections);
      expect(result).toMatchObject({
        mergedPRs: 1,
        costPerMergedDeliverableUsd: 6,
        totals: { unqualifiedPRReferences: 0 },
        withoutPR: { sessions: 0 },
      });
    },
  );
  it.each([
    ['failed', { failed: true }],
    ['replayed after consumed result', { consumed: true }],
  ])(
    'does not promote %s output even with matching server facts',
    (_name, options) => {
      const doc = session(undefined, options);
      expect(doc.deliverables.publicationCandidates).toBeUndefined();
      expect(spend(doc).mergedPRs).toBe(0);
    },
  );
  it('does not promote non-creating lookup output with matching server facts', () => {
    const doc = session('gh pr view 42');
    expect(doc.deliverables.publicationCandidates).toBeUndefined();
    expect(spend(doc).mergedPRs).toBe(0);
  });
  it('does not promote legacy number-only references even with matching server facts', () => {
    const doc = session();
    delete doc.deliverables.publicationCandidates;
    expect(spend(doc).mergedPRs).toBe(0);
  });

  it.each([
    { author: 'someone-else' },
    { author: undefined },
    { createdAt: undefined },
    { createdAt: 'invalid' },
    { createdAt: '2026-10-14T09:59:59.999Z' },
    { createdAt: '2026-10-14T11:00:00.001Z' },
    { headRefName: 'other' },
    { headRefName: undefined },
    { headRepository: 'fork/agent-lcars' },
    { headRepository: undefined },
    { kind: 'issue' as const },
    { anchor: { repo: 'other/repo', issue: 42 } },
    { anchor: { repo: 'jlapenna/agent-lcars', issue: 43 } },
    { body: 'Claude-Session: https://claude.ai/code/session_other' },
    {
      body: 'https://claude.ai/code/session_test https://claude.ai/code/session_other',
    },
  ])('rejects unrelated or incomplete GitHub evidence: %j', (patch) => {
    expect(spend(session(), record(patch))).toMatchObject({
      mergedPRs: 0,
      totals: { unqualifiedPRReferences: 1 },
    });
  });
  it.each([
    { githubActor: undefined },
    { branch: undefined },
    { repo: undefined },
    { githubActor: 'other' },
    { branch: 'main' },
    { startedAt: '' },
    { lastActivityAt: '' },
    { startedAt: end, lastActivityAt: start },
  ])(
    'leaves legacy, offline and mismatched sessions unqualified: %j',
    (patch) => {
      expect(spend({ ...session(), ...patch })).toMatchObject({
        mergedPRs: 0,
        totals: { unqualifiedPRReferences: 1 },
      });
    },
  );
  it('uses inclusive creation bounds and case-insensitive GitHub identities', () => {
    expect(
      spend(
        session(),
        record({
          author: 'JLaPenna',
          headRepository: 'JLaPenna/Agent-LCARS',
          createdAt: start,
        }),
      ).mergedPRs,
    ).toBe(1);
    expect(spend(session(), record({ createdAt: end })).mergedPRs).toBe(1);
  });
  it.each([
    '',
    'Discussion: https://claude.ai/code/session_test',
    '> Claude-Session: https://claude.ai/code/session_test',
    'Claude-Session: https://claude.ai/code/session_test-extra',
    'Claude-Session: https://claude.ai/code/session_test/path',
  ])('requires an exact GitHub session attribution line: %s', (body) => {
    expect(spend(session(), record({ body })).mergedPRs).toBe(0);
  });
  it.each([
    '```text\nClaude-Session: https://claude.ai/code/session_test\n```',
    '~~~\nClaude-Session: https://claude.ai/code/session_test\n~~~',
    '````text\n```\nClaude-Session: https://claude.ai/code/session_test\n````',
    '```text\nClaude-Session: https://claude.ai/code/session_test',
    '<!--\nClaude-Session: https://claude.ai/code/session_test\n-->',
    '<!--\nClaude-Session: https://claude.ai/code/session_test',
    'Claude-<!-- example -->Session: https://claude.ai/code/session_test',
    '<!-- example -->Claude-Session: https://claude.ai/code/session_test',
  ])('does not accept an attribution example or HTML comment: %s', (body) => {
    expect(spend(session(), record({ body })).mergedPRs).toBe(0);
  });
  it('allows a real attribution footer after a closed code sample and attempt comment', () => {
    const body =
      '```text\nClaude-Session: https://claude.ai/code/session_other\n```\n<!-- attempt-claim:test -->\nClaude-Session: https://claude.ai/code/session_test';
    expect(spend(session(), record({ body })).mergedPRs).toBe(1);
  });

  it('cannot attribute inert create text from another same-actor same-branch session', () => {
    const doc = session(
      "printf '%s\\n' 'gh pr create' 'https://github.com/jlapenna/agent-lcars/pull/42'",
    );
    expect(doc.deliverables.publicationCandidates).toHaveLength(1);
    expect(spend(doc, record({ body: '' })).mergedPRs).toBe(0);
    expect(
      spend(
        doc,
        record({
          body: 'Claude-Session: https://claude.ai/code/session_other',
        }),
      ).mergedPRs,
    ).toBe(0);
  });
  it('does not turn missing merge observations into a merge', () => {
    expect(spend(session(), record({ mergedAt: undefined }))).toMatchObject({
      mergedPRs: 0,
      unknownPRs: 1,
    });
  });
  it('does not guess an actor or read bare references for a legacy session', async () => {
    const read = vi.fn(async () => record());
    const doc = { ...session(), githubActor: undefined };
    expect((await loadSpendProjections([doc], read)).projections.size).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });
  it('keeps duplicated hints to one deliverable and charges the session once', () => {
    const doc = session();
    doc.deliverables.prNumbers = [42, 42];
    expect(spend(doc)).toMatchObject({
      mergedPRs: 1,
      deliverables: [{ sessions: 1, reportedCostUsd: 6 }],
    });
  });
});
