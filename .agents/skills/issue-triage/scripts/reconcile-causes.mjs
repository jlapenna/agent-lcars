import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseDocument } from 'yaml';

const causeId = (value) =>
  typeof value === 'string' && /^B[1-9]\d*$/.test(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
function issueKey(value) {
  if (typeof value !== 'string') return null;
  const match = /^([^/]+)\/([\w.-]{1,100})#[1-9]\d*$/.exec(value);
  if (
    !match ||
    match[1].length > 39 ||
    // Normal GitHub logins, plus its documented managed-user shortcode suffix.
    !/^[a-z0-9]+(?:-[a-z0-9]+)*(?:_[a-z0-9]{3,8})?$/i.test(match[1]) ||
    match[2] === '.' ||
    match[2] === '..'
  )
    return null;
  return value.toLowerCase();
}

// Keep strict JSON grammar and values; use the declared lossless parser only
// to reject names JSON.parse would silently discard, including nested records.
function parseRetainedJSON(bytes) {
  const source = bytes.toString();
  const value = JSON.parse(source);
  const document = parseDocument(source, { schema: 'json', uniqueKeys: true });
  const duplicate = document.errors.find(
    (error) => error.code === 'DUPLICATE_KEY',
  );
  if (duplicate)
    throw new Error(`Duplicate JSON property: ${duplicate.message}`);
  return value;
}

// Only explicit JSON pointers are supported. No title, filename or issue-number
// heuristic may turn an unidentified ledger row into a measured cause.
function at(document, pointer) {
  if (pointer === '') return document;
  if (typeof pointer !== 'string' || !pointer.startsWith('/'))
    throw new Error(`Invalid JSON pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split('/')
    .reduce((value, key) => {
      if (/~(?![01])/u.test(key))
        throw new Error(`Invalid JSON pointer: ${pointer}`);
      const decoded = key.replaceAll('~1', '/').replaceAll('~0', '~');
      return value != null && Object.hasOwn(value, decoded)
        ? value[decoded]
        : undefined;
    }, document);
}

/** Read-only report assembly for private interactive ledgers, never runtime state. */
export function reconcileCauses(
  manifest,
  directory = '.',
  read = readFileSync,
) {
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0)
    throw new Error('Declare every root and delegated source in sources');
  if (
    !Array.isArray(manifest.expectedIds) ||
    manifest.expectedIds.length === 0 ||
    !manifest.expectedIds.every(causeId) ||
    new Set(manifest.expectedIds).size !== manifest.expectedIds.length
  )
    throw new Error('expectedIds must declare a nonempty unique cause scope');
  if (manifest.aliases !== undefined && !Array.isArray(manifest.aliases))
    throw new Error('aliases must be an array');

  const sources = [];
  const causes = new Map();
  const unresolved = [];
  const aliasErrors = [];
  const aliases = new Map();
  const usedAliases = new Set();
  const names = new Set();
  const selector = (source, key) => JSON.stringify([source, key]);
  for (const alias of manifest.aliases ?? []) {
    if (
      !text(alias.source) ||
      !text(alias.key) ||
      !causeId(alias.id) ||
      !issueKey(alias.issue) ||
      !text(alias.bodyFile) ||
      !text(alias.basis)
    )
      throw new Error(
        'Aliases require source, key, stable id, qualified issue, bodyFile and basis',
      );
    const key = selector(alias.source, alias.key);
    const prior = aliases.get(key);
    if (
      prior &&
      (prior.id !== alias.id ||
        issueKey(prior.issue) !== issueKey(alias.issue) ||
        prior.bodyFile !== alias.bodyFile ||
        prior.basis !== alias.basis)
    )
      aliasErrors.push({
        source: alias.source,
        key: alias.key,
        reason: 'conflicting aliases',
        aliases: [prior, alias],
      });
    else aliases.set(key, alias);
  }

  for (const source of manifest.sources) {
    if (!text(source.name) || names.has(source.name) || !text(source.path))
      throw new Error('Sources require unique names and paths');
    names.add(source.name);
    if (
      typeof source.sha256 !== 'string' ||
      !/^[a-fA-F0-9]{64}$/.test(source.sha256)
    )
      throw new Error(
        `Sources require a valid SHA256 snapshot pin: ${source.name}`,
      );
    const bytes = read(path.resolve(directory, source.path));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (source.sha256.toLowerCase() !== sha256)
      throw new Error(`Source snapshot changed: ${source.name}`);
    const document = parseRetainedJSON(bytes);
    const rows = at(document, source.collection ?? '');
    if (rows === null || typeof rows !== 'object')
      throw new Error(
        `Source collection is not an array or object: ${source.name}`,
      );
    const entries = Object.entries(rows);
    sources.push({
      name: source.name,
      path: source.path,
      sha256,
      recordsRead: entries.length,
    });
    for (const [key, record] of entries) {
      const retained = { source: source.name, key, record };
      if (
        record === null ||
        typeof record !== 'object' ||
        Array.isArray(record)
      ) {
        unresolved.push({
          ...retained,
          reasons: ['cause record is not an object'],
        });
        continue;
      }
      const fields = source.fields ?? {
        id: '/id',
        issue: '/issue',
        evidence: '/evidence',
      };
      const rawId = fields.id === '$key' ? key : at(record, fields.id);
      const issue = at(record, fields.issue);
      const evidenceValue = at(record, fields.evidence);
      const evidence =
        typeof evidenceValue === 'string' ? [evidenceValue] : evidenceValue;
      const aliasSelector = selector(source.name, key);
      const alias = aliases.get(aliasSelector);
      const reasons = [];
      // Aliases describe the exact keyed legacy identity, never a different ID
      // field, array position or malformed spelling of the B cause namespace.
      const descriptiveKey =
        !Array.isArray(rows) &&
        (rawId === undefined || rawId === key) &&
        /[a-z]/i.test(key) &&
        !/^b(?:[^a-z]|$)/i.test(key.trim());
      if (alias && descriptiveKey) {
        usedAliases.add(aliasSelector);
        retained.alias = alias;
        if (!Array.isArray(evidence) || !evidence.includes(alias.bodyFile))
          reasons.push(
            'alias body-file identity is absent from retained evidence',
          );
        if (issueKey(issue) !== issueKey(alias.issue))
          reasons.push('alias conflicts with owning issue');
      }
      const id = causeId(rawId)
        ? rawId
        : descriptiveKey
          ? alias?.id
          : undefined;
      if (!causeId(id)) reasons.push('unknown or malformed cause id');
      if (!issueKey(issue)) reasons.push('missing qualified owning issue');
      if (
        !Array.isArray(evidence) ||
        evidence.length === 0 ||
        !evidence.every(text)
      )
        reasons.push('missing measured cause/evidence pointers');
      const prior = causes.get(id);
      if (prior && issueKey(prior.issue) !== issueKey(issue))
        reasons.push('cause id has conflicting owning issues');
      if (reasons.length) {
        unresolved.push({ ...retained, id: id ?? null, reasons });
        continue;
      }
      if (prior) {
        prior.records.push(retained);
        prior.evidence = [...new Set([...prior.evidence, ...evidence])];
      } else
        causes.set(id, {
          id,
          issue,
          evidence: [...new Set(evidence)],
          records: [retained],
        });
    }
  }
  for (const [key, alias] of aliases)
    if (!usedAliases.has(key))
      aliasErrors.push({
        ...alias,
        reason: 'alias does not resolve a descriptive source record',
      });
  const expected = new Set(manifest.expectedIds);
  const missingIds = manifest.expectedIds.filter((id) => !causes.has(id));
  const unexpectedIds = [...causes.keys()].filter((id) => !expected.has(id));
  const complete =
    unresolved.length === 0 &&
    aliasErrors.length === 0 &&
    missingIds.length === 0 &&
    unexpectedIds.length === 0;
  const observed = {
    identifiedCauses: causes.size,
    uniqueOwningIssues: new Set(
      [...causes.values()].map(({ issue }) => issueKey(issue)),
    ).size,
  };
  return {
    complete,
    totals: complete
      ? {
          causes: observed.identifiedCauses,
          owningIssues: observed.uniqueOwningIssues,
        }
      : null,
    observed,
    sources,
    aliases: manifest.aliases ?? [],
    missingIds,
    unexpectedIds,
    unresolved,
    aliasErrors,
    causes: [...causes.values()].sort(
      (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)),
    ),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    if (process.argv.length !== 3)
      throw new Error('Usage: node reconcile-causes.mjs <manifest.json>');
    const filename = path.resolve(process.argv[2]);
    const report = reconcileCauses(
      parseRetainedJSON(readFileSync(filename, 'utf8')),
      path.dirname(filename),
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.complete ? 0 : 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ complete: false, totals: null, error: error.message })}\n`,
    );
    process.exitCode = 1;
  }
}
