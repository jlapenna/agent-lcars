#!/usr/bin/env node

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CANONICAL_ENV = fileURLToPath(new URL('./ci.env', import.meta.url));

const SAFE_CREDENTIAL_VALUES = new Map([
  ['AGENT_LCARS_GITHUB_TOKEN', 'dummy-secret'],
  ['AUTH_SECRET', 'dummy-secret'],
  ['NEXT_PUBLIC_FIREBASE_API_KEY', 'demo-api-key'],
]);

const CREDENTIAL_KEY =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIALS?|PRIVATE_KEY|API_KEY|ACCESS_KEY|KEY)(?:_|$)/i;
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const DANGEROUS_DOTENV_KEYS = new Set([
  'BASH_ENV',
  'ENV',
  'HOME',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PATH',
  'SHELLOPTS',
]);

function unquote(value) {
  if (value.length >= 2) {
    const first = value.at(0);
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseFile(file, { required = false } = {}) {
  if (!fs.existsSync(file)) {
    if (required) {
      throw new Error(`${file}: required E2E environment fixture is missing`);
    }
    return new Map();
  }

  const entries = new Map();
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u);

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(
      line,
    );
    if (!match) {
      throw new Error(`${file}:${index + 1}: invalid dotenv entry`);
    }

    const [, key, rawValue] = match;
    if (entries.has(key)) {
      throw new Error(`${file}:${index + 1}: duplicate key ${key}`);
    }
    const value = unquote(rawValue.trim());
    entries.set(key, { line: index + 1, value });
  }

  return entries;
}

function validateEntry(file, key, line, value, schema) {
  if (key === 'DEBUG' && TRUTHY.has(value.toLowerCase())) {
    throw new Error(
      `${file}:${line}: DEBUG must not enable verbose dependency output`,
    );
  }

  if (DANGEROUS_DOTENV_KEYS.has(key)) {
    throw new Error(
      `${file}:${line}: ${key} cannot be set by an E2E dotenv file`,
    );
  }

  if (schema && !schema.has(key)) {
    throw new Error(
      `${file}:${line}: ${key} is not part of the checked-in E2E environment schema`,
    );
  }

  if (CREDENTIAL_KEY.test(key)) {
    const safeValue = SAFE_CREDENTIAL_VALUES.get(key);
    if (safeValue === undefined || value !== safeValue) {
      throw new Error(
        `${file}:${line}: ${key} is not an approved E2E dummy credential`,
      );
    }
  }
}

function validateFile(file, schema) {
  for (const [key, { line, value }] of parseFile(file)) {
    validateEntry(file, key, line, value, schema);
  }
}

function validateProcessEnvironment() {
  for (const [key, value] of Object.entries(process.env)) {
    if (!CREDENTIAL_KEY.test(key)) {
      continue;
    }

    const safeValue = SAFE_CREDENTIAL_VALUES.get(key);
    if (safeValue === undefined || value !== safeValue) {
      throw new Error(
        `process environment contains unexpected credential-shaped key ${key}`,
      );
    }
  }
}

function parseArguments(args) {
  const options = { files: [], nextRoots: [], requireHermetic: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--require-hermetic') {
      options.requireHermetic = true;
    } else if (arg === '--next-root') {
      const nextRoot = args[index + 1];
      if (!nextRoot) {
        throw new Error('--next-root requires a directory');
      }
      options.nextRoots.push(nextRoot);
      index += 1;
    } else {
      options.files.push(arg);
    }
  }

  return options;
}

function validateNextEnvironment(nextRoot, schema) {
  for (const name of [
    '.env.production.local',
    '.env.local',
    '.env.production',
    '.env',
  ]) {
    validateFile(`${nextRoot}/${name}`, schema);
  }
}

try {
  const { files, nextRoots, requireHermetic } = parseArguments(
    process.argv.slice(2),
  );
  const schemaEntries = parseFile(CANONICAL_ENV, { required: true });
  const schema = new Set(schemaEntries.keys());

  for (const [key, { line, value }] of schemaEntries) {
    validateEntry(CANONICAL_ENV, key, line, value);
  }

  if (requireHermetic) {
    if (process.env.E2E_HERMETIC !== '1') {
      throw new Error(
        'internal E2E target requires the hermetic wrapper or Docker boundary',
      );
    }
    validateProcessEnvironment();
  }

  for (const file of files) {
    validateFile(file, schema);
  }
  for (const nextRoot of nextRoots) {
    validateNextEnvironment(nextRoot, schema);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`E2E environment rejected: ${message}`);
  process.exitCode = 1;
}
