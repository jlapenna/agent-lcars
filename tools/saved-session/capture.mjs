#!/usr/bin/env node
import * as readline from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { chromium } from '@playwright/test';

import {
  DEFAULT_ORIGIN,
  DEFAULT_PROJECT,
  isSessionRole,
  isStorageBackend,
  normalizeOrigin,
  saveStorageState,
  secretNameForRole,
  SESSION_ROLES,
  sessionStatus,
  STORAGE_BACKENDS,
} from './saved-session-lib.mjs';

function usage() {
  console.error(
    'Usage: ./tools/nx run @agent-lcars/console:capture-session -- [--role <admin|user>] ' +
      '[--storage <local|secret>] [--origin <origin>] [--state-file <path>] ' +
      '[--project <gcp-project>] [--secret-name <name>]\n' +
      '  --origin defaults to AGENT_LCARS_CONSOLE_URL when set',
  );
}

async function readAuthenticatedSession(context, origin) {
  const response = await context.request.get(
    new URL('/api/auth/session', origin).toString(),
  );
  if (!response.ok()) {
    throw new Error(
      `Auth.js session endpoint returned ${response.status()} ${response.statusText()}.`,
    );
  }
  return response.json();
}

async function main() {
  const { values } = parseArgs({
    options: {
      role: { type: 'string', default: 'admin' },
      storage: { type: 'string', default: 'local' },
      origin: { type: 'string', default: DEFAULT_ORIGIN },
      'state-file': { type: 'string' },
      project: { type: 'string', default: DEFAULT_PROJECT },
      'secret-name': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    usage();
    return 0;
  }
  if (!isSessionRole(values.role) || !isStorageBackend(values.storage)) {
    usage();
    throw new Error(
      `Role must be one of ${SESSION_ROLES.join(', ')} and storage must be one of ${STORAGE_BACKENDS.join(', ')}.`,
    );
  }

  const origin = normalizeOrigin(values.origin);
  const role = values.role;
  const storage = values.storage;
  const secretName = values['secret-name'] ?? secretNameForRole(role);
  const browser = await chromium.launch({ headless: false });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const prompt = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      const loginUrl = new URL('/login', origin).toString();
      console.log(`Opening ${loginUrl} ...`);
      await page.goto(loginUrl);
      console.log(
        `\nComplete GitHub sign-in in the opened browser. The captured ${role} state is a live bearer credential; use only the account and storage location you intend to authorize for testing.`,
      );
      await prompt.question(
        'Press Enter once the console has loaded outside the login page... ',
      );

      const session = await readAuthenticatedSession(context, origin);
      const status = sessionStatus(session, role);
      if (status === 'expired') {
        throw new Error(
          'No authenticated Auth.js session was found. Nothing was saved.',
        );
      }
      if (status === 'wrong-role') {
        throw new Error(
          'The authenticated session is not an LCARS admin session. Nothing was saved.',
        );
      }

      const storageState = await context.storageState();
      const result = await saveStorageState(storageState, {
        storage,
        role,
        stateFile: values['state-file'],
        project: values.project,
        secretName,
      });
      const defaultReuseCommand =
        origin === DEFAULT_ORIGIN &&
        !values['state-file'] &&
        values.project === DEFAULT_PROJECT &&
        !values['secret-name'];
      console.log(
        defaultReuseCommand
          ? `Saved ${role} session to ${result.destination}. Reuse it with: ` +
              `./tools/nx run @agent-lcars/console:verify-session -- --role ${role} --storage ${storage} --path /`
          : `Saved ${role} session to ${result.destination}. Reuse it with the @agent-lcars/console:verify-session Nx target and the same role, storage, origin, and location options.`,
      );
      return 0;
    } finally {
      prompt.close();
    }
  } finally {
    await browser.close();
  }
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
