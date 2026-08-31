import {
  isSafeIdentifier,
  SESSION_AGENTS,
  SessionSchemaBackfill,
  sessionSchemaBackfillPatch,
  sessionSchemaGaps,
} from '@agent-lcars/telemetry';
import * as fs from 'fs';

import { loadSharedConfig } from './lib/config';
import {
  createSessionSchemaMigrationStore,
  SessionSchemaMigrationStore,
} from './lib/store';

const MAX_BACKFILL_SESSIONS = 200;

interface Manifest {
  sessions: SessionSchemaBackfill[];
}

interface Flags {
  manifest?: string;
  inventory?: boolean;
  limit?: number;
  apply?: boolean;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateManifestEntry(
  entry: unknown,
): asserts entry is SessionSchemaBackfill {
  if (
    typeof entry !== 'object' ||
    entry === null ||
    !isSafeIdentifier((entry as { sessionId?: string }).sessionId ?? '')
  ) {
    throw new Error('Each manifest session requires a safe sessionId');
  }
  const candidate = entry as {
    agent?: unknown;
    repo?: { owner?: unknown; name?: unknown };
    renderable?: unknown;
  };
  if (
    !SESSION_AGENTS.includes(candidate.agent as (typeof SESSION_AGENTS)[number])
  ) {
    throw new Error(
      `Session ${(entry as SessionSchemaBackfill).sessionId} has an unsupported agent`,
    );
  }
  if (
    !isNonEmptyString(candidate.repo?.owner) ||
    !isNonEmptyString(candidate.repo?.name)
  ) {
    throw new Error(
      `Session ${(entry as SessionSchemaBackfill).sessionId} requires a non-empty repo owner and name`,
    );
  }
  if (
    candidate.renderable !== undefined &&
    typeof candidate.renderable !== 'boolean'
  ) {
    throw new Error(
      `Session ${(entry as SessionSchemaBackfill).sessionId} has a non-boolean renderable value`,
    );
  }
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--inventory') flags.inventory = true;
    else if (value === '--apply') flags.apply = true;
    else if (value === '--manifest' && argv[index + 1]) {
      flags.manifest = argv[++index];
    } else if (value === '--limit' && argv[index + 1]) {
      flags.limit = Number(argv[++index]);
    }
  }
  return flags;
}

function migrationStore(): SessionSchemaMigrationStore {
  const config = loadSharedConfig();
  const projectId = config.firestoreProjectId;
  if (!projectId) {
    throw new Error('AGENT_TELEMETRY_PROJECT_ID is required');
  }
  return createSessionSchemaMigrationStore({
    projectId,
    ...(config.firestoreWriterKeyJson && {
      credentials: JSON.parse(config.firestoreWriterKeyJson) as {
        client_email: string;
        private_key: string;
      },
    }),
    ...(config.firestoreEmulatorHost && {
      emulatorHost: config.firestoreEmulatorHost,
    }),
  });
}

function readManifest(path: string): Manifest {
  const parsed: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as Manifest).sessions)
  ) {
    throw new Error('Manifest must be an object with a sessions array');
  }
  const manifest = parsed as Manifest;
  if (
    manifest.sessions.length === 0 ||
    manifest.sessions.length > MAX_BACKFILL_SESSIONS
  ) {
    throw new Error(
      `Manifest must contain 1-${MAX_BACKFILL_SESSIONS} explicit sessions`,
    );
  }
  if (
    new Set(manifest.sessions.map((entry) => entry.sessionId)).size !==
    manifest.sessions.length
  ) {
    throw new Error('Manifest contains duplicate session IDs');
  }
  manifest.sessions.forEach(validateManifestEntry);
  return manifest;
}

async function inventory(
  store: SessionSchemaMigrationStore,
  limit: number,
): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BACKFILL_SESSIONS) {
    throw new Error(
      `--limit must be an integer from 1 to ${MAX_BACKFILL_SESSIONS}`,
    );
  }
  const records = (await store.inventory(limit)).map((snapshot) => ({
    sessionId: snapshot.sessionId,
    gaps: sessionSchemaGaps(snapshot.data),
  }));
  process.stdout.write(`${JSON.stringify({ limit, records }, null, 2)}\n`);
}

async function backfill(
  store: SessionSchemaMigrationStore,
  manifest: Manifest,
  apply: boolean,
): Promise<void> {
  const results: { sessionId: string; changed: boolean }[] = [];
  for (const entry of manifest.sessions) {
    const data = await store.get(entry.sessionId);
    if (data === undefined) {
      throw new Error(`Session ${entry.sessionId} was not found`);
    }
    const storedDocument = data as Record<string, unknown>;
    const patch = sessionSchemaBackfillPatch(storedDocument, entry);
    const changed = Object.entries(patch).some(
      ([key, value]) =>
        JSON.stringify(storedDocument[key]) !== JSON.stringify(value),
    );
    if (apply && changed) await store.patchSchema(entry.sessionId, patch);
    results.push({ sessionId: entry.sessionId, changed });
  }
  process.stdout.write(
    `${JSON.stringify({ mode: apply ? 'apply' : 'dry-run', results }, null, 2)}\n`,
  );
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.inventory && !flags.manifest) {
    throw new Error('Pass --inventory or --manifest <path>');
  }
  if (flags.inventory && flags.manifest) {
    throw new Error('--inventory and --manifest cannot be combined');
  }
  const store = migrationStore();
  if (flags.inventory) {
    await inventory(store, flags.limit ?? MAX_BACKFILL_SESSIONS);
    return;
  }
  await backfill(
    store,
    readManifest(flags.manifest as string),
    flags.apply ?? false,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
