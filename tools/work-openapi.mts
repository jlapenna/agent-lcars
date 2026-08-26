// Usage: pnpm exec tsx tools/work-openapi.mts [--check]
// Writes docs/api/work-v1.openapi.json from the `@agent-lcars/work` items
// contract, or with --check exits 1 when the checked-in file is stale (CI).
//
// Run as `tsx` (not plain `node`) because it imports the workspace's own
// TypeScript source directly (`libs/work/src/openapi.ts`); this repo has no
// build step that would otherwise put a `.js` artifact on disk for this lib.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { generateWorkOpenApi } from '../libs/work/src/openapi.ts';

const OUT = 'docs/api/work-v1.openapi.json';

/** JSON.stringify's own key order is deterministic (verified: the generator
 *  visits contract procedures in a fixed order with no randomness), but
 *  normalizing through a parse/stringify round-trip on both sides keeps
 *  `--check` comparing content, not incidental whitespace from how the
 *  checked-in file was last saved (e.g. by prettier). */
function normalize(json: string): string {
  return `${JSON.stringify(JSON.parse(json), null, 2)}\n`;
}

const next = normalize(JSON.stringify(await generateWorkOpenApi()));

if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8');
  if (normalize(current) !== next) {
    console.error(`${OUT} is stale; run: pnpm work:openapi`);
    process.exit(1);
  }
  console.log(`${OUT} is current`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, next);
  console.log(`wrote ${OUT}`);
}
