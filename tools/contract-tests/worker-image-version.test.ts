import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { imageVersion } from '../probes/qualification-version.mjs';

// Observe real subprocess timeout/cleanup at the Docker CLI boundary, using a
// local transport fixture instead of a privileged Docker daemon.
it.each(['success', 'hang', 'failed-exit', 'bad-inspect'])(
  'settles the tracked image-version container on %s',
  (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'policy-version-test-'));
    const docker = join(root, 'docker.mjs');
    const calls = join(root, 'calls.jsonl');
    writeFileSync(
      docker,
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
const mode = ${JSON.stringify(mode)};
switch (args[0]) {
  case 'create': console.log('version-fixture'); break;
  case 'start':
    if (mode === 'hang') await new Promise(() => setInterval(() => {}, 1000));
    else console.log('/usr/local/bin/codex\\ncodex-cli fixture');
    break;
  case 'inspect': console.log(mode === 'bad-inspect' ? 'invalid' : JSON.stringify({ Running: false, ExitCode: mode === 'failed-exit' ? 1 : 0 })); break;
  case 'kill': case 'rm': break;
  default: process.exit(2);
}
`,
      { mode: 0o700 },
    );
    try {
      let value;
      let failed = false;
      try {
        value = imageVersion(['fixture-image'], root, 1000, docker);
      } catch {
        failed = true;
      }
      expect({ value, failed }).toEqual(
        mode === 'success'
          ? { value: '/usr/local/bin/codex\ncodex-cli fixture', failed: false }
          : { value: undefined, failed: true },
      );
      const operations = readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(operations[0][0]).toBe('create');
      expect(operations[1]).toEqual(['start', '--attach', 'version-fixture']);
      expect(operations.some((operation) => operation[0] === 'kill')).toBe(
        mode === 'hang' || mode === 'bad-inspect',
      );
      expect(operations.at(-1)).toEqual(['rm', 'version-fixture']);
      expect(readFileSync(join(root, 'version.stderr.txt'), 'utf8')).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
