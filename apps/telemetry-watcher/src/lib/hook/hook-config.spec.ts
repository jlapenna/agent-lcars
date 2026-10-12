import { describe, expect, it } from 'vitest';

import { loadHookClientConfig } from './hook-config';

const missing = () => {
  throw new Error('ENOENT');
};

const runnerEnv = {
  LCARS_RUN_ID: 'run-1',
  LCARS_REPO: 'jlapenna/agent-lcars',
};

describe('loadHookClientConfig writer credentials', () => {
  it('uses LCARS_TELEMETRY_CREDENTIALS as a key file on a runner', () => {
    const config = loadHookClientConfig({
      homeDirectory: '/home/runner',
      env: {
        ...runnerEnv,
        LCARS_TELEMETRY_CREDENTIALS: '/run/secrets/telemetry-writer.json',
      },
      readFile: missing,
      hostname: () => 'runner-1',
    });
    expect(config.writer).toEqual({
      projectId: 'agent-lcars',
      keyFilename: '/run/secrets/telemetry-writer.json',
    });
    expect(config.runner).toMatchObject({
      runId: 'run-1',
      repo: { owner: 'jlapenna', name: 'agent-lcars' },
    });
  });

  it('prefers the dedicated variable over ambient ADC on a runner', () => {
    const config = loadHookClientConfig({
      homeDirectory: '/home/runner',
      env: {
        ...runnerEnv,
        LCARS_TELEMETRY_CREDENTIALS: '/run/secrets/telemetry-writer.json',
        GOOGLE_APPLICATION_CREDENTIALS: '/somewhere/else.json',
      },
      readFile: missing,
      hostname: () => 'runner-1',
    });
    expect(config.writer?.keyFilename).toBe(
      '/run/secrets/telemetry-writer.json',
    );
  });

  it('ignores the runner key file on a workstation', () => {
    const config = loadHookClientConfig({
      homeDirectory: '/home/dev',
      env: {
        LCARS_TELEMETRY_CREDENTIALS: '/run/secrets/telemetry-writer.json',
      },
      readFile: missing,
      hostname: () => 'laptop',
    });
    expect(config.runner).toBeUndefined();
    expect(config.writer).toBeUndefined();
  });
});
