import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, test } from 'vitest';

import {
  auditSnapshot,
  parseArgs,
  renderMarkdown,
  writePrivateReport,
} from '../apphosting-stale-revision-audit.mjs';

const fixtureRoot = path.resolve(
  import.meta.dirname,
  '../apphosting-stale-revision-audit/fixtures',
);

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(fixtureRoot, `${name}.json`), 'utf8'),
  );
}

describe('App Hosting stale-revision audit', () => {
  test('alerts on backend false/latest revision true and filters failed zero traffic', async () => {
    const report = auditSnapshot(await fixture('alert'));
    assert.equal(report.status, 'alert');
    assert.equal(report.alert?.code, 'APPHOSTING_STALE_REVISION');
    assert.equal(report.latestRevision?.name, 'agent-lcars-00009-abc');
    assert.equal(report.latestRevision?.ready, true);
    assert.deepEqual(
      report.failedZeroTrafficRevisions.map((revision) => revision.name),
      ['agent-lcars-00008-def'],
    );
    assert.equal(
      report.failedZeroTrafficRevisions[0]?.linkage.build,
      'projects/agent-lcars/locations/us-central1/backends/agent-lcars/builds/build-008',
    );
    assert.equal(
      report.failedZeroTrafficRevisions[0]?.linkage.rollout,
      'projects/agent-lcars/locations/us-central1/backends/agent-lcars/rollouts/rollout-008',
    );
  });

  test('renders a clear report with a safe remediation reference', async () => {
    const markdown = renderMarkdown(auditSnapshot(await fixture('alert')));
    assert.match(markdown, /APPHOSTING_STALE_REVISION/u);
    assert.match(markdown, /report-only/u);
    assert.match(markdown, /safe remediation runbook/u);
    assert.match(markdown, /agent-lcars-00008-def/u);
    assert.match(markdown, /build-008/u);
    assert.match(markdown, /rollout-008/u);
  });

  test('does not alert when both backend and latest revision are ready', async () => {
    const report = auditSnapshot(await fixture('healthy'));
    assert.equal(report.status, 'ok');
    assert.equal(report.alert, null);
    assert.deepEqual(report.failedZeroTrafficRevisions, []);
  });

  test('does not alert when the latest revision is not ready', async () => {
    const snapshot = structuredClone(await fixture('alert')) as {
      cloudRun: { revisions: Array<{ status: { conditions: unknown[] } }> };
    };
    snapshot.cloudRun.revisions[0].status.conditions = [
      { type: 'Ready', status: 'False' },
    ];
    const report = auditSnapshot(snapshot);
    assert.equal(report.status, 'ok');
    assert.equal(report.alert, null);
  });

  test('treats missing Ready and traffic observations as indeterminate', async () => {
    const snapshot = structuredClone(await fixture('alert')) as {
      cloudRun: {
        revisions: Array<{
          status: { conditions: unknown[]; traffic?: unknown[] };
        }>;
      };
    };
    snapshot.cloudRun.revisions[0].status.conditions = [
      { type: 'Active', status: 'True' },
    ];
    delete snapshot.cloudRun.revisions[1].status.traffic;
    const report = auditSnapshot(snapshot);
    assert.equal(report.status, 'insufficient-data');
    assert.equal(report.latestRevision?.ready, undefined);
    assert.deepEqual(report.failedZeroTrafficRevisions, []);
  });

  test('requires complete linkage for listed failed zero-traffic revisions', async () => {
    const snapshot = structuredClone(await fixture('alert')) as {
      backend: { name: string };
      cloudRun: { revisions: Array<Record<string, unknown>> };
    };
    snapshot.cloudRun.revisions.push(
      {
        metadata: {
          name: 'agent-lcars-00005-unlinked',
          creationTimestamp: '2026-08-15T16:55:00Z',
        },
        status: {
          conditions: [{ type: 'Ready', status: 'False' }],
          traffic: [],
        },
      },
      {
        metadata: {
          name: 'agent-lcars-00004-mismatched',
          creationTimestamp: '2026-08-15T16:54:00Z',
          labels: {
            'apphosting.build':
              'projects/other/locations/us-central1/backends/other/builds/build-004',
            'apphosting.rollout':
              'projects/agent-lcars/locations/us-central1/backends/agent-lcars/rollouts/rollout-004',
          },
        },
        status: {
          conditions: [{ type: 'Ready', status: 'False' }],
          traffic: [],
        },
      },
    );
    const report = auditSnapshot(snapshot);
    assert.deepEqual(
      report.failedZeroTrafficRevisions.map((revision) => revision.name),
      ['agent-lcars-00008-def'],
    );
  });

  test('rejects incomplete pages and duplicate revision records', async () => {
    const paged = structuredClone(await fixture('healthy')) as {
      cloudRun: { revisions: unknown[]; nextPageToken?: string };
    };
    paged.cloudRun.nextPageToken = 'page-2';
    assert.throws(() => auditSnapshot(paged), /nextPageToken/u);

    const duplicate = structuredClone(await fixture('healthy')) as {
      cloudRun: { revisions: unknown[] };
    };
    duplicate.cloudRun.revisions.push(duplicate.cloudRun.revisions[0]);
    assert.throws(() => auditSnapshot(duplicate), /Duplicate/u);
  });

  test('sorts revision instants chronologically and omits unsafe API messages', async () => {
    const snapshot = structuredClone(await fixture('alert')) as {
      backend: {
        status: {
          conditions: Array<{ message?: string; reason?: string }>;
        };
      };
      cloudRun: {
        revisions: Array<{
          metadata: { creationTimestamp: string; name: string };
        }>;
      };
    };
    snapshot.cloudRun.revisions[0].metadata.creationTimestamp =
      '2026-08-15T09:30:00-07:00';
    snapshot.cloudRun.revisions[1].metadata.creationTimestamp =
      '2026-08-15T17:00:00Z';
    snapshot.backend.status.conditions[0].message =
      'signedUrl=https://example.invalid/?token=secret-value';
    snapshot.backend.status.conditions[0].reason = 'token=secret-value';

    const report = auditSnapshot(snapshot);
    assert.equal(report.latestRevision?.name, 'agent-lcars-00008-def');
    assert.equal(report.backend.reason, null);
    assert.doesNotMatch(JSON.stringify(report), /secret-value|signedUrl/u);
  });

  test('rejects a malformed revision instead of selecting an older one', async () => {
    const snapshot = structuredClone(await fixture('alert')) as {
      cloudRun: {
        revisions: Array<{ metadata: { creationTimestamp?: string } }>;
      };
    };
    delete snapshot.cloudRun.revisions[0].metadata.creationTimestamp;
    assert.throws(() => auditSnapshot(snapshot), /valid creation time/u);
  });

  test('requires the versioned offline fixture and fixture path', () => {
    assert.throws(() => auditSnapshot({}), /schemaVersion/u);
    assert.throws(() => parseArgs([]), /Usage/u);
    assert.throws(
      () => parseArgs(['--fixture', 'fixture.json', '--format', 'html']),
      /Usage/u,
    );
  });

  test('forces an overwritten report to owner-only permissions', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'apphosting-stale-audit-'),
    );
    const output = path.join(directory, 'report.md');
    try {
      await writeFile(output, 'old report\n', { mode: 0o644 });
      await writePrivateReport(output, 'new report');
      assert.equal((await stat(output)).mode & 0o777, 0o600);
      assert.equal(await readFile(output, 'utf8'), 'new report\n');
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
