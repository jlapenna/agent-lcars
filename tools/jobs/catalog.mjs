import { execFileSync } from 'node:child_process';

import { definition, MAX_DOCUMENT_BYTES } from './definition.mjs';

// Only committed regular blobs are authoring inputs. No working-tree files,
// symlink traversal, implicit branch resolution by a worker, or recipe URLs.
export function discover(checkout, repository, ref = 'HEAD') {
  if (!/^[a-zA-Z0-9_./-]+$/u.test(ref) || ref.startsWith('-'))
    throw new Error('invalid revision');
  const git = (args, maxBuffer = 1024 * 1024) =>
    execFileSync('git', ['-C', checkout, ...args], {
      encoding: 'utf8',
      maxBuffer,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const revision = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const entries = git(['ls-tree', '-r', '-z', revision, '--', '.lcars/jobs'])
    .split('\0')
    .filter(Boolean);
  const files = new Map(
    entries.map((entry) => {
      const [meta, path] = entry.split('\t');
      return [path, meta.split(' ')];
    }),
  );
  const jobs = [];
  const errors = [];
  for (const path of [...files.keys()]
    .filter((p) => /^\.lcars\/jobs\/[^/]+\/job\.yaml$/u.test(p))
    .sort()) {
    const name = path.split('/')[2];
    try {
      const read = (file) => {
        const entry = files.get(file);
        if (!entry || entry[0] !== '100644' || entry[1] !== 'blob')
          throw new Error(`expected regular blob: ${file}`);
        return git(['show', `${revision}:${file}`], MAX_DOCUMENT_BYTES);
      };
      jobs.push(
        definition({
          repository,
          revision,
          name,
          jobText: read(path),
          recipeText: read(`.lcars/jobs/${name}/recipe.yaml`),
        }),
      );
    } catch (error) {
      errors.push({ name, error: error.message });
    }
  }
  return { repository, revision, jobs, errors };
}
