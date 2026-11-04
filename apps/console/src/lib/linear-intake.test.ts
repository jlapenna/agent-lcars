// @vitest-environment node
import { createHmac } from 'node:crypto';

import {
  MemoryStore,
  Orchestrator,
  WORK_PAYLOAD_MAX_BYTES,
} from '@agent-lcars/orchestrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type LinearConfig, linearConfig } from './linear-config';
import { admitLinearWebhook, verifyLinearSignature } from './linear-intake';
import type { WorkContext } from './work-mint';

const org = '11111111-1111-4111-8111-111111111111';
const team = '22222222-2222-4222-8222-222222222222';
const label = '33333333-3333-4333-8333-333333333333';
const issueId = '44444444-4444-4444-8444-444444444444';
const config: LinearConfig = {
  organizationId: org,
  routes: [
    {
      teamId: team,
      labelId: label,
      repo: 'owner/repo',
      pipeline: 'codex',
      principal: 'svc:linear',
    },
  ],
};
const now = Date.parse('2026-11-04T10:00:00Z');
function event(
  over: Record<string, unknown> = {},
  issueOver: Record<string, unknown> = {},
) {
  return Buffer.from(
    JSON.stringify({
      type: 'Issue',
      action: 'update',
      organizationId: org,
      webhookTimestamp: now,
      data: {
        id: issueId,
        teamId: team,
        identifier: 'ENG-42',
        title: 'Fix search',
        description: 'Search returns no results.',
        url: 'https://linear.app/example/issue/ENG-42',
        labelIds: [label],
        ...issueOver,
      },
      ...over,
    }),
  );
}
function runtime() {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, {
    now: () => new Date(now).toISOString(),
  });
  const drain = vi.fn();
  return { store, orchestrator, drain } as unknown as WorkContext['runtime'];
}
beforeEach(() => {
  vi.stubEnv('AGENT_LCARS_LINEAR', JSON.stringify(config));
  vi.stubEnv('AGENT_LCARS_LINEAR_API_KEY', 'test-api-key');
  vi.stubEnv('AGENT_LCARS_LINEAR_WEBHOOK_SECRET', 'test-secret');
  vi.stubEnv(
    'AGENT_LCARS_WORK_GRANTS',
    JSON.stringify([
      {
        principal: 'svc:linear',
        subjects: ['linear-adapter'],
        pipelines: ['codex'],
        scopes: ['work.operator'],
        channel: 'linear',
      },
    ]),
  );
  vi.stubEnv('AGENT_LCARS_CONTROL_PLANE_REPOSITORIES', 'owner/repo');
  vi.stubEnv(
    'AGENT_LCARS_WATCHED_REPOS',
    JSON.stringify([{ owner: 'owner', name: 'repo', alias: 'repo' }]),
  );
});
afterEach(() => vi.unstubAllEnvs());

describe('Linear admission boundary', () => {
  it('authenticates the exact bytes and safely rejects malformed signatures', () => {
    const raw = event();
    const signature = createHmac('sha256', 'test-secret')
      .update(raw)
      .digest('hex');
    expect(verifyLinearSignature(raw, signature, 'test-secret')).toBe(true);
    expect(
      verifyLinearSignature(
        Buffer.concat([raw, Buffer.from(' ')]),
        signature,
        'test-secret',
      ),
    ).toBe(false);
    for (const invalid of [
      null,
      '',
      'aa',
      'x'.repeat(64),
      signature.slice(0, -1),
    ])
      expect(verifyLinearSignature(raw, invalid, 'test-secret')).toBe(false);
  });
  it('creates a native work item with the selected repository, pipeline and Linear address', async () => {
    const rt = runtime();
    const result = await admitLinearWebhook(event(), config, rt, now);
    expect(result.status).toBe(200);
    const stored = await rt.store.readTask({
      workId: result.body['itemId'] as string,
    });
    expect(stored?.task.work).toMatchObject({
      origin: {
        principal: 'svc:linear',
        channel: 'linear',
        thread: JSON.stringify({ organizationId: org, issueId }),
      },
      spec: {
        title: 'ENG-42: Fix search',
        pipeline: 'codex',
        target: { repo: 'owner/repo' },
      },
    });
    expect(JSON.stringify(stored?.task.work)).toContain(
      'https://linear.app/example/issue/ENG-42',
    );
    expect(
      await rt.store.listRuns({ workId: result.body['itemId'] as string }),
    ).toHaveLength(1);
    expect(rt.drain).not.toHaveBeenCalled();
  });
  it('deduplicates retries and later edits without overwriting the admitted brief', async () => {
    const rt = runtime();
    const first = await admitLinearWebhook(event(), config, rt, now);
    const second = await admitLinearWebhook(
      event({}, { title: 'Updated title' }),
      config,
      rt,
      now,
    );
    expect(second.body).toEqual({
      outcome: 'existing',
      itemId: first.body['itemId'],
    });
    expect(
      await rt.store.listRuns({ workId: first.body['itemId'] as string }),
    ).toHaveLength(1);
    expect(
      (await rt.store.readTask({ workId: first.body['itemId'] as string }))
        ?.task.work,
    ).toMatchObject({ spec: { title: 'ENG-42: Fix search' } });
  });
  it('admits a restored issue carrying Linear’s nullable trashed field', async () => {
    const rt = runtime();
    const result = await admitLinearWebhook(
      event({}, { trashed: null }),
      config,
      rt,
      now,
    );
    expect(result.status).toBe(200);
    expect(result.body['outcome']).toBe('minted');
    expect(
      await rt.store.listRuns({ workId: result.body['itemId'] as string }),
    ).toHaveLength(1);
  });
  it('admits only one run for concurrent identical webhook deliveries', async () => {
    const rt = runtime();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        admitLinearWebhook(event(), config, rt, now),
      ),
    );
    expect(new Set(results.map((r) => r.body['itemId'])).size).toBe(1);
    expect(
      await rt.store.listRuns({ workId: results[0].body['itemId'] as string }),
    ).toHaveLength(1);
  });
  it.each([
    [{ organizationId: team }, {}],
    [{ type: 'Comment' }, {}],
    [{ action: 'remove' }, {}],
    [{}, { teamId: org }],
    [{}, { labelIds: [] }],
    [{}, { completedAt: '2026-11-04T09:00:00Z' }],
    [{}, { canceledAt: '2026-11-04T09:00:00Z' }],
    [{}, { archivedAt: '2026-11-04T09:00:00Z' }],
    [{}, { trashed: true }],
  ])(
    'ignores an out-of-scope or inactive issue (%j, %j)',
    async (over, issueOver) => {
      const rt = runtime();
      expect(
        (await admitLinearWebhook(event(over, issueOver), config, rt, now))
          .body['outcome'],
      ).toBe('ignored');
      expect(await rt.store.listNativeTasks(10)).toHaveLength(0);
    },
  );
  it('rejects signed but expired, future-dated or malformed events before admission', async () => {
    for (const timestamp of [now - 60_001, now + 60_001])
      expect(
        (
          await admitLinearWebhook(
            event({ webhookTimestamp: timestamp }),
            config,
            runtime(),
            now,
          )
        ).status,
      ).toBe(401);
    expect(
      (await admitLinearWebhook(Buffer.from('{'), config, runtime(), now))
        .status,
    ).toBe(400);
    expect(
      (
        await admitLinearWebhook(
          event({}, { url: 'https://attacker.example/' }),
          config,
          runtime(),
          now,
        )
      ).status,
    ).toBe(400);
  });
  it('refuses ambiguous dispatch labels', async () => {
    const other = {
      ...config,
      routes: [
        ...config.routes,
        { ...config.routes[0], labelId: team, pipeline: 'claude' as const },
      ],
    };
    expect(
      (
        await admitLinearWebhook(
          event({}, { labelIds: [label, team] }),
          other,
          runtime(),
          now,
        )
      ).body['reason'],
    ).toContain('multiple matching routes');
  });
  it('bounds Unicode and JSON-escaped descriptions to the durable Work payload budget', async () => {
    const rt = runtime();
    const result = await admitLinearWebhook(
      event({}, { description: '😀\n\u0001'.repeat(20_000) }),
      config,
      rt,
      now,
    );
    expect(result.status).toBe(200);
    const task = await rt.store.readTask({
      workId: result.body['itemId'] as string,
    });
    expect(
      Buffer.byteLength(JSON.stringify(task?.task.work)),
    ).toBeLessThanOrEqual(WORK_PAYLOAD_MAX_BYTES);
  });
  it('refuses a revoked integration grant', async () => {
    vi.stubEnv('AGENT_LCARS_WORK_GRANTS', '[]');
    expect(
      (await admitLinearWebhook(event(), config, runtime(), now)).status,
    ).toBe(403);
  });
});

describe('Linear deployment configuration', () => {
  it('is disabled by default and accepts an authorized complete configuration', () => {
    expect(linearConfig()).toEqual(config);
    vi.stubEnv('AGENT_LCARS_LINEAR', '');
    expect(linearConfig()).toBeUndefined();
  });
  it.each(['AGENT_LCARS_LINEAR_API_KEY', 'AGENT_LCARS_LINEAR_WEBHOOK_SECRET'])(
    'requires %s when enabled',
    (name) => {
      vi.stubEnv(name, '');
      expect(() => linearConfig()).toThrow(name);
    },
  );
  it('rejects duplicate routes, forbidden pipelines and repositories, and unbound grants', () => {
    for (const routes of [
      [...config.routes, ...config.routes],
      [{ ...config.routes[0], pipeline: 'claude' }],
      [{ ...config.routes[0], repo: 'foreign/repo' }],
      [{ ...config.routes[0], principal: 'user:unknown' }],
    ]) {
      vi.stubEnv(
        'AGENT_LCARS_LINEAR',
        JSON.stringify({ organizationId: org, routes }),
      );
      expect(() => linearConfig()).toThrow();
    }
  });
});
