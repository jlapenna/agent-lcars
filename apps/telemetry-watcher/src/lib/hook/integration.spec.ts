import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  executeIntegrationCommand,
  installIntegration,
  INTEGRATION_VERSION,
  integrationStatus,
  stubCommand,
  uninstallIntegration,
} from './integration';

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
        stdout,
        stderr,
      }),
    ).toBe(1);
    expect(
      executeIntegrationCommand(['install', 'all'], {
        homeDirectory: home,
        stdout,
        stderr,
      }),
    ).toBe(0);
    expect(
      executeIntegrationCommand(['status', 'all'], {
        homeDirectory: home,
        stdout,
        stderr,
      }),
    ).toBe(0);
    expect(stdout).toHaveBeenLastCalledWith(
      expect.stringContaining('codex: installed'),
    );
    expect(
      executeIntegrationCommand(['bogus', 'claude'], {
        homeDirectory: home,
        stdout,
        stderr,
      }),
    ).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('usage:'));
  });
});
