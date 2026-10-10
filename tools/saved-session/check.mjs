#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { request } from '@playwright/test';

import {
  DEFAULT_ORIGIN,
  DEFAULT_PROJECT,
  isSessionRole,
  isStorageBackend,
  loadStorageState,
  normalizeOrigin,
  secretNameForRole,
} from './saved-session-lib.mjs';
import {
  authenticatedSessionReadiness,
  readinessExitCode,
  readinessMessage,
} from './session-readiness.mjs';

async function main() {
  const { values } = parseArgs({
    options: {
      role: { type: 'string', default: 'admin' },
      storage: { type: 'string', default: 'local' },
      origin: { type: 'string', default: DEFAULT_ORIGIN },
      'state-file': { type: 'string' },
      project: { type: 'string', default: DEFAULT_PROJECT },
      'secret-name': { type: 'string' },
      'minimum-valid-days': { type: 'string', default: '14' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: ./tools/nx run @agent-lcars/console:check-session -- ' +
        '[--role admin|user] [--storage local|secret] [--origin origin] ' +
        '[--state-file path] [--project project] [--secret-name name] ' +
        '[--minimum-valid-days days]',
    );
    return 0;
  }
  const minimumValidDays = Number(values['minimum-valid-days']);
  if (
    !isSessionRole(values.role) ||
    !isStorageBackend(values.storage) ||
    !Number.isFinite(minimumValidDays) ||
    minimumValidDays < 0
  ) {
    throw new Error('Invalid readiness arguments.');
  }
  const origin = normalizeOrigin(values.origin);
  const { storageState } = await loadStorageState(
    {
      storage: values.storage,
      role: values.role,
      stateFile: values['state-file'],
      project: values.project,
      secretName: values['secret-name'] ?? secretNameForRole(values.role),
    },
    {
      runFile: (file, args, options) =>
        execFileSync(file, args, { ...options, timeout: 20_000 }),
    },
  );
  const readiness = await authenticatedSessionReadiness(
    storageState,
    {
      origin,
      role: values.role,
      minimumValidDays,
    },
    { requestFactory: request },
  );
  console.log(readinessMessage(readiness));
  return readinessExitCode(readiness.status);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    // Request/parser errors can contain server-controlled text. Never echo it.
    console.error(
      'SESSION_READINESS_UNAVAILABLE: Check the origin, saved-state access and Auth.js endpoint. Use --help for valid options.',
    );
    process.exitCode = 1;
  });
