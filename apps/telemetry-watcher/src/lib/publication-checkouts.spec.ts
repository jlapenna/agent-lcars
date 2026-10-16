import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolvePublicationCheckouts } from './publication-checkouts';

describe('publication checkout observation', () => {
  it('observes exact linked refs and heads but rejects a foreign common directory', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'publication-checkouts-'),
    );
    try {
      const main = path.join(root, 'main');
      const linked = path.join(root, 'linked with spaces');
      const foreign = path.join(root, 'foreign');
      for (const directory of [main, foreign]) {
        fs.mkdirSync(directory);
        execFileSync('git', ['init', '-b', 'main', directory]);
        execFileSync('git', [
          '-C',
          directory,
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'core.hooksPath=/dev/null',
          'commit',
          '--allow-empty',
          '-m',
          'fixture',
        ]);
      }
      execFileSync('git', [
        '-C',
        main,
        'worktree',
        'add',
        '-b',
        'fix/actual-publication',
        linked,
      ]);
      const head = execFileSync('git', ['-C', main, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
      expect(await resolvePublicationCheckouts(linked)).toEqual([
        { branch: 'main', head },
        { branch: 'fix/actual-publication', head },
      ]);
      const retired = path.join(root, 'retired');
      execFileSync('git', [
        '-C',
        main,
        'worktree',
        'add',
        '-b',
        'retired',
        retired,
      ]);
      fs.rmSync(retired, { recursive: true, force: true });
      expect(await resolvePublicationCheckouts(linked)).toEqual([
        { branch: 'main', head },
        { branch: 'fix/actual-publication', head },
      ]);
      // A corrupted/stale registry must not vouch for a different repository.
      fs.writeFileSync(
        path.join(linked, '.git'),
        `gitdir: ${path.join(foreign, '.git')}\n`,
      );
      expect(await resolvePublicationCheckouts(main)).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
