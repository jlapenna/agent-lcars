import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  isNewerHookWrite,
  parseSessionEventV1,
  type SessionEventV1,
  sessionWriteForEvent,
} from '@agent-lcars/telemetry';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  executeHookCommand,
  type HookCommandDependencies,
  opencodeSnapshotDirectory,
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

  it('carries authenticated GitHub actor through the real spool parser and session writer', async () => {
    const home = tempHome();
    const d = deps(home, payload('PostToolUse'), {
      resolveGithubActor: async () => 'jlapenna',
    });
    await executeHookCommand(['claude'], d);
    const parsed = parseSessionEventV1(spooledEvents(home)[0]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    const write = sessionWriteForEvent(
      parsed.event,
      undefined,
      '2026-10-10T12:00:00.000Z',
    );
    expect(write?.doc).toMatchObject({
      githubActor: 'jlapenna',
      branch: 'feat/hooks',
    });
    expect(write?.clearFields).not.toContain('githubActor');
  });

  it.each([undefined, 'failure'])(
    'leaves actor unknown when the authenticated read is unavailable: %s',
    async (failure) => {
      const home = tempHome();
      const d = deps(home, payload('PostToolUse'), {
        resolveGithubActor: async () => {
          if (failure) throw new Error('offline');
          return undefined;
        },
      });
      await executeHookCommand(['claude'], d);
      const parsed = parseSessionEventV1(spooledEvents(home)[0]);
      if (!parsed.ok) throw new Error(parsed.reason);
      const write = sessionWriteForEvent(
        parsed.event,
        undefined,
        '2026-10-10T12:00:00.000Z',
      );
      expect(write?.doc).not.toHaveProperty('githubActor');
      expect(write?.clearFields).toContain('githubActor');
    },
  );

  it('does not qualify a transcript branch when live git resolution fails', async () => {
    const home = tempHome();
    const resolveGithubActor = vi.fn(async () => 'jlapenna');
    const d = deps(home, payload('PostToolUse'), {
      resolveGitBranch: async () => undefined,
      resolveGithubActor,
    });
    await executeHookCommand(['claude'], d);
    expect(spooledEvents(home)[0].summary).not.toHaveProperty('branch');
    expect(spooledEvents(home)[0].summary).not.toHaveProperty('githubActor');
    expect(resolveGithubActor).not.toHaveBeenCalled();
  });

  it('resolves the repository against the allowlist so it is stored canonically', async () => {
    const home = tempHome();
    const resolveGitRepo = vi.fn(async () => ({
      owner: 'jlapenna',
      name: 'agent-lcars',
    }));
    const d = deps(home, payload('PostToolUse'), { resolveGitRepo });
    expect((await executeHookCommand(['claude'], d)).action).toBe('spooled');
    expect(resolveGitRepo).toHaveBeenCalledWith('/home/dev/project', [
      'jlapenna/*',
    ]);
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
      fs.readFileSync(path.join(home, STATE_DIR, 'hook.log'), 'utf8'),
    ).toContain(
      'skipped-subagent parent=session- child=sub-1 event=PostToolUse',
    );
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

describe('lcars hook opencode', () => {
  const OPENCODE_FIXTURE = path.join(
    __dirname,
    '../../../../../libs/telemetry/src/lib/fixtures/opencode-export.json',
  );
  const OPENCODE_SESSION = 'ses_opencode_1';

  function opencodePayload(
    hookEventName: string,
    overrides: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      hook_event_name: hookEventName,
      session_id: OPENCODE_SESSION,
      transcript_path: OPENCODE_FIXTURE,
      cwd: '/home/runner/_work/agent-lcars/agent-lcars',
      ...overrides,
    });
  }

  it('reduces the plugin snapshot with the opencode adapter', async () => {
    const home = tempHome();
    const d = deps(home, opencodePayload('Stop'));
    expect((await executeHookCommand(['opencode'], d)).action).toBe('spooled');
    const [event] = spooledEvents(home);
    expect(event).toMatchObject({
      agent: 'opencode',
      sessionId: OPENCODE_SESSION,
      kind: 'stop',
      runtime: { name: 'opencode', hookEvent: 'Stop' },
    });
    expect(event.summary).toMatchObject({
      agent: 'opencode',
      sessionId: OPENCODE_SESSION,
      host: 'laforge',
    });
    expect(event.summary?.turns).toBeGreaterThan(0);
  });

  it('deletes the plugin snapshot after reading it, whatever the outcome', async () => {
    for (const cwd of ['/home/runner/_work/agent-lcars/agent-lcars', '']) {
      const home = tempHome();
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-opencode-'));
      const snapshot = path.join(scratch, 'export.json');
      fs.copyFileSync(OPENCODE_FIXTURE, snapshot);
      const d = deps(
        home,
        opencodePayload('Stop', { transcript_path: snapshot, cwd }),
        // An unlisted repo exits before the transcript is read.
        cwd ? {} : { resolveGitRepo: async () => undefined },
      );
      const result = await executeHookCommand(['opencode'], d);
      expect(result.action).toBe(cwd ? 'spooled' : 'skipped-unlisted');
      expect(fs.existsSync(scratch)).toBe(false);
    }
  });

  it('only ever treats the plugin snapshot shape as deletable', () => {
    const root = '/tmp';
    const payload = (transcript: unknown) =>
      JSON.stringify({ transcript_path: transcript });
    expect(
      opencodeSnapshotDirectory(
        payload('/tmp/lcars-opencode-AbC123/export.json'),
        root,
      ),
    ).toBe('/tmp/lcars-opencode-AbC123');
    for (const unsafe of [
      '/tmp/lcars-opencode-AbC123/other.json',
      '/tmp/lcars-opencode-AbC123/../../etc/export.json',
      '/var/lcars-opencode-AbC123/export.json',
      '/tmp/nested/lcars-opencode-AbC123/export.json',
      '/tmp/lcars-opencode-/export.json',
      42,
    ]) {
      expect(opencodeSnapshotDirectory(payload(unsafe), root)).toBeUndefined();
    }
    expect(opencodeSnapshotDirectory('not json', root)).toBeUndefined();
  });

  it('skips child sessions the plugin reports with a parent id', async () => {
    const home = tempHome();
    const d = deps(home, opencodePayload('Stop', { agent_id: 'ses_parent' }));
    expect((await executeHookCommand(['opencode'], d)).action).not.toBe(
      'spooled',
    );
    expect(spooledEvents(home)).toEqual([]);
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

describe('Codex child publication ownership (#2669)', () => {
  const childId = '01a13376-2c94-7bc3-a67a-53d940003daa';
  const parentId = '01a11f2d-166d-7651-9a36-7bc92635eceb';
  const childFixture = path.join(
    __dirname,
    'fixtures/codex-child-publication.jsonl',
  );
  type Row = {
    type: string;
    timestamp: string;
    payload: Record<string, unknown>;
  };
  const rows = (): Row[] =>
    fs
      .readFileSync(childFixture, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Row);
  function childDeps(
    home: string,
    input = rows(),
    event = 'PostToolUse',
    overrides: Record<string, unknown> = {},
  ) {
    const transcript = path.join(home, 'child.jsonl');
    const parentTranscript = path.join(home, 'parent.jsonl');
    fs.writeFileSync(
      transcript,
      input.map((row) => JSON.stringify(row)).join('\n'),
    );
    fs.writeFileSync(
      parentTranscript,
      JSON.stringify({ type: 'session_meta', payload: { id: parentId } }),
    );
    return deps(
      home,
      payload(event, {
        session_id: parentId,
        agent_id: childId,
        transcript_path: parentTranscript,
        ...(event === 'SubagentStop' && { agent_transcript_path: transcript }),
        ...overrides,
      }),
      {
        findCodexRollout: (_codexHome, sessionId) =>
          sessionId === childId ? transcript : undefined,
      },
    );
  }

  it('retains the real delayed child publication once with only child thread usage', async () => {
    const home = tempHome();
    const input = rows();
    input.splice(
      2,
      0,
      {
        type: 'event_msg',
        timestamp: input[0].timestamp,
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 900000,
              cached_input_tokens: 0,
              output_tokens: 800000,
            },
          },
        },
      },
      {
        type: 'response_item',
        timestamp: input[0].timestamp,
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'inherited-create',
          arguments: JSON.stringify({ cmd: 'gh pr create' }),
        },
      },
      {
        type: 'response_item',
        timestamp: input[0].timestamp,
        payload: {
          type: 'function_call_output',
          call_id: 'inherited-create',
          output: 'https://github.com/jlapenna/agent-lcars/pull/2282',
        },
      },
    );
    // Legacy counters in the suffix are not evidence of child-owned usage.
    input.push({
      type: 'event_msg',
      timestamp: input.at(-1)!.timestamp,
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 9000000,
            cached_input_tokens: 0,
            output_tokens: 8000000,
          },
        },
      },
    });
    const d = childDeps(home, input);
    expect((await executeHookCommand(['codex'], d)).action).toBe('spooled');
    const [event] = spooledEvents(home);
    expect(event.sessionId).toBe(childId);
    expect(event.summary?.sessionId).toBe(childId);
    expect(event.summary?.tokens).toEqual({
      inputTokens: 1087,
      outputTokens: 46,
      cacheCreationTokens: 0,
      cacheReadTokens: 62208,
    });
    expect(event.summary?.deliverables.qualifiedPRs).toEqual([
      { repo: { owner: 'jlapenna', name: 'agent-lcars' }, number: 2666 },
    ]);
    expect(event.summary?.deliverables.prNumbers).not.toContain(2282);
    expect(event.summary?.totalCostUsd).toBeUndefined();
    expect(
      readHookSessionState(path.join(home, STATE_DIR), parentId),
    ).toBeUndefined();
    const write = sessionWriteForEvent(event, undefined, event.occurredAt);
    expect(write?.doc.sessionId).toBe(childId);
    expect(write?.doc.tokens).toEqual(event.summary?.tokens);
    expect(write?.doc.deliverables.qualifiedPRs).toEqual(
      event.summary?.deliverables.qualifiedPRs,
    );
    expect(isNewerHookWrite(write?.doc.observer, write?.doc.observer)).toBe(
      false,
    );
    await executeHookCommand(['codex'], d);
    const latest = spooledEvents(home).at(-1)!;
    const replacement = sessionWriteForEvent(
      latest,
      write?.doc,
      latest.occurredAt,
    );
    expect(replacement?.doc.deliverables.qualifiedPRs).toHaveLength(1);
    expect(replacement?.doc.tokens).toEqual(write?.doc.tokens);
  });

  it('collects the documented parent-session SubagentStop from its exact child transcript', async () => {
    const home = tempHome();
    const d = childDeps(home, rows(), 'SubagentStop');
    d.findCodexRollout = vi.fn(() => undefined);
    expect((await executeHookCommand(['codex'], d)).action).toBe('spooled');
    expect(spooledEvents(home)[0]).toMatchObject({
      sessionId: childId,
      kind: 'stop',
    });
    expect(d.findCodexRollout).not.toHaveBeenCalled();
    expect(
      readHookSessionState(path.join(home, STATE_DIR), parentId),
    ).toBeUndefined();
  });

  it.each([
    'wrong parent',
    'unsafe child',
    'same child and parent',
    'parent transcript',
    'missing child lookup',
  ])('refuses documented child payload with %s', async (defect) => {
    const home = tempHome();
    const overrides: Record<string, unknown> = {};
    if (defect === 'wrong parent') overrides.session_id = 'another-parent';
    if (defect === 'unsafe child') overrides.agent_id = '../child';
    if (defect === 'same child and parent') overrides.agent_id = parentId;
    if (defect === 'parent transcript')
      overrides.agent_transcript_path = path.join(home, 'parent.jsonl');
    const d = childDeps(home, rows(), 'SubagentStop', overrides);
    if (defect === 'missing child lookup') {
      d.readStdin = () =>
        payload('PostToolUse', {
          session_id: parentId,
          agent_id: childId,
          transcript_path: path.join(home, 'parent.jsonl'),
        });
      d.findCodexRollout = () => undefined;
    }
    expect((await executeHookCommand(['codex'], d)).action).toBe(
      'skipped-subagent',
    );
    expect(spooledEvents(home)).toEqual([]);
    expect(
      readHookSessionState(path.join(home, STATE_DIR), parentId),
    ).toBeUndefined();
  });

  it.each([
    'mismatched child',
    'same parent',
    'mismatched fork',
    'missing boundary',
    'foreign boundary',
    'missing usage',
    'foreign usage',
    'invalid usage',
    'foreign metadata',
  ])('does not create a child record with %s', async (defect) => {
    const input = rows();
    if (defect === 'mismatched child') input[0].payload.id = parentId;
    if (defect === 'same parent')
      input[0].payload.source = {
        subagent: { thread_spawn: { parent_thread_id: childId } },
      };
    if (defect === 'mismatched fork')
      input[0].payload.forked_from_id = 'another-parent';
    if (defect === 'missing boundary') input.splice(2, 1);
    if (defect === 'foreign boundary') input[2].payload.thread_id = parentId;
    if (defect === 'missing usage') input.splice(3, 1);
    if (defect === 'foreign usage') input[3].payload.thread_id = parentId;
    if (defect === 'invalid usage')
      input[3].payload.thread_token_usage = {
        input_tokens: 1,
        output_tokens: 2,
        cached_input_tokens: 3,
      };
    if (defect === 'foreign metadata')
      input.push({
        type: 'session_meta',
        timestamp: input.at(-1)!.timestamp,
        payload: { id: parentId },
      });
    const home = tempHome();
    const d = childDeps(home, input);
    expect((await executeHookCommand(['codex'], d)).action).toBe(
      'skipped-subagent',
    );
    expect(spooledEvents(home)).toEqual([]);
    expect(
      readHookSessionState(path.join(home, STATE_DIR), childId),
    ).toBeUndefined();
    expect(d.spawnFlusher).not.toHaveBeenCalled();
  });

  it.each(['failed', 'edit', 'replayed poll'])(
    'keeps the unchanged publication guard for %s child output',
    async (outcome) => {
      const input = rows();
      if (outcome === 'failed') {
        const output = input[7].payload.output as {
          type: string;
          text: string;
        }[];
        for (const block of output)
          block.text = block.text.replace('"exit_code":0', '"exit_code":1');
      }
      if (outcome === 'edit')
        input[4].payload.input = (input[4].payload.input as string).replace(
          'gh pr create',
          'gh pr edit',
        );
      if (outcome === 'replayed poll') {
        input.splice(6, 0, { ...input[6], payload: { ...input[6].payload } });
      }
      const home = tempHome();
      await executeHookCommand(['codex'], childDeps(home, input));
      expect(
        spooledEvents(home)[0].summary?.deliverables.qualifiedPRs,
      ).toBeUndefined();
      expect(spooledEvents(home)[0].summary?.tokens.outputTokens).toBe(46);
    },
  );
});
