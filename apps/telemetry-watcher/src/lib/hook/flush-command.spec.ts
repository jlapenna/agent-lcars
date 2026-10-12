import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { type SessionEventV1 } from '@agent-lcars/telemetry';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type FlushDependencies, runFlush } from './flush-command';
import { readHookSessionState } from './hook-state';
import { type HookEventWriter } from './hook-store';
import { appendToSpool, spoolPath } from './spool';

const STATE_DIR = '.local/state/agent-lcars';
const FAKE_KEY = JSON.stringify({
  project_id: 'agent-lcars',
  client_email: 'telemetry-writer@agent-lcars.iam.gserviceaccount.com',
  private_key: 'not-a-real-key',
});
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    fs.rmSync(home, { recursive: true, force: true });
});

function homeWithEvents(sessionIds: string[]): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-flush-'));
  homes.push(home);
  const file = spoolPath(path.join(home, STATE_DIR));
  sessionIds.forEach((sessionId, i) =>
    appendToSpool(file, { version: 1, sessionId, seq: i + 1, kind: 'tool' }),
  );
  return home;
}

function deps(
  home: string,
  writer: HookEventWriter,
  env: NodeJS.ProcessEnv = { AGENT_TELEMETRY_WRITER_KEY_JSON: FAKE_KEY },
): FlushDependencies {
  return {
    env,
    homeDirectory: home,
    now: () => new Date('2026-10-12T12:00:00.000Z'),
    hostname: () => 'laptop',
    createWriter: vi.fn(async () => writer),
  };
}

const remaining = (home: string) =>
  ['events.pending.ndjson', 'events.ndjson']
    .map((name) => path.join(home, STATE_DIR, 'spool', name))
    .filter((file) => fs.existsSync(file))
    .flatMap((file) =>
      fs.readFileSync(file, 'utf8').split('\n').filter(Boolean),
    ).length;

describe('runFlush', () => {
  it('writes every event with the configured key and records delivery', async () => {
    const home = homeWithEvents(['s1', 's2']);
    const applied: string[] = [];
    const d = deps(home, {
      apply: vi.fn(async (event: SessionEventV1) => {
        applied.push(event.sessionId);
        return 'applied' as const;
      }),
    });
    expect(await runFlush(d)).toEqual({
      action: 'flushed',
      detail: 'sent=2 dropped=0 remaining=0',
    });
    expect(d.createWriter).toHaveBeenCalledWith({
      projectId: 'agent-lcars',
      credentials: {
        client_email: 'telemetry-writer@agent-lcars.iam.gserviceaccount.com',
        private_key: 'not-a-real-key',
      },
    });
    expect(applied).toEqual(['s1', 's2']);
    expect(
      readHookSessionState(path.join(home, STATE_DIR), 's1'),
    ).toMatchObject({
      lastDeliveredAt: '2026-10-12T12:00:00.000Z',
    });
  });

  it('keeps events when the store is unreachable and drops ones it cannot apply', async () => {
    const home = homeWithEvents(['s1', 's2']);
    const failing = deps(home, {
      apply: vi.fn(async () => {
        throw new Error('UNAVAILABLE');
      }),
    });
    expect(await runFlush(failing)).toMatchObject({
      detail: 'sent=0 dropped=0 remaining=2',
    });
    const outcomes = ['invalid', 'stale'] as const;
    let call = 0;
    const mixed = deps(home, { apply: vi.fn(async () => outcomes[call++]) });
    expect(await runFlush(mixed)).toMatchObject({
      detail: 'sent=1 dropped=1 remaining=0',
    });
    expect(
      fs.readFileSync(path.join(home, STATE_DIR, 'hook.log'), 'utf8'),
    ).toContain('flush drop invalid session=s1');
  });

  it('uses the runner credentials file named by LCARS_TELEMETRY_CREDENTIALS_FILE', async () => {
    const home = homeWithEvents(['s1']);
    const d = deps(
      home,
      { apply: vi.fn(async () => 'applied' as const) },
      {
        LCARS_RUN_ID: 'run-1',
        LCARS_REPO: 'jlapenna/agent-lcars',
        LCARS_TELEMETRY_CREDENTIALS_FILE: '/run/secrets/telemetry-writer.json',
      },
    );
    await runFlush(d);
    expect(d.createWriter).toHaveBeenCalledWith({
      projectId: 'agent-lcars',
      credentialsFile: '/run/secrets/telemetry-writer.json',
    });
  });

  it('leaves the spool alone without writer credentials', async () => {
    const home = homeWithEvents(['s1']);
    const d = deps(home, { apply: vi.fn() }, {});
    expect((await runFlush(d)).action).toBe('flush-no-credentials');
    expect(d.createWriter).not.toHaveBeenCalled();
    expect(remaining(home)).toBe(1);
  });
});
