import {
  claudeProjectSlugFor,
  CLI_TRANSCRIPT_MAX_BYTES,
  CLI_TRANSCRIPT_RETENTION_DAYS,
  CliTranscriptArchive,
  getTranscriptAdapter,
  isRenderableTranscriptAgent,
  isSafeIdentifier,
  SessionSummary,
} from '@agent-lcars/telemetry';
import * as fs from 'fs';
import * as path from 'path';

import { isAllowedProjectDir } from './allowlist';
import { uploadCliTranscript } from './transcript-upload';
import { WatchRootConfig } from './watch-roots';

/** Operator consent is per session and cannot widen the discovery scope. */
export interface CliArchivePolicy {
  bucket: string;
  sessionIds: string[];
  enabledAfter: string;
}

export function parseCliArchivePolicy(
  raw?: string,
): CliArchivePolicy | undefined {
  if (!raw) return undefined;
  const value = JSON.parse(raw) as Partial<CliArchivePolicy> | null;
  if (
    !value ||
    typeof value.bucket !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]$/.test(value.bucket) ||
    !Array.isArray(value.sessionIds) ||
    value.sessionIds.length === 0 ||
    value.sessionIds.length > 100 ||
    !value.sessionIds.every(
      (id) => typeof id === 'string' && isSafeIdentifier(id),
    ) ||
    typeof value.enabledAfter !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value.enabledAfter) ||
    !Number.isFinite(Date.parse(value.enabledAfter))
  ) {
    throw new Error(
      'AGENT_TELEMETRY_CLI_ARCHIVE_POLICY requires bucket, 1–100 safe sessionIds, and enabledAfter (ISO timestamp)',
    );
  }
  return value as CliArchivePolicy;
}

/** Reject roots without a restrictive privacy gate, even with session consent. */
export function isCliArchiveAllowed(
  root: WatchRootConfig,
  file: string,
  summary: SessionSummary,
): boolean {
  const relative = path.relative(path.resolve(root.path), path.resolve(file));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const projectPatterns = root.projectDirAllowlist;
  const cwdPatterns = root.cwdAllowlist;
  const scoped =
    (projectPatterns?.length &&
      !projectPatterns.some((pattern) => /^\*+$/.test(pattern))) ||
    (cwdPatterns?.length &&
      !cwdPatterns.some((pattern) => /^\*+$/.test(pattern)));
  return (
    Boolean(scoped) &&
    (!projectPatterns ||
      isAllowedProjectDir(
        relative.split(path.sep)[0] ?? '',
        projectPatterns,
      )) &&
    (!cwdPatterns ||
      Boolean(summary.cwd && isAllowedProjectDir(summary.cwd, cwdPatterns)))
  );
}

/** Bounded descriptor read, rejecting symlink escapes and concurrent growth. */
export function readCliArchive(file: string, root: WatchRootConfig): string {
  const realRoot = fs.realpathSync(root.path);
  const realFile = fs.realpathSync(file);
  const relative = path.relative(realRoot, realFile);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Archive path escapes watch root');
  if (relative !== path.relative(path.resolve(root.path), path.resolve(file))) {
    throw new Error('Archive path contains a symlinked directory');
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    // Bind containment to the opened inode, including symlinked parent directories.
    if (fs.realpathSync(`/proc/self/fd/${fd}`) !== realFile)
      throw new Error('Archive path changed during open');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Archive is not a regular file');
    if (stat.size > CLI_TRANSCRIPT_MAX_BYTES)
      throw new Error('Archive exceeds size limit');
    const buffer = Buffer.alloc(CLI_TRANSCRIPT_MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > CLI_TRANSCRIPT_MAX_BYTES)
      throw new Error('Archive exceeds size limit');
    return buffer.subarray(0, size).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export interface CliArchiveResult {
  cliTranscriptArchive: CliTranscriptArchive;
  transcriptGcsUri?: string;
}

/** Revalidate the bounded upload bytes with the same adapter and privacy gate. */
export async function archiveCliTranscript(options: {
  policy: CliArchivePolicy;
  root: WatchRootConfig;
  file: string;
  summary: SessionSummary;
  now: string;
  projectId?: string;
  writerKeyJson?: string;
  read?: typeof readCliArchive;
  upload?: typeof uploadCliTranscript;
}): Promise<CliArchiveResult> {
  const { policy, root, file, summary, now } = options;
  if (
    summary.source !== 'cli' ||
    !policy.sessionIds.includes(summary.sessionId) ||
    !isCliArchiveAllowed(root, file, summary) ||
    !Number.isFinite(Date.parse(summary.startedAt)) ||
    Date.parse(summary.startedAt) < Date.parse(policy.enabledAfter) ||
    Date.parse(summary.startedAt) > Date.parse(now)
  ) {
    throw new Error(
      'CLI archive requires current consent for an allowed session',
    );
  }
  if (!isRenderableTranscriptAgent(root.adapter))
    return { cliTranscriptArchive: { status: 'unsupported' } };
  const contents = (options.read ?? readCliArchive)(file, root);
  if (Buffer.byteLength(contents) > CLI_TRANSCRIPT_MAX_BYTES)
    return { cliTranscriptArchive: { status: 'too-large' } };
  for (const line of contents.split('\n').filter((line) => line.trim())) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Native parse errors quote private input; the daemon logs this error.
      throw new Error('Archive contains an invalid JSON record');
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Archive contains an invalid record');
    const payload = entry['payload'] as Record<string, unknown> | undefined;
    const ids = [
      entry['sessionId'],
      ...(entry['type'] === 'session_meta'
        ? [payload?.['id'], payload?.['session_id']]
        : []),
    ];
    if (ids.some((id) => id !== undefined && id !== summary.sessionId)) {
      throw new Error('Archive contains another session');
    }
    // The reducer keeps the final context, but consent must cover every
    // context represented in the bytes, including an earlier relocation.
    const cwds = [entry['cwd'], entry['relocatedCwd'], payload?.['cwd']];
    for (const cwd of cwds) {
      if (cwd === undefined) continue;
      if (
        typeof cwd !== 'string' ||
        !path.isAbsolute(cwd) ||
        (root.cwdAllowlist && !isAllowedProjectDir(cwd, root.cwdAllowlist)) ||
        (root.adapter === 'claude-code' &&
          root.projectDirAllowlist &&
          !isAllowedProjectDir(
            claudeProjectSlugFor(cwd),
            root.projectDirAllowlist,
          ))
      ) {
        throw new Error('Archive contains an excluded cwd context');
      }
    }
  }
  const summaries = getTranscriptAdapter(root.adapter)?.reduce(
    contents.split('\n'),
  );
  const captured = summaries?.[0];
  if (
    !captured ||
    !summaries ||
    summaries.length !== 1 ||
    captured.sessionId !== summary.sessionId ||
    !isCliArchiveAllowed(root, file, captured) ||
    Date.parse(captured.startedAt) < Date.parse(policy.enabledAfter)
  ) {
    throw new Error(
      'Archive bytes do not match the consented, allowed session',
    );
  }
  const object = `cli/${encodeURIComponent(summary.host ?? 'host')}/${root.adapter}/${summary.sessionId}.jsonl`;
  await (options.upload ?? uploadCliTranscript)({
    bucket: policy.bucket,
    object,
    contents,
    projectId: options.projectId,
    writerKeyJson: options.writerKeyJson,
  });
  const expiresAt = new Date(
    Math.min(
      Date.parse(now) + CLI_TRANSCRIPT_RETENTION_DAYS * 86400000,
      Date.parse(summary.lastActivityAt) +
        CLI_TRANSCRIPT_RETENTION_DAYS * 86400000,
    ),
  ).toISOString();
  return {
    cliTranscriptArchive: { status: 'available', expiresAt },
    transcriptGcsUri: `gs://${policy.bucket}/${object}`,
  };
}
