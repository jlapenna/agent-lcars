#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(
  readFileSync(
    new URL('../config/github-labels.json', import.meta.url),
    'utf8',
  ),
);
const apply = process.argv.includes('--apply');
const migrate = process.argv.includes('--migrate');
const prune = process.argv.includes('--prune');
const requestedRepo = process.argv
  .find((arg) => arg.startsWith('--repo='))
  ?.slice(7);
const repositoryEntries = Object.entries(manifest.repositories).filter(
  ([repo]) => !requestedRepo || repo === requestedRepo,
);

if (requestedRepo && repositoryEntries.length === 0) {
  throw new Error(
    `Repository ${requestedRepo} is not declared in the label contract`,
  );
}

function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', ...options }).trim();
}

function editOpenItems(repo, oldName, newNames) {
  for (const kind of ['issue', 'pr']) {
    const items = JSON.parse(
      gh([
        kind,
        'list',
        '--repo',
        repo,
        '--state',
        'open',
        '--label',
        oldName,
        '--limit',
        '1000',
        '--json',
        'number',
      ]),
    );
    for (const { number } of items) {
      const addArgs = newNames.flatMap((name) => ['--add-label', name]);
      gh([
        kind,
        'edit',
        String(number),
        '--repo',
        repo,
        ...addArgs,
        '--remove-label',
        oldName,
      ]);
      console.log(
        `${repo}: migrated ${kind} #${number} from ${oldName} to ${newNames.join(', ')}`,
      );
    }
  }
}

let drift = false;
for (const [repo, config] of repositoryEntries) {
  const live = JSON.parse(
    gh([
      'label',
      'list',
      '--repo',
      repo,
      '--limit',
      '500',
      '--json',
      'name,color,description',
    ]),
  );
  const byName = new Map(live.map((label) => [label.name, label]));

  for (const name of config.labels) {
    const expected = manifest.labels[name];
    if (!expected)
      throw new Error(`${repo} references undefined label ${name}`);
    const actual = byName.get(name);
    const differs =
      !actual ||
      actual.color.toLowerCase() !== expected.color.toLowerCase() ||
      (actual.description ?? '') !== expected.description;
    if (!differs) continue;
    drift = true;
    if (apply || migrate) {
      gh([
        'label',
        actual ? 'edit' : 'create',
        name,
        '--repo',
        repo,
        '--color',
        expected.color,
        '--description',
        expected.description,
      ]);
      console.log(`${repo}: ${actual ? 'updated' : 'created'} ${name}`);
    } else {
      console.log(`${repo}: ${actual ? 'metadata drift' : 'missing'} ${name}`);
    }
  }

  for (const [oldName, newNames] of Object.entries(config.migrations ?? {})) {
    for (const newName of newNames) {
      if (!config.labels.includes(newName)) {
        throw new Error(
          `${repo} migrates ${oldName} to ${newName}, but does not declare the target label`,
        );
      }
    }
    if (migrate && byName.has(oldName)) {
      editOpenItems(repo, oldName, newNames);
    }
  }

  const legacy = [
    ...Object.keys(config.migrations ?? {}),
    ...(config.remove ?? []),
  ];
  for (const name of legacy) {
    if (!byName.has(name)) continue;
    drift = true;
    if (prune) {
      gh(['label', 'delete', name, '--repo', repo, '--yes']);
      console.log(`${repo}: deleted legacy label ${name}`);
    } else {
      console.log(`${repo}: legacy label remains ${name}`);
    }
  }
}

if (!apply && !migrate && !prune && drift) process.exitCode = 1;
