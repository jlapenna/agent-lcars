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
