#!/usr/bin/env node
'use strict';

// Registration primitive for worker bootstrap. Native execution verification
// must succeed after this returns and before the caller launches task work.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const marker = '# lcars-worker-pretool:v1';
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function installRegistration(configPath, handlerPath) {
  if (!path.isAbsolute(configPath) || !path.isAbsolute(handlerPath)) {
    throw new Error(
      'Worker hook setup requires absolute configuration and handler paths',
    );
  }
  const bridge = path.join(__dirname, 'worker-hook-bridge.cjs');
  // Installation verification happens here, never once per tool action.
  for (const file of [bridge, handlerPath]) {
    fs.accessSync(file, fs.constants.R_OK);
    const checked = spawnSync(process.execPath, ['--check', file], {
      timeout: 5000,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    if (checked.error || checked.status !== 0)
      throw new Error('Worker hook setup: invalid executable module');
  }
  let before = '',
    mode = 0o600;
  const stat = fs.lstatSync(configPath, { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(
        'Worker hook setup will not replace a non-regular config',
      );
    mode = stat.mode & 0o777;
    before = fs.readFileSync(configPath, 'utf8');
  }
  const config = before ? JSON.parse(before) : {};
  const object = (value) =>
    value && typeof value === 'object' && !Array.isArray(value);
  if (
    !object(config) ||
    (config.hooks !== undefined && !object(config.hooks))
  ) {
    throw new Error('Worker hook setup: invalid hook configuration');
  }
  const groups = config.hooks?.PreToolUse ?? [];
  if (
    !Array.isArray(groups) ||
    groups.some((group) => !object(group) || !Array.isArray(group.hooks))
  ) {
    throw new Error('Worker hook setup: invalid PreToolUse groups');
  }
  // Remove only our previous managed handler, including when it shares a
  // matcher group with an unrelated hook. Preserve all other settings.
  const retained = groups.flatMap((group) => {
    const hooks = group.hooks.filter(
      (hook) =>
        !(typeof hook?.command === 'string' && hook.command.endsWith(marker)),
    );
    if (hooks.length === group.hooks.length) return [group];
    return hooks.length ? [{ ...group, hooks }] : [];
  });
  const command = `${quote(process.execPath)} ${quote(bridge)} ${quote(handlerPath)} || { echo 'LCARS hook bridge failed; action denied' >&2; exit 2; } ${marker}`;
  const managed = {
    matcher: '.*',
    hooks: [{ type: 'command', command, timeout: 10 }],
  };
  config.hooks = { ...config.hooks, PreToolUse: [...retained, managed] };
  const after = `${JSON.stringify(config, null, 2)}\n`;
  if (after === before) return { changed: false, command };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temporary = fs.mkdtempSync(
    path.join(path.dirname(configPath), '.lcars-hook-setup-'),
  );
  try {
    const staged = path.join(temporary, 'config.json');
    fs.writeFileSync(staged, after, { mode });
    // Detect edits made while setup prepared the replacement; never clobber them.
    const current = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, 'utf8')
      : '';
    if (current !== before)
      throw new Error('Worker hook configuration changed during setup');
    fs.renameSync(staged, configPath);
    if (fs.readFileSync(configPath, 'utf8') !== after)
      throw new Error('Worker hook setup readback failed');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return { changed: true, command };
}

if (require.main === module) {
  try {
    const [configPath, handlerPath, ...extra] = process.argv.slice(2);
    if (extra.length || !configPath || !handlerPath)
      throw new Error('Expected configuration and handler paths');
    const result = installRegistration(configPath, handlerPath);
    process.stdout.write(
      `${JSON.stringify({ changed: result.changed, executionSmokeRequired: true })}\n`,
    );
  } catch {
    process.stderr.write(
      'LCARS worker hook setup failed; worker launch must not proceed.\n',
    );
    process.exitCode = 1;
  }
}

module.exports = { installRegistration };
