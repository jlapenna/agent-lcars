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
