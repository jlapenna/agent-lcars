import { readFile } from 'node:fs/promises';

import { assertPrivacySafe } from './redact.mjs';
import { compareVariant, renderComparisonMarkdown } from './report.mjs';
import { validateCorpus, validateVariant } from './schema.mjs';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function runOfflineComparison({ corpusPath, variantPath }) {
  const corpus = validateCorpus(await readJson(corpusPath));
  const variant = validateVariant(await readJson(variantPath));
  assertPrivacySafe(corpus);
  const comparison = compareVariant(corpus, variant);
  return { comparison, markdown: renderComparisonMarkdown(comparison) };
}
