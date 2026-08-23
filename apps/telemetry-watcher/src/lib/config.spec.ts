import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultProjectDirAllowlist } from './allowlist';
import { defaultAntigravityWorkspacePrefixes } from './antigravity-summary-source';
import { loadConfig } from './config';

const ENV_KEYS = [
  'AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR',
  'AGENT_TELEMETRY_CHECKOUT_ROOTS',
  'AGENT_TELEMETRY_CODEX_SESSIONS_DIR',
  'AGENT_TELEMETRY_WATCH_ROOTS',
  'AGENT_TELEMETRY_HOST',
  'AGENT_TELEMETRY_PROJECT_ID',
  'AGENT_TELEMETRY_TRANSCRIPTS_BUCKET',
  'AGENT_TELEMETRY_WRITER_KEY_JSON',
  'AGENT_TELEMETRY_HEARTBEAT_INTERVAL_MS',
  'AGENT_TELEMETRY_STALENESS_WINDOW_MS',
  'AGENT_TELEMETRY_SHARE_DIR',
  'AGENT_TELEMETRY_METRICS_HOST',
  'AGENT_TELEMETRY_METRICS_PORT',
  'AGENT_TELEMETRY_ANTIGRAVITY_SUMMARY_DB',
  'AGENT_TELEMETRY_SESSION_STATE_DIR',
  'FIRESTORE_EMULATOR_HOST',
] as const;

describe('loadConfig', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env['AGENT_TELEMETRY_CHECKOUT_ROOTS'] =
      '/srv/checkouts/sprinkles,/srv/checkouts/agent-lcars';
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

  it('defaults to scoped Claude Code and Codex watch roots', () => {
    const config = loadConfig();

    expect(config.watchRoots).toEqual([
      {
        path: path.join(os.homedir(), '.claude', 'projects'),
        adapter: 'claude-code',
        projectDirAllowlist: defaultProjectDirAllowlist(),
      },
      {
        path: path.join(os.homedir(), '.codex', 'sessions'),
        adapter: 'codex',
        recursive: true,
        cwdAllowlist: [
          '/srv/checkouts/sprinkles*',
          '/srv/checkouts/agent-lcars*',
        ],
      },
    ]);
    expect(config.heartbeatIntervalMs).toBe(10_000);
    expect(config.stalenessWindowMs).toBe(50_000);
    expect(config.shareDir).toBe(path.join(os.homedir(), 'share'));
    expect(config.metricsHost).toBe('0.0.0.0');
    expect(config.metricsPort).toBe(9464);
  });

  it('fails closed when checkout scope is not configured', () => {
    delete process.env['AGENT_TELEMETRY_CHECKOUT_ROOTS'];

    expect(() => loadConfig()).toThrow(/must explicitly name/);
  });

  it('respects metrics listener overrides', () => {
    process.env['AGENT_TELEMETRY_METRICS_HOST'] = '127.0.0.1';
    process.env['AGENT_TELEMETRY_METRICS_PORT'] = '9876';

    const config = loadConfig();

    expect(config.metricsHost).toBe('127.0.0.1');
    expect(config.metricsPort).toBe(9876);
  });

  it('rejects an invalid metrics port', () => {
    process.env['AGENT_TELEMETRY_METRICS_PORT'] = '70000';

    expect(() => loadConfig()).toThrow(/integer from 1 to 65535/);
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

  describe('transcriptsBucket (issue #24)', () => {
    it('is undefined when no project id is configured', () => {
      const config = loadConfig();

      expect(config.transcriptsBucket).toBeUndefined();
    });

    it('derives the bucket name from the configured project id', () => {
      process.env['AGENT_TELEMETRY_PROJECT_ID'] = 'agent-lcars';

      const config = loadConfig();

      expect(config.transcriptsBucket).toBe('agent-lcars-session-transcripts');
    });

    it('respects an explicit bucket override', () => {
      process.env['AGENT_TELEMETRY_PROJECT_ID'] = 'agent-lcars';
      process.env['AGENT_TELEMETRY_TRANSCRIPTS_BUCKET'] = 'custom-bucket';

      const config = loadConfig();

      expect(config.transcriptsBucket).toBe('custom-bucket');
    });
  });

  describe('AGENT_TELEMETRY_ANTIGRAVITY_SUMMARY_DB (#3123 phase 3)', () => {
    it('defaults to enabled at ~/.gemini/antigravity-cli/conversation_summaries.db with the configured checkout workspace prefix', () => {
      const config = loadConfig();

      expect(config.antigravitySummaryDb).toEqual({
        path: path.join(
          os.homedir(),
          '.gemini',
          'antigravity-cli',
          'conversation_summaries.db',
        ),
        workspacePrefixes: defaultAntigravityWorkspacePrefixes(),
      });
    });

    it('respects a custom DB path override', () => {
      process.env['AGENT_TELEMETRY_ANTIGRAVITY_SUMMARY_DB'] =
        '/custom/summaries.db';

      const config = loadConfig();

      expect(config.antigravitySummaryDb).toEqual({
        path: '/custom/summaries.db',
        workspacePrefixes: defaultAntigravityWorkspacePrefixes(),
      });
    });

    it('disables entirely when set to the empty string', () => {
      process.env['AGENT_TELEMETRY_ANTIGRAVITY_SUMMARY_DB'] = '';

      const config = loadConfig();

      expect(config.antigravitySummaryDb).toBeUndefined();
    });
  });

  describe('AGENT_TELEMETRY_SESSION_STATE_DIR (#1212)', () => {
    it('defaults to enabled at ~/.local/state/agent-lcars', () => {
      const config = loadConfig();

      expect(config.sessionStateDir).toBe(
        path.join(os.homedir(), '.local', 'state', 'agent-lcars'),
      );
    });

    it('respects a custom state dir override', () => {
      process.env['AGENT_TELEMETRY_SESSION_STATE_DIR'] = '/custom/state';

      const config = loadConfig();

      expect(config.sessionStateDir).toBe('/custom/state');
    });

    it('disables the overlay entirely when set to the empty string', () => {
      process.env['AGENT_TELEMETRY_SESSION_STATE_DIR'] = '';

      const config = loadConfig();

      expect(config.sessionStateDir).toBeUndefined();
    });
  });
});
