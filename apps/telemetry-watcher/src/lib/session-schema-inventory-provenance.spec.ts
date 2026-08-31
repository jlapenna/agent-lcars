import { describe, expect, it } from 'vitest';

import { sessionSchemaInventoryProvenance } from './session-schema-inventory-provenance';

describe('sessionSchemaInventoryProvenance', () => {
  it('returns only explicit CLI provenance and never a derived value', () => {
    expect(
      sessionSchemaInventoryProvenance({
        source: 'cli',
        agent: 'codex',
        repo: { owner: 'jlapenna', name: 'agent-lcars' },
        host: 'laforge',
        cwd: '/home/jlapenna/p/agent-lcars',
        worktree: '/home/jlapenna/p/agent-lcars-1632-inventory-provenance',
        lastActivityAt: '2026-08-31T13:00:00.000Z',
        transcriptGcsUri: 'gs://private-bucket/never-print-this.jsonl',
      }),
    ).toEqual({
      source: 'cli',
      agent: 'codex',
      repo: { owner: 'jlapenna', name: 'agent-lcars' },
      host: 'laforge',
      cwd: '/home/jlapenna/p/agent-lcars',
      worktree: '/home/jlapenna/p/agent-lcars-1632-inventory-provenance',
      archivePresent: true,
      lastActivityAt: '2026-08-31T13:00:00.000Z',
    });
  });

  it('returns only explicit issue-agent anchors and archive capability', () => {
    expect(
      sessionSchemaInventoryProvenance({
        source: 'issue-agent',
        agent: 'opencode',
        repo: { owner: 'jlapenna', name: 'agent-lcars' },
        runId: 'run-42',
        intentId: 'work:01ABC/r1',
        issueNumber: 1632,
        transcriptGcsUri: 'gs://private-bucket/never-print-this.jsonl',
        renderable: false,
        lastActivityAt: '2026-08-31T13:00:00.000Z',
        host: 'must-not-cross-source-boundaries',
      }),
    ).toEqual({
      source: 'issue-agent',
      agent: 'opencode',
      repo: { owner: 'jlapenna', name: 'agent-lcars' },
      runId: 'run-42',
      intentId: 'work:01ABC/r1',
      issueNumber: 1632,
      archivePresent: true,
      renderable: false,
      lastActivityAt: '2026-08-31T13:00:00.000Z',
    });
  });

  it('does not default missing or malformed stored values', () => {
    expect(sessionSchemaInventoryProvenance({})).toEqual({
      archivePresent: false,
    });
    expect(
      sessionSchemaInventoryProvenance({
        source: 'retired-source',
        agent: '',
        repo: { owner: ' ', name: '' },
        renderable: 'unknown',
      }),
    ).toEqual({
      source: 'retired-source',
      agent: '',
      repo: { owner: ' ', name: '' },
      archivePresent: false,
      renderable: 'unknown',
    });
  });
});
