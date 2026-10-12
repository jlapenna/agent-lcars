'use strict';

// Console build worker sizing (#2493).
//
// `next build` sizes its page-data worker pool from the CPUs a process can
// *see*, not the CPUs its phase is allowed to *use*: the pinned Next 16.4.0
// defaultConfig derives `max(1, (CIRCLE_NODE_TOTAL || os.cpus().length) - 1)`
// and `apps/console/next.config.js` only capped `experimental.cpus` under CI.
// A truthful 2 CPU / 3 GiB phase on a many-core host therefore started 11
// workers and was OOM-killed before the branch could be published, because the
// repository's pre-push smoke runs that real production build locally.
//
// Resolution order, first match wins:
//
// 1. an explicit validated worker budget (`LCARS_CONSOLE_BUILD_CPUS`);
// 2. the repository's existing CI cap;
// 3. the cgroup CPU quota the process is actually bounded by;
// 4. nothing at all, which leaves Next's host-CPU default in place so an
//    ordinary unbounded developer build keeps the parallelism it has today.
//
// Invalid explicit input is rejected by throwing rather than ignored: silently
// falling back to host sizing is the exact failure this owner exists to stop.

const fs = require('node:fs');

const nodePath = require('node:path');

const os = require('node:os');

/** Env var carrying an explicit page-data worker budget for this build. */
const WORKER_BUDGET_ENV = 'LCARS_CONSOLE_BUILD_CPUS';
/** Cap the repository already applied to CI builds. */
const CI_WORKER_CAP = 2;
/** Upper bound accepted for an explicit budget, as a typo guard. */
const MAX_WORKER_BUDGET = 256;

function explicitWorkerBudget(env) {
  const raw = env[WORKER_BUDGET_ENV];
  if (raw === undefined) return null;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(
      `${WORKER_BUDGET_ENV} must be a positive integer worker count at or below ` +
        `${MAX_WORKER_BUDGET}, received ${JSON.stringify(raw)}.`,
    );
  }
  const budget = Number(raw);
  if (!Number.isSafeInteger(budget) || budget > MAX_WORKER_BUDGET) {
    throw new Error(
      `${WORKER_BUDGET_ENV} must be a positive integer worker count at or below ` +
        `${MAX_WORKER_BUDGET}, received ${JSON.stringify(raw)}.`,
    );
  }
  return budget;
}

function createDefaultIo() {
  return {
    read(file) {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

// "/system.slice/lcars-phase.service" -> itself, then every ancestor. CPU
// bandwidth composes down the hierarchy, so the effective bound is the most
// restrictive value along the path.
function cgroupAncestors(cgroupPath) {
  const trimmed = cgroupPath.replace(/\/+$/, '');
  const chain = [];
  let current = trimmed === '' ? '/' : trimmed;
  for (;;) {
    chain.push(current);
    if (current === '/') break;
    const slash = current.lastIndexOf('/');
    current = slash <= 0 ? '/' : current.slice(0, slash);
  }
  return chain;
}

function selfCgroupPaths(io, controller) {
  const raw = io.read('/proc/self/cgroup');
  if (raw === null) return [];
  const paths = [];
  for (const line of raw.split('\n')) {
    const entry = line.trim();
    if (!entry) continue;
    const first = entry.indexOf(':');
    const second = entry.indexOf(':', first + 1);
    if (first === -1 || second === -1) continue;
    const controllers = entry.slice(first + 1, second).split(',');
    const cgroupPath = entry.slice(second + 1);
    if (controllers.includes(controller)) paths.push(cgroupPath);
  }
  return paths;
}

function quotaToCpus(quota, period) {
  const parsedQuota = Number(quota);
  const parsedPeriod = Number(period);
  if (
    !Number.isFinite(parsedQuota) ||
    !Number.isFinite(parsedPeriod) ||
    parsedQuota <= 0 ||
    parsedPeriod <= 0
  ) {
    return null;
  }
  return parsedQuota / parsedPeriod;
}

// cgroup v2 unified hierarchy: `<mount>/<ancestor>/cpu.max` holds
// "<quota> <period>" or "max <period>". Containerized phases report "/" here,
// where the namespace root carries the container's own limit.
function cgroupV2CpuLimit(io) {
  if (io.read('/sys/fs/cgroup/cgroup.controllers') === null) return null;
  const ownPaths = selfCgroupPaths(io, '');
  const startingPoints = ownPaths.length > 0 ? ownPaths : ['/'];
  let limit = null;
  for (const startingPoint of startingPoints) {
    for (const ancestor of cgroupAncestors(startingPoint)) {
      const maxPath = nodePath.join('/sys/fs/cgroup', ancestor, 'cpu.max');
      const raw = io.read(maxPath);
      if (raw === null) continue;
      const [quota, period] = raw.trim().split(/\s+/);
      if (!quota || quota === 'max' || !period) continue;
      const cpus = quotaToCpus(quota, period);
      if (cpus === null) continue;
      if (limit === null || cpus < limit) limit = cpus;
    }
  }
  return limit;
}

// cgroup v1: the cpu controller mount plus `cpu.cfs_quota_us` /
// `cpu.cfs_period_us`, where a quota of -1 means unlimited.
function cgroupV1CpuLimit(io) {
  const mounts = io.read('/proc/mounts');
  if (mounts === null) return null;
  let mount = null;
  for (const line of mounts.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    if (fields[2] !== 'cgroup') continue;
    if (!fields[3].split(',').includes('cpu')) continue;
    mount = fields[1];
    break;
  }
  if (mount === null) return null;
  const ownPaths = selfCgroupPaths(io, 'cpu');
  const startingPoints = ownPaths.length > 0 ? ownPaths : ['/'];
  let limit = null;
  for (const startingPoint of startingPoints) {
    for (const ancestor of cgroupAncestors(startingPoint)) {
      const quota = io.read(nodePath.join(mount, ancestor, 'cpu.cfs_quota_us'));
      const period = io.read(
        nodePath.join(mount, ancestor, 'cpu.cfs_period_us'),
      );
      if (quota === null || period === null) continue;
      const cpus = quotaToCpus(quota.trim(), period.trim());
      if (cpus === null) continue;
      if (limit === null || cpus < limit) limit = cpus;
    }
  }
  return limit;
}

function boundedCpuLimit(io) {
  return cgroupV2CpuLimit(io) ?? cgroupV1CpuLimit(io);
}

/**
 * Decide how many `next build` page-data workers this phase may start.
 *
 * @param {{env?: Record<string, string | undefined>, io?: {read(file: string): string | null}, cpuCount?: number}} [options]
 * @returns {{cpus: number | null, source: 'explicit' | 'ci' | 'bounded-cpu' | 'next-default', detail: string}}
 */
function resolveConsoleBuildWorkers(options = {}) {
  const env = options.env ?? process.env;
  const budget = explicitWorkerBudget(env);
  if (budget !== null) {
    return {
      cpus: budget,
      source: 'explicit',
      detail: `${WORKER_BUDGET_ENV}=${budget}`,
    };
  }
  if (env.CI) {
    return {
      cpus: CI_WORKER_CAP,
      source: 'ci',
      detail: `CI build cap of ${CI_WORKER_CAP} workers`,
    };
  }
  const io = options.io ?? createDefaultIo();
  const cpuCount = options.cpuCount ?? os.cpus().length;
  const bounded = boundedCpuLimit(io);
  if (bounded !== null) {
    // Mirror Next's own reserve-one-core heuristic, applied to the quota the
    // phase actually holds rather than to the host's visible CPU count, and
    // never exceed what Next would have chosen on its own.
    const fromQuota = Math.max(1, Math.floor(bounded) - 1);
    const hostDefault = Math.max(1, cpuCount - 1);
    const cpus = Math.min(fromQuota, hostDefault);
    return {
      cpus,
      source: 'bounded-cpu',
      detail: `cgroup CPU quota of ${bounded} on a ${cpuCount}-CPU host`,
    };
  }
  return {
    cpus: null,
    source: 'next-default',
    detail: 'no validated budget or bounded CPU availability detected',
  };
}

module.exports = {
  CI_WORKER_CAP,
  MAX_WORKER_BUDGET,
  WORKER_BUDGET_ENV,
  resolveConsoleBuildWorkers,
};
