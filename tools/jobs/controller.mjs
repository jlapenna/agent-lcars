import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { admitProfile, dueAt } from './definition.mjs';
import { validateResult } from './result.mjs';

// Local, single-host prototype persistence. This is not a second production
// scheduler: the CLI explicitly ticks it. Production must bind these operations
// to Work admission/leases and object storage before it can be enabled.
export class JobController {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, job TEXT NOT NULL, occurrence TEXT NOT NULL,
        fingerprint TEXT NOT NULL, definition TEXT NOT NULL, status TEXT NOT NULL,
        started TEXT NOT NULL, deadline TEXT NOT NULL, finished TEXT,
        baseline TEXT, result TEXT, error TEXT, owner TEXT,
        UNIQUE(job, occurrence)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON runs(job) WHERE status IN ('queued', 'running');
      CREATE TABLE IF NOT EXISTS baselines (job TEXT PRIMARY KEY, run TEXT NOT NULL);
    `);
  }

  close() {
    this.db.close();
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row
      ? {
          ...row,
          definition: JSON.parse(row.definition),
          result: row.result ? JSON.parse(row.result) : null,
        }
      : undefined;
  }

  list() {
    return this.db
      .prepare(
        'SELECT id, job, occurrence, status, started, finished, error FROM runs ORDER BY started DESC LIMIT 100',
      )
      .all();
  }

  baseline(job) {
    const row = this.db
      .prepare('SELECT run FROM baselines WHERE job = ?')
      .get(job);
    return row ? this.get(row.run) : undefined;
  }

  admit(def, { trigger = 'manual', requestId, at = new Date(), profile }) {
    admitProfile(def, profile);
    if (trigger !== 'manual' && trigger !== 'schedule')
      throw new Error('unknown trigger');
    if (trigger === 'manual' && !def.job.triggers.manual)
      throw new Error('manual trigger disabled');
    if (trigger === 'schedule' && !dueAt(def, at))
      return { outcome: 'not-due' };
    if (!Number.isFinite(at.getTime()))
      throw new Error('invalid admission time');
    if (
      trigger === 'manual' &&
      (typeof requestId !== 'string' || !/^[\w.-]{1,128}$/u.test(requestId))
    ) {
      throw new Error('manual runs need a stable requestId');
    }
    const slot = new Date(
      Math.floor(at.getTime() / 60_000) * 60_000,
    ).toISOString();
    const occurrence =
      trigger === 'schedule' ? `schedule:${slot}` : `manual:${requestId}`;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([def.revision, def.digest, def.job.inputs]))
      .digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db
        .prepare(
          'SELECT id, fingerprint FROM runs WHERE job = ? AND occurrence = ?',
        )
        .get(def.id, occurrence);
      if (prior) {
        // A scheduled occurrence is bound to its first admitted revision, even
        // if the repository changes while that minute is still being ticked.
        if (trigger === 'manual' && prior.fingerprint !== fingerprint)
          throw new Error('requestId already used with different definition');
        this.db.exec('COMMIT');
        return { outcome: 'replay', run: this.get(prior.id) };
      }
      // Queued work has never launched a worker and can safely expire. Running
      // work requires explicit termination proof through recover().
      this.db
        .prepare(
          "UPDATE runs SET status = 'timed-out', finished = ?, error = 'expired before execution' WHERE job = ? AND status = 'queued' AND deadline <= ?",
        )
        .run(at.toISOString(), def.id, at.toISOString());
      const active = this.db
        .prepare(
          "SELECT id FROM runs WHERE job = ? AND status IN ('queued', 'running')",
        )
        .get(def.id);
      const id = randomUUID();
      const previous = def.job.state.previousSuccessfulResult
        ? this.baseline(def.id)
        : undefined;
      const comparisonScope = (value) =>
        JSON.stringify([
          value.job.result.contract,
          value.job.inputs.subnet,
          value.job.inputs.findingsRepository,
        ]);
      const baseline =
        previous &&
        comparisonScope(previous.definition) === comparisonScope(def)
          ? previous.id
          : null;
      const status = active ? 'skipped' : 'queued';
      const deadline = new Date(
        at.getTime() + parseInt(def.job.execution.timeout, 10) * 60_000,
      ).toISOString();
      this.db
        .prepare(
          `INSERT INTO runs(id, job, occurrence, fingerprint, definition, status, started, deadline, finished, baseline, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          def.id,
          occurrence,
          fingerprint,
          JSON.stringify(def),
          status,
          at.toISOString(),
          deadline,
          active ? at.toISOString() : null,
          baseline,
          active ? `overlap with ${active.id}` : null,
        );
      this.db.exec('COMMIT');
      return { outcome: active ? 'skipped' : 'admitted', run: this.get(id) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  #settle(id, owner, status, result, error, now = new Date()) {
    if (
      !['succeeded', 'incomplete', 'failed', 'cancelled', 'timed-out'].includes(
        status,
      )
    )
      throw new Error('invalid terminal status');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run = this.get(id);
      if (!run || run.status !== 'running' || run.owner !== owner)
        throw new Error('execution owner is stale');
      if (
        status === 'succeeded' &&
        now.getTime() >= new Date(run.deadline).getTime()
      ) {
        status = 'timed-out';
        error = 'result arrived after deadline';
      }
      this.db
        .prepare(
          'UPDATE runs SET status = ?, result = ?, error = ?, finished = ? WHERE id = ?',
        )
        .run(
          status,
          result ? JSON.stringify(result) : null,
          error ?? null,
          now.toISOString(),
          id,
        );
      if (status === 'succeeded') {
        this.db
          .prepare(
            'INSERT INTO baselines(job, run) VALUES (?, ?) ON CONFLICT(job) DO UPDATE SET run = excluded.run',
          )
          .run(run.job, id);
      }
      this.db.exec('COMMIT');
      return this.get(id);
    } catch (failure) {
      this.db.exec('ROLLBACK');
      throw failure;
    }
  }

  async execute(run, executor, signal) {
    const owner = randomUUID();
    const claimed = this.db
      .prepare(
        "UPDATE runs SET status = 'running', owner = ? WHERE id = ? AND status = 'queued'",
      )
      .run(owner, run.id);
    if (claimed.changes !== 1)
      throw new Error('run already claimed or terminal');
    // The stored commit, inputs and baseline are authoritative, never the
    // mutable object supplied by a caller that requested execution.
    run = this.get(run.id);
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const remaining = new Date(run.deadline).getTime() - Date.now();
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.max(0, remaining),
    );
    try {
      if (remaining <= 0) {
        timedOut = true;
        controller.abort();
      }
      if (controller.signal.aborted)
        throw new Error('execution cancelled before launch');
      const previous = run.baseline
        ? this.get(run.baseline)?.result?.artifacts['findings.json']
        : null;
      const output = await executor({
        run,
        baseline: previous,
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw new Error('execution stopped');
      const result = validateResult(output, run.definition.job.inputs.subnet);
      return this.#settle(run.id, owner, result.status, result);
    } catch (error) {
      return this.#settle(
        run.id,
        owner,
        timedOut
          ? 'timed-out'
          : controller.signal.aborted
            ? 'cancelled'
            : 'failed',
        null,
        error.message,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  async recover(id, verifyStopped, now = new Date()) {
    const run = this.get(id);
    if (!run || run.status !== 'running' || new Date(run.deadline) > now)
      throw new Error('run is not expired');
    // The host adapter must prove its entire owned allocation is gone. Time
    // alone never permits overlapping the old worker with a replacement.
    if (typeof verifyStopped !== 'function' || !(await verifyStopped(run)))
      throw new Error('worker termination is unverified');
    return this.#settle(
      id,
      run.owner,
      'timed-out',
      null,
      'recovered after verified worker termination',
      now,
    );
  }
}
