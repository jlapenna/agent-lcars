#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';

const SCHEMA_VERSION = 'apphosting-stale-revision/v1';
const REMEDIATION_REFERENCE =
  'docs/apphosting-stale-revision-audit.md#safe-remediation';
const APP_HOSTING_RESOURCE =
  /^projects\/[^/]+\/locations\/[^/]+\/backends\/[^/]+\/(?:builds|rollouts)\/[^/]+$/u;

function condition(resource) {
  const conditions = resource?.status?.conditions ?? resource?.conditions;
  if (!Array.isArray(conditions)) return undefined;
  return conditions.find((entry) => entry?.type === 'Ready');
}

function ready(resource) {
  const status =
    condition(resource)?.status ??
    resource?.ready ??
    resource?.status?.ready ??
    resource?.state?.ready;
  if (status === 'True' || status === true) return true;
  if (status === 'False' || status === false) return false;
  return undefined;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function safeReason(value) {
  const reason = nonEmptyString(value);
  return reason && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(reason)
    ? reason
    : null;
}

function metadataValue(resource, names) {
  const metadata = resource?.metadata ?? {};
  const sources = [
    metadata.labels,
    metadata.annotations,
    resource?.labels,
    resource?.annotations,
  ];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const name of names) {
      const value = nonEmptyString(source[name]);
      if (value) return value;
    }
  }
  return null;
}

function linkage(resource) {
  const appHosting = resource?.appHosting ?? resource?.apphosting ?? {};
  return {
    build:
      nonEmptyString(appHosting.build) ??
      nonEmptyString(appHosting.buildName) ??
      metadataValue(resource, [
        'apphosting.build',
        'apphosting.buildName',
        'firebase.google.com/apphosting-build',
        'firebase.google.com/apphosting-build-name',
        'firebase.google.com/apphosting-build-id',
      ]),
    rollout:
      nonEmptyString(appHosting.rollout) ??
      nonEmptyString(appHosting.rolloutName) ??
      metadataValue(resource, [
        'apphosting.rollout',
        'apphosting.rolloutName',
        'firebase.google.com/apphosting-rollout',
        'firebase.google.com/apphosting-rollout-name',
        'firebase.google.com/apphosting-rollout-id',
      ]),
  };
}

function trafficPercent(resource) {
  const direct = resource?.trafficPercent ?? resource?.status?.trafficPercent;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0)
    return direct;
  const traffic = resource?.status?.traffic ?? resource?.traffic;
  if (!Array.isArray(traffic)) return null;
  let total = 0;
  for (const entry of traffic) {
    const value = entry?.percent ?? entry?.trafficPercent;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      return null;
    total += value;
  }
  return total;
}

function revisionName(resource) {
  return (
    nonEmptyString(resource?.metadata?.name) ?? nonEmptyString(resource?.name)
  );
}

function revisionTime(resource) {
  return (
    nonEmptyString(resource?.metadata?.creationTimestamp) ??
    nonEmptyString(resource?.createTime) ??
    nonEmptyString(resource?.creationTimestamp)
  );
}

function validLinkage(link, backendName) {
  if (
    !APP_HOSTING_RESOURCE.test(link.build ?? '') ||
    !APP_HOSTING_RESOURCE.test(link.rollout ?? '')
  )
    return false;
  const backendPath = backendName?.match(
    /^(projects\/[^/]+\/locations\/[^/]+\/backends\/[^/]+)(?:\/|$)/u,
  )?.[1];
  if (!backendPath) return false;
  return (
    link.build.startsWith(`${backendPath}/builds/`) &&
    link.rollout.startsWith(`${backendPath}/rollouts/`)
  );
}

function requireSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object')
    throw new Error('Snapshot must be a JSON object');
  if (snapshot.schemaVersion !== SCHEMA_VERSION)
    throw new Error(`Snapshot schemaVersion must be ${SCHEMA_VERSION}`);
  if (!snapshot.backend || typeof snapshot.backend !== 'object')
    throw new Error('Snapshot backend is required');
  if (!Array.isArray(snapshot.cloudRun?.revisions))
    throw new Error('Snapshot cloudRun.revisions must be an array');
}

/**
 * Normalize one recorded App Hosting + Cloud Run API response.
 *
 * This function only examines the supplied object. It deliberately has no
 * client, network, credential, traffic, revision, or deployment capability.
 */
export function auditSnapshot(snapshot) {
  requireSnapshot(snapshot);
  const backend = snapshot.backend;
  const backendReady = ready(backend);
  if (snapshot.cloudRun.nextPageToken)
    throw new Error(
      'Snapshot cloudRun.revisions must contain every page; nextPageToken is not supported',
    );
  const seenRevisionNames = new Set();
  const revisions = snapshot.cloudRun.revisions
    .map((resource) => {
      if (!resource || typeof resource !== 'object')
        throw new Error('Snapshot revisions must be objects');
      const name = revisionName(resource);
      const createdAt = revisionTime(resource);
      if (!name || !createdAt || !Number.isFinite(Date.parse(createdAt)))
        throw new Error(
          'Every recorded revision needs a name and valid creation time',
        );
      if (seenRevisionNames.has(name))
        throw new Error(`Duplicate recorded Cloud Run revision: ${name}`);
      seenRevisionNames.add(name);
      return {
        resource,
        name,
        createdAt,
        createdAtEpoch: Date.parse(createdAt),
        ready: ready(resource),
        trafficPercent: trafficPercent(resource),
        linkage: linkage(resource),
      };
    })
    .sort((left, right) => {
      const time = right.createdAtEpoch - left.createdAtEpoch;
      return time || right.name.localeCompare(left.name);
    });
  const latestRevision = revisions[0] ?? null;
  const failedZeroTrafficRevisions = revisions
    .filter(
      (revision) =>
        revision.ready === false &&
        revision.trafficPercent === 0 &&
        validLinkage(revision.linkage, backend.name),
    )
    .map(
      ({ resource: _resource, createdAtEpoch: _createdAtEpoch, ...revision }) =>
        revision,
    );
  const stale = backendReady === false && latestRevision?.ready === true;
  const status =
    stale === true
      ? 'alert'
      : backendReady === undefined || latestRevision?.ready === undefined
        ? 'insufficient-data'
        : 'ok';

  return {
    schemaVersion: SCHEMA_VERSION,
    capturedAt: nonEmptyString(snapshot.capturedAt),
    status,
    alert:
      stale === true
        ? {
            code: 'APPHOSTING_STALE_REVISION',
            summary:
              'App Hosting backend is not Ready although its latest Cloud Run revision is Ready.',
            remediationReference: REMEDIATION_REFERENCE,
          }
        : null,
    backend: {
      name: nonEmptyString(backend.name),
      ready: backendReady,
      reason: safeReason(condition(backend)?.reason),
    },
    latestRevision: latestRevision
      ? {
          name: latestRevision.name,
          createdAt: latestRevision.createdAt,
          ready: latestRevision.ready,
          trafficPercent: latestRevision.trafficPercent,
        }
      : null,
    failedZeroTrafficRevisions,
  };
}

export function renderMarkdown(report) {
  const title = '# App Hosting stale-revision audit';
  const lines = [
    title,
    '',
    `- Status: **${report.status.toUpperCase()}**`,
    `- Backend: \`${report.backend.name ?? 'unknown'}\` (Ready=${String(report.backend.ready)})`,
    `- Latest Cloud Run revision: \`${report.latestRevision?.name ?? 'unknown'}\` (Ready=${String(report.latestRevision?.ready)})`,
    `- Failed zero-traffic revisions: **${report.failedZeroTrafficRevisions.length}**`,
  ];
  if (report.alert) {
    lines.push(
      '',
      `## Alert: ${report.alert.code}`,
      '',
      report.alert.summary,
      '',
      `This audit is report-only. Follow the [safe remediation runbook](${report.alert.remediationReference}) after validating the build and rollout; do not treat this report as authorization for a control-plane change.`,
    );
  }
  if (report.failedZeroTrafficRevisions.length > 0) {
    lines.push('', '## Failed zero-traffic revisions', '');
    for (const revision of report.failedZeroTrafficRevisions) {
      lines.push(
        `- \`${revision.name}\` (created ${revision.createdAt}); build: \`${revision.linkage.build ?? 'unknown'}\`; rollout: \`${revision.linkage.rollout ?? 'unknown'}\``,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function parseArgs(args) {
  const fixture = option(args, '--fixture');
  const format = option(args, '--format') ?? 'markdown';
  const output = option(args, '--output');
  if (!fixture || !['json', 'markdown'].includes(format))
    throw new Error(
      'Usage: node tools/apphosting-stale-revision-audit.mjs --fixture <recorded-json> [--format markdown|json] [--output <file>]',
    );
  return { fixture, format, output };
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  const report = auditSnapshot(
    JSON.parse(await readFile(input.fixture, 'utf8')),
  );
  const content =
    input.format === 'json'
      ? JSON.stringify(report, null, 2)
      : renderMarkdown(report);
  if (input.output)
    await writeFile(input.output, `${content.trimEnd()}\n`, { mode: 0o600 });
  else process.stdout.write(content);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
