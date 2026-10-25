import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';

import {
  claudeCodeAdapter,
  CLI_TRANSCRIPT_MAX_BYTES,
  codexAdapter,
  type SessionDoc,
} from '@agent-lcars/telemetry';
import { FieldValue, Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';

import { loadHookClientConfig } from './hook/hook-config';
import { matchesRepoAllowlist } from './hook/repo-allowlist';
import { resolveSessionId } from './session-id';

export const CLI_ARCHIVE_USAGE =
  'usage: lcars session archive --consent <transcript.jsonl> | --revoke';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PREFIX = 'cli-consented-v1/';

/** Refuse uploads until the owning Terraform lifecycle has actually landed. */
export function cliArchiveRetentionReady(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const lifecycle = (metadata as { lifecycle?: { rule?: unknown } }).lifecycle;
  if (!Array.isArray(lifecycle?.rule)) return false;
  return lifecycle.rule.some((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return false;
    const rule = raw as {
      action?: { type?: unknown };
      condition?: Record<string, unknown>;
    };
    const condition = rule.condition;
    return (
      rule.action?.type === 'Delete' &&
      condition !== undefined &&
      typeof condition['age'] === 'number' &&
      condition['age'] >= 0 &&
      condition['age'] <= 7 &&
      Array.isArray(condition['matchesPrefix']) &&
      condition['matchesPrefix'].includes(PREFIX) &&
      Object.keys(condition).every((key) =>
        ['age', 'matchesPrefix'].includes(key),
      )
    );
  });
}

type ArchiveSession = Pick<
  SessionDoc,
  'sessionId' | 'source' | 'agent' | 'repo'
> & { host?: string };
export interface CliArchiveDependencies {
  env: NodeJS.ProcessEnv;
  now: () => Date;
  id: () => string;
  host: string;
  repos: readonly string[];
  bucket: string;
  getSession: (sessionId: string) => Promise<ArchiveSession | undefined>;
  /** Claim and publish use the same session identity fence as getSession. */
  claim: (session: ArchiveSession, captureId: string) => Promise<void>;
  fail: (session: ArchiveSession, captureId: string) => Promise<void>;
  publish: (
    session: ArchiveSession,
    captureId: string,
    uri: string,
    expiresAt: string,
  ) => Promise<boolean>;
  revoke: (session: ArchiveSession) => Promise<string | undefined>;
  upload: (object: string, bytes: Buffer) => Promise<void>;
  remove: (object: string) => Promise<void>;
}

/** Open once, refuse symlinks/nonfiles, and bound even a concurrently growing file. */
export function readCliArchive(file: string): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size === 0 ||
      stat.size > CLI_TRANSCRIPT_MAX_BYTES
    )
      throw new Error('archive-size');
    const bytes = Buffer.alloc(CLI_TRANSCRIPT_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!read) break;
      length += read;
    }
    if (!length || length > CLI_TRANSCRIPT_MAX_BYTES)
      throw new Error('archive-size');
    return bytes.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}

function sameSession(
  a: ArchiveSession | undefined,
  b: ArchiveSession,
): boolean {
  return (
    a?.source === 'cli' &&
    a.sessionId === b.sessionId &&
    a.agent === b.agent &&
    a.host === b.host &&
    a.repo?.owner === b.repo?.owner &&
    a.repo?.name === b.repo?.name
  );
}

/** Explicit, one-session snapshot consent; never scans or enables future uploads. */
export async function executeCliArchiveCommand(
  args: readonly string[],
  deps: CliArchiveDependencies,
): Promise<{ ok: boolean; message: string }> {
  if (!(
    (args.length === 2 && args[0] === '--consent') ||
    (args.length === 1 && args[0] === '--revoke')
  ))
    return { ok: false, message: CLI_ARCHIVE_USAGE };
  const target = resolveSessionId(deps.env);
  if (!target.ok || deps.env['LCARS_RUN_ID'])
    return {
      ok: false,
      message: 'CLI archive requires one local CLI session.',
    };
  let capture: { session: ArchiveSession; id: string } | undefined;
  try {
    const session = await deps.getSession(target.sessionId);
    if (
      !session ||
      session.sessionId !== target.sessionId ||
      session.source !== 'cli' ||
      session.host !== deps.host
    )
      return {
        ok: false,
        message: 'CLI archive session is unavailable or excluded.',
      };
    if (args[0] === '--revoke') {
      const uri = await deps.revoke(session);
      const ownedPrefix = `gs://${deps.bucket}/${PREFIX}${session.agent}/${session.sessionId}/`;
      if (uri?.startsWith(ownedPrefix))
        await deps.remove(uri.slice(`gs://${deps.bucket}/`.length));
      return { ok: true, message: 'CLI archive access revoked.' };
    }
    if (
      !session.repo ||
      !matchesRepoAllowlist(session.repo, deps.repos) ||
      !['claude-code', 'codex'].includes(session.agent)
    )
      return {
        ok: false,
        message: 'CLI archive session is unavailable or excluded.',
      };
    const bytes = readCliArchive(args[1]);
    const adapter =
      session.agent === 'codex' ? codexAdapter : claudeCodeAdapter;
    const lines = bytes
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim());
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (!record || typeof record !== 'object')
        throw new Error('invalid-transcript');
      const embeddedId =
        session.agent === 'codex'
          ? record['type'] === 'session_meta'
            ? (record['payload'] as { id?: unknown } | undefined)?.id
            : undefined
          : record['sessionId'];
      if (embeddedId !== undefined && embeddedId !== target.sessionId)
        throw new Error('mixed-session-transcript');
    }
    const summaries = adapter.reduce(lines);
    if (summaries.length !== 1 || summaries[0].sessionId !== target.sessionId)
      return {
        ok: false,
        message: 'Transcript does not identify exactly this session.',
      };
    const captureId = deps.id();
    const object = `${PREFIX}${session.agent}/${session.sessionId}/${captureId}.jsonl`;
    const expiresAt = new Date(
      deps.now().getTime() + RETENTION_MS,
    ).toISOString();
    await deps.claim(session, captureId);
    capture = { session, id: captureId };
    await deps.upload(object, bytes);
    if (
      !(await deps.publish(
        session,
        captureId,
        `gs://${deps.bucket}/${object}`,
        expiresAt,
      ))
    ) {
      await deps.remove(object);
      return {
        ok: false,
        message: 'CLI archive consent changed during upload.',
      };
    }
    return {
      ok: true,
      message: `CLI snapshot archived; console access expires ${expiresAt}.`,
    };
  } catch {
    if (capture)
      await deps.fail(capture.session, capture.id).catch(() => undefined);
    // Never disclose source text, paths, credentials or provider error payloads.
    return {
      ok: false,
      message:
        'CLI archive operation failed; check session archive status before retrying.',
    };
  }
}

export function defaultCliArchiveDependencies(
  env: NodeJS.ProcessEnv = process.env,
): CliArchiveDependencies {
  const config = loadHookClientConfig({ env, homeDirectory: os.homedir() });
  if (!config.writer || config.runner || config.writer.emulatorHost)
    throw new Error('archive-not-configured');
  const { projectId, credentials, credentialsFile } = config.writer;
  const options = {
    projectId,
    ...(credentials && { credentials }),
    ...(credentialsFile && { keyFilename: credentialsFile }),
  };
  const store = new Firestore({
    ...options,
    databaseId: env['AGENT_TELEMETRY_DATABASE_ID'] ?? '(default)',
  });
  const bucket =
    env['AGENT_TELEMETRY_TRANSCRIPTS_BUCKET'] ??
    `${projectId}-session-transcripts`;
  const storage = new Storage(options);
  const ref = (id: string) => store.collection('sessions').doc(id);
  return {
    env,
    host: config.host,
    repos: config.repos,
    bucket,
    now: () => new Date(),
    id: randomUUID,
    getSession: async (id) => {
      const doc = await ref(id).get();
      return doc.exists ? (doc.data() as ArchiveSession) : undefined;
    },
    claim: async (session, captureId) => {
      await store.runTransaction(async (tx) => {
        const doc = await tx.get(ref(session.sessionId));
        if (!sameSession(doc.data() as ArchiveSession | undefined, session))
          throw new Error('session-changed');
        tx.update(doc.ref, {
          cliTranscriptArchive: { status: 'pending', captureId },
          transcriptGcsUri: FieldValue.delete(),
          renderable: FieldValue.delete(),
        });
      });
    },
    fail: async (session, captureId) => {
      await store.runTransaction(async (tx) => {
        const doc = await tx.get(ref(session.sessionId));
        if (
          doc.data()?.['cliTranscriptArchive']?.captureId === captureId &&
          doc.data()?.['cliTranscriptArchive']?.status === 'pending'
        )
          tx.update(doc.ref, { cliTranscriptArchive: { status: 'failed' } });
      });
    },
    publish: (session, captureId, uri, expiresAt) =>
      store.runTransaction(async (tx) => {
        const doc = await tx.get(ref(session.sessionId));
        const data = doc.data();
        if (
          !sameSession(data as ArchiveSession | undefined, session) ||
          data?.['cliTranscriptArchive']?.captureId !== captureId
        )
          return false;
        tx.update(doc.ref, {
          cliTranscriptArchive: { status: 'available', captureId, expiresAt },
          transcriptGcsUri: uri,
          renderable: true,
        });
        return true;
      }),
    revoke: (session) =>
      store.runTransaction(async (tx) => {
        const doc = await tx.get(ref(session.sessionId));
        const data = doc.data();
        if (!sameSession(data as ArchiveSession | undefined, session))
          throw new Error('session-changed');
        tx.update(doc.ref, {
          cliTranscriptArchive: { status: 'expired' },
          transcriptGcsUri: FieldValue.delete(),
          renderable: FieldValue.delete(),
        });
        return typeof data?.['transcriptGcsUri'] === 'string'
          ? data['transcriptGcsUri']
          : undefined;
      }),
    upload: async (object, bytes) => {
      const [metadata] = await storage.bucket(bucket).getMetadata();
      if (!cliArchiveRetentionReady(metadata))
        throw new Error('retention-not-ready');
      await storage
        .bucket(bucket)
        .file(object)
        .save(bytes, {
          resumable: false,
          contentType: 'application/x-ndjson',
          preconditionOpts: { ifGenerationMatch: 0 },
        });
    },
    remove: async (object) => {
      await storage
        .bucket(bucket)
        .file(object)
        .delete({ ignoreNotFound: true });
    },
  };
}
