import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  antigravityAdapter,
  claudeCodeAdapter,
  CLI_TRANSCRIPT_SAFETY_MAX_BYTES,
  codexAdapter,
  MAX_TRANSCRIPT_LINE_BYTES,
  type SessionDoc,
} from '@agent-lcars/telemetry';
import { FieldValue, Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';

import { loadHookClientConfig } from './hook/hook-config';
import { matchesRepoAllowlist } from './hook/repo-allowlist';
import { readTranscriptLinesFromFd } from './read-transcript-lines';
import { resolveSessionId } from './session-id';

export const CLI_ARCHIVE_USAGE =
  'usage: lcars session archive --consent <transcript.jsonl> | --revoke';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PREFIX = 'cli-consented-v1/';
const UPLOAD_CHUNK_BYTES = 64 * 1024;
const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;
// Without a chunk size the Storage SDK sends one PUT and keeps only its latest
// input buffer, so a retryable failure that commits an older offset cannot be
// replayed. Bounded chunks (a multiple of 256 KiB) let it resume at the
// committed offset while buffering at most this many bytes.
const RESUMABLE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

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
  maxBytes?: number;
  maxLineBytes?: number;
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
  upload: (
    object: string,
    source: NodeJS.ReadableStream,
    byteLength: number,
  ) => Promise<void>;
  remove: (object: string) => Promise<void>;
}

/** Open once, refuse symlinks/nonfiles, and enforce the safety ceiling on stat. */
export function openCliArchiveFd(
  file: string,
  maxBytes: number = CLI_TRANSCRIPT_SAFETY_MAX_BYTES,
): number {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) {
      throw new Error('archive-size');
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

interface PrivateStagingSnapshot {
  fd: number;
  closeAndCleanup: () => void;
}

/**
 * Create an unlinked `0o600` file inside a private `0o700` temporary directory
 * so validated bytes are isolated from concurrent in-place edits, appends, or
 * truncations of the live CLI transcript while never materializing the whole
 * file in memory.
 */
function createPrivateStagingSnapshot(): PrivateStagingSnapshot {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-cli-stage-'));
  const stagePath = path.join(stageDir, 'snapshot.jsonl');
  let fd: number | undefined;
  let closed = false;
  try {
    fd = fs.openSync(
      stagePath,
      fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.unlinkSync(stagePath);
    const openedFd = fd;
    return {
      fd: openedFd,
      closeAndCleanup: () => {
        if (closed) return;
        closed = true;
        try {
          fs.closeSync(openedFd);
        } finally {
          fs.rmSync(stageDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore secondary close error during cleanup.
      }
    }
    fs.rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }
}

function writeAllSync(fd: number, chunk: Buffer, position: number): number {
  let written = 0;
  while (written < chunk.length) {
    const n = fs.writeSync(
      fd,
      chunk,
      written,
      chunk.length - written,
      position + written,
    );
    if (n <= 0) {
      throw new Error('stage-write-failed');
    }
    written += n;
  }
  return position + written;
}

/**
 * Create a pull-driven readable byte stream clamped to `[0, byteLength)` on an
 * already-open file descriptor.
 */
export function createBoundedFdReadStream(
  fd: number,
  byteLength: number,
): Readable {
  function* generateChunks(): Generator<Buffer> {
    let offset = 0;
    while (offset < byteLength) {
      const toRead = Math.min(UPLOAD_CHUNK_BYTES, byteLength - offset);
      const chunk = Buffer.allocUnsafe(toRead);
      const bytesRead = fs.readSync(fd, chunk, 0, toRead, offset);
      if (bytesRead === 0) {
        throw new Error('archive-truncated');
      }
      offset += bytesRead;
      yield bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
    }
  }
  return Readable.from(generateChunks(), { objectMode: false });
}

function validateTranscriptLine(
  line: string,
  agent: SessionDoc['agent'],
  expectedSessionId: string,
): void {
  const parsed: unknown = JSON.parse(line);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid-transcript');
  }
  const record = parsed as Record<string, unknown>;
  const embeddedId =
    agent === 'codex'
      ? record['type'] === 'session_meta'
        ? (record['payload'] as { id?: unknown } | undefined)?.id
        : undefined
      : agent === 'antigravity'
        ? (record['conversationId'] ??
          record['conversation_id'] ??
          record['session_id'] ??
          record['sessionId'])
        : record['sessionId'];
  if (embeddedId !== undefined && embeddedId !== expectedSessionId) {
    throw new Error('mixed-session-transcript');
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
  let sourceFd: number | undefined;
  let stagedSnapshot: PrivateStagingSnapshot | undefined;
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
      !['claude-code', 'codex', 'antigravity'].includes(session.agent)
    )
      return {
        ok: false,
        message: 'CLI archive session is unavailable or excluded.',
      };

    const sessionAgent = session.agent;
    const expectedSessionId = target.sessionId;
    const maxBytes = deps.maxBytes ?? CLI_TRANSCRIPT_SAFETY_MAX_BYTES;
    const maxLineBytes = deps.maxLineBytes ?? MAX_TRANSCRIPT_LINE_BYTES;
    sourceFd = openCliArchiveFd(args[1], maxBytes);
    stagedSnapshot = createPrivateStagingSnapshot();
    const stageFd = stagedSnapshot.fd;
    const adapter =
      sessionAgent === 'codex'
        ? codexAdapter
        : sessionAgent === 'antigravity'
          ? antigravityAdapter
          : claudeCodeAdapter;

    let stagedBytes = 0;
    let validatedBytes = 0;
    let validatedLineCount = 0;
    const rawIterator = readTranscriptLinesFromFd(sourceFd, {
      maxBytes,
      maxLineBytes,
      onChunkRead: (chunk) => {
        stagedBytes = writeAllSync(stageFd, chunk, stagedBytes);
      },
    });
    let iteratorDone = false;

    function* validatedLines(): Generator<string> {
      while (true) {
        const next = rawIterator.next();
        if (next.done) {
          iteratorDone = true;
          return;
        }
        const { line, endByteOffset } = next.value;
        validatedBytes = endByteOffset;
        const trimmed = line.trim();
        if (!trimmed) continue;
        validateTranscriptLine(trimmed, sessionAgent, expectedSessionId);
        validatedLineCount += 1;
        yield trimmed;
      }
    }

    const summaries = adapter.reduce(validatedLines(), args[1]);
    // Drain any remaining lines in case an adapter ever terminates early so
    // every byte in [0, validatedBytes) has passed line-level validation.
    if (!iteratorDone) {
      for (const _ of validatedLines()) {
        // Intentional drain.
      }
    }

    // Close the source descriptor immediately after single-pass staging +
    // validation so subsequent async claim/upload steps never touch the live file.
    fs.closeSync(sourceFd);
    sourceFd = undefined;

    if (
      validatedLineCount === 0 ||
      validatedBytes <= 0 ||
      stagedBytes !== validatedBytes ||
      summaries.length !== 1 ||
      summaries[0].sessionId !== target.sessionId
    )
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

    const uploadStream = createBoundedFdReadStream(stageFd, validatedBytes);
    try {
      await deps.upload(object, uploadStream, validatedBytes);
    } finally {
      uploadStream.destroy();
    }

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
  } finally {
    if (sourceFd !== undefined) {
      fs.closeSync(sourceFd);
    }
    stagedSnapshot?.closeAndCleanup();
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
    upload: async (object, source, byteLength) => {
      try {
        const [metadata] = await storage.bucket(bucket).getMetadata();
        if (!cliArchiveRetentionReady(metadata))
          throw new Error('retention-not-ready');
        await pipeline(
          source,
          storage
            .bucket(bucket)
            .file(object)
            .createWriteStream({
              ...(byteLength > RESUMABLE_UPLOAD_THRESHOLD_BYTES
                ? { resumable: true, chunkSize: RESUMABLE_UPLOAD_CHUNK_BYTES }
                : { resumable: false }),
              contentType: 'application/x-ndjson',
              preconditionOpts: { ifGenerationMatch: 0 },
            }),
        );
      } finally {
        if ('destroy' in source && typeof source.destroy === 'function') {
          source.destroy();
        }
      }
    },
    remove: async (object) => {
      await storage
        .bucket(bucket)
        .file(object)
        .delete({ ignoreNotFound: true });
    },
  };
}
