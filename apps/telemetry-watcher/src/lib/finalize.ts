import { logger } from '@agent-lcars/logging';
import {
  buildSessionDoc,
  getTranscriptAdapter,
  RUNNER_CAPTURE_AGENTS,
  runnerWatchRoots,
  SessionAgent,
  SessionSummary,
  transcriptObjectPath,
} from '@agent-lcars/telemetry';
import * as fs from 'fs';

import { discoverAcrossRoots, discoverTranscriptFiles } from './discover';
import { resolveGitBranch as defaultResolveGitBranch } from './git-branch';
import { applyGitContext } from './git-context';
import { resolveGitRepo as defaultResolveGitRepo } from './git-repo';
import { RunnerConfig } from './runner-config';
import { SessionStore } from './store';
import {
  uploadTranscript as defaultUploadTranscript,
  UploadTranscriptOptions,
} from './transcript-upload';

/**
 * Emits a GitHub Actions `::warning::` workflow command so a failed
 * transcript upload or session upsert surfaces in the Actions UI instead of
 * requiring someone to open this step's raw log (agent-lcars#352 — a WIF
 * grant silently rejected every sprinkles-repo telemetry write for months
 * because the failure never showed up anywhere but plain step output).
 * Only fires under `GITHUB_ACTIONS=true` (unset in local/test runs) and
 * deliberately writes straight to stdout rather than through `logger.warn`
 * — the structured/JSON logging mode `@agent-lcars/logging` can switch to would
 * bury the `::warning::` prefix Actions parses for annotations. `%`/CR/LF
 * are escaped per Actions' workflow-command format so a multi-line error
 * message can't break the single-line annotation.
 */
function annotateWarning(message: string): void {
  if (process.env['GITHUB_ACTIONS'] !== 'true') {
    return;
  }
  const escaped = message
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
  console.log(`::warning::${escaped}`);
}

export interface FinalizeSidecarOptions {
  config: RunnerConfig;
  store: SessionStore;
  /** Test-only injection points, mirrored from `StartSidecarOptions`. */
  discover?: (rootPath: string, allowlist: string[]) => string[];
  readFile?: (filePath: string) => string;
  resolveGitBranch?: (cwd: string) => Promise<string | undefined>;
  resolveGitRepo?: (
    cwd: string,
  ) => Promise<{ owner: string; name: string } | undefined>;
  uploadTranscript?: (options: UploadTranscriptOptions) => Promise<void>;
}

/**
 * One-shot finalize pass for a runner (issue-agent) session (issue #24),
 * run once "Run Claude Code" has already exited: unlike `startSidecar`'s
 * long-lived tick loop, this reduces each discovered transcript exactly
 * once, archives its raw content to `config.transcriptsBucket` (the runner
 * container is destroyed on job exit, so this is the session's only chance
 * to survive as more than a Firestore summary), and upserts a final
 * `ended` doc pointing at it via `transcriptGcsUri`.
 *
 * Liveness is hardcoded to `'ended'` rather than recomputed via
 * `computeLiveness` — by the time claude.yml's "Finalize telemetry
 * sidecar" step runs, "Run Claude Code" has already completed, so the
 * process this session's transcript belonged to is unconditionally gone;
 * there is no `/proc` check left to make.
 *
 * Fails soft throughout, per-transcript and per-session: one broken read,
 * reduce, upload, or upsert must never stop the others from shipping, and
 * this function itself never throws.
 */
export async function finalizeSidecar(
  options: FinalizeSidecarOptions,
): Promise<void> {
  const { config, store } = options;
  const discover = options.discover ?? discoverTranscriptFiles;
  const readFile =
    options.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const resolveGitBranch = options.resolveGitBranch ?? defaultResolveGitBranch;
  const resolveGitRepo = options.resolveGitRepo ?? defaultResolveGitRepo;
  const uploadTranscript = options.uploadTranscript ?? defaultUploadTranscript;

  // The single runner-mode watch-root contract (@agent-lcars/telemetry,
  // #645) — the same function `startSidecar` (runner.ts) calls. Before
  // #645 this was a second, hand-copied array with a comment admitting it
  // "must mirror startSidecar's roots exactly"; finalize is the
  // authoritative last write, so a root the sidecar watched but this pass
  // didn't would leave that session stuck on its final `live`/`idle`
  // snapshot, never marked `ended` and never given a transcriptGcsUri —
  // importing one definition instead of two hand-copies makes that drift
  // structurally impossible rather than merely commented against.
  const discovered = discoverAcrossRoots(
    runnerWatchRoots({
      claudeProjectsDir: config.claudeProjectsDir,
      codexSessionsDir: config.codexSessionsDir,
    }),
    discover,
  );

  // Counts sessions actually reduced (not just files discovered) across
  // every watch root, so the zero-shipped check below fires whenever this
  // run produced no telemetry for any reason, not only a missing root — see
  // that check's own comment.
  let shippedCount = 0;

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
      shippedCount++;
      await finalizeSummary(summary, content, root.adapter, {
        config,
        store,
        resolveGitBranch,
        resolveGitRepo,
        uploadTranscript,
      });
    }
  }

  if (shippedCount === 0) {
    // Bug 2 (agent-lcars#645): before this check, a run whose agent has no
    // registered runner-mode watch root/adapter — OpenCode today, see
    // RUNNER_CAPTURE_AGENTS — authenticated telemetry, started and stopped
    // the sidecar, and both steps reported success, while shipping zero
    // session docs with no warning anywhere. This pass has no reliable way
    // to know which agent's workflow invoked it (runnerWatchRoots is
    // deliberately agent-agnostic — see its own doc comment), so this fires
    // for ANY zero-session finalize pass, not only OpenCode's: a genuinely
    // idle Claude/Codex run is rare enough that the extra visibility is
    // worth having there too, and it costs nothing when it's a false
    // positive (see annotateWarning above).
    const message =
      `agent-lcars-telemetry-watcher: finalize discovered zero sessions across every configured watch root (run ${config.runId ?? 'unknown'}) — this run's telemetry did not ship. ` +
      `Runner mode only has a watch root for ${RUNNER_CAPTURE_AGENTS.join(', ')}; expected when this run's agent isn't one of those (e.g. OpenCode, whose local session store is a single SQLite database rather than a per-session file this pass can discover), a real gap otherwise.`;
    logger.warn(message);
    annotateWarning(message);
  }
}

async function finalizeSummary(
  summary: SessionSummary,
  rawContent: string,
  adapter: SessionAgent,
  deps: {
    config: RunnerConfig;
    store: SessionStore;
    resolveGitBranch: (cwd: string) => Promise<string | undefined>;
    resolveGitRepo: (
      cwd: string,
    ) => Promise<{ owner: string; name: string } | undefined>;
    uploadTranscript: (options: UploadTranscriptOptions) => Promise<void>;
  },
): Promise<void> {
  const { config, store } = deps;
  const finalSummary = await applyGitContext(
    summary,
    deps.resolveGitBranch,
    deps.resolveGitRepo,
  );

  let transcriptGcsUri: string | undefined;
  if (config.transcriptsBucket) {
    // A function of the watch root's own declared adapter, not a hardcoded
    // 'claude-code' literal (the fix for Bug 1, agent-lcars#645) — every
    // Codex transcript used to archive under the claude-code/ prefix
    // regardless of which agent actually produced it.
    const object = transcriptObjectPath({
      runId: config.runId,
      adapter,
      sessionId: summary.sessionId,
    });
    try {
      await deps.uploadTranscript({
        projectId: config.firestoreProjectId,
        bucket: config.transcriptsBucket,
        object,
        contents: rawContent,
      });
      transcriptGcsUri = `gs://${config.transcriptsBucket}/${object}`;
    } catch (error) {
      const message = `agent-lcars-telemetry-watcher: finalize failed to upload transcript for session ${summary.sessionId}, shipping doc without transcriptGcsUri`;
      logger.warn(message, error);
      annotateWarning(`${message}: ${error}`);
    }
  }

  const doc = buildSessionDoc(finalSummary, 'ended', {
    runId: config.runId,
    issueNumber: config.issueNumber,
    repo: config.repo,
    // Same override the sidecar applies (see runner.ts) — this is the
    // authoritative last write, so it must agree with the live snapshots
    // rather than flipping a Codex session back to `cli` at the end.
    forceSource: 'issue-agent',
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
    const message = `agent-lcars-telemetry-watcher: finalize failed to upsert session ${summary.sessionId}`;
    logger.warn(message, error);
    annotateWarning(`${message}: ${error}`);
  }
}
