import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isProcessAliveForCwd } from './process-check';

describe('isProcessAliveForCwd', () => {
  let procRoot: string;

  beforeEach(() => {
    procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-proc-'));
  });

  afterEach(() => {
    fs.rmSync(procRoot, { recursive: true, force: true });
  });

  function fakeProcess(pid: number, cwd: string) {
    const pidDir = path.join(procRoot, String(pid));
    fs.mkdirSync(pidDir);
    fs.symlinkSync(cwd, path.join(pidDir, 'cwd'));
  }

  function fakeIdentifiedProcess(
    pid: number,
    cwd: string,
    cmdline: string[],
    startTicks: number,
  ) {
    fakeProcess(pid, cwd);
    const pidDir = path.join(procRoot, String(pid));
    fs.writeFileSync(path.join(pidDir, 'cmdline'), `${cmdline.join('\0')}\0`);
    const fields = Array.from({ length: 20 }, () => '0');
    fields[18] = String(startTicks);
    fs.writeFileSync(path.join(pidDir, 'stat'), `${pid} (codex) S ${fields.join(' ')}`);
    fs.writeFileSync(path.join(procRoot, 'stat'), 'btime 1000\n');
  }

  it('is true when a process has a matching cwd', () => {
    fakeProcess(123, '/home/jlapenna/p/members');
    fakeProcess(456, '/tmp/unrelated');

    expect(isProcessAliveForCwd('/home/jlapenna/p/members', procRoot)).toBe(
      true,
    );
  });

  it('is false when no process matches', () => {
    fakeProcess(456, '/tmp/unrelated');

    expect(isProcessAliveForCwd('/home/jlapenna/p/members', procRoot)).toBe(
      false,
    );
  });

  it('matches a repository-root process for a nested transcript cwd', () => {
    fakeProcess(123, '/home/jlapenna/p/members');

    expect(
      isProcessAliveForCwd(
        '/home/jlapenna/p/members/.agents/skills',
        procRoot,
      ),
    ).toBe(true);
  });

  it('does not let a process at filesystem root match every cwd', () => {
    fakeProcess(123, '/');

    expect(isProcessAliveForCwd('/home/jlapenna/p/members', procRoot)).toBe(
      false,
    );
  });

  it('matches a resumed process by session id without matching sibling sessions', () => {
    fakeIdentifiedProcess(
      123,
      '/home/jlapenna/p/members',
      ['codex', 'resume', 'current-session'],
      500,
    );

    expect(
      isProcessAliveForCwd(
        '/home/jlapenna/p/members',
        procRoot,
        'current-session',
        '1970-01-01T00:00:00.000Z',
      ),
    ).toBe(true);
    expect(
      isProcessAliveForCwd(
        '/home/jlapenna/p/members',
        procRoot,
        'historical-session',
        '1970-01-01T00:00:00.000Z',
      ),
    ).toBe(false);
  });

  it('matches a new process by transcript and process start time', () => {
    fakeIdentifiedProcess(
      123,
      '/home/jlapenna/p/members',
      ['claude', '--dangerously-skip-permissions'],
      500,
    );

    expect(
      isProcessAliveForCwd(
        '/home/jlapenna/p/members/.agents/skills',
        procRoot,
        'new-session',
        '1970-01-01T00:16:45.000Z',
      ),
    ).toBe(true);
  });

  it('ignores non-numeric entries and broken symlinks without throwing', () => {
    fs.mkdirSync(path.join(procRoot, 'self'));
    const pidDir = path.join(procRoot, '789');
    fs.mkdirSync(pidDir);
    fs.symlinkSync('/does/not/exist/but/is/fine', path.join(pidDir, 'gone'));

    expect(isProcessAliveForCwd('/home/jlapenna/p/members', procRoot)).toBe(
      false,
    );
  });

  it('fails soft when the proc root does not exist', () => {
    expect(
      isProcessAliveForCwd('/home/jlapenna/p/members', '/no/such/proc'),
    ).toBe(false);
  });
});
