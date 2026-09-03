import { afterEach, describe, expect, it } from 'vitest';

import {
  adminGithubLogins,
  agentFleetLogin,
  agentSessionResumeScript,
  artifactShareBaseUrl,
  codexCentralAuthObject,
  consoleDescription,
  consoleRepositoryUrl,
  consoleUrl,
  controlPlaneRepositories,
  controlPlaneRepository,
  isAdminGithubLogin,
  isControlPlaneRepository,
  isPushWatchedRepository,
  maintainerLogin,
  pushWatchedRepos,
  pushWatchTargetRepo,
  shareArtifactUrl,
  validateDeploymentIdentity,
} from './deployment';

const VARS = [
  'AGENT_LCARS_ADMIN_GITHUB_LOGIN',
  'AGENT_LCARS_ADMIN_GITHUB_LOGINS',
  'AGENT_LCARS_FLEET_GITHUB_LOGIN',
  'AGENT_LCARS_ARTIFACT_SHARE_BASE_URL',
  'AGENT_LCARS_CONTROL_PLANE_REPOSITORY',
  'AGENT_LCARS_CONTROL_PLANE_REPOSITORIES',
  'AGENT_LCARS_WATCHED_REPOS',
  'AGENT_LCARS_CONSOLE_URL',
  'AGENT_LCARS_CONSOLE_DESCRIPTION',
  'AGENT_LCARS_PUSH_WATCHED_REPOS',
  'AGENT_LCARS_PUSH_WATCH_TARGET_REPO',
  'AGENT_LCARS_CODEX_CENTRAL_AUTH_OBJECT',
] as const;

afterEach(() => {
  for (const key of VARS) delete process.env[key];
});

// The point of this module is that a fork changes config, not source. These
// Identity configuration is explicit; these assert parsing and admission
// boundaries without allowing an unset deployment to silently drift.
describe('deployment config', () => {
  it('reads the maintainer login from the environment', () => {
    process.env['AGENT_LCARS_ADMIN_GITHUB_LOGIN'] = 'someone-else';
    expect(maintainerLogin()).toBe('someone-else');
  });

  it('fails closed when the maintainer login is unset -- no jlapenna fallback', () => {
    delete process.env['AGENT_LCARS_ADMIN_GITHUB_LOGIN'];
    expect(() => maintainerLogin()).toThrow('AGENT_LCARS_ADMIN_GITHUB_LOGIN');
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
      process.env['AGENT_LCARS_ADMIN_GITHUB_LOGIN'] = 'jlapenna';
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

  it('fails closed when the artifact share base URL is unset -- no jlapenna fallback', () => {
    delete process.env['AGENT_LCARS_ARTIFACT_SHARE_BASE_URL'];
    expect(() => artifactShareBaseUrl()).toThrow(
      'AGENT_LCARS_ARTIFACT_SHARE_BASE_URL',
    );
  });

  it('reads the Codex central auth object path from the environment', () => {
    process.env['AGENT_LCARS_CODEX_CENTRAL_AUTH_OBJECT'] =
      'other-owner/other-repo/auth.json';
    expect(codexCentralAuthObject()).toBe('other-owner/other-repo/auth.json');
  });

  it('fails closed when the Codex central auth object path is unset -- no jlapenna fallback', () => {
    delete process.env['AGENT_LCARS_CODEX_CENTRAL_AUTH_OBJECT'];
    expect(() => codexCentralAuthObject()).toThrow(
      'AGENT_LCARS_CODEX_CENTRAL_AUTH_OBJECT',
    );
  });

  it('reads the control-plane repository from the environment', () => {
    process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORY'] = 'owner/controller';
    expect(controlPlaneRepository()).toBe('owner/controller');
  });

  describe('consoleUrl', () => {
    it('reads the console URL from the environment', () => {
      process.env['AGENT_LCARS_CONSOLE_URL'] = 'https://lcars.example.test';
      expect(consoleUrl()).toBe('https://lcars.example.test');
    });

    it('fails closed when unset -- no jlapenna fallback', () => {
      delete process.env['AGENT_LCARS_CONSOLE_URL'];
      expect(() => consoleUrl()).toThrow('AGENT_LCARS_CONSOLE_URL');
    });
  });

  describe('consoleDescription', () => {
    it('falls back to a generic, deployment-neutral description when unset', () => {
      delete process.env['AGENT_LCARS_CONSOLE_DESCRIPTION'];
      expect(consoleDescription()).toBe(
        'Agent LCARS — multi-agent issue activity',
      );
    });

    it('reads an explicit description from the environment', () => {
      process.env['AGENT_LCARS_CONSOLE_DESCRIPTION'] = 'Fork — issue queue';
      expect(consoleDescription()).toBe('Fork — issue queue');
    });
  });

  describe('consoleRepositoryUrl', () => {
    it('derives from the control-plane repository', () => {
      process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORY'] = 'owner/fork';
      expect(consoleRepositoryUrl()).toBe('https://github.com/owner/fork');
    });

    it('fails closed when the control-plane repository is unset', () => {
      delete process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORY'];
      expect(() => consoleRepositoryUrl()).toThrow(
        'AGENT_LCARS_CONTROL_PLANE_REPOSITORY',
      );
    });
  });

  describe('controlPlaneRepositories', () => {
    it('reads the explicit matching home-repo configuration', () => {
      expect(controlPlaneRepositories()).toEqual(['jlapenna/agent-lcars']);
    });

    it('fails closed when the control-plane repository list is absent', () => {
      delete process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'];
      expect(() => controlPlaneRepositories()).toThrow(
        'AGENT_LCARS_CONTROL_PLANE_REPOSITORIES',
      );
    });

    it('parses a comma-separated list from the environment', () => {
      process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] =
        'jlapenna/agent-lcars, other-org/other-repo ,third-org/third-repo';
      process.env['AGENT_LCARS_WATCHED_REPOS'] = JSON.stringify([
        { owner: 'jlapenna', name: 'agent-lcars' },
        { owner: 'other-org', name: 'other-repo' },
        { owner: 'third-org', name: 'third-repo' },
      ]);
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

    it('rejects a control-plane list that differs from watched repositories', () => {
      process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] =
        'jlapenna/agent-lcars,other-org/other-repo';
      expect(() => controlPlaneRepositories()).toThrow(
        'must exactly match AGENT_LCARS_WATCHED_REPOS',
      );
    });
  });

  // Exact, case-sensitive membership -- GitHub full names are
  // case-preserving, and the old equality check this replaces never
  // case-folded either.
  describe('isControlPlaneRepository', () => {
    it('admits exactly the explicit home repository', () => {
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
      process.env['AGENT_LCARS_WATCHED_REPOS'] = JSON.stringify([
        { owner: 'jlapenna', name: 'agent-lcars' },
        { owner: 'other-org', name: 'other-repo' },
      ]);
      expect(isControlPlaneRepository('jlapenna/agent-lcars')).toBe(true);
      expect(isControlPlaneRepository('other-org/other-repo')).toBe(true);
      expect(isControlPlaneRepository('unlisted-org/unlisted-repo')).toBe(
        false,
      );
    });
  });

  // Unlike controlPlaneRepositories(), this list is additive/opt-in: no
  // anchor rendering depends on it, so an unset or malformed entry degrades
  // to "nothing push-watched" rather than throwing.
  describe('pushWatchedRepos / isPushWatchedRepository', () => {
    it('is empty when unset', () => {
      expect(pushWatchedRepos()).toEqual([]);
      expect(isPushWatchedRepository('jlapenna/repo-tools')).toBe(false);
    });

    it('parses a comma-separated list from the environment', () => {
      process.env['AGENT_LCARS_PUSH_WATCHED_REPOS'] =
        'jlapenna/repo-tools, other-org/other-repo ';
      expect(pushWatchedRepos()).toEqual([
        'jlapenna/repo-tools',
        'other-org/other-repo',
      ]);
      expect(isPushWatchedRepository('jlapenna/repo-tools')).toBe(true);
      expect(isPushWatchedRepository('unlisted-org/unlisted-repo')).toBe(false);
    });

    it('drops malformed entries instead of throwing', () => {
      process.env['AGENT_LCARS_PUSH_WATCHED_REPOS'] =
        'jlapenna/repo-tools,not-a-repo-name,,owner/name/extra';
      expect(pushWatchedRepos()).toEqual(['jlapenna/repo-tools']);
    });

    it('is case-sensitive and does not substring-match', () => {
      process.env['AGENT_LCARS_PUSH_WATCHED_REPOS'] = 'jlapenna/repo-tools';
      expect(isPushWatchedRepository('Jlapenna/Repo-Tools')).toBe(false);
      expect(isPushWatchedRepository('jlapenna/repo-tools-fork')).toBe(false);
    });
  });

  describe('pushWatchTargetRepo', () => {
    it('reads the target repository from the environment', () => {
      process.env['AGENT_LCARS_PUSH_WATCH_TARGET_REPO'] = 'owner/target';
      expect(pushWatchTargetRepo()).toBe('owner/target');
    });

    it('fails closed when unset -- no jlapenna fallback', () => {
      delete process.env['AGENT_LCARS_PUSH_WATCH_TARGET_REPO'];
      expect(() => pushWatchTargetRepo()).toThrow(
        'AGENT_LCARS_PUSH_WATCH_TARGET_REPO',
      );
    });

    it('rejects a value that is not owner/name shaped', () => {
      process.env['AGENT_LCARS_PUSH_WATCH_TARGET_REPO'] = 'not-a-repo-name';
      expect(() => pushWatchTargetRepo()).toThrow(
        /not a valid owner\/name repository/,
      );
    });
  });

  describe('validateDeploymentIdentity', () => {
    function completeEnv() {
      process.env['AGENT_LCARS_ADMIN_GITHUB_LOGIN'] = 'someone';
      process.env['AGENT_LCARS_CONSOLE_URL'] = 'https://lcars.example.test';
      process.env['AGENT_LCARS_ARTIFACT_SHARE_BASE_URL'] =
        'https://share.example.test';
      process.env['AGENT_LCARS_PUSH_WATCH_TARGET_REPO'] = 'owner/target';
      process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORY'] = 'owner/console';
      process.env['AGENT_LCARS_CODEX_CENTRAL_AUTH_OBJECT'] =
        'owner/console/auth.json';
    }

    it('succeeds silently when every identity variable is set', () => {
      completeEnv();
      expect(() => validateDeploymentIdentity()).not.toThrow();
    });

    it('fails with a clear message naming the missing variable', () => {
      completeEnv();
      delete process.env['AGENT_LCARS_ADMIN_GITHUB_LOGIN'];
      expect(() => validateDeploymentIdentity()).toThrow(
        'AGENT_LCARS_ADMIN_GITHUB_LOGIN',
      );
    });

    it('fails when the push-watch target repository is unset', () => {
      completeEnv();
      delete process.env['AGENT_LCARS_PUSH_WATCH_TARGET_REPO'];
      expect(() => validateDeploymentIdentity()).toThrow(
        'AGENT_LCARS_PUSH_WATCH_TARGET_REPO',
      );
    });

    it('fails when the Codex central auth object path is unset', () => {
      completeEnv();
      delete process.env['AGENT_LCARS_CODEX_CENTRAL_AUTH_OBJECT'];
      expect(() => validateDeploymentIdentity()).toThrow(
        'AGENT_LCARS_CODEX_CENTRAL_AUTH_OBJECT',
      );
    });
  });

  it('uses the remaining deployment identity defaults', () => {
    process.env['AGENT_LCARS_ADMIN_GITHUB_LOGIN'] = 'jlapenna';
    expect(maintainerLogin()).toBe('jlapenna');
    expect(agentFleetLogin()).toBe('agent-lcars-bot');
    expect(agentSessionResumeScript()).toBe('fleet-claude-agent-session');
  });
});
