import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadRunnerConfig } from './runner-config';

const ENV_KEYS = [
  'AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR',
  'AGENT_TELEMETRY_PROJECT_DIR_ALLOWLIST',
  'AGENT_TELEMETRY_HOST',
  'AGENT_TELEMETRY_PROJECT_ID',
  'AGENT_TELEMETRY_TRANSCRIPTS_BUCKET',
  'AGENT_TELEMETRY_WRITER_KEY_JSON',
  'AGENT_TELEMETRY_HEARTBEAT_INTERVAL_MS',
  'AGENT_TELEMETRY_STALENESS_WINDOW_MS',
  'AGENT_TELEMETRY_SHARE_DIR',
  'FIRESTORE_EMULATOR_HOST',
  'GITHUB_REPOSITORY',
] as const;

describe('loadRunnerConfig', () => {
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

  it('parses --run-id, --issue-number, and --projects-dir', () => {
    const config = loadRunnerConfig([
      '--run-id',
      '123456789',
      '--issue-number',
      '3107',
      '--projects-dir',
      '/home/runner/.claude/projects',
    ]);

    expect(config.runId).toBe('123456789');
    expect(config.issueNumber).toBe(3107);
    expect(config.claudeProjectsDir).toBe('/home/runner/.claude/projects');
  });

  it('falls back to loadConfig defaults when no flags are passed', () => {
    const config = loadRunnerConfig([]);

    expect(config.runId).toBeUndefined();
    expect(config.issueNumber).toBeUndefined();
    expect(config.heartbeatIntervalMs).toBe(10_000);
    expect(config.claudeProjectsDir).toContain('.claude/projects');
  });

  it('ignores unknown flags without breaking parsing of known ones after them', () => {
    const config = loadRunnerConfig([
      '--not-a-real-flag',
      'value',
      '--run-id',
      '42',
    ]);

    expect(config.runId).toBe('42');
  });

  it('drops a non-numeric --issue-number rather than shipping NaN', () => {
    const config = loadRunnerConfig(['--issue-number', 'not-a-number']);

    expect(config.issueNumber).toBeUndefined();
  });

  it('still honors env-driven overrides for the shared watcher knobs', () => {
    process.env['AGENT_TELEMETRY_HEARTBEAT_INTERVAL_MS'] = '7000';
    process.env['AGENT_TELEMETRY_PROJECT_ID'] = 'supersprinklesracing';

    const config = loadRunnerConfig(['--run-id', '1']);

    expect(config.heartbeatIntervalMs).toBe(7000);
    expect(config.firestoreProjectId).toBe('supersprinklesracing');
  });

  it('a trailing flag with no value is ignored rather than consuming the next flag', () => {
    const config = loadRunnerConfig(['--run-id']);

    expect(config.runId).toBeUndefined();
  });

  it('parses --repo owner/name', () => {
    const config = loadRunnerConfig(['--repo', 'supersprinklesracing/members']);

    expect(config.repo).toEqual({
      owner: 'supersprinklesracing',
      name: 'members',
    });
  });

  it('ignores a malformed --repo value (no slash) rather than crashing', () => {
    const config = loadRunnerConfig(['--repo', 'not-a-repo']);

    expect(config.repo).toBeUndefined();
  });

  it('ignores a malformed --repo value (too many slashes)', () => {
    const config = loadRunnerConfig(['--repo', 'a/b/c']);

    expect(config.repo).toBeUndefined();
  });

  it('ignores a malformed --repo value (empty owner or name)', () => {
    expect(loadRunnerConfig(['--repo', '/members']).repo).toBeUndefined();
    expect(
      loadRunnerConfig(['--repo', 'supersprinklesracing/']).repo,
    ).toBeUndefined();
  });

  it('falls back to GITHUB_REPOSITORY when --repo is not passed', () => {
    process.env['GITHUB_REPOSITORY'] = 'supersprinklesracing/members';

    const config = loadRunnerConfig([]);

    expect(config.repo).toEqual({
      owner: 'supersprinklesracing',
      name: 'members',
    });
  });

  it('ignores a malformed GITHUB_REPOSITORY rather than crashing', () => {
    process.env['GITHUB_REPOSITORY'] = 'not-a-repo';

    const config = loadRunnerConfig([]);

    expect(config.repo).toBeUndefined();
  });

  it('prefers the --repo flag over GITHUB_REPOSITORY when both are present', () => {
    process.env['GITHUB_REPOSITORY'] = 'env-owner/env-repo';

    const config = loadRunnerConfig(['--repo', 'flag-owner/flag-repo']);

    expect(config.repo).toEqual({ owner: 'flag-owner', name: 'flag-repo' });
  });

  it('omits repo entirely when neither --repo nor GITHUB_REPOSITORY is set', () => {
    const config = loadRunnerConfig([]);

    expect(config.repo).toBeUndefined();
  });

  it('threads the derived transcriptsBucket through from loadConfig (issue #24)', () => {
    process.env['AGENT_TELEMETRY_PROJECT_ID'] = 'agent-lcars';

    const config = loadRunnerConfig([]);

    expect(config.transcriptsBucket).toBe('agent-lcars-session-transcripts');
  });

  it('omits transcriptsBucket entirely when no project id is configured', () => {
    const config = loadRunnerConfig([]);

    expect(config.transcriptsBucket).toBeUndefined();
  });
});
