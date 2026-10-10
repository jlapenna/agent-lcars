import type { GithubAnchorProjection } from '@agent-lcars/orchestrator';
import {
  buildSessionDoc,
  codexAdapter,
  parseSessionDoc,
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
