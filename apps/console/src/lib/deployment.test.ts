import { afterEach, describe, expect, it } from 'vitest';

import {
  agentFleetLogin,
  agentSessionResumeScript,
  artifactShareBaseUrl,
  consoleDescription,
  consoleRepositoryUrl,
  controlPlaneRepository,
  maintainerLogin,
  shareArtifactUrl,
} from './deployment';

const VARS = [
  'AGENT_LCARS_ADMIN_GITHUB_LOGIN',
  'AGENT_LCARS_FLEET_GITHUB_LOGIN',
  'AGENT_LCARS_ARTIFACT_SHARE_BASE_URL',
  'AGENT_LCARS_CONTROL_PLANE_REPOSITORY',
] as const;

afterEach(() => {
  for (const key of VARS) delete process.env[key];
});

// The point of this module is that a fork changes config, not source. These
// assert both halves: the override is honored, and the fallback keeps this
// deployment working with nothing set.
describe('deployment config', () => {
  it('reads the maintainer login from the environment', () => {
    process.env['AGENT_LCARS_ADMIN_GITHUB_LOGIN'] = 'someone-else';
    expect(maintainerLogin()).toBe('someone-else');
  });

  it('reads the fleet login from the environment', () => {
    process.env['AGENT_LCARS_FLEET_GITHUB_LOGIN'] = 'other-bot';
    expect(agentFleetLogin()).toBe('other-bot');
  });

  it('reads the artifact share base URL from the environment', () => {
    process.env['AGENT_LCARS_ARTIFACT_SHARE_BASE_URL'] =
      'https://share.example.test';
    expect(artifactShareBaseUrl()).toBe('https://share.example.test');
    expect(shareArtifactUrl('host-1', 'session-1', 'plot.png')).toBe(
      'https://share.example.test/host-1/session-1/plot.png',
    );
  });

  it('reads the control-plane repository from the environment', () => {
    process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORY'] = 'owner/controller';
    expect(controlPlaneRepository()).toBe('owner/controller');
  });

  it('falls back to this deployment when nothing is configured', () => {
    expect(maintainerLogin()).toBe('jlapenna');
    expect(agentFleetLogin()).toBe('jclaw-bot');
    expect(consoleDescription()).toBe(
      'jlapenna/agent-lcars — multi-agent issue activity',
    );
    expect(consoleRepositoryUrl()).toBe(
      'https://github.com/jlapenna/agent-lcars',
    );
    expect(controlPlaneRepository()).toBe('jlapenna/agent-lcars');
    expect(agentSessionResumeScript()).toBe('tools/claude-agent-session.sh');
    expect(shareArtifactUrl('pike', 'abc', 'out.txt')).toBe(
      'https://share.lan.jlapenna.net/pike/abc/out.txt',
    );
  });
});
