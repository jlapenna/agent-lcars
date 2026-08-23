import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  executeSessionTitleAnnotationCommand,
  SESSION_TITLE_CLI_USAGE,
} from './session-title-annotation-command';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-title-'));
  homes.push(home);
  return home;
}

function declaredPath(home: string, sessionId: string): string {
  return path.join(
    home,
    '.local/state/agent-lcars/session-metadata',
    `${sessionId}.json`,
  );
}

function statusPath(home: string, sessionId: string): string {
  return path.join(
    home,
    '.local/state/agent-lcars/session-status',
    `${sessionId}.json`,
  );
}

describe('session annotation command', () => {
  it('writes a declared title using the highest-priority session id', () => {
    const home = tempHome();
    expect(
      executeSessionTitleAnnotationCommand(
        ['session', 'title', 'Current work'],
        {
          homeDirectory: home,
          env: {
            LCARS_SESSION_ID: 'explicit-session',
            CLAUDE_CODE_SESSION_ID: 'ignored-session',
          },
        },
      ),
    ).toEqual({ ok: true });

    expect(
      JSON.parse(
        fs.readFileSync(declaredPath(home, 'explicit-session'), 'utf8'),
      ),
    ).toMatchObject({
      sessionId: 'explicit-session',
      title: 'Current work',
    });
    expect(fs.existsSync(declaredPath(home, 'ignored-session'))).toBe(false);
  });

  it('keeps status independent from title and clears each channel', () => {
    const home = tempHome();
    const dependencies = {
      homeDirectory: home,
      env: { CODEX_THREAD_ID: 'codex-session' },
    };
    expect(
      executeSessionTitleAnnotationCommand(
        ['session', 'title', 'Named'],
        dependencies,
      ),
    ).toEqual({ ok: true });
    expect(
      executeSessionTitleAnnotationCommand(
        ['session', 'status', 'Testing'],
        dependencies,
      ),
    ).toEqual({ ok: true });
    expect(
      JSON.parse(fs.readFileSync(statusPath(home, 'codex-session'), 'utf8')),
    ).toMatchObject({ status: 'Testing' });

    expect(
      executeSessionTitleAnnotationCommand(
        ['session', 'status', '--clear'],
        dependencies,
      ),
    ).toEqual({ ok: true });
    expect(fs.existsSync(statusPath(home, 'codex-session'))).toBe(false);
    expect(fs.existsSync(declaredPath(home, 'codex-session'))).toBe(true);
    expect(
      executeSessionTitleAnnotationCommand(
        ['session', 'title', '--clear'],
        dependencies,
      ),
    ).toEqual({ ok: true });
    expect(fs.existsSync(declaredPath(home, 'codex-session'))).toBe(false);
  });

  it('rejects missing or unsafe session ids without creating state', () => {
    const home = tempHome();
    expect(
      executeSessionTitleAnnotationCommand(['session', 'title', 'No target'], {
        homeDirectory: home,
        env: {},
      }),
    ).toEqual({ ok: false, error: 'invalid-session' });
    expect(
      executeSessionTitleAnnotationCommand(['session', 'title', 'Unsafe'], {
        homeDirectory: home,
        env: {
          LCARS_SESSION_ID: '../escape',
          CODEX_THREAD_ID: 'safe-fallback',
        },
      }),
    ).toEqual({ ok: false, error: 'invalid-session' });
    expect(fs.existsSync(path.join(home, '.local/state'))).toBe(false);
  });

  it('keeps the small public grammar explicit', () => {
    expect(executeSessionTitleAnnotationCommand(['--help'])).toEqual({
      ok: true,
      usage: SESSION_TITLE_CLI_USAGE,
    });
    expect(
      executeSessionTitleAnnotationCommand(['session', 'unknown']),
    ).toEqual({
      ok: false,
      error: 'invalid-command',
      usage: SESSION_TITLE_CLI_USAGE,
    });
  });
});
