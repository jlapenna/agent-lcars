import {
  buildSessionDoc,
  computeLiveness,
  reduceTranscripts,
  SessionSummary,
} from '@repo/agent-telemetry';
import { logger } from '@repo/logging';
import * as fs from 'fs';

import { discoverTranscriptFiles } from './discover';
import { resolveGitBranch as defaultResolveGitBranch } from './git-branch';
import { isProcessAliveForCwd as defaultIsProcessAliveForCwd } from './process-check';
import { SessionStore } from './store';

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
  now?: () => string;
  readFile?: (filePath: string) => string;
  discover?: (claudeProjectsDir: string, allowlist: string[]) => string[];
  isProcessAliveForCwd?: (cwd: string) => boolean;
  resolveGitBranch?: (cwd: string) => string | undefined;
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
  private intervalHandle?: ReturnType<typeof setInterval>;

  constructor(private readonly options: WatcherDaemonOptions) {}

  async tick(): Promise<void> {
    const now = (this.options.now ?? (() => new Date().toISOString()))();
    const discover = this.options.discover ?? discoverTranscriptFiles;
    const readFile =
      this.options.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
    const isProcessAliveForCwd =
      this.options.isProcessAliveForCwd ?? defaultIsProcessAliveForCwd;
    const resolveGitBranch =
      this.options.resolveGitBranch ?? defaultResolveGitBranch;

    const files = discover(
      this.options.claudeProjectsDir,
      this.options.allowlist,
    );

    const contents: string[] = [];
    for (const file of files) {
      try {
        contents.push(readFile(file));
      } catch (error) {
        logger.warn(
          `agent-telemetry-watcher: failed to read transcript ${file}, skipping`,
          error,
        );
      }
    }

    let summaries: SessionSummary[] = [];
    try {
      summaries = reduceTranscripts(contents, { host: this.options.host });
    } catch (error) {
      logger.warn(
        'agent-telemetry-watcher: failed to reduce transcripts this tick, skipping',
        error,
      );
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

      const doc = buildSessionDoc(tracked.summary, liveness);

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
