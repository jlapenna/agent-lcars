import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  executeIntegrationCommand,
  installIntegration,
  INTEGRATION_VERSION,
  integrationStatus,
  opencodePluginPath,
  stubCommand,
  uninstallIntegration,
} from './integration';
import { OPENCODE_TELEMETRY_PLUGIN } from './opencode-plugin-source';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    fs.rmSync(home, { recursive: true, force: true });
});
function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-integration-'));
  homes.push(home);
  return home;
}
const readJson = (file: string) =>
  JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

describe('lcars integration', () => {
  it('installs a versioned stub and constant hook entries without disturbing other settings', () => {
    const home = tempHome();
    const settingsPath = path.join(home, '.claude/settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const existing = {
      permissions: { defaultMode: 'bypassPermissions' },
      model: 'opus',
      hooks: {
        SessionStart: [
          {
            matcher: '^startup$',
            hooks: [
              { type: 'command', command: 'herdr-agent-state.sh session' },
            ],
          },
        ],
      },
      statusLine: { type: 'command', command: 'x' },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(existing), { mode: 0o600 });

    const status = installIntegration('claude', home);
    expect(status).toMatchObject({
      installed: true,
      stubVersion: INTEGRATION_VERSION,
      entriesPresent: 5,
    });

    const stub = fs.readFileSync(
      path.join(home, '.claude/hooks/lcars-hook.sh'),
      'utf8',
    );
    expect(stub).toContain(
      `# LCARS_INTEGRATION_VERSION=${INTEGRATION_VERSION}`,
    );
    expect(stub).toContain('hook "$runtime"');
    expect(
      fs.statSync(path.join(home, '.claude/hooks/lcars-hook.sh')).mode & 0o777,
    ).toBe(0o700);
    expect(fs.statSync(settingsPath).mode & 0o077).toBe(0);

    const written = readJson(settingsPath);
    expect(Object.keys(written)).toEqual([
      'permissions',
      'model',
      'hooks',
      'statusLine',
    ]);
    const hooks = written['hooks'] as Record<
      string,
      Array<{ hooks: Array<Record<string, unknown>> }>
    >;
    expect(hooks['SessionStart']).toHaveLength(2);
    expect(hooks['SessionStart'][0].hooks[0]['command']).toBe(
      'herdr-agent-state.sh session',
    );
    expect(hooks['SessionStart'][1].hooks[0]).toEqual({
      type: 'command',
      command: stubCommand('claude'),
      timeout: 10,
    });
    expect(hooks['PostToolUse'][0].hooks[0]).toEqual({
      type: 'command',
      command: stubCommand('claude'),
      async: true,
    });
    expect(hooks['SessionEnd'][0].hooks[0]).toMatchObject({ timeout: 5 });
  });

  it('detects a prior Codex installation after execution policy changes and refreshes it without disturbing foreign settings', () => {
    const home = tempHome();
    const env = {};
    installIntegration('codex', home, env);
    const settingsPath = path.join(home, '.codex/hooks.json');
    const settings = readJson(settingsPath);
    type Groups = Record<
      string,
      Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>
    >;
    const hooks = settings['hooks'] as Groups;
    const foreign = {
      type: 'command',
      command: 'foreign-stop',
      async: true,
      timeout: 77,
    };
    hooks['Stop'][0].hooks[0]['async'] = true;
    delete hooks['Stop'][0].hooks[0]['timeout'];
    hooks['Stop'][0].matcher = '*';
    hooks['Stop'][0].hooks.push(foreign);
    hooks['Stop'].unshift({
      hooks: [{ type: 'command', command: 'before-stop' }],
    });
    hooks['Notification'] = [
      { hooks: [{ type: 'command', command: 'foreign-notification' }] },
    ];
    settings['model'] = 'preserved-model';
    fs.writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o640 });
    fs.chmodSync(settingsPath, 0o640);
    const stub = fs.readFileSync(
      path.join(home, '.codex/lcars-hook.sh'),
      'utf8',
    );
    // The persisted legacy Stop must be refreshed to the canonical synchronous
    // definition without changing unrelated settings, hooks or the stub.
    expect(integrationStatus('codex', home, env)).toMatchObject({
      stubCurrent: true,
      stubVersion: INTEGRATION_VERSION,
      entriesPresent: 7,
      installed: false,
    });
    const stdout = vi.fn();
    expect(
      executeIntegrationCommand(['status', 'codex'], {
        homeDirectory: home,
        env,
        stdout,
      }),
    ).toBe(1);
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining('codex: not installed'),
    );
    expect(installIntegration('codex', home, env).installed).toBe(true);
    expect(
      executeIntegrationCommand(['status', 'codex'], {
        homeDirectory: home,
        env,
        stdout,
      }),
    ).toBe(0);
    const refreshed = readJson(settingsPath);
    const refreshedHooks = refreshed['hooks'] as Groups;
    expect(refreshed['model']).toBe('preserved-model');
    expect(refreshedHooks['Notification']).toEqual(hooks['Notification']);
    expect(refreshedHooks['Stop'][0]).toEqual(hooks['Stop'][0]);
    expect(refreshedHooks['Stop'][1].matcher).toBe('*');
    expect(refreshedHooks['Stop'][1].hooks).toEqual([
      { type: 'command', command: stubCommand('codex'), timeout: 5 },
      foreign,
    ]);
    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o640);
    expect(
      fs.readFileSync(path.join(home, '.codex/lcars-hook.sh'), 'utf8'),
    ).toBe(stub);
  });

  it.each(['claude', 'codex'] as const)(
    'refreshes stale managed hooks in every %s group and preserves foreign ordering',
    (runtime) => {
      const home = tempHome();
      const env = {};
      expect(installIntegration(runtime, home, env).installed).toBe(true);
      const settingsPath = path.join(
        home,
        runtime === 'claude' ? '.claude/settings.json' : '.codex/hooks.json',
      );
      const settings = readJson(settingsPath);
      type Group = { matcher?: string; hooks: Array<Record<string, unknown>> };
      const hooks = settings['hooks'] as Record<string, Group[]>;
      const current = hooks['Stop'][0].hooks[0];
      const before = {
        matcher: 'before-*',
        hooks: [{ type: 'command', command: 'before-stop' }],
      };
      const firstForeign = {
        type: 'command',
        command: 'first-foreign',
        async: true,
        timeout: 77,
      };
      const between = { hooks: [{ type: 'command', command: 'between-stop' }] };
      const laterBefore = { type: 'command', command: 'later-before' };
      const laterAfter = {
        type: 'command',
        command: 'later-after',
        timeout: 19,
      };
      const after = {
        matcher: 'after-*',
        hooks: [{ type: 'command', command: 'after-stop' }],
      };
      hooks['Stop'] = [
        before,
        { matcher: 'first-*', hooks: [current, firstForeign] },
        between,
        {
          matcher: 'later-*',
          hooks: [
            laterBefore,
            { ...current, async: true, timeout: 99 },
            { ...current, timeout: 0 },
            laterAfter,
          ],
        },
        after,
      ];
      settings['model'] = 'preserved-model';
      fs.writeFileSync(settingsPath, JSON.stringify(settings));
      fs.chmodSync(settingsPath, 0o640);
      expect(integrationStatus(runtime, home, env).installed).toBe(false);
      expect(installIntegration(runtime, home, env).installed).toBe(true);
      const refreshed = readJson(settingsPath);
      expect(refreshed['model']).toBe('preserved-model');
      expect((refreshed['hooks'] as Record<string, Group[]>)['Stop']).toEqual([
        before,
        { matcher: 'first-*', hooks: [current, firstForeign] },
        between,
        { matcher: 'later-*', hooks: [laterBefore, current, laterAfter] },
        after,
      ]);
      expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o640);
      const once = fs.readFileSync(settingsPath, 'utf8');
      expect(installIntegration(runtime, home, env).installed).toBe(true);
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(once);
      const stdout = vi.fn();
      expect(
        executeIntegrationCommand(['status', runtime], {
          homeDirectory: home,
          env,
          stdout,
        }),
      ).toBe(0);
    },
  );

  it.each([
    ['async', false],
    ['async', 'true'],
    ['timeout', 5],
    ['timeout', null],
    ['type', 'prompt'],
    ['command', stubCommand('claude')],
    ['command', stubCommand('codex', '$HOME/.codex/previous/lcars-hook.sh')],
  ] as const)(
    'rejects stale managed Codex %s=%s options and refreshes through the existing installer',
    (field, value) => {
      const home = tempHome();
      const env = {};
      expect(installIntegration('codex', home, env).installed).toBe(true);
      const settingsPath = path.join(home, '.codex/hooks.json');
      const settings = readJson(settingsPath);
      const hooks = settings['hooks'] as Record<
        string,
        Array<{ hooks: Array<Record<string, unknown>> }>
      >;
      hooks['PostToolUse'][0].hooks[0][field] = value;
      fs.writeFileSync(settingsPath, JSON.stringify(settings));
      expect(integrationStatus('codex', home, env)).toMatchObject({
        stubCurrent: true,
        entriesPresent: 7,
        installed: false,
      });
      expect(installIntegration('codex', home, env).installed).toBe(true);
      expect(integrationStatus('codex', home, env).installed).toBe(true);
    },
  );

  it('accepts explicit false on a synchronous managed entry and ignores foreign hook options', () => {
    const home = tempHome();
    const env = {};
    installIntegration('codex', home, env);
    const settingsPath = path.join(home, '.codex/hooks.json');
    const settings = readJson(settingsPath);
    const hooks = settings['hooks'] as Record<
      string,
      Array<{ hooks: Array<Record<string, unknown>> }>
    >;
    hooks['SessionStart'][0].hooks[0]['async'] = false;
    hooks['SessionStart'][0].hooks.push({
      type: 'command',
      command: 'foreign',
      async: false,
      timeout: 999,
    });
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    expect(integrationStatus('codex', home, env).installed).toBe(true);
  });

  it('keeps an existing settings mode regardless of the process umask', () => {
    const home = tempHome();
    const settingsPath = path.join(home, '.claude/settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{}');
    fs.chmodSync(settingsPath, 0o664);
    const previous = process.umask(0o077);
    try {
      installIntegration('claude', home);
    } finally {
      process.umask(previous);
    }
    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o664);
  });

  it('is idempotent and uninstall removes exactly what install added', () => {
    const home = tempHome();
    installIntegration('codex', home);
    installIntegration('codex', home);
    const hooksPath = path.join(home, '.codex/hooks.json');
    const hooks = readJson(hooksPath)['hooks'] as Record<string, unknown[]>;
    expect(hooks['PostToolUse']).toHaveLength(1);
    expect(Object.keys(hooks).sort()).toEqual([
      'Interrupt',
      'PostToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'SubagentStop',
      'UserPromptSubmit',
    ]);

    const after = uninstallIntegration('codex', home);
    expect(after.installed).toBe(false);
    expect(fs.existsSync(path.join(home, '.codex/lcars-hook.sh'))).toBe(false);
    expect(readJson(hooksPath)).toEqual({});
  });

  it('keeps a foreign hook that shares a group with ours, on install and uninstall', () => {
    const home = tempHome();
    const settingsPath = path.join(home, '.codex/hooks.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'theirs' },
                { type: 'command', command: stubCommand('codex') },
              ],
            },
          ],
          Notification: [
            { hooks: [{ type: 'command', command: 'tmux-bell' }] },
          ],
          PreCompact: [
            {
              hooks: [
                { type: 'command', command: 'cat ~/.codex/lcars-hook.sh' },
              ],
            },
          ],
        },
      }),
    );
    installIntegration('codex', home);
    type Hooks = Record<
      string,
      Array<{ hooks: Array<Record<string, unknown>> }>
    >;
    let hooks = readJson(settingsPath)['hooks'] as Hooks;
    expect(hooks['Stop']).toHaveLength(1);
    expect(hooks['Stop'][0].hooks.map((h) => h['command'])).toEqual([
      'theirs',
      stubCommand('codex'),
    ]);
    expect(hooks['Notification']).toHaveLength(1);
    uninstallIntegration('codex', home);
    hooks = readJson(settingsPath)['hooks'] as Hooks;
    expect(hooks['Stop'][0].hooks.map((h) => h['command'])).toEqual(['theirs']);
    expect(hooks['Notification']).toHaveLength(1);
    expect(hooks['PostToolUse']).toBeUndefined();
    // A foreign command that merely mentions the stub path is not ours.
    expect(hooks['PreCompact']).toHaveLength(1);
  });

  it('follows CODEX_HOME and CLAUDE_CONFIG_DIR with an absolute stub path', () => {
    const home = tempHome();
    const codexHome = path.join(home, 'volatile', 'codex-home');
    const claudeDir = path.join(home, 'claude-config');
    const env = { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeDir };
    expect(installIntegration('codex', home, env).installed).toBe(true);
    expect(installIntegration('claude', home, env).installed).toBe(true);
    const codexHooks = readJson(path.join(codexHome, 'hooks.json'))[
      'hooks'
    ] as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    const stub = path.join(codexHome, 'lcars-hook.sh');
    expect(codexHooks['Stop'][0].hooks[0]['command']).toBe(
      stubCommand('codex', stub),
    );
    expect(fs.existsSync(stub)).toBe(true);
    expect(fs.existsSync(path.join(claudeDir, 'hooks', 'lcars-hook.sh'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
    expect(uninstallIntegration('codex', home, env).installed).toBe(false);
    expect(fs.existsSync(stub)).toBe(false);
  });

  it('refuses a relocated config dir that cannot be quoted safely', () => {
    const home = tempHome();
    expect(() =>
      installIntegration('codex', home, { CODEX_HOME: `${home}/a"b` }),
    ).toThrow(/shell-unsafe/);
  });

  it('reports an outdated stub as not installed', () => {
    const home = tempHome();
    installIntegration('claude', home);
    fs.writeFileSync(
      path.join(home, '.claude/hooks/lcars-hook.sh'),
      '#!/bin/sh\n# LCARS_INTEGRATION_VERSION=0\n',
    );
    expect(integrationStatus('claude', home)).toMatchObject({
      stubInstalled: true,
      stubVersion: 0,
      stubCurrent: false,
      installed: false,
    });
  });

  it('exposes install/status/uninstall through the CLI with exit codes', () => {
    const home = tempHome();
    const stdout = vi.fn();
    const stderr = vi.fn();
    expect(
      executeIntegrationCommand(['status', 'claude'], {
        homeDirectory: home,
        env: {},
        stdout,
        stderr,
      }),
    ).toBe(1);
    expect(
      executeIntegrationCommand(['install', 'all'], {
        homeDirectory: home,
        env: {},
        stdout,
        stderr,
      }),
    ).toBe(0);
    expect(
      executeIntegrationCommand(['status', 'all'], {
        homeDirectory: home,
        env: {},
        stdout,
        stderr,
      }),
    ).toBe(0);
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining('codex: installed'),
    );
    expect(stdout).toHaveBeenLastCalledWith('opencode: installed (plugin v1)');
    expect(
      executeIntegrationCommand(['bogus', 'claude'], {
        homeDirectory: home,
        env: {},
        stdout,
        stderr,
      }),
    ).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('usage:'));
  });

  it('installs the OpenCode plugin under XDG_CONFIG_HOME and removes it', () => {
    const home = tempHome();
    const env = { XDG_CONFIG_HOME: path.join(home, 'xdg') };
    const pluginPath = opencodePluginPath(home, env);
    expect(pluginPath).toBe(
      path.join(home, 'xdg/opencode/plugins/lcars-telemetry.js'),
    );
    expect(integrationStatus('opencode', home, env).installed).toBe(false);

    expect(installIntegration('opencode', home, env)).toMatchObject({
      runtime: 'opencode',
      stubInstalled: true,
      stubVersion: 1,
      installed: true,
    });
    expect(fs.readFileSync(pluginPath, 'utf8')).toBe(OPENCODE_TELEMETRY_PLUGIN);
    expect(fs.statSync(pluginPath).mode & 0o777).toBe(0o600);

    fs.writeFileSync(pluginPath, '// LCARS_INTEGRATION_VERSION=0\n');
    expect(integrationStatus('opencode', home, env)).toMatchObject({
      stubVersion: 0,
      stubCurrent: false,
      installed: false,
    });

    expect(uninstallIntegration('opencode', home, env).stubInstalled).toBe(
      false,
    );
    expect(fs.existsSync(pluginPath)).toBe(false);
    // Uninstalling twice is a no-op.
    expect(uninstallIntegration('opencode', home, env).installed).toBe(false);
  });

  it('defaults the OpenCode plugin directory to ~/.config', () => {
    const home = tempHome();
    expect(opencodePluginPath(home, {})).toBe(
      path.join(home, '.config/opencode/plugins/lcars-telemetry.js'),
    );
  });

  it('embeds the repository OpenCode plugin byte for byte', () => {
    const source = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../../../agents/opencode/lcars-telemetry.js',
      ),
      'utf8',
    );
    expect(OPENCODE_TELEMETRY_PLUGIN).toBe(source);
  });
});
