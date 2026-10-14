import { createRequire } from 'node:module';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const consoleRoot = path.join(workspaceRoot, 'apps/console');
const configPath = path.join(consoleRoot, 'next.config.js');
const workersPath = path.join(consoleRoot, 'build-workers.cjs');
// Loading the production Next config also loads Nx's plugin graph. That real
// integration can exceed Vitest's 5s default on a cold runner (#1529).
const coldConfigLoadTimeoutMs = 30_000;

// eslint-disable-next-line no-restricted-syntax
const { resolveConsoleBuildWorkers } = require(workersPath);
const BUDGET_ENV = 'LCARS_CONSOLE_BUILD_CPUS';

function io(files: Record<string, string>) {
  return {
    read(file: string): string | null {
      return Object.prototype.hasOwnProperty.call(files, file)
        ? files[file]
        : null;
    },
  };
}

const v2Mount = { '/sys/fs/cgroup/cgroup.controllers': 'cpu io memory pids' };
const v2Self = { '/proc/self/cgroup': '0::/system.slice/lcars-phase.service' };

function v2Files(quotaByPath: Record<string, string>) {
  return { ...v2Mount, ...v2Self, ...quotaByPath };
}

const restoredEnv: Record<string, string | undefined> = {};
function setEnv(name: string, value: string | undefined) {
  if (!(name in restoredEnv)) restoredEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of Object.entries(restoredEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete restoredEnv[name];
  }
});

function loadConsoleConfig() {
  delete require.cache[require.resolve(configPath)];
  delete require.cache[require.resolve(workersPath)];
  // next.config.js deliberately exports the CommonJS function Next loads.
  // eslint-disable-next-line no-restricted-syntax
  const exported = require(configPath) as (
    phase: string,
    context: { defaultConfig: Record<string, never> },
  ) => Promise<{ experimental?: { cpus?: number } }>;
  return exported('phase-production-build', { defaultConfig: {} });
}

describe('console build worker sizing (#2493)', () => {
  it('honors a validated explicit worker budget', () => {
    const decision = resolveConsoleBuildWorkers({
      env: { [BUDGET_ENV]: '4' },
      io: io({}),
      cpuCount: 96,
    });
    expect(decision).toMatchObject({ cpus: 4, source: 'explicit' });
  });

  it('lets an explicit budget win over the CI cap', () => {
    const decision = resolveConsoleBuildWorkers({
      env: { CI: 'true', [BUDGET_ENV]: '6' },
      io: io({}),
      cpuCount: 96,
    });
    expect(decision.cpus).toBe(6);
  });

  it.each(['', '0', '-3', '2.5', '1e3', '03', ' 2', 'two', '300', '999999'])(
    'rejects the invalid worker budget %j instead of falling back to host sizing',
    (raw) => {
      expect(() =>
        resolveConsoleBuildWorkers({
          env: { [BUDGET_ENV]: raw },
          io: io({}),
          cpuCount: 96,
        }),
      ).toThrow(BUDGET_ENV);
    },
  );

  it('retains the CI cap when no budget is supplied', () => {
    const decision = resolveConsoleBuildWorkers({
      env: { CI: 'true' },
      io: io({}),
      cpuCount: 96,
    });
    expect(decision).toMatchObject({ cpus: 2, source: 'ci' });
  });

  it('sizes workers from the cgroup v2 quota instead of the host CPU count', () => {
    const decision = resolveConsoleBuildWorkers({
      env: {},
      io: io(
        v2Files({
          '/sys/fs/cgroup/system.slice/lcars-phase.service/cpu.max':
            '200000 100000\n',
        }),
      ),
      cpuCount: 6,
    });
    expect(decision).toMatchObject({ cpus: 1, source: 'bounded-cpu' });
  });

  it('takes the most restrictive quota along the cgroup v2 path', () => {
    const decision = resolveConsoleBuildWorkers({
      env: {},
      io: io(
        v2Files({
          '/sys/fs/cgroup/cpu.max': 'max 100000\n',
          '/sys/fs/cgroup/system.slice/cpu.max': '300000 100000\n',
          '/sys/fs/cgroup/system.slice/lcars-phase.service/cpu.max':
            '800000 100000\n',
        }),
      ),
      cpuCount: 12,
    });
    expect(decision.cpus).toBe(2);
  });

  it('sizes workers from a cgroup v1 cpu quota', () => {
    const decision = resolveConsoleBuildWorkers({
      env: {},
      io: io({
        '/proc/mounts':
          'cgroup /sys/fs/cgroup/cpu,cpuacct cgroup rw,relatime,cpu,cpuacct 0 0\n',
        '/proc/self/cgroup': '3:cpu,cpuacct:/system.slice/lcars-phase.service',
        '/sys/fs/cgroup/cpu,cpuacct/system.slice/lcars-phase.service/cpu.cfs_quota_us':
          '200000\n',
        '/sys/fs/cgroup/cpu,cpuacct/system.slice/lcars-phase.service/cpu.cfs_period_us':
          '100000\n',
      }),
      cpuCount: 6,
    });
    expect(decision).toMatchObject({ cpus: 1, source: 'bounded-cpu' });
  });

  it('never asks for more workers than Next would have chosen itself', () => {
    const decision = resolveConsoleBuildWorkers({
      env: {},
      io: io(v2Files({ '/sys/fs/cgroup/cpu.max': '10000000 100000\n' })),
      cpuCount: 4,
    });
    expect(decision.cpus).toBe(3);
  });

  it('leaves Next host sizing in place when nothing bounds the phase', () => {
    const decision = resolveConsoleBuildWorkers({
      env: {},
      io: io(v2Files({ '/sys/fs/cgroup/cpu.max': 'max 100000\n' })),
      cpuCount: 96,
    });
    expect(decision).toMatchObject({ cpus: null, source: 'next-default' });
  });

  it.each([
    ['an unreadable hierarchy', {}],
    [
      'an unlimited root',
      v2Files({ '/sys/fs/cgroup/cpu.max': 'max 100000\n' }),
    ],
    [
      'a malformed quota file',
      v2Files({ '/sys/fs/cgroup/cpu.max': 'nonsense\n' }),
    ],
    [
      'a disabled v1 quota',
      {
        '/proc/mounts':
          'cgroup /sys/fs/cgroup/cpu cgroup rw,relatime,cpu 0 0\n',
        '/proc/self/cgroup': '3:cpu:/',
        '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1\n',
        '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000\n',
      },
    ],
  ])(
    'treats %s as unbounded rather than failing the build',
    (_label, files) => {
      const decision = resolveConsoleBuildWorkers({
        env: {},
        io: io(files as Record<string, string>),
        cpuCount: 24,
      });
      expect(decision).toMatchObject({ cpus: null, source: 'next-default' });
    },
  );

  it(
    'carries the explicit budget into the production Next config',
    async () => {
      setEnv(BUDGET_ENV, '3');
      setEnv('CI', undefined);
      const config = await loadConsoleConfig();
      expect(config.experimental?.cpus).toBe(3);
    },
    coldConfigLoadTimeoutMs,
  );

  it(
    'retains the CI cap in the production Next config',
    async () => {
      setEnv(BUDGET_ENV, undefined);
      setEnv('CI', 'true');
      const config = await loadConsoleConfig();
      expect(config.experimental?.cpus).toBe(2);
    },
    coldConfigLoadTimeoutMs,
  );
});
