import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const CLI_PATH = path.join(__dirname, 'session-title-cli.ts');

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0))
    fs.rmSync(home, { recursive: true, force: true });
});

function tempHome(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-title-cli-'));
  homes.push(value);
  return value;
}

/** Base env for every run: real process.env (so PATH/tsx internals still
 * resolve) with all three session-id variables stripped -- this test
 * itself runs under an agent CLI, so the ambient environment likely
 * already carries a real `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`
 * that must never leak into a case this suite means to be "unset". */
function baseEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env['LCARS_SESSION_ID'];
  delete env['CLAUDE_CODE_SESSION_ID'];
  delete env['CODEX_THREAD_ID'];
  return env;
}

/** Spawns the real CLI entry point as a real child process via `tsx`
 * (same mechanism `daemon.memory.spec.ts` uses to exercise a `.ts` file
 * without a build step) with an explicit argv and env, so this suite
 * observes actual process behavior -- exit code, stderr text, and files
 * written on disk -- rather than only the dispatcher function in
 * isolation. Uses `spawnSync` rather than `execFileSync`: the latter only
 * returns captured output on a zero exit code, which would silently drop
 * stderr on every success-path assertion in this suite (e.g. `--help`). */
function runCli(args: readonly string[], env: NodeJS.ProcessEnv): CliRun {
  const result = spawnSync(
    process.execPath,
    [require.resolve('tsx/cli'), CLI_PATH, ...args],
    { encoding: 'utf8', env },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function declaredPath(home: string, sessionId: string): string {
  return path.join(
    home,
    '.local',
    'state',
    'agent-lcars',
    'session-metadata',
    `${sessionId}.json`,
  );
}

describe('session-title CLI end-to-end process behavior', () => {
  it('writes a declared annotation from CLAUDE_CODE_SESSION_ID and exits 0', () => {
    const home = tempHome();
    const run = runCli(['session', 'title', 'a real title'], {
      ...baseEnv(home),
      CLAUDE_CODE_SESSION_ID: 'claude-session-1',
    });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    const annotation = JSON.parse(
      fs.readFileSync(declaredPath(home, 'claude-session-1'), 'utf8'),
    );
    expect(annotation).toMatchObject({
      version: 1,
      sessionId: 'claude-session-1',
      title: 'a real title',
    });
  });

  it('writes a declared annotation from CODEX_THREAD_ID when the other two are absent', () => {
    const home = tempHome();
    const run = runCli(['session', 'title', 'codex title'], {
      ...baseEnv(home),
      CODEX_THREAD_ID: 'codex-session-1',
    });

    expect(run.status).toBe(0);
    expect(
      JSON.parse(
        fs.readFileSync(declaredPath(home, 'codex-session-1'), 'utf8'),
      ),
    ).toMatchObject({ sessionId: 'codex-session-1', title: 'codex title' });
  });

  it('LCARS_SESSION_ID outranks CLAUDE_CODE_SESSION_ID when both are present', () => {
    const home = tempHome();
    const run = runCli(['session', 'title', 'explicit override'], {
      ...baseEnv(home),
      LCARS_SESSION_ID: 'explicit-session',
      CLAUDE_CODE_SESSION_ID: 'claude-session-should-be-ignored',
    });

    expect(run.status).toBe(0);
    expect(fs.existsSync(declaredPath(home, 'explicit-session'))).toBe(true);
    expect(
      fs.existsSync(declaredPath(home, 'claude-session-should-be-ignored')),
    ).toBe(false);
  });

  it('--clear removes a previously written declared annotation and exits 0', () => {
    const home = tempHome();
    const env = {
      ...baseEnv(home),
      CLAUDE_CODE_SESSION_ID: 'claude-session-2',
    };
    expect(runCli(['session', 'title', 'to be cleared'], env).status).toBe(0);
    expect(fs.existsSync(declaredPath(home, 'claude-session-2'))).toBe(true);

    const clear = runCli(['session', 'title', '--clear'], env);
    expect(clear.status).toBe(0);
    expect(fs.existsSync(declaredPath(home, 'claude-session-2'))).toBe(false);
  });

  it('exits non-zero with the generic message and writes nothing when no session id is set', () => {
    const home = tempHome();
    const run = runCli(['session', 'title', 'orphan title'], baseEnv(home));

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('session title command failed');
    expect(run.stderr).not.toContain('orphan title');
    expect(fs.existsSync(path.join(home, '.local', 'state'))).toBe(false);
  });

  it('a present-but-unsafe id exits non-zero and does not fall through to the next variable', () => {
    const home = tempHome();
    const run = runCli(['session', 'title', 'must not be written'], {
      ...baseEnv(home),
      LCARS_SESSION_ID: '../escape',
      CLAUDE_CODE_SESSION_ID: 'a-perfectly-safe-fallback-id',
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('session title command failed');
    expect(
      fs.existsSync(declaredPath(home, 'a-perfectly-safe-fallback-id')),
    ).toBe(false);
    expect(fs.existsSync(path.join(home, '.local', 'state'))).toBe(false);
  });

  it('exits non-zero on unrecognized argv without disclosing filesystem details', () => {
    const home = tempHome();
    const run = runCli(['bogus', 'argv'], {
      ...baseEnv(home),
      CLAUDE_CODE_SESSION_ID: 'claude-session-3',
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('session title command failed');
    expect(run.stderr).not.toContain(home);
  });

  it('--help exits 0 and prints the terse usage surface without requiring a session id', () => {
    const home = tempHome();
    const run = runCli(['--help'], baseEnv(home));

    expect(run.status).toBe(0);
    expect(run.stderr.toLowerCase()).toContain('session title');
    expect(run.stderr.toLowerCase()).toContain('import-native');
  });

  it('session import-native exits 0 without a session id and with no Codex state DB present', () => {
    const home = tempHome();
    const run = runCli(['session', 'import-native'], baseEnv(home));

    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
  });
});

describe('session-title CLI build target wiring', () => {
  // Not a behavioral check (see the describe block above for that) -- this
  // only guards the Nx target metadata that decides what actually ships,
  // so a future edit can't accidentally point the build at `main.ts` or
  // rename the emitted bundle out from under `deploy/systemd/*.service`.
  it('builds this exact entry point to its own dedicated output', () => {
    interface ProjectConfig {
      targets: Record<string, { options?: Record<string, unknown> }>;
    }
    const workspaceRoot = path.resolve(__dirname, '../../..');
    const project = JSON.parse(
      fs.readFileSync(
        path.join(workspaceRoot, 'apps/telemetry-watcher/project.json'),
        'utf8',
      ),
    ) as ProjectConfig;
    const target = project.targets['session-title-cli'];
    expect(target?.options).toMatchObject({
      outputPath: 'dist/apps/telemetry-watcher-session-title-cli',
      outputFileName: 'lcars-session-title.cjs',
      main: 'apps/telemetry-watcher/src/session-title-cli.ts',
    });
    expect(target?.options?.main).not.toBe(
      'apps/telemetry-watcher/src/main.ts',
    );
  });
});
