import {
  isSafeIdentifier,
  SESSION_AGENTS,
  SessionSchemaBackfill,
  sessionSchemaBackfillPatch,
  sessionSchemaGaps,
} from '@agent-lcars/telemetry';
import * as fs from 'fs';

import { loadSharedConfig } from './lib/config';
import { firestoreStoreOptions } from './lib/create-store';
import {
  createSessionSchemaMigrationStore,
  MAX_SESSION_SCHEMA_MIGRATION_PAGE_SIZE,
  SessionSchemaMigrationStore,
} from './lib/store';

interface Manifest {
  sessions: SessionSchemaBackfill[];
}

interface Flags {
  manifest?: string;
  inventory?: boolean;
  limit?: number;
  cursor?: string;
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
    } else if (value === '--cursor' && argv[index + 1]) {
      flags.cursor = argv[++index];
    }
  }
  return flags;
}

function migrationStore(): SessionSchemaMigrationStore {
  const config = loadSharedConfig();
  const options = firestoreStoreOptions(config);
  if (options === undefined) {
    throw new Error(
      'AGENT_TELEMETRY_PROJECT_ID is required unless FIRESTORE_EMULATOR_HOST is configured',
    );
  }
  return createSessionSchemaMigrationStore(options);
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
    manifest.sessions.length > MAX_SESSION_SCHEMA_MIGRATION_PAGE_SIZE
  ) {
    throw new Error(
      `Manifest must contain 1-${MAX_SESSION_SCHEMA_MIGRATION_PAGE_SIZE} explicit sessions`,
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
  cursor: string | undefined,
): Promise<void> {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_SESSION_SCHEMA_MIGRATION_PAGE_SIZE
  ) {
    throw new Error(
      `--limit must be an integer from 1 to ${MAX_SESSION_SCHEMA_MIGRATION_PAGE_SIZE}`,
    );
  }
  const page = await store.inventory({ limit, cursor: cursor ?? undefined });
  const records = page.records.map((snapshot) => ({
    sessionId: snapshot.sessionId,
    gaps: sessionSchemaGaps(snapshot.data),
  }));
  process.stdout.write(
    `${JSON.stringify(
      {
        limit,
        cursor: cursor ?? null,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor ?? null,
        records,
      },
      null,
      2,
    )}\n`,
  );
}

async function backfill(
  store: SessionSchemaMigrationStore,
  manifest: Manifest,
  apply: boolean,
): Promise<void> {
  const results: { sessionId: string; changed: boolean }[] = [];
  for (const entry of manifest.sessions) {
    if (apply) {
      // The store transaction re-reads and validates before writing so this
      // cannot turn a reviewed manifest into a stale read/overwrite race.
      const result = await store.applySchemaBackfill(entry);
      results.push({ sessionId: entry.sessionId, changed: result.changed });
    } else {
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
      results.push({ sessionId: entry.sessionId, changed });
    }
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
  if (!flags.inventory && flags.cursor !== undefined) {
    throw new Error('--cursor is only valid with --inventory');
  }
  const store = migrationStore();
  if (flags.inventory) {
    await inventory(
      store,
      flags.limit ?? MAX_SESSION_SCHEMA_MIGRATION_PAGE_SIZE,
      flags.cursor,
    );
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
