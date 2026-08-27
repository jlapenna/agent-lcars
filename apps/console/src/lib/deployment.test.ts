import { afterEach, describe, expect, it } from 'vitest';

import {
  adminGithubLogins,
  agentFleetLogin,
  agentSessionResumeScript,
  artifactShareBaseUrl,
  consoleDescription,
  consoleRepositoryUrl,
  consoleUrl,
  controlPlaneRepositories,
  controlPlaneRepository,
  isAdminGithubLogin,
  isControlPlaneRepository,
  maintainerLogin,
  shareArtifactUrl,
} from './deployment';

const VARS = [
  'AGENT_LCARS_ADMIN_GITHUB_LOGIN',
  'AGENT_LCARS_ADMIN_GITHUB_LOGINS',
  'AGENT_LCARS_FLEET_GITHUB_LOGIN',
  'AGENT_LCARS_ARTIFACT_SHARE_BASE_URL',
  'AGENT_LCARS_CONTROL_PLANE_REPOSITORY',
  'AGENT_LCARS_CONTROL_PLANE_REPOSITORIES',
  'AGENT_LCARS_CONSOLE_URL',
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

  describe('console admin authorization', () => {
    it('defaults to the configured maintainer login', () => {
      process.env['AGENT_LCARS_ADMIN_GITHUB_LOGIN'] = 'someone-else';
      expect(adminGithubLogins()).toEqual(['someone-else']);
      expect(isAdminGithubLogin('someone-else')).toBe(true);
      expect(isAdminGithubLogin('unlisted-user')).toBe(false);
    });

    it('admits each configured login without changing the maintainer', () => {
      process.env['AGENT_LCARS_ADMIN_GITHUB_LOGIN'] = 'queue-owner';
      process.env['AGENT_LCARS_ADMIN_GITHUB_LOGINS'] =
        'queue-owner, LizSprinkles, queue-owner';

      expect(adminGithubLogins()).toEqual(['queue-owner', 'lizsprinkles']);
      expect(isAdminGithubLogin('lizsprinkles')).toBe(true);
      expect(isAdminGithubLogin('LizSprinkles')).toBe(true);
      expect(maintainerLogin()).toBe('queue-owner');
    });

    it('rejects missing and unlisted profile logins', () => {
      process.env['AGENT_LCARS_ADMIN_GITHUB_LOGINS'] = 'jlapenna,lizsprinkles';
      expect(isAdminGithubLogin(undefined)).toBe(false);
      expect(isAdminGithubLogin(null)).toBe(false);
      expect(isAdminGithubLogin('someone-else')).toBe(false);
    });
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

  describe('consoleUrl', () => {
    it('defaults to this deployment when unset', () => {
      expect(consoleUrl()).toBe('https://lcars.jlapenna.net');
    });

    it('reads the console URL from the environment', () => {
      process.env['AGENT_LCARS_CONSOLE_URL'] = 'https://lcars.example.test';
      expect(consoleUrl()).toBe('https://lcars.example.test');
    });
  });

  // #1190 slice 1: `controlPlaneRepositories` generalizes the single pinned
  // repository into an allow-list, provably unchanged in production -- the
  // unset case must still resolve to exactly the one home repo.
  describe('controlPlaneRepositories', () => {
    it('defaults to exactly the home repo when unset', () => {
      expect(controlPlaneRepositories()).toEqual(['jlapenna/agent-lcars']);
    });

    it('defaults to a single-var override wrapped in an array', () => {
      process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORY'] = 'owner/controller';
      expect(controlPlaneRepositories()).toEqual(['owner/controller']);
    });

    it('parses a comma-separated list from the environment', () => {
      process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] =
        'jlapenna/agent-lcars, other-org/other-repo ,third-org/third-repo';
      expect(controlPlaneRepositories()).toEqual([
        'jlapenna/agent-lcars',
        'other-org/other-repo',
        'third-org/third-repo',
      ]);
    });

    it('throws on an entry that is not owner/name shaped', () => {
      process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] =
        'jlapenna/agent-lcars,not-a-repo-name';
      expect(() => controlPlaneRepositories()).toThrow(
        /not a valid owner\/name repository/,
      );
    });

    it('throws on an entry with an embedded extra slash', () => {
      process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] =
        'owner/name/extra';
      expect(() => controlPlaneRepositories()).toThrow(
        /not a valid owner\/name repository/,
      );
    });

    it('throws when set to an empty or whitespace-only value', () => {
      process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] = '  , , ';
      expect(() => controlPlaneRepositories()).toThrow(
        /must list at least one owner\/name repository/,
      );
    });
  });

  // Exact, case-sensitive membership -- GitHub full names are
  // case-preserving, and the old equality check this replaces never
  // case-folded either.
  describe('isControlPlaneRepository', () => {
    it('admits exactly the default home repo when nothing is configured', () => {
      expect(isControlPlaneRepository('jlapenna/agent-lcars')).toBe(true);
      expect(isControlPlaneRepository('someone-else/other-repo')).toBe(false);
    });

    it('is case-sensitive', () => {
      expect(isControlPlaneRepository('Jlapenna/Agent-Lcars')).toBe(false);
    });

    it('does not substring-match', () => {
      expect(isControlPlaneRepository('jlapenna/agent-lcars-fork')).toBe(false);
      expect(isControlPlaneRepository('x-jlapenna/agent-lcars')).toBe(false);
    });

    it('admits every repository configured in the allow-list', () => {
      process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] =
        'jlapenna/agent-lcars,other-org/other-repo';
      expect(isControlPlaneRepository('jlapenna/agent-lcars')).toBe(true);
      expect(isControlPlaneRepository('other-org/other-repo')).toBe(true);
      expect(isControlPlaneRepository('unlisted-org/unlisted-repo')).toBe(
        false,
      );
    });
  });

  it('falls back to this deployment when nothing is configured', () => {
    expect(maintainerLogin()).toBe('jlapenna');
    expect(agentFleetLogin()).toBe('agent-lcars-bot');
    expect(consoleDescription()).toBe(
      'jlapenna/agent-lcars — multi-agent issue activity',
    );
    expect(consoleRepositoryUrl()).toBe(
      'https://github.com/jlapenna/agent-lcars',
    );
    expect(controlPlaneRepository()).toBe('jlapenna/agent-lcars');
    expect(agentSessionResumeScript()).toBe('fleet-claude-agent-session');
    expect(shareArtifactUrl('pike', 'abc', 'out.txt')).toBe(
      'https://share.lan.jlapenna.net/pike/abc/out.txt',
    );
  });
});
