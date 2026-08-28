import { logger } from '@agent-lcars/logging';
import {
  applySessionTitleOverlay,
  buildSessionWrite,
  computeLiveness,
  getTranscriptAdapter,
  SessionStatusAnnotationV1,
  SessionSummary,
  SessionTitleAnnotationV1,
} from '@agent-lcars/telemetry';
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
import { applyGitContext } from './git-context';
import { resolveGitRepo as defaultResolveGitRepo } from './git-repo';
import { WatcherMetricsSink } from './metrics';
import {
  isProcessAliveForCwd as defaultIsProcessAliveForCwd,
  scanProcCwds,
} from './process-check';
import { readTranscriptLines as defaultReadTranscriptLines } from './read-transcript-lines';
import {
  readSessionStatusOverlay as defaultReadSessionStatusOverlay,
  readSessionTitleOverlay as defaultReadSessionTitleOverlay,
  SessionStatusDirectoryRead,
  SessionTitleOverlayRead,
} from './session-title-annotation-source';
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
  /** Runner-mode only, see `runId`. Orchestrator run ID (`broker_intent_id`)
   * — the join key a work item needs to find its sessions. Distinct from
   * `runId`, the GitHub Actions run id. */
  intentId?: string;
  /** Runner-mode only, see `runId`. */
  issueNumber?: number;
  /** Runner-mode only: forces every doc this daemon upserts to the given
   * source, overriding what the transcript claims. `runner.ts` sets
   * `'issue-agent'` — see `BuildSessionDocOptions.forceSource` for why the
   * transcript can't be trusted to say so for every agent. */
  forceSource?: SessionSummary['source'];
  /** Runner-mode only, see `runId`. Threaded into `buildSessionDoc`'s
   * options for `issue-agent` docs, which can't derive repo from a git
   * remote the way CLI sessions do (see `resolveGitRepo` below) — a CI
   * container's checkout may not have a real `origin` remote, but the
   * workflow already knows its own repo, so it's just told here. */
  repo?: { owner: string; name: string };
  /** Optional Antigravity summary-DB source (#3123 phase 3), alongside the
   * file-based `watchRoots` above — see `config.ts`'s `loadConfig`
   * (default-enabled) and `antigravity-summary-source.ts`. `main.ts`'s host
   * watcher is the only production caller that sets this; runner mode has
   * no equivalent (an ephemeral CI container never has the Antigravity CLI
   * installed). */
  antigravitySummaryDb?: AntigravitySummaryDbConfig;
  /** Optional session-title overlay root (issue #1212), alongside the
   * file-based `watchRoots` above — see `config.ts`'s `loadConfig`
   * (default-enabled) and `session-title-annotation-source.ts`. `main.ts`'s
   * host watcher is the only production caller that sets this; runner mode
   * (`runner.ts`) has no equivalent — a dispatch runner's ephemeral
   * container has no `~/.local/state/agent-lcars` writer/importer
   * publishing candidates for its own CI session, so `sessionStateDir`
   * simply stays unset there and this daemon skips the overlay entirely
   * (same "unset means skip" pattern as `shareDir`/`antigravitySummaryDb`
   * above). */
  sessionStateDir?: string;
  /** Host-watcher Prometheus observer. Runner mode deliberately omits it. */
  metrics?: WatcherMetricsSink;
  now?: () => string;
  /**
   * Test seam for the production streaming reader. `readFile` is retained
   * for existing unit fixtures, whose in-memory strings naturally become an
   * iterable of lines below.
   */
  readTranscriptLines?: (filePath: string) => Iterable<string>;
  readFile?: (filePath: string) => string;
  /** Runner-mode hook that materializes non-file-backed sessions before
   * discovery. It is fail-soft: an exception skips only this tick. */
  beforeDiscover?: () => void | Promise<void>;
  statFile?: (filePath: string) => FileStat;
  discover?: (rootPath: string, allowlist: string[]) => string[];
  isProcessAliveForCwd?: (cwd: string) => boolean;
  resolveGitBranch?: (cwd: string) => Promise<string | undefined>;
  /** CLI sessions only: per-tick `origin`-remote resolution stamped onto
   * `summary.repo`, same seam shape as `resolveGitBranch`. Runner-mode
   * sessions get `repo` from the static option above instead. */
  resolveGitRepo?: (
    cwd: string,
  ) => Promise<{ owner: string; name: string } | undefined>;
  discoverArtifacts?: (shareDir: string, sessionId: string) => string[];
  /** Test-only injection point, mirrored from the seams above — production
   * callers (main.ts) never set this; the daemon uses the real
   * `pollAntigravitySummaries` (real `node:sqlite`) by default. */
  pollAntigravitySummaries?: (
    dbPath: string,
    allowlistPrefixes: string[],
    options?: { onUnavailable?: (error: unknown) => void },
  ) => SessionSummary[];
  /** Test-only injection point, mirrored from the seams above — production
   * callers (main.ts) never set this; the daemon uses the real
   * `readSessionTitleOverlay` (real `fs`) by default. */
  readSessionTitleOverlay?: (
    stateDirectory: string,
    sessionIds: Iterable<string>,
  ) => SessionTitleOverlayRead;
  /** Test-only injection point, mirrored from the seams above — production
   * callers (main.ts) never set this; the daemon uses the real
   * `readSessionStatusOverlay` (real `fs`) by default. Read from the same
   * `sessionStateDir` root as `readSessionTitleOverlay` — see
   * `STATUS_SUBDIRECTORY`'s doc comment for why status gets its own
   * channel directory beneath that same root rather than a new top-level
   * option. */
  readSessionStatusOverlay?: (
    stateDirectory: string,
    sessionIds: Iterable<string>,
  ) => SessionStatusDirectoryRead;
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
  /** Serialized `SessionWrite` from the last successful write per session. A
   * tick that recomputes an identical write is only a local heartbeat and
   * must not become a billable Firestore no-op write. Failed writes are
   * never cached, so the next tick retries them.
   *
   * Keyed on the WHOLE `SessionWrite` (`{ doc, clearFields }`), not on
   * `doc` alone (issue #1257) — this is deliberate and load-bearing, not
   * an arbitrary choice. `doc` and `clearFields` together are the entire
   * operation this cache exists to dedupe; a key built from only part of
   * that operation is narrower than the operation itself, and anything in
   * the operation but not in the key becomes a silent no-op by
   * construction — see `SessionWrite`'s doc comment
   * (`@agent-lcars/telemetry`'s `types.ts`) for the fuller argument, and
   * this repo's own #1257 discussion for the concrete trap: a doc with no
   * `status` serializes identically whether or not that tick's write is
   * the one that must carry a delete. Serializing the *write* rather than
   * the doc means the key is a total function of the operation and cannot
   * drift from it — including for any clearable field added after this
   * one, with no change needed here. */
  private readonly lastWrittenWrites = new Map<string, string>();
  /** Set the first time `pollAntigravitySummaries` reports the DB
   * unavailable (missing/locked/corrupt) - keeps the warning to once per
   * process instead of once per tick, since a host with no Antigravity CLI
   * installed will report this on every single tick forever. */
  private antigravityDbUnavailableWarned = false;
  /** Last-good declared session-title overlay read (issue #1212) — see
   * `readSessionTitleOverlay`'s `available` flag on `SessionTitleDirectoryRead`.
   * A directory read that fails (missing, unreadable, or over the
   * per-directory file-count bound) must not blank every session's
   * declared title candidate on this tick; instead the daemon
   * keeps showing whatever the last *successful* read produced. That
   * includes a successful read that found zero files — an empty map from a
   * successful read is real information ("nothing declared right now"),
   * distinct from "couldn't read," and it DOES replace last-good. Only ever
   * updated in `tick()`, and only when the corresponding directory reports
   * `available: true`. */
  private lastGoodDeclaredTitles: ReadonlyMap<
    string,
    SessionTitleAnnotationV1
  > = new Map();
  /** Last-good session-status annotations (issue #1257) — the status
   * channel's own analogue of `lastGoodDeclaredTitles` above, same
   * available/unavailable + last-good semantics (see that field's doc
   * comment). Status has no precedence tier of its own, so there is only
   * this one map, not a declared/generated pair. */
  private lastGoodStatusAnnotations: ReadonlyMap<
    string,
    SessionStatusAnnotationV1
  > = new Map();
  private intervalHandle?: ReturnType<typeof setInterval>;
  private tickInFlight?: Promise<void>;

  constructor(private readonly options: WatcherDaemonOptions) {}

  /**
   * A stale session's transcript is no longer discoverable. Once its stale
   * write succeeds, keeping its cached transcript, dedupe write, and session
   * record buys nothing: it would otherwise stay in every future tick's
   * process/artifact loop for the lifetime of the daemon. Last-good
   * annotations are intentionally separate: they must survive an unavailable
   * annotation read when this transcript later reappears. Eviction is
   * deliberately coupled to that successful terminal write, not a periodic
   * maintenance job. A later rediscovery starts from the transcript again.
   */
  private evictStaleSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.lastWrittenWrites.delete(sessionId);

    for (const [file, sessionIds] of this.sessionIdsByFile) {
      if (!sessionIds.includes(sessionId)) continue;
      const remainingSessionIds = sessionIds.filter((id) => id !== sessionId);
      if (remainingSessionIds.length === 0) {
        this.sessionIdsByFile.delete(file);
        this.fileStats.delete(file);
      } else {
        this.sessionIdsByFile.set(file, remainingSessionIds);
      }
    }
  }

  /** Coalesces overlapping interval/manual triggers onto the active tick.
   * OpenCode capture can legitimately take longer than one heartbeat, and
   * every tick mutates shared discovery caches, so running a second pass in
   * parallel would race both its export-directory pruning and this daemon's
   * state. The next interval after completion starts a fresh pass. */
  tick(): Promise<void> {
    if (this.tickInFlight) return this.tickInFlight;

    const inFlight = this.runTick();
    this.tickInFlight = inFlight;
    const clear = () => {
      if (this.tickInFlight === inFlight) this.tickInFlight = undefined;
    };
    void inFlight.then(clear, clear);
    return inFlight;
  }

  private async runTick(): Promise<void> {
    const now = (this.options.now ?? (() => new Date().toISOString()))();
    // Persist proof that the watcher is healthy without writing every 10s.
    // A five-minute bucket gives the console two missed buckets of tolerance.
    const observedAt = new Date(
      Math.floor(Date.parse(now) / (5 * 60 * 1000)) * 5 * 60 * 1000,
    ).toISOString();
    const discover = this.options.discover ?? discoverTranscriptFiles;
    const readFile = this.options.readFile;
    const readTranscriptLines =
      this.options.readTranscriptLines ??
      (readFile
        ? (p: string) => readFile(p).split('\n')
        : defaultReadTranscriptLines);
    const statFile =
      this.options.statFile ??
      ((p: string) => {
        const stat = fs.statSync(p);
        return { mtimeMs: stat.mtimeMs, size: stat.size };
      });
    const isProcessAliveForCwd =
      this.options.isProcessAliveForCwd ?? defaultIsProcessAliveForCwd;
    // Scanned once per tick and reused for every tracked session's liveness
    // check below, instead of each session independently re-scanning all of
    // /proc — see scanProcCwds's doc comment. Skipped entirely when a test
    // has replaced isProcessAliveForCwd wholesale, since the scan would then
    // go unused.
    const procCwds = this.options.isProcessAliveForCwd
      ? undefined
      : scanProcCwds('/proc');
    const resolveGitBranch =
      this.options.resolveGitBranch ?? defaultResolveGitBranch;
    const resolveGitRepo = this.options.resolveGitRepo ?? defaultResolveGitRepo;
    const discoverArtifacts =
      this.options.discoverArtifacts ?? defaultDiscoverArtifacts;

    try {
      await this.options.beforeDiscover?.();
    } catch (error) {
      logger.warn(
        'agent-lcars-telemetry-watcher: pre-discovery capture failed, continuing with existing transcript files',
        error,
      );
    }
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
          `agent-lcars-telemetry-watcher: failed to stat transcript ${file}, skipping`,
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

    // Read and reduce one changed file at a time, via its root's own adapter
    // resolved by name from the shared registry. A file maps 1:1
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
            `agent-lcars-telemetry-watcher: no transcript adapter registered for agent "${root.adapter}" (root ${root.path}), skipping its files`,
          );
        }
        continue;
      }

      let lines: Iterable<string>;
      try {
        lines = readTranscriptLines(file);
      } catch (error) {
        logger.warn(
          `agent-lcars-telemetry-watcher: failed to read transcript ${file}, skipping`,
          error,
        );
        continue;
      }
      try {
        const fileSummaries = adapter.reduce(lines);
        // The production reader is lazy. Only mark the file read after the
        // reducer has consumed it successfully; otherwise a late I/O error
        // would suppress the retry on every subsequent tick.
        this.fileStats.set(file, stat);
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
          `agent-lcars-telemetry-watcher: failed to reduce transcript ${file} (agent ${root.adapter}), skipping`,
          error,
        );
      }
    }

    // Every changed session's branch/repo resolution runs concurrently
    // (each is a `git` subprocess spawn) rather than serially awaiting one
    // at a time.
    const enrichedSummaries = await Promise.all(
      summaries.map((summary) =>
        applyGitContext(summary, resolveGitBranch, resolveGitRepo),
      ),
    );
    for (const summary of enrichedSummaries) {
      this.sessions.set(summary.sessionId, {
        summary,
        lastHeartbeatAt: now,
      });
    }

    // Read annotations only for sessions discovered from upstream transcripts.
    // Historical files are never enumerated, so they cannot degrade a live
    // tick or overflow a directory-wide reader cap.
    if (this.options.sessionStateDir) {
      const readOverlay =
        this.options.readSessionTitleOverlay ?? defaultReadSessionTitleOverlay;
      const sessionIds = this.sessions.keys();
      const overlayRead = readOverlay(this.options.sessionStateDir, sessionIds);
      // `available` is tracked and applied per channel — see
      // `lastGoodDeclaredTitles`'s doc comment above for why a failed read
      // preserves the previous last-good instead of blanking it, and why a
      // successful-but-empty read still replaces it.
      if (overlayRead.declared.available) {
        this.lastGoodDeclaredTitles = overlayRead.declared.annotations;
      }
      // Session-status channel (issue #1257): read once per tick alongside
      // the title channel above, same available/unavailable +
      // last-good semantics, same reasoning for reading it here rather
      // than per-session below.
      const readStatusOverlay =
        this.options.readSessionStatusOverlay ??
        defaultReadSessionStatusOverlay;
      const statusRead = readStatusOverlay(
        this.options.sessionStateDir,
        this.sessions.keys(),
      );
      if (statusRead.available) {
        this.lastGoodStatusAnnotations = statusRead.annotations;
      }
    }

    for (const [sessionId, tracked] of this.sessions) {
      const heartbeatReceived =
        Date.parse(now) - Date.parse(tracked.lastHeartbeatAt) <=
        this.options.stalenessWindowMs;
      const processAlive = tracked.summary.cwd
        ? isProcessAliveForCwd(
            tracked.summary.cwd,
            '/proc',
            tracked.summary.sessionId,
            tracked.summary.startedAt,
            tracked.summary.agent,
            procCwds,
          )
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

      // Overlay declared title candidates fresh from the
      // pristine `tracked.summary` every tick, into a local variable only —
      // this result is deliberately NEVER stored back into `this.sessions`.
      // `tracked.summary` must stay exactly what the reducer produced,
      // because that pristine state is the ONLY reason removing a
      // `declared` annotation can fall back to the transcript's
      // own title on the very next tick instead of getting stuck on a
      // stale overlaid value (there being no "explicit clear" operation to
      // trigger that fallback otherwise — see `applySessionTitleOverlay`'s
      // doc comment in libs/telemetry for the full argument). This is the
      // single easiest invariant for a future change to accidentally break
      // by doing `this.sessions.set(sessionId, { summary: overlaidSummary,
      // ... })` somewhere below — don't.
      //
      // Looking annotations up by `sessionId` here (rather than iterating
      // the overlay maps themselves) is also what guarantees an annotation
      // for a session this daemon has never discovered a transcript for
      // produces no doc and no upsert: this loop only ever runs over
      // `this.sessions`, so an unknown id sitting in
      // `lastGoodDeclaredTitles` is simply never
      // read.
      const overlaidSummary = applySessionTitleOverlay(summary, {
        declared: this.lastGoodDeclaredTitles.get(sessionId),
      });

      // Join the current session-status candidate the same way, straight
      // onto `overlaidSummary` (itself already derived fresh from the
      // pristine `summary` above, never stored back — see the long comment
      // above for why that matters). Unlike title there is no precedence to
      // apply: status has exactly one source, so "present" means "joined
      // this tick" and "absent" means exactly that — there is deliberately
      // no separate "was a status previously set" state to consult here.
      // Absence is what `buildSessionWrite` reads as "clear it" (see that
      // function's own doc comment in `session-doc.ts`), so a removed
      // annotation reaching zero effect on `overlaidSummary.status` is the
      // entire mechanism, not a special case.
      const statusAnnotation = this.lastGoodStatusAnnotations.get(sessionId);
      const summaryWithStatus = statusAnnotation
        ? {
            ...overlaidSummary,
            status: statusAnnotation.status,
            statusUpdatedAt: statusAnnotation.updatedAt,
          }
        : overlaidSummary;

      const write = buildSessionWrite(summaryWithStatus, liveness, {
        runId: this.options.runId,
        intentId: this.options.intentId,
        issueNumber: this.options.issueNumber,
        repo: this.options.repo,
        ...(this.options.forceSource && {
          forceSource: this.options.forceSource,
        }),
        observedAt,
      });
      // Keyed on the WHOLE write, not the doc alone — see
      // `lastWrittenWrites`'s own doc comment above for why that
      // distinction is load-bearing rather than cosmetic.
      const serializedWrite = JSON.stringify(write);
      if (this.lastWrittenWrites.get(sessionId) === serializedWrite) {
        continue;
      }

      try {
        await this.options.store.upsertSession(write);
        this.lastWrittenWrites.set(sessionId, serializedWrite);
        this.options.metrics?.recordSuccessfulSessionUpsert(now, liveness);
        if (liveness === 'stale') {
          this.evictStaleSession(sessionId);
        }
      } catch (error) {
        logger.warn(
          `agent-lcars-telemetry-watcher: failed to upsert session ${sessionId}, will retry next tick`,
          error,
        );
      }
    }

    await this.tickAntigravitySummaries(now);
    this.options.metrics?.recordCompletedTick(now, this.sessions.size);
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
            `agent-lcars-telemetry-watcher: antigravity summary DB unavailable at ${dbPath} (expected on hosts without the Antigravity CLI installed) - polling disabled silently for the rest of this process`,
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
      // even a different machine profile entirely), so `processAlive` is
      // hardcoded false and `heartbeatReceived` true: a one-off snapshot of
      // already-recorded activity, never a fabricated `live`/`idle`
      // distinction this poller can't back up.
      const liveness = computeLiveness({
        now,
        lastActivityAt: summary.lastActivityAt,
        processAlive: false,
        heartbeatReceived: true,
      });

      // Antigravity rows never join the session-status overlay (it's keyed
      // by transcript-discovered `sessionId`, and these come from a polled
      // summary DB instead) — `buildSessionWrite` requests the clear
      // unconditionally here, deliberately, same as any other write with no
      // status on its summary. See that function's own doc comment.
      const write = buildSessionWrite(summary, liveness);

      try {
        await this.options.store.upsertSession(write);
        this.options.metrics?.recordSuccessfulSessionUpsert(now, liveness);
        this.antigravityLastModified.set(
          summary.sessionId,
          summary.lastActivityAt,
        );
      } catch (error) {
        logger.warn(
          `agent-lcars-telemetry-watcher: failed to upsert antigravity session ${summary.sessionId}, will retry next tick`,
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
