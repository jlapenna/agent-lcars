import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { reconcileCauses } from '../../.agents/skills/issue-triage/scripts/reconcile-causes.mjs';

const script = path.resolve(
  '.agents/skills/issue-triage/scripts/reconcile-causes.mjs',
);
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

// Synthetic structural regression for #2465, not the unavailable private
// snapshot/body files. Owning references for the four aliases come from #2465;
// every filename below is deliberately a fixture identity.
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cause-report-'));
  directories.push(directory);
  const ids = Array.from({ length: 182 }, (_, i) => `B${i + 1}`);
  const issueNumbers: Record<string, number> = {
    B67: 2299,
    B68: 2301,
    B69: 2302,
    B70: 2303,
  };
  const rows = ids.map((id) => ({
    id,
    issue: `jlapenna/agent-lcars#${issueNumbers[id] ?? 10000 + Number(id.slice(1))}`,
    evidence: [`fixture/retained-${id}.md`],
    failures: [{ receipt: `fixture/failed-${id}.log`, outcome: 'failed' }],
    remainingGates: ['runtime qualification'],
    queuedIntent: { outcome: 'cancelled-already-satisfied' },
  }));
  const root = rows.filter((_, i) => i < 66 || i >= 166);
  const ledger = Object.fromEntries(
    rows
      .slice(66, 166)
      .map((row, i) => [i < 4 ? `descriptive-${i}` : row.id, row]),
  );
  const aliases = rows.slice(66, 70).map((row, i) => ({
    source: 'ledger',
    key: `descriptive-${i}`,
    id: row.id,
    issue: row.issue,
    bodyFile: row.evidence[0],
    basis: 'fixture/consolidation-receipt.json',
  }));
  const manifest = {
    expectedIds: ids,
    sources: [
      { name: 'root', path: 'root.json', sha256: '' },
      {
        name: 'ledger',
        path: 'ledger.json',
        sha256: '',
        collection: '/causes',
        fields: { id: '$key', issue: '/issue', evidence: '/evidence' },
      },
    ],
    aliases,
  };
  const save = () => {
    writeFileSync(path.join(directory, 'root.json'), JSON.stringify(root));
    writeFileSync(
      path.join(directory, 'ledger.json'),
      JSON.stringify({ causes: ledger }),
    );
    for (const source of manifest.sources)
      source.sha256 = createHash('sha256')
        .update(readFileSync(path.join(directory, source.path)))
        .digest('hex');
    writeFileSync(
      path.join(directory, 'manifest.json'),
      JSON.stringify(manifest),
    );
  };
  save();
  return { directory, rows, root, ledger, manifest, save };
}

describe('complete interactive workstream report assembly', () => {
  it('assembles the reported 82+100 shape through the actual CLI and retains failures/gates', () => {
    const f = fixture();
    const before = ['root.json', 'ledger.json'].map((file) =>
      readFileSync(path.join(f.directory, file), 'utf8'),
    );
    const result = spawnSync(
      process.execPath,
      [script, path.join(f.directory, 'manifest.json')],
      { encoding: 'utf8' },
    );
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: '',
    });
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      complete: true,
      totals: { causes: 182, owningIssues: 182 },
    });
    expect(report.sources.map((source: any) => source.recordsRead)).toEqual([
      82, 100,
    ]);
    expect(report.causes.map((cause: any) => cause.id)).toEqual(
      f.manifest.expectedIds,
    );
    for (const alias of f.manifest.aliases) {
      const cause = report.causes.find((cause: any) => cause.id === alias.id);
      expect(cause.issue).toBe(alias.issue);
      expect(cause.records[0].alias.bodyFile).toBe(alias.bodyFile);
    }
    expect(report.causes[0].records[0].record).toEqual(f.rows[0]);
    expect(
      ['root.json', 'ledger.json'].map((file) =>
        readFileSync(path.join(f.directory, file), 'utf8'),
      ),
    ).toEqual(before);
  });

  it.each([
    undefined,
    null,
    false,
    42,
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'g'.repeat(64),
    `${'a'.repeat(64)}\n`,
    ` ${'a'.repeat(64)}`,
  ])(
    'refuses an absent or invalid snapshot pin %s through the actual CLI',
    (sha256) => {
      // A later source must not inherit the first source's qualified pin.
      for (const sourceIndex of [0, 1]) {
        const f = fixture();
        const source = f.manifest.sources[sourceIndex];
        Object.assign(source, { sha256 });
        writeFileSync(
          path.join(f.directory, 'manifest.json'),
          JSON.stringify(f.manifest),
        );
        const result = spawnSync(
          process.execPath,
          [script, path.join(f.directory, 'manifest.json')],
          { encoding: 'utf8' },
        );
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
          complete: false,
          totals: null,
          error: `Sources require a valid SHA256 snapshot pin: ${source.name}`,
        });
      }
    },
  );

  it('rejects content changed after pinning and accepts the exact restored bytes', () => {
    const f = fixture();
    const filename = path.join(f.directory, 'ledger.json');
    const original = readFileSync(filename);
    // Keep all identities valid so a missing hash check would report complete.
    f.ledger.B71.remainingGates.push('new evidence requiring review');
    writeFileSync(filename, JSON.stringify({ causes: f.ledger }));
    const invoke = () =>
      spawnSync(
        process.execPath,
        [script, path.join(f.directory, 'manifest.json')],
        { encoding: 'utf8' },
      );
    const changed = invoke();
    expect(changed.status).toBe(1);
    expect(JSON.parse(changed.stdout)).toMatchObject({
      complete: false,
      totals: null,
      error: 'Source snapshot changed: ledger',
    });
    writeFileSync(filename, original);
    const restored = invoke();
    expect(restored.status).toBe(0);
    expect(JSON.parse(restored.stdout)).toMatchObject({
      complete: true,
      totals: { causes: 182, owningIssues: 182 },
    });
  });

  it('accepts case-equivalent immutable SHA256 pins', () => {
    const f = fixture();
    for (const source of f.manifest.sources)
      source.sha256 = source.sha256.toUpperCase();
    const report = reconcileCauses(f.manifest, f.directory);
    expect(report).toMatchObject({
      complete: true,
      totals: { causes: 182, owningIssues: 182 },
    });
  });

  it.each(['/id', '$key'])(
    'retains a receipt-backed descriptive-key alias when the ID field is absent (%s)',
    (pointer) => {
      const f = fixture();
      f.manifest.sources[1].fields.id = pointer;
      for (const alias of f.manifest.aliases)
        Reflect.deleteProperty(f.ledger[alias.key], 'id');
      f.save();
      const result = spawnSync(
        process.execPath,
        [script, path.join(f.directory, 'manifest.json')],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        complete: true,
        totals: { causes: 182, owningIssues: 182 },
      });
    },
  );

  it.each(['B-1', 'b1', 'B 1', 'B_1', 'B01', 'B0', '', null, 'descriptive-id'])(
    'never uses an alias to replace an explicit invalid ID %s',
    (id) => {
      const f = fixture();
      f.manifest.sources[1].fields.id = '/id';
      Object.assign(f.ledger['descriptive-0'], { id });
      f.save();
      const result = spawnSync(
        process.execPath,
        [script, path.join(f.directory, 'manifest.json')],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        complete: false,
        totals: null,
        missingIds: ['B67'],
        unresolved: [
          expect.objectContaining({
            source: 'ledger',
            key: 'descriptive-0',
            reasons: expect.arrayContaining(['unknown or malformed cause id']),
          }),
        ],
      });
    },
  );

  it.each([
    'B-1',
    'b1',
    'B 1',
    'B_1',
    'B01',
    'B0',
    'B',
    '0',
    ' B1',
    'B1 ',
    ' b1 ',
    ' B-1 ',
  ])('does not alias a malformed cause-namespace or numeric key %s', (key) => {
    const f = fixture();
    f.ledger[key] = f.ledger['descriptive-0'];
    delete f.ledger['descriptive-0'];
    f.manifest.aliases[0].key = key;
    f.save();
    const result = spawnSync(
      process.execPath,
      [script, path.join(f.directory, 'manifest.json')],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      complete: false,
      totals: null,
      missingIds: ['B67'],
      unresolved: [
        expect.objectContaining({
          source: 'ledger',
          key,
          reasons: expect.arrayContaining(['unknown or malformed cause id']),
        }),
      ],
    });
  });

  it.each([
    '../..#1',
    '-/-#1',
    'owner/..#1',
    'owner/.#1',
    '-owner/repo#1',
    'owner-/repo#1',
    'own--er/repo#1',
    'owner__emu/repo#1',
    'owner/repo#1\n',
    `${'o'.repeat(40)}/repo#1`,
    `owner/${'r'.repeat(101)}#1`,
  ])(
    'rejects a malformed qualified record issue %s through the CLI',
    (issue) => {
      const f = fixture();
      f.root[0].issue = issue;
      f.save();
      const result = spawnSync(
        process.execPath,
        [script, path.join(f.directory, 'manifest.json')],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        complete: false,
        totals: null,
        missingIds: ['B1'],
        unresolved: [expect.objectContaining({ source: 'root', key: '0' })],
      });
    },
  );

  it.each(['../..#1', '-/-#1'])(
    'rejects a malformed qualified alias issue %s before counting',
    (issue) => {
      const f = fixture();
      f.manifest.aliases[0].issue = issue;
      f.ledger['descriptive-0'].issue = issue;
      f.save();
      const result = spawnSync(
        process.execPath,
        [script, path.join(f.directory, 'manifest.json')],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        complete: false,
        totals: null,
        error: expect.stringContaining('qualified issue'),
      });
    },
  );

  it.each([
    'Mixed-Owner/.repo_name-1#1',
    'mona-cat_octo/-repo#1',
    `${'o'.repeat(39)}/${'r'.repeat(100)}#1`,
  ])('accepts a qualified GitHub issue syntax %s through the CLI', (issue) => {
    const f = fixture();
    f.root[0].issue = issue;
    f.save();
    const result = spawnSync(
      process.execPath,
      [script, path.join(f.directory, 'manifest.json')],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      complete: true,
      totals: { causes: 182, owningIssues: 182 },
    });
  });

  it.each([
    'ledger-row',
    'record-field',
    'escaped-record-field',
    'nested-retained-field',
    'manifest-scope',
    'manifest-sources',
    'prototype-name',
  ])(
    'rejects duplicate JSON names without dropping retained evidence (%s)',
    (kind) => {
      const f = fixture();
      const sourceFile = kind === 'ledger-row' ? 'ledger.json' : 'root.json';
      const filename = path.join(f.directory, sourceFile);
      let bytes = readFileSync(filename, 'utf8');
      if (kind === 'ledger-row')
        bytes = bytes.replace(
          '{"causes":{',
          '{"causes":{"B71":{"issue":"other/owner#1","evidence":["discarded"]},',
        );
      else if (kind === 'record-field')
        bytes = bytes.replace('"issue":', '"issue":"../..#1","issue":');
      else if (kind === 'escaped-record-field')
        bytes = bytes.replace('"issue":', '"\\u0069ssue":"../..#1","issue":');
      else if (kind === 'nested-retained-field')
        bytes = bytes.replace('"receipt":', '"receipt":"discarded","receipt":');
      else if (kind === 'prototype-name')
        bytes = bytes.replace('[{', '[{"__proto__":false,"__proto__":null,');
      writeFileSync(filename, bytes);
      const source = f.manifest.sources.find((row) => row.path === sourceFile)!;
      source.sha256 = createHash('sha256').update(bytes).digest('hex');
      let manifest = JSON.stringify(f.manifest);
      if (kind === 'manifest-scope')
        manifest = manifest.replace(
          '"expectedIds":',
          '"expectedIds":[],"expectedIds":',
        );
      else if (kind === 'manifest-sources')
        manifest = manifest.replace('"sources":', '"sources":[],"sources":');
      writeFileSync(path.join(f.directory, 'manifest.json'), manifest);
      const result = spawnSync(
        process.execPath,
        [script, path.join(f.directory, 'manifest.json')],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        complete: false,
        totals: null,
        error: expect.stringContaining('Duplicate JSON property'),
      });
      expect(readFileSync(filename, 'utf8')).toBe(bytes);
      expect(
        readFileSync(path.join(f.directory, 'manifest.json'), 'utf8'),
      ).toBe(manifest);
    },
  );

  it('keeps JSON values and repeated names in separate objects intact', () => {
    const f = fixture();
    (f.root[0] as any).metadata = {
      date: '2026-01-01',
      literal: 'yes',
      boolean: true,
      absent: null,
      quoted: '"issue":{},[]',
      exponent: 1e3,
    };
    (f.root[1] as any).metadata = {
      date: '2026-01-02',
      literal: 'no',
      boolean: false,
      absent: null,
      quoted: '"issue":{},[]',
      exponent: 1e4,
    };
    f.save();
    const result = spawnSync(
      process.execPath,
      [script, path.join(f.directory, 'manifest.json')],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      complete: true,
      totals: { causes: 182, owningIssues: 182 },
    });
    expect(report.causes[0].records[0].record).toEqual(f.root[0]);
    expect(report.causes[1].records[0].record).toEqual(f.root[1]);
  });

  it.each(['array-entry', 'stable-object-key', 'explicit-stable-id'])(
    'rejects a redundant alias that cannot resolve a descriptive identity (%s)',
    (shape) => {
      const f = fixture();
      if (shape === 'array-entry') {
        const row = f.root[0];
        f.manifest.aliases.push({
          source: 'root',
          key: '0',
          id: row.id,
          issue: row.issue,
          bodyFile: row.evidence[0],
          basis: 'fixture/array-redundant-alias-receipt.json',
        });
      } else if (shape === 'stable-object-key') {
        f.ledger.B67 = f.ledger['descriptive-0'];
        delete f.ledger['descriptive-0'];
        f.manifest.aliases[0].key = 'B67';
      } else {
        f.manifest.sources[1].fields.id = '/id';
      }
      f.save();
      const result = spawnSync(
        process.execPath,
        [script, path.join(f.directory, 'manifest.json')],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({
        complete: false,
        totals: null,
        observed: { identifiedCauses: 182 },
        missingIds: [],
      });
      const source = shape === 'array-entry' ? 'root' : 'ledger';
      const key =
        shape === 'array-entry'
          ? '0'
          : shape === 'stable-object-key'
            ? 'B67'
            : 'descriptive-0';
      expect(report.aliasErrors).toContainEqual(
        expect.objectContaining({
          source,
          key,
          reason: 'alias does not resolve a descriptive source record',
        }),
      );
      const retained = report.causes
        .flatMap((cause: any) => cause.records)
        .find((record: any) => record.source === source && record.key === key);
      expect(retained).toBeDefined();
      expect(retained).not.toHaveProperty('alias');
    },
  );

  it('does not inflate totals for replayed causes, duplicate aliases or shared owning issues', () => {
    const f = fixture();
    f.root.push(...f.rows.slice(66, 70));
    f.manifest.aliases.push(...f.manifest.aliases);
    f.rows[1].issue = f.rows[0].issue;
    f.save();
    const first = reconcileCauses(f.manifest, f.directory);
    const second = reconcileCauses(f.manifest, f.directory);
    expect(first.totals).toEqual({ causes: 182, owningIssues: 181 });
    expect(
      first.causes.find((cause: any) => cause.id === 'B67').records,
    ).toHaveLength(2);
    expect(second).toEqual(first);
  });

  it('refuses the old standalone 82 count when the declared workstream has 182 causes', () => {
    const f = fixture();
    f.manifest.sources.splice(1);
    f.manifest.aliases = [];
    const report = reconcileCauses(f.manifest, f.directory);
    expect(report).toMatchObject({
      complete: false,
      totals: null,
      observed: { identifiedCauses: 82 },
    });
    expect(report.missingIds).toEqual(f.manifest.expectedIds.slice(66, 166));
  });

  it.each([
    'unknown',
    'missing-evidence',
    'owner-conflict',
    'alias-file',
    'alias-owner',
    'alias-id',
    'alias-unused',
    'alias-conflict',
    'unexpected',
  ])('withholds totals and retains diagnostics for %s', (failure) => {
    const f = fixture();
    if (failure === 'unknown') f.manifest.aliases.splice(0, 1);
    if (failure === 'missing-evidence') f.root[0].evidence = [];
    if (failure === 'owner-conflict')
      f.root.push({ ...f.rows[0], issue: 'other/repository#1' });
    if (failure === 'alias-file')
      f.manifest.aliases[0].bodyFile = 'fixture/not-retained.md';
    if (failure === 'alias-owner')
      f.manifest.aliases[0].issue = 'other/repository#1';
    if (failure === 'alias-id') {
      f.manifest.sources[1].fields.id = '/id';
      f.manifest.aliases[0].id = 'B1';
    }
    if (failure === 'alias-unused') f.manifest.aliases[0].key = 'absent';
    if (failure === 'alias-conflict')
      f.manifest.aliases.push({ ...f.manifest.aliases[0], id: 'B68' });
    if (failure === 'unexpected') f.root.push({ ...f.rows[0], id: 'B183' });
    f.save();
    const result = spawnSync(
      process.execPath,
      [script, path.join(f.directory, 'manifest.json')],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.complete).toBe(false);
    expect(report.totals).toBeNull();
    expect(
      report.unresolved.length +
        report.aliasErrors.length +
        report.unexpectedIds.length,
    ).toBeGreaterThan(0);
  });

  it.each([
    'absent-source',
    'changed-snapshot',
    'invalid-json',
    'missing-collection',
    'malformed-id',
    'bad-issue',
  ])(
    'fails closed on %s rather than reporting a partial source set',
    (failure) => {
      const f = fixture();
      if (failure === 'malformed-id') f.root[0].id = 'B01';
      if (failure === 'bad-issue') f.root[0].issue = '#1';
      f.save();
      if (failure === 'absent-source')
        rmSync(path.join(f.directory, 'ledger.json'));
      if (failure === 'invalid-json') {
        const filename = path.join(f.directory, 'ledger.json');
        writeFileSync(filename, '{');
        // Qualify the bytes so this still reaches JSON parsing, not hash refusal.
        f.manifest.sources[1].sha256 = createHash('sha256')
          .update(readFileSync(filename))
          .digest('hex');
      }
      if (failure === 'missing-collection')
        f.manifest.sources[1].collection = '/missing';
      if (failure === 'changed-snapshot')
        Object.assign(f.manifest.sources[0], { sha256: '0'.repeat(64) });
      writeFileSync(
        path.join(f.directory, 'manifest.json'),
        JSON.stringify(f.manifest),
      );
      const result = spawnSync(
        process.execPath,
        [script, path.join(f.directory, 'manifest.json')],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        complete: false,
        totals: null,
      });
    },
  );

  it('binds a complete report to pinned source bytes and supports explicit legacy field pointers', () => {
    const f = fixture();
    const legacy = {
      'cause/id': 'B1',
      owner: { issue: f.rows[0].issue },
      'evidence~path': f.rows[0].evidence[0],
      original: f.rows[0],
    };
    writeFileSync(
      path.join(f.directory, 'legacy.json'),
      JSON.stringify({ rows: [legacy] }),
    );
    const bytes = readFileSync(path.join(f.directory, 'legacy.json'));
    const report = reconcileCauses(
      {
        expectedIds: ['B1'],
        sources: [
          {
            name: 'legacy',
            path: 'legacy.json',
            collection: '/rows',
            sha256: createHash('sha256').update(bytes).digest('hex'),
            fields: {
              id: '/cause~1id',
              issue: '/owner/issue',
              evidence: '/evidence~0path',
            },
          },
        ],
      },
      f.directory,
    );
    expect(report.totals).toEqual({ causes: 1, owningIssues: 1 });
    expect(report.causes[0].records[0].record).toEqual(legacy);
  });
});
