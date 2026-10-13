import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { GithubAnchorProjection } from '@agent-lcars/orchestrator';
import {
  buildSessionDoc,
  codexAdapter,
  parseSessionDoc,
  reduceTranscript,
} from '@agent-lcars/telemetry';
import { describe, expect, it } from 'vitest';

import { aggregateSessionSpend } from './session-spend';

const repo = { owner: 'jlapenna', name: 'agent-lcars' };
const timestamp = '2026-10-01T00:00:00.000Z';
const local: GithubAnchorProjection = {
  anchor: { repo: 'jlapenna/agent-lcars', issue: 42 },
  kind: 'pr',
  state: 'closed',
  title: 'local',
  body: '',
  url: 'https://github.com/jlapenna/agent-lcars/pull/42',
  labels: [],
  assigneeLogins: [],
  sourceUpdatedAt: timestamp,
  observedAt: timestamp,
  mergedAt: timestamp,
};
function session(payloads: unknown[]) {
  const summary = codexAdapter.reduce([
    JSON.stringify({
      type: 'session_meta',
      timestamp,
      payload: {
        id: 's',
        cwd: '/home/jlapenna/p/agent-lcars',
        originator: 'codex_cli_rs',
      },
    }),
    ...payloads.map((payload) =>
      JSON.stringify({ type: 'response_item', timestamp, payload }),
    ),
  ])[0];
  if (!summary) throw new Error('missing real adapter summary');
  return parseSessionDoc(
    buildSessionDoc({ ...summary, totalCostUsd: 5 }, 'ended', { repo }),
  );
}
const call = (id: string, command: string) => ({
  type: 'function_call',
  call_id: id,
  name: 'exec_command',
  arguments: JSON.stringify({ cmd: command }),
});
const output = (id: string, text: string) => ({
  type: 'function_call_output',
  call_id: id,
  output: text,
});

describe('qualified publication → retained session → spend boundary (#2301)', () => {
  it.each([
    'gh pr create --dry-run',
    'gh pr create "--dry-run"',
    'gh pr create --help',
    'gh pr create -dh',
    'gh pr create -dw',
    'printf "%s" "gh pr create"',
    "rg 'gh pr create' docs/product",
    'gh pr view 42 --json body --jq "gh pr create"',
  ])('keeps non-creating invocation unqualified: %s', (command) => {
    const doc = session([
      call('inspect', command),
      output('inspect', local.url),
    ]);
    const spend = aggregateSessionSpend(
      [doc],
      new Map([['jlapenna/agent-lcars#42', local]]),
    );
    expect(doc.deliverables.qualifiedPRs).toBeUndefined();
    expect(spend.mergedPRs).toBe(0);
    expect(spend.totals.costUsd).toBe(5);
  });

  it('retains failed Claude cost without attributing an unrelated merged URL', () => {
    const summary = reduceTranscript(
      [
        {
          type: 'assistant',
          sessionId: 'failed-claude',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                name: 'Bash',
                id: 'create',
                input: { command: 'gh pr create' },
              },
            ],
          },
        },
        {
          type: 'user',
          sessionId: 'failed-claude',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'create',
                is_error: true,
                content: local.url,
              },
            ],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n'),
    )[0];
    const doc = parseSessionDoc(
      buildSessionDoc({ ...summary, totalCostUsd: 5 }, 'ended', { repo }),
    );
    const spend = aggregateSessionSpend(
      [doc],
      new Map([['jlapenna/agent-lcars#42', local]]),
    );
    expect(doc.deliverables.qualifiedPRs).toBeUndefined();
    expect(spend.mergedPRs).toBe(0);
    expect(spend.totals.costUsd).toBe(5);
  });

  it('does not turn foreign user or lookup output into a local merged deliverable', () => {
    const doc = session([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Inspect https://github.com/acme/other-project/pull/42',
          },
        ],
      },
      call('lookup', 'gh pr view 42'),
      output('lookup', 'https://github.com/jlapenna/agent-lcars/pull/42'),
    ]);
    const spend = aggregateSessionSpend(
      [doc],
      new Map([['jlapenna/agent-lcars#42', local]]),
    );
    expect(doc.deliverables.prNumbers).toEqual([42]);
    expect(doc.deliverables.qualifiedPRs).toBeUndefined();
    expect(spend).toMatchObject({
      mergedPRs: 0,
      deliverables: [],
      totals: { costUsd: 5, unqualifiedPRReferences: 1 },
      withoutPR: { costUsd: 5 },
    });
  });
  it('preserves foreign creating-command identity and does not match an unrelated local number', () => {
    const doc = session([
      call('create', 'gh pr create --repo acme/other-project'),
      output('create', 'https://github.com/acme/other-project/pull/42'),
    ]);
    expect(doc.deliverables.qualifiedPRs).toEqual([
      { repo: { owner: 'acme', name: 'other-project' }, number: 42 },
    ]);
    const spend = aggregateSessionSpend(
      [doc],
      new Map([['jlapenna/agent-lcars#42', local]]),
    );
    expect(spend).toMatchObject({
      mergedPRs: 0,
      unknownPRs: 1,
      deliverables: [{ key: 'acme/other-project#42', reportedCostUsd: 5 }],
    });
  });
  it('deduplicates actual publication identity and retains known merged cost', () => {
    const doc = session([
      call('create', 'gh pr create'),
      output(
        'create',
        'https://github.com/JLAPENNA/agent-lcars/pull/42\nhttps://github.com/jlapenna/agent-lcars/pull/42',
      ),
    ]);
    expect(doc.deliverables.qualifiedPRs).toHaveLength(1);
    const spend = aggregateSessionSpend(
      [doc],
      new Map([['jlapenna/agent-lcars#42', local]]),
    );
    expect(spend).toMatchObject({
      mergedPRs: 1,
      costPerMergedDeliverableUsd: 5,
      totals: { unqualifiedPRReferences: 0 },
    });
  });
  it('rejects malformed stored qualified identities but retains legacy number hints without guessing', () => {
    const doc = session([]);
    expect(() =>
      parseSessionDoc({
        ...doc,
        deliverables: {
          prNumbers: [42],
          commitShas: [],
          qualifiedPRs: [
            { repo: { owner: 'bad/owner', name: 'repo' }, number: 42 },
          ],
        },
      }),
    ).toThrow('invalid qualified PR');
    const legacy = parseSessionDoc({
      ...doc,
      deliverables: { prNumbers: [42], commitShas: [] },
    });
    expect(
      aggregateSessionSpend(
        [legacy],
        new Map([['jlapenna/agent-lcars#42', local]]),
      ).mergedPRs,
    ).toBe(0);
  });
});

describe('Codex publication stdout normalization (#2302)', () => {
  it.each(['envelope', 'code-mode', 'plain'])(
    'retains qualified publication through %s',
    (format) => {
      const url = 'https://github.com/jlapenna/agent-lcars/pull/42';
      const envelope = JSON.stringify({
        chunk_id: 'a',
        exit_code: 0,
        output: url + '\n',
      });
      const content =
        format === 'envelope'
          ? envelope
          : format === 'code-mode'
            ? 'Script completed\nOutput:\n' + envelope
            : url + '\n';
      const doc = session([
        call('create', 'gh pr create'),
        output('create', content),
      ]);
      expect(
        aggregateSessionSpend(
          [doc],
          new Map([['jlapenna/agent-lcars#42', local]]),
        ).mergedPRs,
      ).toBe(1);
    },
  );
  it('does not count failed envelopes even inside code-mode prose', () => {
    const envelope = JSON.stringify({
      exit_code: 1,
      output: 'https://github.com/jlapenna/agent-lcars/pull/42',
    });
    for (const content of [
      envelope,
      'Script completed\nOutput:\n' + envelope,
    ]) {
      const doc = session([
        call('create', 'gh pr create'),
        output('create', content),
      ]);
      expect(
        aggregateSessionSpend(
          [doc],
          new Map([['jlapenna/agent-lcars#42', local]]),
        ).mergedPRs,
      ).toBe(0);
    }
  });
});

// Sanitized incident shape, never the private archive or its message bodies.
const delayedRows = readFileSync(
  resolve(
    __dirname,
    '../../../../libs/telemetry/src/lib/fixtures/codex-delayed-publication.jsonl',
  ),
  'utf8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));

describe('delayed Codex code-mode → retained session → spend (#2461)', () => {
  it.each(['published', 'failed', 'quoted', 'foreign', 'unknown'] as const)(
    'retains publication identity, cost, tokens and honest coverage for %s',
    (outcome) => {
      const rows = structuredClone(delayedRows);
      const publication = 'https://github.com/jlapenna/agent-lcars/pull/2460';
      const poll = rows[5].payload;
      poll.output[poll.output.length - 1].text = JSON.stringify({
        exit_code: outcome === 'failed' ? 1 : 0,
        output:
          outcome === 'foreign'
            ? 'https://github.com/acme/other/pull/2460'
            : outcome === 'quoted'
              ? `fixture: "${publication}"`
              : publication,
      });
      const summary = codexAdapter.reduce(
        rows.map((row) => JSON.stringify(row)),
      )[0];
      const doc = parseSessionDoc(
        buildSessionDoc({ ...summary, totalCostUsd: 5 }, 'ended', { repo }),
      );
      const spend = aggregateSessionSpend(
        [doc],
        new Map(
          outcome === 'unknown'
            ? []
            : [
                [
                  'jlapenna/agent-lcars#2460',
                  {
                    ...local,
                    anchor: { repo: 'jlapenna/agent-lcars', issue: 2460 },
                    url: publication,
                  },
                ],
              ],
        ),
      );
      expect(doc.tokens).toEqual({
        inputTokens: 80,
        outputTokens: 30,
        cacheReadTokens: 40,
        cacheCreationTokens: 0,
      });
      expect(doc.deliverables.prNumbers).toContain(2460);
      expect(spend.totals).toMatchObject({
        costUsd: 5,
        reportedCostUsd: 5,
        tokens: 114,
      });
      const qualified = outcome !== 'failed' && outcome !== 'quoted';
      expect(doc.deliverables.qualifiedPRs).toEqual(
        qualified
          ? [
              {
                repo:
                  outcome === 'foreign'
                    ? { owner: 'acme', name: 'other' }
                    : repo,
                number: 2460,
              },
            ]
          : undefined,
      );
      expect(spend.mergedPRs).toBe(outcome === 'published' ? 1 : 0);
      expect(spend.unknownPRs).toBe(
        outcome === 'foreign' || outcome === 'unknown' ? 1 : 0,
      );
      expect(spend.deliverables).toHaveLength(qualified ? 1 : 0);
      expect(spend.deliverables[0]?.reportedCostUsd).toBe(
        qualified ? 5 : undefined,
      );
      expect(spend.totals.unqualifiedPRReferences).toBe(qualified ? 0 : 1);
      expect(spend.withoutPR.costUsd ?? 0).toBe(qualified ? 0 : 5);
      expect(spend.coverageLimited).toBe(false);
    },
  );
  it('does not invent prices for delayed publications with unpriced sessions', () => {
    const summary = codexAdapter.reduce(
      delayedRows.map((row) => JSON.stringify(row)),
    )[0];
    const doc = parseSessionDoc(buildSessionDoc(summary, 'ended', { repo }));
    const spend = aggregateSessionSpend([doc], new Map());
    expect(spend.totals.unpricedSessions).toBe(1);
    expect(spend.totals.tokens).toBe(114);
    expect(spend.unknownPRs).toBe(1);
    expect(spend.coverageLimited).toBe(false);
  });
});
