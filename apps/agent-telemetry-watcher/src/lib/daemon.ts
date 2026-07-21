import {
  buildSessionDoc,
  computeLiveness,
  getTranscriptAdapter,
  SessionSummary,
} from '@repo/agent-telemetry';
import { logger } from '@repo/logging';
import * as fs from 'fs';
import * as path from 'path';

import { isAllowedProjectDir } from './allowlist';
import {
  AntigravitySummaryDbConfig,
  pollAntigravitySummaries as defaultPollAntigravitySummaries,
} from './antigravity-summary-source';
import { discoverAcrossRoots, discoverTranscriptFiles } from './discover';
import { discoverSessionArtifacts as defaultDiscoverArtifacts } from './discover-artifacts';
import { resolveGitBranch as defaultResolveGitBranch } from './git-branch';
import { isProcessAliveForCwd as defaultIsProcessAliveForCwd } from './process-check';
import { SessionStore } from './store';
import { WatchRootConfig } from './watch-roots';

export interface FileStat {
  mtimeMs: number;
  size: number;
}

export interface WatcherDaemonOptions {
  /** Every root this daemon instance discovers transcripts under — see
   * `watch-roots.ts`. The host watcher (main.ts) normally has exactly one
   * (today's `~/.claude/projects`, `claude-code`); runner mode
   * (`runner.ts`) also passes exactly one, allowlist-free. Multiple roots
   * are discovered, change-detected, and reduced fully independently of
   * each other within the same tick. */
  watchRoots: WatchRootConfig[];
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
   * skipped entirely when unset. Deliberately NOT per-root: it's keyed only
   * by `sessionId` (globally unique regardless of which root/agent produced
   * the session), so scanning it once for every tracked session is already
   * correct for every root — a root whose agent never writes artifacts
   * there simply always gets `[]` back (fails soft, no per-root gating
   * needed). Same reasoning applies to `isProcessAliveForCwd` below: a
   * `cwd` from a non-local-process agent just won't match any `/proc`
   * entry, so it degrades to "not alive" on its own without root-specific
   * logic. */
  shareDir?: string;
  /** Runner-mode only (`source: 'issue-agent'` sessions, see
   * `runner.ts`/`runner-config.ts`): tagged onto every doc this daemon
   * instance upserts. `buildSessionDoc` only ever reads these for
   * `issue-agent` docs, so a host-watcher instance simply never sets them. */
  runId?: string;
  /** Runner-mode only, see `runId`. */
  issueNumber?: number;
  /** Optional Antigravity summary-DB source (#3123 phase 3), alongside the
   * file-based `watchRoots` above — see `config.ts`'s `loadConfig`
   * (default-enabled) and `antigravity-summary-source.ts`. `main.ts`'s host
   * watcher is the only production caller that sets this; runner mode has
   * no equivalent (an ephemeral CI container never has the Antigravity CLI
   * installed). */
  antigravitySummaryDb?: AntigravitySummaryDbConfig;
  now?: () => string;
  readFile?: (filePath: string) => string;
  statFile?: (filePath: string) => FileStat;
  discover?: (rootPath: string, allowlist: string[]) => string[];
  isProcessAliveForCwd?: (cwd: string) => boolean;
  resolveGitBranch?: (cwd: string) => string | undefined;
  discoverArtifacts?: (shareDir: string, sessionId: string) => string[];
  /** Test-only injection point, mirrored from the seams above — production
   * callers (main.ts) never set this; the daemon uses the real
   * `pollAntigravitySummaries` (real `node:sqlite`) by default. */
  pollAntigravitySummaries?: (
    dbPath: string,
    allowlistPrefixes: string[],
    options?: { onUnavailable?: (error: unknown) => void },
  ) => SessionSummary[];
}

interface TrackedSession {
  summary: SessionSummary;
  /** Last time this tick's discovery pass successfully found this session. */
  lastHeartbeatAt: string;
}

/**
 * Long-lived per-host daemon: on every tick, discovers allowlisted
 * transcripts across every configured watch root, reduces each one with its
 * root's own adapter, resolves liveness, and upserts each known session doc
 * to the store. Fails soft everywhere — a bad file, a missing adapter, a
 * reducer error, or a store write failure logs and moves on rather than
 * crashing the process, since one broken transcript should never take down
 * telemetry for every other live session.
 */
export class WatcherDaemon {
  private readonly sessions = new Map<string, TrackedSession>();
  /** Per-file mtime/size as of the last tick that successfully read it. */
  private readonly fileStats = new Map<string, FileStat>();
  /** Session ids produced by each file. Codex rollout filenames contain a
   * timestamp prefix, so basename alone is not a reliable session id. */
  private readonly sessionIdsByFile = new Map<string, string[]>();
  /** Per-conversation `lastActivityAt` (i.e. `last_modified_time`) as of the
   * last tick that successfully upserted an antigravity summary row - the
   * DB-row analogue of `fileStats` above, used the same way: an unchanged
   * value means the row can't have produced a different doc, so skip
   * re-upserting it. */
  private readonly antigravityLastModified = new Map<string, string>();
  /** Set the first time `pollAntigravitySummaries` reports the DB
   * unavailable (missing/locked/corrupt) - keeps the warning to once per
   * process instead of once per tick, since a host with no Antigravity CLI
   * installed will report this on every single tick forever. */
  private antigravityDbUnavailableWarned = false;
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

    const discovered = discoverAcrossRoots(this.options.watchRoots, discover);

    // Transcript filenames are `<sessionId>.jsonl` — a file that hasn't
    // changed since it was last read can't have produced a different
    // summary, so skip re-reading/re-reducing it and just refresh its
    // session's heartbeat (this is also what makes an `ended` session's
    // now-immutable file permanently skipped, with no extra bookkeeping).
    // File paths are assumed unique across roots (roots are expected to
    // point at disjoint trees), so a single fileStats map keyed by path is
    // still correct with multiple roots.
    const changedFiles = new Map<
      string,
      { stat: FileStat; root: WatchRootConfig }
    >();
    for (const { file, root } of discovered) {
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
        for (const sessionId of this.sessionIdsByFile.get(file) ?? [
          path.basename(file, '.jsonl'),
        ]) {
          const tracked = this.sessions.get(sessionId);
          if (tracked) tracked.lastHeartbeatAt = now;
        }
        continue;
      }

      changedFiles.set(file, { stat, root });
    }

    // Read and reduce one changed file at a time (never batching multiple
    // files' contents into memory simultaneously - see #2606's OOM
    // regression, guarded by daemon.memory.spec.ts) via its root's own
    // adapter, resolved by name from the shared registry. A file maps 1:1
    // to a sessionId by construction (`<sessionId>.jsonl`), so per-file
    // adapter.reduce() calls are equivalent to the old batched
    // reduceTranscripts() call for every case this daemon actually sees -
    // cross-file merging for one session (which reduceTranscripts also
    // supports) only matters for callers walking an arbitrary multi-file
    // directory, not this daemon's discovery.
    const missingAdapterWarned = new Set<string>();
    const summaries: SessionSummary[] = [];
    for (const [file, { stat, root }] of changedFiles) {
      const adapter = getTranscriptAdapter(root.adapter);
      if (!adapter) {
        if (!missingAdapterWarned.has(root.adapter)) {
          missingAdapterWarned.add(root.adapter);
          logger.warn(
            `agent-telemetry-watcher: no transcript adapter registered for agent "${root.adapter}" (root ${root.path}), skipping its files`,
          );
        }
        continue;
      }

      let content: string;
      try {
        content = readFile(file);
      } catch (error) {
        logger.warn(
          `agent-telemetry-watcher: failed to read transcript ${file}, skipping`,
          error,
        );
        continue;
      }
      this.fileStats.set(file, stat);

      try {
        const fileSummaries = adapter.reduce(content.split('\n'));
        // Host is attached here (not inside the adapter, which has no
        // options param) so it's stamped uniformly regardless of which
        // adapter produced the summary - mirrors the old reduceTranscripts
        // call's `{ host }` option, which every summary from a call got
        // whether or not it ended up cli- or issue-agent-sourced.
        const acceptedSessionIds: string[] = [];
        for (const summary of fileSummaries) {
          if (
            root.cwdAllowlist &&
            (!summary.cwd ||
              !isAllowedProjectDir(summary.cwd, root.cwdAllowlist))
          ) {
            continue;
          }
          summaries.push(
            this.options.host
              ? { ...summary, host: this.options.host }
              : summary,
          );
          acceptedSessionIds.push(summary.sessionId);
        }
        this.sessionIdsByFile.set(file, acceptedSessionIds);
      } catch (error) {
        logger.warn(
          `agent-telemetry-watcher: failed to reduce transcript ${file} (agent ${root.adapter}), skipping`,
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

    await this.tickAntigravitySummaries(now);
  }

  /**
   * Polls the optional Antigravity summary-DB source (#3123 phase 3) and
   * upserts one doc per attributable, changed row - entirely independent of
   * the file-based `sessions`/`fileStats` bookkeeping above, since a DB row
   * has no filesystem heartbeat/staleness story of its own (it either
   * exists in the DB or it doesn't; there is no "undiscovered past the
   * staleness window" state to detect). No-ops when
   * `options.antigravitySummaryDb` is unset.
   */
  private async tickAntigravitySummaries(now: string): Promise<void> {
    if (!this.options.antigravitySummaryDb) {
      return;
    }
    const { path: dbPath, workspacePrefixes } =
      this.options.antigravitySummaryDb;
    const poll =
      this.options.pollAntigravitySummaries ?? defaultPollAntigravitySummaries;

    const summaries = poll(dbPath, workspacePrefixes, {
      onUnavailable: (error) => {
        if (!this.antigravityDbUnavailableWarned) {
          this.antigravityDbUnavailableWarned = true;
          logger.warn(
            `agent-telemetry-watcher: antigravity summary DB unavailable at ${dbPath} (expected on hosts without the Antigravity CLI installed) - polling disabled silently for the rest of this process`,
            error,
          );
        }
      },
    });

    for (const summary of summaries) {
      const previousLastActivityAt = this.antigravityLastModified.get(
        summary.sessionId,
      );
      if (previousLastActivityAt === summary.lastActivityAt) {
        // Unchanged since the last tick that shipped this row - the doc
        // would be byte-for-byte identical, so skip re-upserting it.
        continue;
      }

      // A polled DB row isn't a live host-watcher heartbeat the way a
      // rediscovered transcript file is - Antigravity conversations have no
      // `cwd`-to-PID mapping this daemon can verify via `/proc` (the
      // conversation may be driven by a different process, IDE window, or
      // even a different machine profile entirely). This mirrors
      // `apps/cli/src/commands/agent-telemetry/upsert.ts`'s exact
      // `processAlive`/`heartbeatReceived` pair for the same reason it uses
      // them: a one-off snapshot of already-recorded activity, never a
      // fabricated `live`/`idle` distinction this poller can't back up.
      const liveness = computeLiveness({
        now,
        lastActivityAt: summary.lastActivityAt,
        processAlive: false,
        heartbeatReceived: true,
      });

      const doc = buildSessionDoc(summary, liveness);

      try {
        await this.options.store.upsertSession(doc);
        this.antigravityLastModified.set(
          summary.sessionId,
          summary.lastActivityAt,
        );
      } catch (error) {
        logger.warn(
          `agent-telemetry-watcher: failed to upsert antigravity session ${summary.sessionId}, will retry next tick`,
          error,
        );
        // Deliberately not caching lastActivityAt on failure - the next
        // tick's poll will see the same (still-uncached) value as
        // "changed" and retry the upsert.
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
