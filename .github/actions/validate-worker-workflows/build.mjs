import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { format, resolveConfig } from 'prettier';

const actionDirectory = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.resolve(
  process.argv[2] ?? path.join(actionDirectory, 'dist/validate.cjs'),
);

await build({
  entryPoints: [path.join(actionDirectory, 'validate.cjs')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile,
});

const bundled = await readFile(outfile, 'utf8');
const prettierConfig =
  (await resolveConfig(path.join(actionDirectory, 'validate.cjs'))) ?? {};
await writeFile(
  outfile,
  await format(bundled, { ...prettierConfig, parser: 'babel' }),
);
