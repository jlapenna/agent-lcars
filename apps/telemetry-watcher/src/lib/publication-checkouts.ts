import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

function commonDirectory(cwd: string): string | undefined {
  try {
    let directory = fs.realpathSync(cwd);
    for (let depth = 0; depth < 64; depth++) {
      const marker = path.join(directory, '.git');
      if (fs.existsSync(marker)) {
        const readPointer = (file: string): string => {
          const stat = fs.statSync(file);
          if (!stat.isFile() || stat.size > 8192)
            throw new Error('Unbounded Git pointer');
          return fs.readFileSync(file, 'utf8');
        };
        let git: string;
        if (fs.statSync(marker).isDirectory()) {
          git = fs.realpathSync(marker);
        } else {
          const pointer = /^gitdir: ([^\r\n]+)\n?$/u.exec(
            readPointer(marker),
          )?.[1];
          if (!pointer) return undefined;
          git = fs.realpathSync(path.resolve(directory, pointer));
        }
        const common = path.join(git, 'commondir');
        return fs.existsSync(common)
          ? fs.realpathSync(path.resolve(git, readPointer(common).trim()))
          : git;
      }
      const parent = path.dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  } catch {
    /* Unknown checkout identity stays unknown. */
  }
  return undefined;
}

/** Corroborates immutable checkouts in this Git common directory. It does not
 * claim that a shell ran in any listed checkout or parse a shell command. */
export function resolvePublicationCheckouts(
  cwd: string,
): Promise<{ branch: string; head: string }[] | undefined> {
  const common = commonDirectory(cwd);
  if (!common) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', 'worktree', 'list', '--porcelain', '-z'],
      { cwd, timeout: 2000, maxBuffer: 65_536, encoding: 'utf8' },
      (error, stdout) => {
        if (error || !stdout.endsWith('\0\0')) return resolve(undefined);
        const records = stdout.slice(0, -2).split('\0\0');
        if (records.length > 64) return resolve(undefined);
        const result: { branch: string; head: string }[] = [];
        for (const record of records) {
          const fields = record.split('\0');
          const location = fields
            .find((field) => field.startsWith('worktree '))
            ?.slice(9);
          if (
            fields.some(
              (field) => field === 'bare' || field.startsWith('prunable'),
            )
          )
            continue;
          if (!location || commonDirectory(location) !== common)
            return resolve(undefined);
          const branch = fields
            .find((field) => field.startsWith('branch refs/heads/'))
            ?.slice(18);
          const head = fields
            .find((field) => field.startsWith('HEAD '))
            ?.slice(5);
          if (!branch) continue; // Detached heads do not corroborate a PR ref.
          if (
            branch.length > 1024 ||
            [...branch].some(
              (character) =>
                character.charCodeAt(0) <= 32 ||
                character.charCodeAt(0) === 127,
            ) ||
            !head ||
            !/^[a-f0-9]{40}$/u.test(head)
          )
            return resolve(undefined);
          result.push({ branch, head });
        }
        resolve(result);
      },
    );
  });
}
