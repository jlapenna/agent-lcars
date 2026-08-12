#!/usr/bin/env node
import { parseArgs } from 'node:util';

import {
  DEFAULT_AUTH_SECRET_NAME,
  mintStorageState,
  readSecretValue,
} from './mint-session-lib.mjs';
import {
  DEFAULT_ORIGIN,
  DEFAULT_PROJECT,
  isStorageBackend,
  normalizeOrigin,
  saveStorageState,
  secretNameForRole,
  STORAGE_BACKENDS,
} from './saved-session-lib.mjs';

function usage() {
  console.error(
    'Usage: ./tools/nx run @agent-lcars/console:mint-session -- ' +
      '[--storage <local|secret>] [--origin <origin>] [--state-file <path>] ' +
      '[--project <gcp-project>] [--secret-name <name>] ' +
      '[--auth-secret-name <name>]',
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      storage: { type: 'string', default: 'local' },
      origin: { type: 'string', default: DEFAULT_ORIGIN },
      'state-file': { type: 'string' },
      project: { type: 'string', default: DEFAULT_PROJECT },
      'secret-name': { type: 'string' },
      'auth-secret-name': {
        type: 'string',
        default: DEFAULT_AUTH_SECRET_NAME,
      },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    usage();
    return 0;
  }
  if (!isStorageBackend(values.storage)) {
    usage();
    throw new Error(`Storage must be one of ${STORAGE_BACKENDS.join(', ')}.`);
  }

  const origin = normalizeOrigin(values.origin);
  const secretName = values['secret-name'] ?? secretNameForRole('admin');
  const authSecret = readSecretValue(
    values['auth-secret-name'],
    values.project,
  );
  const storageState = await mintStorageState({ authSecret, origin });
  const result = await saveStorageState(storageState, {
    storage: values.storage,
    role: 'admin',
    stateFile: values['state-file'],
    project: values.project,
    secretName,
  });

  console.log(
    `Minted a 30-day dedicated admin verification session in ${result.destination}. ` +
      'The Auth.js secret and session token were not printed.',
  );
  console.log(
    `Verify it with: ./tools/nx run @agent-lcars/console:verify-session -- --role admin --storage ${values.storage} --path /`,
  );
  return 0;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    usage();
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
