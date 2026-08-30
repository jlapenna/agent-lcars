#!/usr/bin/env node

import { appendFile, open, readdir, stat, truncate } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

const DEFAULTS = Object.freeze({
  pollIntervalMs: 250,
  readChunkBytes: 256 * 1024,
  // A page line always carries the runner's ISO timestamp, but structured
  // metadata still expands it in memory. Keep one discovery pass comfortably
  // below the bounded queue even when the page contains unusually short lines.
  maxReadBytesPerTick: 256 * 1024,
  maxQueueBytes: 2 * 1024 * 1024,
  maxBatchBytes: 512 * 1024,
  maxBatchLines: 1000,
  // job-daemon.sh gives a stopped child five seconds to exit. Keep one
  // in-flight push plus the final shutdown push inside that outer bound.
  pushTimeoutMs: 2000,
  initialBackoffMs: 500,
  maxBackoffMs: 30_000,
  shutdownBudgetMs: 2500,
  maxDiagnosticBytes: 64 * 1024,
});

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function pageIdentity(filename) {
  return filename.replace(/_\d+\.log$/u, '');
}

function groupName(line) {
  const match = /##\[group\](?:Run )?(.+)$/u.exec(line);
  return match?.[1]?.trim();
}

export class PageLogShipper {
  constructor({
    pageDirectory,
    endpoint,
    labels,
    metadata,
    diagnosticPath,
    fetchImplementation = globalThis.fetch,
    now = Date.now,
    config = {},
  }) {
    this.pageDirectory = pageDirectory;
    this.endpoint = endpoint;
    this.labels = labels;
    this.metadata = metadata;
    this.diagnosticPath = diagnosticPath;
    this.fetchImplementation = fetchImplementation;
    this.now = now;
    this.config = { ...DEFAULTS, ...config };

    this.files = new Map();
    this.stepNames = new Map();
    this.selectedIdentity = undefined;
    this.queue = [];
    this.queueBytes = 0;
    this.droppedLines = 0;
    this.backoffMs = this.config.initialBackoffMs;
    this.retryAt = 0;
    this.lastTimestampNs = 0n;
  }

  nextTimestamp() {
    const wallClock = BigInt(this.now()) * 1_000_000n;
    this.lastTimestampNs =
      wallClock > this.lastTimestampNs ? wallClock : this.lastTimestampNs + 1n;
    return this.lastTimestampNs.toString();
  }

  async diagnose(message) {
    if (!this.diagnosticPath) return;
    try {
      let size = 0;
      try {
        size = (await stat(this.diagnosticPath)).size;
      } catch {
        // The first diagnostic creates the file.
      }
      if (size >= this.config.maxDiagnosticBytes) {
        await truncate(this.diagnosticPath, 0);
      }
      await appendFile(
        this.diagnosticPath,
        `${new Date(this.now()).toISOString()} ${message}\n`,
        'utf8',
      );
    } catch {
      // Observability diagnostics must never affect the instrumented job.
    }
  }

  enqueue(line, state) {
    const discoveredGroup = groupName(line);
    if (discoveredGroup) {
      state.stepName = discoveredGroup;
      this.stepNames.set(state.identity, discoveredGroup);
    }

    const structuredMetadata = {
      ...this.metadata,
      step_name: state.stepName,
    };
    const value = [this.nextTimestamp(), line, structuredMetadata];
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (
      bytes > this.config.maxQueueBytes ||
      this.queueBytes + bytes > this.config.maxQueueBytes
    ) {
      this.droppedLines += 1;
      return;
    }
    this.queue.push({ value, bytes });
    this.queueBytes += bytes;
  }

  stateFor(filename) {
    let state = this.files.get(filename);
    if (state) return state;

    const identity = pageIdentity(filename);
    state = {
      offset: 0,
      carry: '',
      decoder: new StringDecoder('utf8'),
      identity,
      stepName: this.stepNames.get(identity) ?? filename,
    };
    this.files.set(filename, state);
    return state;
  }

  async selectPageIdentity(filenames) {
    if (this.selectedIdentity) return this.selectedIdentity;

    const candidates = new Map();
    for (const filename of filenames) {
      try {
        const fileStat = await stat(path.join(this.pageDirectory, filename));
        const identity = pageIdentity(filename);
        const candidate = candidates.get(identity) ?? {
          identity,
          bytes: 0,
          createdAt: fileStat.birthtimeMs,
        };
        candidate.bytes += fileStat.size;
        candidate.createdAt = Math.min(
          candidate.createdAt,
          fileStat.birthtimeMs,
        );
        candidates.set(identity, candidate);
      } catch (error) {
        await this.diagnose(
          `selection stat failed for ${filename}: ${error.message}`,
        );
      }
    }

    const selected = [...candidates.values()].sort(
      (left, right) =>
        right.bytes - left.bytes || left.createdAt - right.createdAt,
    )[0];
    if (selected) this.selectedIdentity = selected.identity;
    return this.selectedIdentity;
  }

  async readAvailable() {
    let entries;
    try {
      entries = await readdir(this.pageDirectory, { withFileTypes: true });
    } catch (error) {
      await this.diagnose(`page discovery failed: ${error.message}`);
      return;
    }

    let filenames = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
      .map((entry) => entry.name)
      .sort();
    const selectedIdentity = await this.selectPageIdentity(filenames);
    if (!selectedIdentity) return;
    // The runner writes every line to both a cumulative job record and an
    // ephemeral per-step record. At shipper startup the cumulative identity
    // is the largest because checkout has already completed. Follow only that
    // identity (including its numbered rotations) so Loki matches the final
    // archive instead of containing every line twice.
    filenames = filenames.filter(
      (filename) => pageIdentity(filename) === selectedIdentity,
    );
    let budget = this.config.maxReadBytesPerTick;

    for (const filename of filenames) {
      if (budget <= 0) break;
      const filePath = path.join(this.pageDirectory, filename);
      const state = this.stateFor(filename);
      let fileSize;
      try {
        fileSize = (await stat(filePath)).size;
      } catch (error) {
        await this.diagnose(`stat failed for ${filename}: ${error.message}`);
        continue;
      }

      if (fileSize < state.offset) {
        state.offset = 0;
        state.carry = '';
        state.decoder = new StringDecoder('utf8');
      }

      while (state.offset < fileSize && budget > 0) {
        const length = Math.min(
          fileSize - state.offset,
          budget,
          this.config.readChunkBytes,
        );
        const buffer = Buffer.allocUnsafe(length);
        let bytesRead;
        let handle;
        try {
          handle = await open(filePath, 'r');
          ({ bytesRead } = await handle.read(buffer, 0, length, state.offset));
        } catch (error) {
          await this.diagnose(`read failed for ${filename}: ${error.message}`);
          break;
        } finally {
          if (handle) await handle.close().catch(() => undefined);
        }
        if (bytesRead === 0) break;

        state.offset += bytesRead;
        budget -= bytesRead;
        const decoded = state.decoder.write(buffer.subarray(0, bytesRead));
        const lines = `${state.carry}${decoded}`.split('\n');
        state.carry = lines.pop() ?? '';
        for (const rawLine of lines) {
          this.enqueue(
            rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine,
            state,
          );
        }
      }
    }
  }

  async pushAvailable({ force = false } = {}) {
    if (this.queue.length === 0) return true;
    if (!force && this.now() < this.retryAt) return false;

    while (this.queue.length > 0) {
      const batch = [];
      let batchBytes = 0;
      for (const entry of this.queue) {
        if (
          batch.length > 0 &&
          (batch.length >= this.config.maxBatchLines ||
            batchBytes + entry.bytes > this.config.maxBatchBytes)
        ) {
          break;
        }
        batch.push(entry);
        batchBytes += entry.bytes;
      }

      try {
        const response = await this.fetchImplementation(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            streams: [
              {
                stream: this.labels,
                values: batch.map((entry) => entry.value),
              },
            ],
          }),
          signal: AbortSignal.timeout(this.config.pushTimeoutMs),
        });
        if (!response.ok) {
          throw new Error(`Loki returned HTTP ${response.status}`);
        }

        this.queue.splice(0, batch.length);
        this.queueBytes -= batchBytes;
        this.backoffMs = this.config.initialBackoffMs;
        this.retryAt = 0;
      } catch (error) {
        await this.diagnose(
          `push failed; retaining bounded batch: ${error.message}`,
        );
        this.retryAt = this.now() + this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, this.config.maxBackoffMs);
        return false;
      }
    }

    return true;
  }

  async tick(options) {
    await this.readAvailable();
    await this.pushAvailable(options);
  }

  enqueuePartialLines() {
    for (const state of this.files.values()) {
      const decoded = state.decoder.end();
      const line = `${state.carry}${decoded}`;
      state.carry = '';
      if (line) this.enqueue(line, state);
    }
  }

  async run() {
    let stopping = false;
    const requestStop = () => {
      stopping = true;
    };
    process.once('SIGINT', requestStop);
    process.once('SIGTERM', requestStop);

    await this.diagnose('shipper started');
    while (!stopping) {
      await this.tick();
      await sleep(this.config.pollIntervalMs);
    }

    await this.readAvailable();
    this.enqueuePartialLines();
    const deadline = this.now() + this.config.shutdownBudgetMs;
    while (this.queue.length > 0 && this.now() < deadline) {
      const before = this.queue.length;
      await this.pushAvailable({ force: true });
      if (this.queue.length >= before) await sleep(100);
    }
    await this.diagnose(
      `shipper stopped; queued=${this.queue.length} dropped=${this.droppedLines}`,
    );
  }
}

export function shipperFromEnvironment() {
  const runnerHost = process.env.AGENT_LCARS_RUNNER_HOST?.trim() || 'unknown';
  const metadata = {
    run_id: requiredEnvironment('GITHUB_RUN_ID'),
    run_attempt: process.env.GITHUB_RUN_ATTEMPT?.trim() || '1',
    job_name: requiredEnvironment('GITHUB_JOB'),
    sha: requiredEnvironment('GITHUB_SHA'),
  };
  if (process.env.ATTEMPT_ID?.trim()) {
    metadata.attempt_id = process.env.ATTEMPT_ID.trim();
  }

  return new PageLogShipper({
    pageDirectory:
      process.env.AGENT_LCARS_CI_LOG_PAGE_DIR || '/home/runner/_diag/pages',
    endpoint: requiredEnvironment('AGENT_LCARS_CI_LOG_LOKI_URL'),
    labels: {
      job: 'gha-ci',
      repo: requiredEnvironment('GITHUB_REPOSITORY'),
      workflow: requiredEnvironment('GITHUB_WORKFLOW'),
      runner_host: runnerHost,
    },
    metadata,
    diagnosticPath:
      process.env.AGENT_LCARS_CI_LOG_DIAGNOSTIC_PATH ||
      '/tmp/agent-lcars-ci-log-shipper.log',
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) {
  try {
    await shipperFromEnvironment().run();
  } catch (error) {
    try {
      await appendFile(
        process.env.AGENT_LCARS_CI_LOG_DIAGNOSTIC_PATH ||
          '/tmp/agent-lcars-ci-log-shipper.log',
        `${new Date().toISOString()} startup failed: ${error.message}\n`,
        'utf8',
      );
    } catch {
      // The shipper is deliberately fail-soft even when diagnostics fail.
    }
  }
}
