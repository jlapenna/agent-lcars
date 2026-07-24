import {
  buildSessionDoc,
  getTranscriptAdapter,
  SessionSummary,
} from '@agent-lcars/telemetry';
import { logger } from '@repo/logging';
import * as fs from 'fs';

import { discoverAcrossRoots, discoverTranscriptFiles } from './discover';
import { resolveGitBranch as defaultResolveGitBranch } from './git-branch';
import { resolveGitRepo as defaultResolveGitRepo } from './git-repo';
import { RunnerConfig } from './runner-config';
import { SessionStore } from './store';
import {
  uploadTranscript as defaultUploadTranscript,
  UploadTranscriptOptions,
} from './transcript-upload';

/** Mirrors `runner.ts`'s `RUNNER_ALLOWLIST` — see that constant's doc
 * comment for why a runner container's single checkout needs no scoping. */
const RUNNER_ALLOWLIST = ['*'];

export interface FinalizeRideAlongOptions {
  config: RunnerConfig;
  store: SessionStore;
  /** Test-only injection points, mirrored from `StartRideAlongOptions`. */
  discover?: (rootPath: string, allowlist: string[]) => string[];
  readFile?: (filePath: string) => string;
  resolveGitBranch?: (cwd: string) => string | undefined;
  resolveGitRepo?: (cwd: string) => { owner: string; name: string } | undefined;
  uploadTranscript?: (options: UploadTranscriptOptions) => Promise<void>;
}

/**
 * One-shot finalize pass for a runner (issue-agent) session (issue #24),
 * run once "Run Claude Code" has already exited: unlike `startRideAlong`'s
 * long-lived tick loop, this reduces each discovered transcript exactly
 * once, archives its raw content to `config.transcriptsBucket` (the runner
 * container is destroyed on job exit, so this is the session's only chance
 * to survive as more than a Firestore summary), and upserts a final
 * `ended` doc pointing at it via `transcriptGcsUri`.
 *
 * Liveness is hardcoded to `'ended'` rather than recomputed via
 * `computeLiveness` — by the time claude.yml's "Finalize telemetry
 * ride-along" step runs, "Run Claude Code" has already completed, so the
 * process this session's transcript belonged to is unconditionally gone;
 * there is no `/proc` check left to make.
 *
 * Fails soft throughout, per-transcript and per-session: one broken read,
 * reduce, upload, or upsert must never stop the others from shipping, and
 * this function itself never throws.
 */
export async function finalizeRideAlong(
  options: FinalizeRideAlongOptions,
): Promise<void> {
  const { config, store } = options;
  const discover = options.discover ?? discoverTranscriptFiles;
  const readFile =
    options.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const resolveGitBranch = options.resolveGitBranch ?? defaultResolveGitBranch;
  const resolveGitRepo = options.resolveGitRepo ?? defaultResolveGitRepo;
  const uploadTranscript = options.uploadTranscript ?? defaultUploadTranscript;

  const discovered = discoverAcrossRoots(
    [
      {
        path: config.claudeProjectsDir,
        adapter: 'claude-code',
        projectDirAllowlist: RUNNER_ALLOWLIST,
      },
    ],
    discover,
  );

  for (const { file, root } of discovered) {
    const adapter = getTranscriptAdapter(root.adapter);
    if (!adapter) {
      continue;
    }

    let content: string;
    try {
      content = readFile(file);
    } catch (error) {
      logger.warn(
        `agent-lcars-telemetry-watcher: finalize failed to read transcript ${file}, skipping`,
        error,
      );
      continue;
    }

    let summaries: SessionSummary[];
    try {
      summaries = adapter.reduce(content.split('\n'));
    } catch (error) {
      logger.warn(
        `agent-lcars-telemetry-watcher: finalize failed to reduce transcript ${file}, skipping`,
        error,
      );
      continue;
    }

    for (const summary of summaries) {
      await finalizeSummary(summary, content, {
        config,
        store,
        resolveGitBranch,
        resolveGitRepo,
        uploadTranscript,
      });
    }
  }
}

async function finalizeSummary(
  summary: SessionSummary,
  rawContent: string,
  deps: {
    config: RunnerConfig;
    store: SessionStore;
    resolveGitBranch: (cwd: string) => string | undefined;
    resolveGitRepo: (
      cwd: string,
    ) => { owner: string; name: string } | undefined;
    uploadTranscript: (options: UploadTranscriptOptions) => Promise<void>;
  },
): Promise<void> {
  const { config, store } = deps;
  const branch = summary.cwd ? deps.resolveGitBranch(summary.cwd) : undefined;
  const repo = summary.cwd ? deps.resolveGitRepo(summary.cwd) : undefined;
  const finalSummary: SessionSummary = {
    ...summary,
    ...(branch && { branch }),
    ...(repo && { repo }),
  };

  let transcriptGcsUri: string | undefined;
  if (config.transcriptsBucket) {
    const object = `runs/${config.runId ?? 'unknown'}/claude-code/${summary.sessionId}.jsonl`;
    try {
      await deps.uploadTranscript({
        projectId: config.firestoreProjectId,
        bucket: config.transcriptsBucket,
        object,
        contents: rawContent,
      });
      transcriptGcsUri = `gs://${config.transcriptsBucket}/${object}`;
    } catch (error) {
      logger.warn(
        `agent-lcars-telemetry-watcher: finalize failed to upload transcript for session ${summary.sessionId}, shipping doc without transcriptGcsUri`,
        error,
      );
    }
  }

  const doc = buildSessionDoc(finalSummary, 'ended', {
    runId: config.runId,
    issueNumber: config.issueNumber,
    repo: config.repo,
    ...(transcriptGcsUri && { transcriptGcsUri }),
  });

  try {
    await store.upsertSession(doc);
    logger.info(
      `agent-lcars-telemetry-watcher: finalized session ${summary.sessionId} (run ${config.runId ?? 'unknown'})${
        transcriptGcsUri ? ` with transcript at ${transcriptGcsUri}` : ''
      }`,
    );
  } catch (error) {
    logger.warn(
      `agent-lcars-telemetry-watcher: finalize failed to upsert session ${summary.sessionId}`,
      error,
    );
  }
}
