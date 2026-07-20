import {
  buildSessionDoc,
  computeLiveness,
  reduceTranscripts,
  SessionSummary,
} from '@repo/agent-telemetry';
import { logger } from '@repo/logging';
import * as fs from 'fs';
import * as path from 'path';

import { discoverTranscriptFiles } from './discover';
import { discoverSessionArtifacts as defaultDiscoverArtifacts } from './discover-artifacts';
import { resolveGitBranch as defaultResolveGitBranch } from './git-branch';
import { isProcessAliveForCwd as defaultIsProcessAliveForCwd } from './process-check';
import { SessionStore } from './store';

export interface FileStat {
  mtimeMs: number;
  size: number;
}

export interface WatcherDaemonOptions {
  /** Root of `~/.claude/projects` (or a bind-mounted fixture dir in tests/Docker). */
  claudeProjectsDir: string;
  /** `*`-wildcard glob patterns matched against project-dir basenames. */
  allowlist: string[];
  host: string;
  store: SessionStore;
  heartbeatIntervalMs: number;
  /**
   * How long a session can go without the watcher successfully rediscovering
   * its transcript before it's surfaced as `stale` (distinct from `ended`,
   * which requires the watcher to have actually observed the process exit).
   */
  stalenessWindowMs: number;
  /** Root of `~/share` (share-media skill convention). Artifact discovery is
   * skipped entirely when unset. */
  shareDir?: string;
  /** Runner-mode only (`source: 'issue-agent'` sessions, see
   * `runner.ts`/`runner-config.ts`): tagged onto every doc this daemon
   * instance upserts. `buildSessionDoc` only ever reads these for
   * `issue-agent` docs, so a host-watcher instance simply never sets them. */
  runId?: string;
  /** Runner-mode only, see `runId`. */
  issueNumber?: number;
  now?: () => string;
  readFile?: (filePath: string) => string;
  statFile?: (filePath: string) => FileStat;
  discover?: (claudeProjectsDir: string, allowlist: string[]) => string[];
  isProcessAliveForCwd?: (cwd: string) => boolean;
  resolveGitBranch?: (cwd: string) => string | undefined;
  discoverArtifacts?: (shareDir: string, sessionId: string) => string[];
}

interface TrackedSession {
  summary: SessionSummary;
  /** Last time this tick's discovery pass successfully found this session. */
  lastHeartbeatAt: string;
}

/**
 * Long-lived per-host daemon: on every tick, discovers allowlisted
 * transcripts, reduces them, resolves liveness, and upserts each known
 * session doc to the store. Fails soft everywhere — a bad file, a reducer
 * error, or a store write failure logs and moves on rather than crashing
 * the process, since one broken transcript should never take down telemetry
 * for every other live session.
 */
export class WatcherDaemon {
  private readonly sessions = new Map<string, TrackedSession>();
  /** Per-file mtime/size as of the last tick that successfully read it. */
  private readonly fileStats = new Map<string, FileStat>();
  private intervalHandle?: ReturnType<typeof setInterval>;

  constructor(private readonly options: WatcherDaemonOptions) {}

  async tick(): Promise<void> {
    const now = (this.options.now ?? (() => new Date().toISOString()))();
    const discover = this.options.discover ?? discoverTranscriptFiles;
    const readFile =
      this.options.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
    const statFile =
      this.options.statFile ??
      ((p: string) => {
        const stat = fs.statSync(p);
        return { mtimeMs: stat.mtimeMs, size: stat.size };
      });
    const isProcessAliveForCwd =
      this.options.isProcessAliveForCwd ?? defaultIsProcessAliveForCwd;
    const resolveGitBranch =
      this.options.resolveGitBranch ?? defaultResolveGitBranch;
    const discoverArtifacts =
      this.options.discoverArtifacts ?? defaultDiscoverArtifacts;

    const files = discover(
      this.options.claudeProjectsDir,
      this.options.allowlist,
    );

    // Transcript filenames are `<sessionId>.jsonl` — a file that hasn't
    // changed since it was last read can't have produced a different
    // summary, so skip re-reading/re-reducing it and just refresh its
    // session's heartbeat (this is also what makes an `ended` session's
    // now-immutable file permanently skipped, with no extra bookkeeping).
    const changedFiles = new Map<string, FileStat>();
    for (const file of files) {
      let stat: FileStat;
      try {
        stat = statFile(file);
      } catch (error) {
        logger.warn(
          `agent-telemetry-watcher: failed to stat transcript ${file}, skipping`,
          error,
        );
        continue;
      }

      const previousStat = this.fileStats.get(file);
      if (
        previousStat &&
        previousStat.mtimeMs === stat.mtimeMs &&
        previousStat.size === stat.size
      ) {
        const tracked = this.sessions.get(path.basename(file, '.jsonl'));
        if (tracked) {
          tracked.lastHeartbeatAt = now;
        }
        continue;
      }

      changedFiles.set(file, stat);
    }

    // Lazily read one changed file's content at a time (rather than
    // collecting them all into an array first) so peak memory stays
    // bounded to a single transcript even on the first tick, when every
    // discovered file is "changed".
    const fileStats = this.fileStats;
    function* readChangedContents() {
      for (const [file, stat] of changedFiles) {
        try {
          const content = readFile(file);
          fileStats.set(file, stat);
          yield content;
        } catch (error) {
          logger.warn(
            `agent-telemetry-watcher: failed to read transcript ${file}, skipping`,
            error,
          );
        }
      }
    }

    let summaries: SessionSummary[] = [];
    if (changedFiles.size > 0) {
      try {
        summaries = reduceTranscripts(readChangedContents(), {
          host: this.options.host,
        });
      } catch (error) {
        logger.warn(
          'agent-telemetry-watcher: failed to reduce transcripts this tick, skipping',
          error,
        );
      }
    }

    for (const summary of summaries) {
      const branch = summary.cwd ? resolveGitBranch(summary.cwd) : undefined;
      this.sessions.set(summary.sessionId, {
        summary: branch ? { ...summary, branch } : summary,
        lastHeartbeatAt: now,
      });
    }

    for (const [sessionId, tracked] of this.sessions) {
      const heartbeatReceived =
        Date.parse(now) - Date.parse(tracked.lastHeartbeatAt) <=
        this.options.stalenessWindowMs;
      const processAlive = tracked.summary.cwd
        ? isProcessAliveForCwd(tracked.summary.cwd)
        : false;

      const liveness = computeLiveness({
        now,
        lastActivityAt: tracked.summary.lastActivityAt,
        processAlive,
        heartbeatReceived,
      });

      // Re-checked every tick (not just when the transcript itself changes)
      // since a shared artifact can appear well after the session's last
      // transcript activity - e.g. a report written just before the agent
      // wraps up.
      const artifacts = this.options.shareDir
        ? discoverArtifacts(this.options.shareDir, sessionId)
        : [];
      const summary =
        artifacts.length > 0
          ? { ...tracked.summary, artifacts }
          : tracked.summary;

      const doc = buildSessionDoc(summary, liveness, {
        runId: this.options.runId,
        issueNumber: this.options.issueNumber,
      });

      try {
        await this.options.store.upsertSession(doc);
      } catch (error) {
        logger.warn(
          `agent-telemetry-watcher: failed to upsert session ${sessionId}, will retry next tick`,
          error,
        );
      }
    }
  }

  /** Runs an initial tick immediately, then on `heartbeatIntervalMs`. */
  start(): void {
    void this.tick();
    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, this.options.heartbeatIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }
}
