import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const STREAMING_MEMORY_RATIO_LIMIT = 0.75;

interface MemoryMeasurement {
  rssDeltaMb: number;
  managedDeltaMb: number;
  materializedBytes: number;
}

function retainedMemoryMb(measurement: MemoryMeasurement): number {
  // RSS is the production-impact signal, but allocators and kernels can
  // report it well below the bytes a process still owns. Heap + external
  // memory is the stable lower-level signal for retained strings/Buffers.
  return Math.max(measurement.rssDeltaMb, measurement.managedDeltaMb);
}

function measureTickMemory(
  corpusDir: string,
  extraArgs: string[] = [],
  nodeArgs: string[] = [],
): MemoryMeasurement {
  const output = execFileSync(
    process.execPath,
    [
      ...nodeArgs,
      '--expose-gc',
      require.resolve('tsx/cli'),
      path.join(__dirname, 'measure-tick-rss.ts'),
      corpusDir,
      ...extraArgs,
    ],
    { encoding: 'utf8' },
  );

  return JSON.parse(output) as MemoryMeasurement;
}

// Regression coverage for #2606: `tick()` used to read every discovered
// transcript file in full into a single array before reducing, so peak
// memory scaled with the *whole* discovered corpus. Against a real
// `~/.claude/projects` checkout (170 files, 417MB) that OOM-crashed the
// daemon on its first tick. This generates a similarly-sized fixture corpus
// and asserts RSS growth during a real `tick()` stays a small fraction of
// the corpus size — proving the fix streams file contents instead of
// materializing them all at once.
describe('WatcherDaemon tick() retained memory', () => {
  const FILE_COUNT = 110;
  // Real pike deployment averaged ~2.45MB/file (417MB / 170 files).
  const LINES_PER_FILE = 6_000;
  const LINE_TEXT_LENGTH = 400;
  // Pike has Codex rollouts around this size. The old readFile+split path
  // temporarily held the file string, a line array, and parsed payloads at
  // once, exceeding its 384 MiB production V8 heap.
  const LARGE_FILE_LINES = 450;
  const LARGE_FILE_LINE_TEXT_LENGTH = 300_000;

  let corpusDir: string;
  let totalBytes = 0;

  // Building the 200MB+ corpus is itself I/O-heavy and has exceeded Vitest's
  // 10s hook default on saturated runners. Give fixture creation the same
  // budget as the memory measurements below.
  beforeAll(() => {
    corpusDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'agent-telemetry-oom-regression-'),
    );
    const projectDir = path.join(corpusDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });

    for (let i = 0; i < FILE_COUNT; i++) {
      const sessionId = `session-${i.toString().padStart(4, '0')}`;
      const filePath = path.join(projectDir, `${sessionId}.jsonl`);
      const fd = fs.openSync(filePath, 'w');
      fs.writeSync(
        fd,
        JSON.stringify({
          isSidechain: false,
          type: 'user',
          timestamp: '2026-07-12T09:00:00.000Z',
          sessionId,
          cwd: '/home/dev/project',
          gitBranch: 'main',
          message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        }) + '\n',
      );
      const line =
        JSON.stringify({
          isSidechain: false,
          type: 'assistant',
          timestamp: '2026-07-12T09:00:01.000Z',
          sessionId,
          message: {
            model: 'claude-sonnet-5',
            role: 'assistant',
            content: [{ type: 'text', text: 'x'.repeat(LINE_TEXT_LENGTH) }],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }) + '\n';
      for (let j = 0; j < LINES_PER_FILE; j++) {
        fs.writeSync(fd, line);
      }
      fs.closeSync(fd);
      totalBytes += fs.statSync(filePath).size;
    }

    const filePath = path.join(projectDir, 'large-session.jsonl');
    const fd = fs.openSync(filePath, 'w');
    fs.writeSync(
      fd,
      JSON.stringify({
        isSidechain: false,
        type: 'user',
        timestamp: '2026-07-12T09:00:00.000Z',
        sessionId: 'large-session',
        cwd: '/home/dev/project',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      }) + '\n',
    );
    const largeLine =
      JSON.stringify({
        isSidechain: false,
        type: 'assistant',
        timestamp: '2026-07-12T09:00:01.000Z',
        sessionId: 'large-session',
        message: {
          model: 'claude-sonnet-5',
          role: 'assistant',
          content: [
            { type: 'text', text: 'x'.repeat(LARGE_FILE_LINE_TEXT_LENGTH) },
          ],
        },
      }) + '\n';
    for (let i = 0; i < LARGE_FILE_LINES; i++) {
      fs.writeSync(fd, largeLine);
    }
    fs.closeSync(fd);
    totalBytes += fs.statSync(filePath).size;
  }, 120_000);

  afterAll(() => {
    fs.rmSync(corpusDir, { recursive: true, force: true });
  });

  it('keeps retained memory growth well below the corpus size on a single tick', () => {
    const totalMb = totalBytes / 1e6;
    expect(totalMb).toBeGreaterThan(200); // sanity-check the fixture is actually large

    const measurement = measureTickMemory(
      corpusDir,
      [],
      ['--max-old-space-size=384'],
    );

    // The naive (pre-fix) implementation retains roughly the full corpus
    // plus reduced state simultaneously. Ten real-workload runs measured
    // the streaming RSS ratio at 30.6-31.1% locally; a loaded-runner
    // incident reached roughly 55%. A 75% bound leaves 20 percentage points
    // above that outlier. retainedMemoryMb also covers V8-owned heap and
    // external memory because a runner can report RSS far below bytes that
    // remain strongly reachable (34.9% in CI for the full-corpus control).
    expect(retainedMemoryMb(measurement) / totalMb).toBeLessThan(
      STREAMING_MEMORY_RATIO_LIMIT,
    );
    // Timeout raised 60s -> 120s (#3123 phase 1 CI investigation): CI failed
    // once at 70.488s against this 200MB+ synthetic corpus while the
    // multi-root/adapter refactor's own local runs stayed well under 20s -
    // investigated by diffing daemon.ts's per-file change-detection path
    // against origin/main (the stat-then-skip gate for unchanged files is
    // untouched; no adapter/detect() work happens before that gate) and by
    // running this exact spec's child-process workload directly (bypassing
    // vitest) interleaved against an origin/main worktree on the same
    // machine, 3 runs each: both clustered at 14.5-17.5s with no consistent
    // gap between them. The CI timeout reflects this test's real cost on
    // loaded CI hardware for a deliberately oversized (200MB+) fixture, not
    // a regression - see #2606 (the original OOM issue this spec guards)
    // for why the fixture has to be this large to be a meaningful check.
  }, 120_000);

  it('rejects deliberate whole-corpus materialization', () => {
    const totalMb = totalBytes / 1e6;
    const measurement = measureTickMemory(corpusDir, ['--materialize-corpus']);

    // The helper reads this total only after its final GC/memory sample, so
    // this equality proves every corpus Buffer was still retained when
    // measured.
    expect(measurement.materializedBytes).toBe(totalBytes);
    expect(retainedMemoryMb(measurement) / totalMb).toBeGreaterThanOrEqual(
      STREAMING_MEMORY_RATIO_LIMIT,
    );
  }, 120_000);
});
