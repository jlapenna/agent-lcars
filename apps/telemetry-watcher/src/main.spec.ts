import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

// This exercises the real CLI entrypoint end to end (fake network via a
// stubbed fetch is not available for a spawned process, so this test
// instead stubs the module-level Storage client the way
// transcript-upload.spec.ts does, by running the *function* main.ts wires
// up rather than spawning node -- see runRunnerResume, exported for
// testing below). Importing `./main` is itself only safe because main.ts
// guards its bottom-level `main()` call behind an entrypoint check (see
// that file's comment) -- without it, importing this module under vitest
// falls through to `runHostWatcher()` and throws (no
// `AGENT_TELEMETRY_CHECKOUT_ROOTS` in the test env), observed directly
// while building this spec.
import { _runRunnerResumeForTesting } from './main';

describe('runner resume subcommand', () => {
  it('writes the transcript to the computed local session path and prints it', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-resume-'));
    const projectsDir = path.join(tmp, 'projects');
    const printed = await _runRunnerResumeForTesting(
      [
        '--session-id',
        'sess_1',
        '--transcript-uri',
        'gs://bucket/runs/x/claude-code/sess_1.jsonl',
        '--cwd',
        '/home/runner/work/repo/repo',
        '--projects-dir',
        projectsDir,
      ],
      { download: async () => '{"line":1}\n' },
    );
    const expected = path.join(
      projectsDir,
      '-home-runner-work-repo-repo',
      'sess_1.jsonl',
    );
    expect(printed).toBe(expected);
    expect(fs.readFileSync(expected, 'utf8')).toBe('{"line":1}\n');
  });

  // Every character Claude Code's own encoding treats as non-alphanumeric
  // (a `.` here, alongside the `/`s) must collapse to `-`, matching
  // `claudeProjectSlugFor`'s `absoluteCwd.replace(/[^a-zA-Z0-9]/g, '-')`
  // exactly -- this is the whole point of resume: naming the directory a
  // real `claude --resume` will actually look in.
  it('computes the written path for a cwd containing dots', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-resume-'));
    const projectsDir = path.join(tmp, 'projects');
    const printed = await _runRunnerResumeForTesting(
      [
        '--session-id',
        'sess_1',
        '--transcript-uri',
        'gs://bucket/runs/x/claude-code/sess_1.jsonl',
        '--cwd',
        '/home/runner/work/repo.checkout/repo.checkout',
        '--projects-dir',
        projectsDir,
      ],
      { download: async () => '{"line":1}\n' },
    );
    const expected = path.join(
      projectsDir,
      '-home-runner-work-repo-checkout-repo-checkout',
      'sess_1.jsonl',
    );
    expect(printed).toBe(expected);
  });

  it('threads --project-id through to downloadTranscript', async () => {
    const download = vi.fn().mockResolvedValue('{}\n');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-resume-'));
    await _runRunnerResumeForTesting(
      [
        '--session-id',
        'sess_1',
        '--transcript-uri',
        'gs://bucket/runs/x/claude-code/sess_1.jsonl',
        '--cwd',
        '/home/runner/work/repo/repo',
        '--projects-dir',
        path.join(tmp, 'projects'),
        '--project-id',
        'agent-lcars',
      ],
      { download },
    );
    expect(download).toHaveBeenCalledWith(
      'gs://bucket/runs/x/claude-code/sess_1.jsonl',
      { projectId: 'agent-lcars' },
    );
  });

  it('falls back to AGENT_TELEMETRY_PROJECT_ID when --project-id is omitted', async () => {
    const previous = process.env['AGENT_TELEMETRY_PROJECT_ID'];
    process.env['AGENT_TELEMETRY_PROJECT_ID'] = 'agent-lcars';
    try {
      const download = vi.fn().mockResolvedValue('{}\n');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-resume-'));
      await _runRunnerResumeForTesting(
        [
          '--session-id',
          'sess_1',
          '--transcript-uri',
          'gs://bucket/runs/x/claude-code/sess_1.jsonl',
          '--cwd',
          '/home/runner/work/repo/repo',
          '--projects-dir',
          path.join(tmp, 'projects'),
        ],
        { download },
      );
      expect(download).toHaveBeenCalledWith(
        'gs://bucket/runs/x/claude-code/sess_1.jsonl',
        { projectId: 'agent-lcars' },
      );
    } finally {
      if (previous === undefined)
        delete process.env['AGENT_TELEMETRY_PROJECT_ID'];
      else process.env['AGENT_TELEMETRY_PROJECT_ID'] = previous;
    }
  });

  it('prints nothing and never throws when a required flag is missing', async () => {
    const printed = await _runRunnerResumeForTesting(
      ['--session-id', 'sess_1'],
      {
        download: async () => '{}',
      },
    );
    expect(printed).toBeUndefined();
  });

  // sessionId arrives from untrusted document content (jq -r over the work
  // payload). resumeTranscript itself rejects this shape (see
  // resume-transcript.spec.ts), but the CLI boundary rejects it too --
  // defense in depth, and it means an unsafe id never reaches a GCS call
  // at all.
  it('rejects a --session-id that is not a plain id (path traversal), printing nothing', async () => {
    const download = vi.fn().mockResolvedValue('{}\n');
    const printed = await _runRunnerResumeForTesting(
      [
        '--session-id',
        '../../../etc/passwd',
        '--transcript-uri',
        'gs://bucket/x.jsonl',
        '--cwd',
        '/home/runner/work/repo/repo',
      ],
      { download },
    );
    expect(printed).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
  });

  // Failure is soft: a transcript that cannot be downloaded (missing,
  // unreadable, GCS error) must degrade resume to a fresh session, never
  // throw or otherwise disrupt the caller -- this is the fail-soft
  // contract `runRunnerResume`'s wrapper always exits 0 on, exercised here
  // at the layer that can actually observe the return value.
  it('fails soft: returns undefined (no throw) when the transcript download fails', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-resume-'));
    const printed = await _runRunnerResumeForTesting(
      [
        '--session-id',
        'sess_1',
        '--transcript-uri',
        'gs://bucket/runs/x/claude-code/sess_1.jsonl',
        '--cwd',
        '/home/runner/work/repo/repo',
        '--projects-dir',
        path.join(tmp, 'projects'),
      ],
      {
        download: async () => {
          throw new Error('object not found');
        },
      },
    );
    expect(printed).toBeUndefined();
  });

  // resumeTranscript's writeFile always overwrites (plain
  // fs.writeFileSync) -- idempotent by construction. A second `runner
  // resume` for the same session (e.g. a retried dispatch) must land the
  // latest transcript, not silently keep a stale one.
  it('is idempotent: a second resume for the same session overwrites the file', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-resume-'));
    const projectsDir = path.join(tmp, 'projects');
    const argv = [
      '--session-id',
      'sess_1',
      '--transcript-uri',
      'gs://bucket/runs/x/claude-code/sess_1.jsonl',
      '--cwd',
      '/home/runner/work/repo/repo',
      '--projects-dir',
      projectsDir,
    ];

    const first = await _runRunnerResumeForTesting(argv, {
      download: async () => '{"line":1}\n',
    });
    const second = await _runRunnerResumeForTesting(argv, {
      download: async () => '{"line":2}\n',
    });

    expect(first).toBe(second);
    expect(fs.readFileSync(second as string, 'utf8')).toBe('{"line":2}\n');
  });
});
