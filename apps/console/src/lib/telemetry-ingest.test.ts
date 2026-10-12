import type { SessionDoc, SessionWrite } from '@agent-lcars/telemetry';
import { describe, expect, it, vi } from 'vitest';

import {
  handleSessionEventRequest,
  type TelemetryIngestDependencies,
  type TelemetryWriterPrincipal,
} from './telemetry-ingest';

const SESSION_ID = 'sess-1';
const NOW = '2026-10-10T12:00:00.000Z';

const summary = {
  sessionId: SESSION_ID,
  source: 'cli',
  agent: 'claude-code',
  startedAt: '2026-10-10T10:00:00.000Z',
  lastActivityAt: '2026-10-10T11:59:00.000Z',
  turns: 3,
  toolCallCounts: { Bash: 2 },
  tokens: {
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 5,
  },
  deliverables: { prNumbers: [], commitShas: [] },
  repo: { owner: 'jlapenna', name: 'agent-lcars' },
  title: 'Hooks phase 0',
};

function event(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    eventId: 'evt-1',
    seq: 2,
    occurredAt: NOW,
    host: 'laforge',
    agent: 'claude-code',
    sessionId: SESSION_ID,
    kind: 'tool',
    runtime: {
      name: 'claude-code',
      hookEvent: 'PostToolUse',
      clientVersion: '0.1.0',
    },
    summary,
    ...overrides,
  };
}

const hostPrincipal: TelemetryWriterPrincipal = {
  principal: 'host:laforge',
  boundHost: 'laforge',
  allowRunner: false,
};
const servicePrincipal: TelemetryWriterPrincipal = {
  principal: 'svc:telemetry-writer',
  allowRunner: true,
};

function deps(overrides: Partial<TelemetryIngestDependencies> = {}) {
  const writes: SessionWrite[] = [];
  const d: TelemetryIngestDependencies & { writes: SessionWrite[] } = {
    enabled: () => true,
    authenticate: vi.fn(async () => hostPrincipal),
    readSessionDoc: vi.fn(async () => undefined),
    writeSession: vi.fn(async (write: SessionWrite) => {
      writes.push(write);
    }),
    now: () => NOW,
    writes,
    ...overrides,
  };
  return d;
}

function request(body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(
    `https://lcars.test/api/telemetry/v1/sessions/${SESSION_ID}/events`,
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer tok',
        'content-type': 'application/json',
        ...headers,
      },
      body: text,
    },
  );
}

describe('handleSessionEventRequest', () => {
  it('is a 404 until the ingest flag is on', async () => {
    const d = deps({ enabled: () => false });
    const response = await handleSessionEventRequest(
      request(event()),
      SESSION_ID,
      d,
    );
    expect(response.status).toBe(404);
    expect(d.authenticate).not.toHaveBeenCalled();
  });

  it('requires a bearer the authenticator accepts', async () => {
    const d = deps({ authenticate: vi.fn(async () => undefined) });
    expect(
      (await handleSessionEventRequest(request(event()), SESSION_ID, d)).status,
    ).toBe(401);
    const noHeader = new Request('https://lcars.test/x', {
      method: 'POST',
      body: '{}',
    });
    expect(
      (await handleSessionEventRequest(noHeader, SESSION_ID, deps())).status,
    ).toBe(401);
  });

  it('writes a live cli doc with hook provenance for a first event', async () => {
    const d = deps();
    const response = await handleSessionEventRequest(
      request(event()),
      SESSION_ID,
      d,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: true,
      liveness: 'live',
      seq: 2,
    });
    expect(d.writes).toHaveLength(1);
    const { doc, clearFields } = d.writes[0];
    expect(doc).toMatchObject({
      sessionId: SESSION_ID,
      source: 'cli',
      liveness: 'live',
      observedAt: NOW,
      host: 'laforge',
      title: 'Hooks phase 0',
      repo: { owner: 'jlapenna', name: 'agent-lcars' },
      observer: {
        kind: 'hook',
        runtime: 'claude-code',
        host: 'laforge',
        seq: 2,
        eventId: 'evt-1',
        occurredAt: NOW,
        clientVersion: '0.1.0',
      },
    });
    expect(clearFields).toContain('status');
  });

  it('maps stop to idle and end to ended', async () => {
    const d = deps();
    await handleSessionEventRequest(
      request(event({ kind: 'stop' })),
      SESSION_ID,
      d,
    );
    await handleSessionEventRequest(
      request(event({ kind: 'end', seq: 3 })),
      SESSION_ID,
      d,
    );
    expect(d.writes.map((w) => w.doc.liveness)).toEqual(['idle', 'ended']);
  });

  it('refuses an out-of-order event from the same host and accepts a newer one', async () => {
    const existing = {
      sessionId: SESSION_ID,
      source: 'cli',
      host: 'laforge',
      agent: 'claude-code',
      liveness: 'live',
      startedAt: summary.startedAt,
      lastActivityAt: summary.lastActivityAt,
      turns: 3,
      toolCallCounts: {},
      tokens: summary.tokens,
      deliverables: summary.deliverables,
      observer: {
        kind: 'hook',
        runtime: 'claude-code',
        host: 'laforge',
        seq: 5,
        eventId: 'evt-5',
        occurredAt: NOW,
      },
    } as SessionDoc;
    const d = deps({ readSessionDoc: vi.fn(async () => existing) });
    const stale = await handleSessionEventRequest(
      request(event({ seq: 4 })),
      SESSION_ID,
      d,
    );
    expect(stale.status).toBe(200);
    expect(await stale.json()).toEqual({ accepted: false, reason: 'stale' });
    expect(d.writes).toHaveLength(0);
    const fresh = await handleSessionEventRequest(
      request(event({ seq: 6 })),
      SESSION_ID,
      d,
    );
    expect(fresh.status).toBe(202);
  });

  it('applies a lifecycle-only event on top of the stored doc', async () => {
    const existing = {
      sessionId: SESSION_ID,
      source: 'cli',
      host: 'laforge',
      agent: 'claude-code',
      liveness: 'live',
      startedAt: summary.startedAt,
      lastActivityAt: summary.lastActivityAt,
      turns: 7,
      toolCallCounts: { Bash: 4 },
      tokens: summary.tokens,
      deliverables: summary.deliverables,
      title: 'kept',
      cwd: '/w',
      branch: 'main',
    } as SessionDoc;
    const d = deps({ readSessionDoc: vi.fn(async () => existing) });
    const response = await handleSessionEventRequest(
      request(event({ kind: 'end', summary: undefined })),
      SESSION_ID,
      d,
    );
    expect(response.status).toBe(202);
    expect(d.writes[0].doc).toMatchObject({
      liveness: 'ended',
      turns: 7,
      title: 'kept',
      branch: 'main',
    });
  });

  it('needs a summary for a session it has never seen', async () => {
    const response = await handleSessionEventRequest(
      request(event({ kind: 'end', summary: undefined })),
      SESSION_ID,
      deps(),
    );
    expect(response.status).toBe(422);
  });

  it('rejects malformed, mismatched, or oversized bodies', async () => {
    const d = deps();
    expect(
      (await handleSessionEventRequest(request('{not json'), SESSION_ID, d))
        .status,
    ).toBe(400);
    expect(
      (
        await handleSessionEventRequest(
          request(event({ kind: 'nope' })),
          SESSION_ID,
          d,
        )
      ).status,
    ).toBe(400);
    expect(
      (await handleSessionEventRequest(request(event()), 'other-session', d))
        .status,
    ).toBe(400);
    expect(
      (await handleSessionEventRequest(request(event()), '../x', d)).status,
    ).toBe(400);
    const big = request(
      event({ summary: { ...summary, title: 'x'.repeat(300_000) } }),
    );
    expect((await handleSessionEventRequest(big, SESSION_ID, d)).status).toBe(
      413,
    );
    expect(d.writes).toHaveLength(0);
  });

  it('never trusts the summary source: a host token always yields a cli doc', async () => {
    const d = deps();
    const response = await handleSessionEventRequest(
      request(event({ summary: { ...summary, source: 'issue-agent' } })),
      SESSION_ID,
      d,
    );
    expect(response.status).toBe(202);
    expect(d.writes[0].doc.source).toBe('cli');
  });

  it('refuses a host token writing a session recorded by another host or a runner', async () => {
    const base = {
      sessionId: SESSION_ID,
      agent: 'claude-code',
      liveness: 'live',
      startedAt: summary.startedAt,
      lastActivityAt: summary.lastActivityAt,
      turns: 1,
      toolCallCounts: {},
      tokens: summary.tokens,
      deliverables: summary.deliverables,
    };
    const otherHost = { ...base, source: 'cli', host: 'pike' } as SessionDoc;
    const runnerDoc = {
      ...base,
      source: 'issue-agent',
      repo: { owner: 'jlapenna', name: 'agent-lcars' },
      runId: 'run-1',
    } as SessionDoc;
    const hookFromOther = {
      ...base,
      source: 'cli',
      observer: {
        kind: 'hook',
        runtime: 'claude-code',
        host: 'pike',
        seq: 1,
        eventId: 'e',
        occurredAt: NOW,
      },
    } as SessionDoc;
    const hostless = { ...base, source: 'cli' } as SessionDoc;
    for (const existing of [otherHost, runnerDoc, hookFromOther, hostless]) {
      const d = deps({ readSessionDoc: vi.fn(async () => existing) });
      const response = await handleSessionEventRequest(
        request(event({ seq: 9 })),
        SESSION_ID,
        d,
      );
      expect(response.status).toBe(403);
      expect(d.writes).toHaveLength(0);
    }
    const own = { ...base, source: 'cli', host: 'laforge' } as SessionDoc;
    const d = deps({ readSessionDoc: vi.fn(async () => own) });
    expect(
      (await handleSessionEventRequest(request(event()), SESSION_ID, d)).status,
    ).toBe(202);
    const runner = {
      runId: 'run-7',
      repo: { owner: 'jlapenna', name: 'agent-lcars' },
    };
    // A service identity never writes workstation docs: without runner
    // context it is refused, and with it a CLI doc is not its to overwrite.
    const svcNoRunner = deps({
      authenticate: vi.fn(async () => servicePrincipal),
    });
    expect(
      (
        await handleSessionEventRequest(
          request(event({ host: 'pike' })),
          SESSION_ID,
          svcNoRunner,
        )
      ).status,
    ).toBe(403);
    const svcOnCli = deps({
      authenticate: vi.fn(async () => servicePrincipal),
      readSessionDoc: vi.fn(async () => otherHost),
    });
    expect(
      (
        await handleSessionEventRequest(
          request(event({ host: 'pike', runner })),
          SESSION_ID,
          svcOnCli,
        )
      ).status,
    ).toBe(403);
    const svcOnOwnRun = deps({
      authenticate: vi.fn(async () => servicePrincipal),
      readSessionDoc: vi.fn(
        async () => ({ ...runnerDoc, runId: 'run-7' }) as SessionDoc,
      ),
    });
    expect(
      (
        await handleSessionEventRequest(
          request(event({ host: 'pike', runner })),
          SESSION_ID,
          svcOnOwnRun,
        )
      ).status,
    ).toBe(202);
    const svcOnOtherRun = deps({
      authenticate: vi.fn(async () => servicePrincipal),
      readSessionDoc: vi.fn(async () => runnerDoc),
    });
    expect(
      (
        await handleSessionEventRequest(
          request(event({ host: 'pike', runner })),
          SESSION_ID,
          svcOnOtherRun,
        )
      ).status,
    ).toBe(403);
  });

  it('binds host tokens to their host and runner context to service identities', async () => {
    const d = deps();
    expect(
      (
        await handleSessionEventRequest(
          request(event({ host: 'pike' })),
          SESSION_ID,
          d,
        )
      ).status,
    ).toBe(403);
    const runner = {
      runId: 'run-1',
      repo: { owner: 'jlapenna', name: 'agent-lcars' },
      issueNumber: 5,
    };
    expect(
      (
        await handleSessionEventRequest(
          request(event({ runner })),
          SESSION_ID,
          d,
        )
      ).status,
    ).toBe(403);
    const svc = deps({ authenticate: vi.fn(async () => servicePrincipal) });
    const response = await handleSessionEventRequest(
      request(event({ host: 'runner-1', runner })),
      SESSION_ID,
      svc,
    );
    expect(response.status).toBe(202);
    expect(svc.writes[0].doc).toMatchObject({
      source: 'issue-agent',
      runId: 'run-1',
      issueNumber: 5,
      repo: runner.repo,
    });
  });
});
