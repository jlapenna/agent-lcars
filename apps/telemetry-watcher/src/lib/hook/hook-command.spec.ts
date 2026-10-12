import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { type SessionEventV1 } from '@agent-lcars/telemetry';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  executeHookCommand,
  type HookCommandDependencies,
} from './hook-command';
import { readHookSessionState } from './hook-state';
import { spoolPath } from './spool';

const FIXTURE = path.join(
  __dirname,
  '../../../../../libs/telemetry/src/lib/fixtures/normal-session.jsonl',
);
const SESSION_ID = 'session-normal-1';
const STATE_DIR = '.local/state/agent-lcars';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-hook-'));
  homes.push(home);
  fs.mkdirSync(path.join(home, '.config/agent-lcars'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config/agent-lcars/config.json'),
    JSON.stringify({ repos: ['jlapenna/*'] }),
  );
  return home;
}

function payload(
  hookEventName: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    hook_event_name: hookEventName,
    session_id: SESSION_ID,
    transcript_path: FIXTURE,
    cwd: '/home/dev/project',
    permission_mode: 'bypassPermissions',
    prompt: 'never read',
    ...overrides,
  });
}

function deps(
  home: string,
  stdin: string,
  overrides: Partial<HookCommandDependencies> = {},
): HookCommandDependencies {
  return {
    env: {},
    homeDirectory: home,
    now: () => new Date('2026-10-10T12:00:00.000Z'),
    readStdin: () => stdin,
    readTranscriptLines: (filePath) =>
      fs.readFileSync(filePath, 'utf8').split('\n'),
    fileExists: (filePath) => fs.existsSync(filePath),
    findCodexRollout: () => undefined,
    resolveGitRepo: async () => ({ owner: 'jlapenna', name: 'agent-lcars' }),
    resolveGitBranch: async () => 'feat/hooks',
    runFlusher: vi.fn(async () => undefined),
    spawnFlusher: vi.fn(),
    randomId: () => 'evt-fixed',
    hostname: () => 'laforge.lan',
    stderr: vi.fn(),
    ...overrides,
  };
}

function spooledEvents(home: string): SessionEventV1[] {
  const file = spoolPath(path.join(home, STATE_DIR));
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEventV1);
}

describe('lcars hook claude', () => {
  it('reduces the transcript, enriches it, and spools a summary-only event', async () => {
    const home = tempHome();
    const d = deps(home, payload('PostToolUse'));
    const result = await executeHookCommand(['claude'], d);
    expect(result.action).toBe('spooled');
    expect(d.spawnFlusher).toHaveBeenCalledOnce();
    const [event] = spooledEvents(home);
    expect(event).toMatchObject({
      version: 1,
      seq: 1,
      host: 'laforge',
      agent: 'claude-code',
      sessionId: SESSION_ID,
      kind: 'tool',
      runtime: { name: 'claude-code', hookEvent: 'PostToolUse' },
    });
    expect(event.summary).toMatchObject({
      turns: 3,
      toolCallCounts: { Bash: 2, Edit: 1 },
      branch: 'feat/hooks',
      repo: { owner: 'jlapenna', name: 'agent-lcars' },
      host: 'laforge',
      deliverables: { prNumbers: [42] },
    });
    expect(JSON.stringify(event)).not.toContain('never read');
    expect(JSON.stringify(event)).not.toContain('flaky login test and open');
    expect(
      readHookSessionState(path.join(home, STATE_DIR), SESSION_ID),
    ).toMatchObject({
      seq: 1,
      lastKind: 'tool',
    });
  });

  it('skips sessions whose repository is not allowlisted, without touching state', async () => {
    const home = tempHome();
    const d = deps(home, payload('PostToolUse'), {
      resolveGitRepo: async () => ({ owner: 'someone', name: 'private' }),
    });
    expect((await executeHookCommand(['claude'], d)).action).toBe(
      'skipped-unlisted',
    );
    expect(spooledEvents(home)).toEqual([]);
    expect(fs.existsSync(path.join(home, STATE_DIR, 'hook-sessions'))).toBe(
      false,
    );
    expect(d.spawnFlusher).not.toHaveBeenCalled();
  });

  it('skips subagent payloads and unknown events', async () => {
    const home = tempHome();
    expect(
      (
        await executeHookCommand(
          ['claude'],
          deps(home, payload('PostToolUse', { agent_id: 'sub-1' })),
        )
      ).action,
    ).toBe('skipped-subagent');
    expect(
      (await executeHookCommand(['claude'], deps(home, payload('PreCompact'))))
        .action,
    ).toBe('ignored');
    expect(
      (await executeHookCommand(['claude'], deps(home, 'not json'))).action,
    ).toBe('ignored');
    expect(spooledEvents(home)).toEqual([]);
  });

  it('throttles tool events but always ships lifecycle events, with increasing seq', async () => {
    const home = tempHome();
    await executeHookCommand(['claude'], deps(home, payload('PostToolUse')));
    expect(
      (await executeHookCommand(['claude'], deps(home, payload('PostToolUse'))))
        .action,
    ).toBe('throttled');
    expect(
      (await executeHookCommand(['claude'], deps(home, payload('Stop'))))
        .action,
    ).toBe('spooled');
    const later = deps(home, payload('PostToolUse'), {
      now: () => new Date('2026-10-10T12:00:20.000Z'),
    });
    expect((await executeHookCommand(['claude'], later)).action).toBe(
      'spooled',
    );
    expect(spooledEvents(home).map((e) => [e.kind, e.seq])).toEqual([
      ['tool', 1],
      ['stop', 2],
      ['tool', 3],
    ]);
  });

  it('ships a start event with a zero summary when the transcript does not exist yet', async () => {
    const home = tempHome();
    const d = deps(
      home,
      payload('SessionStart', {
        transcript_path: '/nope.jsonl',
        source: 'startup',
      }),
    );
    expect((await executeHookCommand(['claude'], d)).action).toBe('spooled');
    const [event] = spooledEvents(home);
    expect(event.kind).toBe('start');
    expect(event.summary).toMatchObject({
      turns: 0,
      cwd: '/home/dev/project',
      host: 'laforge',
    });
  });

  it('ships an end event without a summary when the transcript is gone', async () => {
    const home = tempHome();
    const d = deps(
      home,
      payload('SessionEnd', {
        transcript_path: '/nope.jsonl',
        reason: 'other',
      }),
    );
    expect((await executeHookCommand(['claude'], d)).action).toBe('spooled');
    const [event] = spooledEvents(home);
    expect(event.kind).toBe('end');
    expect(event.summary).toBeUndefined();
  });

  it('joins declared title and status overlays', async () => {
    const home = tempHome();
    const stateDir = path.join(home, STATE_DIR);
    fs.mkdirSync(path.join(stateDir, 'session-metadata'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'session-status'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'session-metadata', `${SESSION_ID}.json`),
      JSON.stringify({
        version: 1,
        sessionId: SESSION_ID,
        updatedAt: '2026-10-10T11:00:00.000Z',
        title: 'Declared title',
      }),
    );
    fs.writeFileSync(
      path.join(stateDir, 'session-status', `${SESSION_ID}.json`),
      JSON.stringify({
        version: 1,
        sessionId: SESSION_ID,
        updatedAt: '2026-10-10T11:30:00.000Z',
        status: 'waiting on CI',
      }),
    );
    await executeHookCommand(['claude'], deps(home, payload('Stop')));
    const [event] = spooledEvents(home);
    expect(event.summary).toMatchObject({
      title: 'Declared title',
      status: 'waiting on CI',
      statusUpdatedAt: '2026-10-10T11:30:00.000Z',
    });
  });

  it('records nothing once the runner has fenced hooks before finalize', async () => {
    const home = tempHome();
    const stateDir = path.join(home, STATE_DIR);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'hook-fence'), '');
    const d = deps(home, payload('Stop'));
    expect(await executeHookCommand(['claude'], d)).toEqual({
      action: 'ignored',
      detail: 'fenced',
    });
    expect(spooledEvents(home)).toEqual([]);
    expect(d.spawnFlusher).not.toHaveBeenCalled();
  });

  it('bypasses the allowlist and attaches runner context on a QueueExecutor runner', async () => {
    const home = tempHome();
    const d = deps(home, payload('PostToolUse'), {
      env: {
        LCARS_RUN_ID: 'run-9',
        INTENT_ID: 'intent-9',
        NUM: '77',
        LCARS_REPO: 'supersprinklesracing/www',
      },
      resolveGitRepo: async () => undefined,
    });
    expect((await executeHookCommand(['claude'], d)).action).toBe('spooled');
    expect(spooledEvents(home)[0].runner).toEqual({
      runId: 'run-9',
      intentId: 'intent-9',
      issueNumber: 77,
      repo: { owner: 'supersprinklesracing', name: 'www' },
    });
  });

  it('--inline runs the flusher in the foreground instead of spawning it', async () => {
    const home = tempHome();
    const d = deps(home, payload('Stop'));
    expect((await executeHookCommand(['claude', '--inline'], d)).action).toBe(
      'spooled',
    );
    expect(d.spawnFlusher).not.toHaveBeenCalled();
    expect(d.runFlusher).toHaveBeenCalledOnce();
    expect(spooledEvents(home).map((e) => e.kind)).toEqual(['stop']);
  });
});

describe('lcars hook codex', () => {
  const CODEX_FIXTURE = path.join(
    __dirname,
    '../../../../../libs/telemetry/src/lib/fixtures/codex-session.jsonl',
  );
  const CODEX_SESSION = 'codex-session-1';

  function codexPayload(
    hookEventName: string,
    overrides: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      hook_event_name: hookEventName,
      session_id: CODEX_SESSION,
      transcript_path: CODEX_FIXTURE,
      cwd: '/home/developer/p/members',
      model: 'gpt-6.1-sol',
      turn_id: 'turn-1',
      ...overrides,
    });
  }

  it('reduces a Codex rollout with the codex adapter', async () => {
    const home = tempHome();
    const d = deps(home, codexPayload('Stop'));
    expect((await executeHookCommand(['codex'], d)).action).toBe('spooled');
    const [event] = spooledEvents(home);
    expect(event).toMatchObject({
      agent: 'codex',
      kind: 'stop',
      runtime: { name: 'codex', hookEvent: 'Stop' },
    });
    expect(event.summary).toMatchObject({
      agent: 'codex',
      sessionId: CODEX_SESSION,
      host: 'laforge',
    });
    expect(event.summary?.turns).toBeGreaterThan(0);
  });

  it('falls back to locating the rollout when the payload has no transcript path', async () => {
    const home = tempHome();
    const d = deps(
      home,
      codexPayload('PostToolUse', { transcript_path: null }),
      {
        findCodexRollout: (codexHome, sessionId) =>
          codexHome === path.join(home, '.codex') && sessionId === CODEX_SESSION
            ? CODEX_FIXTURE
            : undefined,
      },
    );
    expect((await executeHookCommand(['codex'], d)).action).toBe('spooled');
    expect(spooledEvents(home)[0].summary?.turns).toBeGreaterThan(0);
  });

  it('treats Interrupt as a stop and carries the payload model when nothing else has one', async () => {
    const home = tempHome();
    const d = deps(
      home,
      codexPayload('Interrupt', { transcript_path: '/nope.jsonl' }),
    );
    expect((await executeHookCommand(['codex'], d)).action).toBe('spooled');
    const [event] = spooledEvents(home);
    expect(event.kind).toBe('stop');
    expect(event.summary).toMatchObject({
      turns: 0,
      model: 'gpt-6.1-sol',
      agent: 'codex',
    });
  });
});

describe('lcars hook flush', () => {
  it('runs the flusher bundle for the flush subcommand', async () => {
    const home = tempHome();
    const d = deps(home, '');
    expect((await executeHookCommand(['flush'], d)).action).toBe('flushed');
    expect(d.runFlusher).toHaveBeenCalledOnce();
  });

  it('prints usage for anything else, to stderr only', async () => {
    const home = tempHome();
    const d = deps(home, '');
    expect((await executeHookCommand(['bogus'], d)).action).toBe('usage');
    expect(d.stderr).toHaveBeenCalledOnce();
  });
});
