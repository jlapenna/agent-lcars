import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { materializeReviewSource } from './materialize-review-source.mjs';

for (const missingObjects of [false, true]) {
  test(`native project imports read reviewed source with ${missingObjects ? 'uncached' : 'cached'} commits`, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'lcars-review-source-'));
    const history = join(temporary, 'history');
    mkdirSync(history);
    const git = (directory, ...args) =>
      execFileSync('git', ['-C', directory, ...args], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    try {
      git(history, 'init', '--quiet');
      git(history, 'config', 'user.email', 'fixture@example.invalid');
      git(history, 'config', 'user.name', 'Source fixture');
      writeFileSync(join(history, 'AGENTS.md'), 'Reviewed guidance.\n');
      git(history, 'add', 'AGENTS.md');
      git(history, 'commit', '--quiet', '-m', 'Reviewed source');
      const head = git(history, 'rev-parse', 'HEAD');
      writeFileSync(
        join(history, 'AGENTS.md'),
        'Later guidance must not leak.\n',
      );
      git(history, 'commit', '--quiet', '-am', 'Later source');
      const later = git(history, 'rev-parse', 'HEAD');
      let source = history;
      if (missingObjects) {
        source = join(temporary, 'shallow');
        execFileSync('git', [
          'clone',
          '--quiet',
          '--no-local',
          '--depth=1',
          history,
          source,
        ]);
      }
      const destination = join(temporary, 'review');
      materializeReviewSource(source, destination, head, later, history);
      assert.equal(git(destination, 'rev-parse', 'HEAD'), head);
      assert.equal(
        readFileSync(join(destination, 'AGENTS.md'), 'utf8'),
        'Reviewed guidance.\n',
      );
      assert.equal(git(source, 'rev-parse', 'HEAD'), later);
      assert.equal(git(source, 'status', '--porcelain'), '');
      assert.equal(
        readFileSync(join(source, 'AGENTS.md'), 'utf8'),
        'Later guidance must not leak.\n',
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}
