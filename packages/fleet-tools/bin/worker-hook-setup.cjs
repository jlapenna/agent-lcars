#!/usr/bin/env node
'use strict';

// Setup owns registration and identity binding. A native execution smoke must
// still succeed before the caller launches task work.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const policy = require('./worker-policy.cjs');
const marker = '# lcars-worker-pretool:v1';
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value);

function verifyModules(files) {
  for (const file of files) {
    if (!path.isAbsolute(file))
      throw new Error('Worker setup requires absolute module paths');
    fs.accessSync(file, fs.constants.R_OK);
    const checked = spawnSync(process.execPath, ['--check', file], {
      timeout: 5000,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    if (checked.error || checked.status !== 0)
      throw new Error('Worker hook setup: invalid executable module');
  }
}

function updateJson(configPath, transform) {
  if (!path.isAbsolute(configPath))
    throw new Error('Worker setup requires absolute configuration paths');
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
  if (!object(config))
    throw new Error('Worker hook setup: invalid configuration');
  const after = JSON.stringify(transform(config), null, 2) + '\n';
  if (after === before) return { changed: false };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temporary = fs.mkdtempSync(
    path.join(path.dirname(configPath), '.lcars-hook-setup-'),
  );
  try {
    const staged = path.join(temporary, 'config.json');
    fs.writeFileSync(staged, after, { mode });
    const currentStat = fs.lstatSync(configPath, { throwIfNoEntry: false });
    if (currentStat && (!currentStat.isFile() || currentStat.isSymbolicLink()))
      throw new Error('Configuration replaced during setup');
    const current = currentStat ? fs.readFileSync(configPath, 'utf8') : '';
    if (current !== before)
      throw new Error('Worker hook configuration changed during setup');
    fs.renameSync(staged, configPath);
    if (fs.readFileSync(configPath, 'utf8') !== after)
      throw new Error('Worker hook setup readback failed');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return { changed: true };
}

function installRegistration(configPath, handlerPath) {
  const bridge = path.join(__dirname, 'worker-hook-bridge.cjs');
  verifyModules([bridge, handlerPath]);
  const command =
    [quote(process.execPath), quote(bridge), quote(handlerPath)].join(' ') +
    " || { echo 'LCARS hook bridge failed; action denied' >&2; exit 2; } " +
    marker;
  const result = updateJson(configPath, (config) => {
    if (config.hooks !== undefined && !object(config.hooks))
      throw new Error('Invalid hook configuration');
    const groups = config.hooks?.PreToolUse ?? [];
    if (
      !Array.isArray(groups) ||
      groups.some((group) => !object(group) || !Array.isArray(group.hooks))
    )
      throw new Error('Invalid PreToolUse groups');
    const retained = groups.flatMap((group) => {
      const hooks = group.hooks.filter(
        (hook) =>
          !(typeof hook?.command === 'string' && hook.command.endsWith(marker)),
      );
      if (hooks.length === group.hooks.length) return [group];
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    config.hooks = {
      ...config.hooks,
      PreToolUse: [
        ...retained,
        {
          matcher: '.*',
          hooks: [{ type: 'command', command, timeout: 10 }],
        },
      ],
    };
    return config;
  });
  return { ...result, command };
}

function installOpenCode(
  configPath,
  pluginPath = path.join(__dirname, 'worker-opencode-plugin.mjs'),
) {
  verifyModules([
    pluginPath,
    path.join(__dirname, 'worker-policy.cjs'),
    path.join(__dirname, 'worker-hook-bridge.cjs'),
  ]);
  const plugin = pathToFileURL(pluginPath).href;
  return updateJson(configPath, (config) => {
    if (config.plugin !== undefined && !Array.isArray(config.plugin))
      throw new Error('Invalid OpenCode plugin configuration');
    // Package/image paths stay stable across updates. Never remove unrelated
    // plugins merely because their basename resembles ours.
    config.plugin = [
      ...(config.plugin ?? []).filter(
        (entry) => entry !== plugin && entry !== pluginPath,
      ),
      plugin,
    ];
    return config;
  });
}

function prepareWorker({
  provider,
  configPath,
  contextPath,
  briefPath,
  runId,
  attemptId,
}) {
  if (
    ![configPath, contextPath, briefPath].every(
      (file) => typeof file === 'string' && path.isAbsolute(file),
    ) ||
    new Set(
      [configPath, contextPath, briefPath].map((file) => path.resolve(file)),
    ).size !== 3
  )
    throw new Error('Setup paths must be absolute and distinct');
  const context = policy.prepareContext(
    JSON.parse(fs.readFileSync(briefPath, 'utf8')),
    { provider, runId, attemptId },
  );
  // Each attempt gets its own path. Repeat setup is a no-op; reuse by another
  // dispatch is an error rather than changing the identity of a live session.
  const binding = updateJson(contextPath, (existing) => {
    if (
      Object.keys(existing).length &&
      JSON.stringify(existing) !== JSON.stringify(context)
    )
      throw new Error('Worker context already belongs to another dispatch');
    return context;
  });
  const registration =
    provider === 'opencode'
      ? installOpenCode(configPath)
      : installRegistration(
          configPath,
          path.join(__dirname, 'worker-policy.cjs'),
        );
  return {
    changed: binding.changed || registration.changed,
    contextPath,
    executionSmokeRequired: true,
  };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    let result;
    if (args[0] === '--worker' && args.length === 7) {
      const [, provider, configPath, contextPath, briefPath, runId, attemptId] =
        args;
      result = prepareWorker({
        provider,
        configPath,
        contextPath,
        briefPath,
        runId,
        attemptId,
      });
    } else {
      const [configPath, handlerPath, ...extra] = args;
      if (extra.length || !configPath || !handlerPath)
        throw new Error('Expected configuration and handler paths');
      result = installRegistration(configPath, handlerPath);
    }
    process.stdout.write(
      JSON.stringify({
        changed: result.changed,
        contextPath: result.contextPath,
        executionSmokeRequired: true,
      }) + '\n',
    );
  } catch {
    process.stderr.write(
      'LCARS worker hook setup failed; worker launch must not proceed.\n',
    );
    process.exitCode = 1;
  }
}

module.exports = { installRegistration, installOpenCode, prepareWorker };
