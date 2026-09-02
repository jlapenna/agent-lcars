#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { chromium } from '@playwright/test';

import {
  assertSuccessfulNavigation,
  DEFAULT_ORIGIN,
  DEFAULT_PROJECT,
  isSessionRole,
  isStorageBackend,
  loadStorageState,
  normalizeOrigin,
  savedSessionExpiration,
  secretNameForRole,
  SESSION_ROLES,
  STORAGE_BACKENDS,
  targetUrlFor,
  verificationStatus,
} from './saved-session-lib.mjs';

function usage() {
  console.error(
    'Usage: ./tools/nx run @agent-lcars/console:verify-session -- --path <path> [--role <admin|user>] ' +
      '[--storage <local|secret>] [--origin <origin>] [--state-file <path>] ' +
      '[--project <gcp-project>] [--secret-name <name>] ' +
      '[--wait-for <selector>] [--click <selector>] [--assert-text <text>] ' +
      '[--minimum-valid-days <days>] ' +
      '[--screenshot <path>] [--screenshot-mode <viewport|full-page>]\n' +
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
      path: { type: 'string' },
      role: { type: 'string', default: 'admin' },
      storage: { type: 'string', default: 'local' },
      origin: { type: 'string', default: DEFAULT_ORIGIN },
      'state-file': { type: 'string' },
      project: { type: 'string', default: DEFAULT_PROJECT },
      'secret-name': { type: 'string' },
      'wait-for': { type: 'string' },
      click: { type: 'string' },
      'assert-text': { type: 'string', multiple: true },
      'minimum-valid-days': { type: 'string', default: '0' },
      screenshot: { type: 'string' },
      'screenshot-mode': { type: 'string', default: 'full-page' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    usage();
    return 0;
  }
  if (
    !values.path ||
    !isSessionRole(values.role) ||
    !isStorageBackend(values.storage) ||
    !['viewport', 'full-page'].includes(values['screenshot-mode']) ||
    !Number.isFinite(Number(values['minimum-valid-days'])) ||
    Number(values['minimum-valid-days']) < 0
  ) {
    usage();
    throw new Error(
      `Path is required; role must be one of ${SESSION_ROLES.join(', ')}, storage must be one of ${STORAGE_BACKENDS.join(', ')}, and minimum-valid-days must be a non-negative number.`,
    );
  }

  const origin = normalizeOrigin(values.origin);
  const target = targetUrlFor(origin, values.path);
  const role = values.role;
  const storage = values.storage;
  const secretName = values['secret-name'] ?? secretNameForRole(role);
  const { storageState, source } = await loadStorageState({
    storage,
    role,
    stateFile: values['state-file'],
    project: values.project,
    secretName,
  });
  const minimumValidDays = Number(values['minimum-valid-days']);
  if (minimumValidDays > 0) {
    const expiration = savedSessionExpiration(storageState);
    if (expiration === undefined) {
      console.error(
        `SESSION_EXPIRY_UNKNOWN: ${source} has no persistent Auth.js cookie expiry, so rotation cannot be scheduled safely.`,
      );
      return 4;
    }
    const minimumExpiration = Date.now() / 1000 + minimumValidDays * 86_400;
    if (expiration < minimumExpiration) {
      console.error(
        `SESSION_EXPIRING: ${source} expires before the required ${minimumValidDays}-day safety window. Re-run the @agent-lcars/console:mint-session target.`,
      );
      return 4;
    }
    console.log(
      `PASS: saved session remains valid for at least ${minimumValidDays} more days.`,
    );
  }

  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    const navigation = await page.goto(target.toString(), {
      waitUntil: 'networkidle',
    });
    assertSuccessfulNavigation(navigation, target);
    const landed = new URL(page.url());
    const session = await readAuthenticatedSession(context, origin);
    const status = verificationStatus(session, role, landed, target);
    if (status === 'expired') {
      console.error(
        `SESSION_EXPIRED: ${source} no longer authenticates. Re-run the @agent-lcars/console:mint-session or @agent-lcars/console:capture-session Nx target.`,
      );
      return 2;
    }
    if (status === 'wrong-role') {
      console.error(
        `ROLE_MISMATCH: ${source} authenticates, but it is not an LCARS admin session.`,
      );
      return 3;
    }
    if (status === 'redirected') {
      console.error(
        `REDIRECTED: requested ${target.toString()} but landed on ${page.url()}.`,
      );
      return 3;
    }

    console.log(
      `PASS: ${target.pathname} loaded with the saved ${role} session from ${source}.`,
    );

    if (values['wait-for']) {
      await page.locator(values['wait-for']).first().waitFor({
        state: 'visible',
        timeout: 10_000,
      });
      console.log(`PASS: ready selector "${values['wait-for']}" is visible.`);
    }
    if (values.click) {
      await page.locator(values.click).first().click({ timeout: 10_000 });
      await page.waitForLoadState('networkidle');
      console.log(`PASS: clicked "${values.click}".`);
    }
    for (const expectedText of values['assert-text'] ?? []) {
      await page.getByText(expectedText, { exact: false }).first().waitFor({
        state: 'visible',
        timeout: 10_000,
      });
      console.log(`PASS: text "${expectedText}" is visible.`);
    }

    const screenshot =
      values.screenshot ??
      `/tmp/verify-agent-lcars-${role}-${Date.now().toString()}.png`;
    await page.screenshot({
      path: screenshot,
      fullPage: values['screenshot-mode'] === 'full-page',
    });
    console.log(`Screenshot saved to ${screenshot}.`);
    return 0;
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
