#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { collectRecentCorpus } from './github-source.mjs';
import { runOfflineComparison } from './offline-replay.mjs';
import { assertPrivacySafe } from './redact.mjs';
import { buildReport, renderMarkdown } from './report.mjs';
import { validateCorpus } from './schema.mjs';

function usage() {
  return `Usage:
  trajectory-evaluation validate --corpus <file>
  trajectory-evaluation report --corpus <file> [--format markdown|json] [--output <file>]
  trajectory-evaluation compare --corpus <file> --variant <file> [--format markdown|json] [--output <file>]
  trajectory-evaluation collect --repository <owner/repo> --days <1..90> [--limit <1..300>] --output <file> [--report <file>]

Only collect imports the read-only GitHub source. Validate, report, and compare are offline file operations.`;
}

function options(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      parsed._.push(argument);
      continue;
    }
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--'))
      throw new Error(`--${key} requires a value`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

async function json(pathname) {
  return JSON.parse(await readFile(pathname, 'utf8'));
}

async function emit(value, pathname) {
  if (!pathname) {
    process.stdout.write(value);
    if (!value.endsWith('\n')) process.stdout.write('\n');
    return;
  }
  await mkdir(path.dirname(pathname), { recursive: true });
  await writeFile(pathname, value.endsWith('\n') ? value : `${value}\n`, {
    mode: 0o600,
  });
}

async function main() {
  const parsed = options(process.argv.slice(2));
  const command = parsed._[0];
  if (!command || ['help', '--help', '-h'].includes(command)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === 'validate') {
    if (!parsed.corpus) throw new Error('validate requires --corpus');
    const corpus = validateCorpus(await json(parsed.corpus));
    assertPrivacySafe(corpus);
    process.stdout.write(
      `valid ${corpus.schemaVersion}: ${corpus.entries.length} entries\n`,
    );
    return;
  }
  if (command === 'report') {
    if (!parsed.corpus) throw new Error('report requires --corpus');
    const corpus = validateCorpus(await json(parsed.corpus));
    assertPrivacySafe(corpus);
    const report = buildReport(corpus);
    await emit(
      parsed.format === 'json'
        ? JSON.stringify(report, null, 2)
        : renderMarkdown(report),
      parsed.output,
    );
    return;
  }
  if (command === 'compare') {
    if (!parsed.corpus || !parsed.variant)
      throw new Error('compare requires --corpus and --variant');
    const { comparison, markdown } = await runOfflineComparison({
      corpusPath: parsed.corpus,
      variantPath: parsed.variant,
    });
    await emit(
      parsed.format === 'json' ? JSON.stringify(comparison, null, 2) : markdown,
      parsed.output,
    );
    return;
  }
  if (command === 'collect') {
    const repository = parsed.repository ?? process.env.GITHUB_REPOSITORY;
    if (!repository || !parsed.days || !parsed.output) {
      throw new Error('collect requires --repository, --days, and --output');
    }
    const corpus = await collectRecentCorpus({
      repository,
      days: Number(parsed.days),
      limit: parsed.limit ? Number(parsed.limit) : 100,
      token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    });
    await emit(JSON.stringify(corpus, null, 2), parsed.output);
    if (parsed.report)
      await emit(renderMarkdown(buildReport(corpus)), parsed.report);
    return;
  }
  throw new Error(`unknown command ${command}\n${usage()}`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
