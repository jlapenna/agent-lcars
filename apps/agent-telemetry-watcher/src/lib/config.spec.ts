import { DEFAULT_PROJECT_DIR_ALLOWLIST } from './allowlist';
import { loadConfig } from './config';

const ENV_KEYS = [
  'AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR',
  'AGENT_TELEMETRY_PROJECT_DIR_ALLOWLIST',
  'AGENT_TELEMETRY_HOST',
  'AGENT_TELEMETRY_PROJECT_ID',
  'AGENT_TELEMETRY_WRITER_KEY_JSON',
  'AGENT_TELEMETRY_HEARTBEAT_INTERVAL_MS',
  'AGENT_TELEMETRY_STALENESS_WINDOW_MS',
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

  it('defaults the allowlist and staleness window when unset', () => {
    const config = loadConfig();

    expect(config.allowlist).toEqual(DEFAULT_PROJECT_DIR_ALLOWLIST);
    expect(config.heartbeatIntervalMs).toBe(10_000);
    expect(config.stalenessWindowMs).toBe(50_000);
  });

  it('parses a comma-separated allowlist override', () => {
    process.env['AGENT_TELEMETRY_PROJECT_DIR_ALLOWLIST'] =
      '-home-alice-*, -home-bob-*';

    const config = loadConfig();

    expect(config.allowlist).toEqual(['-home-alice-*', '-home-bob-*']);
  });

  it('respects explicit heartbeat and staleness overrides', () => {
    process.env['AGENT_TELEMETRY_HEARTBEAT_INTERVAL_MS'] = '5000';
    process.env['AGENT_TELEMETRY_STALENESS_WINDOW_MS'] = '20000';

    const config = loadConfig();

    expect(config.heartbeatIntervalMs).toBe(5000);
    expect(config.stalenessWindowMs).toBe(20000);
  });
});
