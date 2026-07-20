import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_PROJECT_DIR_ALLOWLIST } from './allowlist';
import { loadConfig } from './config';

const ENV_KEYS = [
  'AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR',
  'AGENT_TELEMETRY_PROJECT_DIR_ALLOWLIST',
  'AGENT_TELEMETRY_WATCH_ROOTS',
  'AGENT_TELEMETRY_HOST',
  'AGENT_TELEMETRY_PROJECT_ID',
  'AGENT_TELEMETRY_WRITER_KEY_JSON',
  'AGENT_TELEMETRY_HEARTBEAT_INTERVAL_MS',
  'AGENT_TELEMETRY_STALENESS_WINDOW_MS',
  'AGENT_TELEMETRY_SHARE_DIR',
  'FIRESTORE_EMULATOR_HOST',
] as const;

describe('loadConfig', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it("defaults to exactly one watch root matching today's behavior: ~/.claude/projects, claude-code, the default allowlist", () => {
    const config = loadConfig();

    expect(config.watchRoots).toEqual([
      {
        path: path.join(os.homedir(), '.claude', 'projects'),
        adapter: 'claude-code',
        projectDirAllowlist: DEFAULT_PROJECT_DIR_ALLOWLIST,
      },
    ]);
    expect(config.heartbeatIntervalMs).toBe(10_000);
    expect(config.stalenessWindowMs).toBe(50_000);
    expect(config.shareDir).toBe(path.join(os.homedir(), 'share'));
  });

  it('respects a share dir override', () => {
    process.env['AGENT_TELEMETRY_SHARE_DIR'] = '/mnt/share';

    const config = loadConfig();

    expect(config.shareDir).toBe('/mnt/share');
  });

  it('respects explicit heartbeat and staleness overrides', () => {
    process.env['AGENT_TELEMETRY_HEARTBEAT_INTERVAL_MS'] = '5000';
    process.env['AGENT_TELEMETRY_STALENESS_WINDOW_MS'] = '20000';

    const config = loadConfig();

    expect(config.heartbeatIntervalMs).toBe(5000);
    expect(config.stalenessWindowMs).toBe(20000);
  });

  describe('back-compat single-root env vars (default watch root only)', () => {
    it("honors AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR as the default root's path", () => {
      process.env['AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR'] = '/custom/projects';

      const config = loadConfig();

      expect(config.watchRoots).toEqual([
        {
          path: '/custom/projects',
          adapter: 'claude-code',
          projectDirAllowlist: DEFAULT_PROJECT_DIR_ALLOWLIST,
        },
      ]);
    });

    it("parses a comma-separated AGENT_TELEMETRY_PROJECT_DIR_ALLOWLIST as the default root's allowlist", () => {
      process.env['AGENT_TELEMETRY_PROJECT_DIR_ALLOWLIST'] =
        '-home-alice-*, -home-bob-*';

      const config = loadConfig();

      expect(config.watchRoots[0].projectDirAllowlist).toEqual([
        '-home-alice-*',
        '-home-bob-*',
      ]);
    });
  });

  describe('AGENT_TELEMETRY_WATCH_ROOTS (multi-root JSON override)', () => {
    it('parses a multi-root JSON array, replacing the default entirely', () => {
      process.env['AGENT_TELEMETRY_WATCH_ROOTS'] = JSON.stringify([
        {
          path: '/home/dev/.claude/projects',
          adapter: 'claude-code',
          projectDirAllowlist: ['-home-dev-*'],
        },
        { path: '/home/dev/.codex/sessions', adapter: 'codex' },
      ]);

      const config = loadConfig();

      expect(config.watchRoots).toEqual([
        {
          path: '/home/dev/.claude/projects',
          adapter: 'claude-code',
          projectDirAllowlist: ['-home-dev-*'],
        },
        { path: '/home/dev/.codex/sessions', adapter: 'codex' },
      ]);
    });

    it('ignores the legacy single-root env vars once AGENT_TELEMETRY_WATCH_ROOTS is set', () => {
      process.env['AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR'] = '/should/be/ignored';
      process.env['AGENT_TELEMETRY_PROJECT_DIR_ALLOWLIST'] = 'ignored-*';
      process.env['AGENT_TELEMETRY_WATCH_ROOTS'] = JSON.stringify([
        { path: '/only/this/one', adapter: 'gemini' },
      ]);

      const config = loadConfig();

      expect(config.watchRoots).toEqual([
        { path: '/only/this/one', adapter: 'gemini' },
      ]);
    });

    it('throws with a clear message on malformed JSON', () => {
      process.env['AGENT_TELEMETRY_WATCH_ROOTS'] = 'not json at all';

      expect(() => loadConfig()).toThrow(/not valid JSON/);
    });

    it('throws when the JSON is not a non-empty array', () => {
      process.env['AGENT_TELEMETRY_WATCH_ROOTS'] = JSON.stringify({});

      expect(() => loadConfig()).toThrow(/non-empty JSON array/);
    });

    it('throws when an entry is missing a valid path', () => {
      process.env['AGENT_TELEMETRY_WATCH_ROOTS'] = JSON.stringify([
        { adapter: 'claude-code' },
      ]);

      expect(() => loadConfig()).toThrow(/\[0\]\.path/);
    });

    it('throws when an entry has an unrecognized adapter', () => {
      process.env['AGENT_TELEMETRY_WATCH_ROOTS'] = JSON.stringify([
        { path: '/x', adapter: 'not-a-real-agent' },
      ]);

      expect(() => loadConfig()).toThrow(/\[0\]\.adapter/);
    });

    it('throws when projectDirAllowlist is present but not an array of strings', () => {
      process.env['AGENT_TELEMETRY_WATCH_ROOTS'] = JSON.stringify([
        { path: '/x', adapter: 'claude-code', projectDirAllowlist: 'nope' },
      ]);

      expect(() => loadConfig()).toThrow(/projectDirAllowlist/);
    });
  });
});
