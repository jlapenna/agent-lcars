import { execFileSync } from 'node:child_process';

// Native clients import project guidance before processing the task prompt.
// Keep their entire checkout at the reviewed revision, including skill imports.
export function materializeReviewSource(
  source,
  destination,
  head,
  base,
  remote = 'https://github.com/jlapenna/agent-lcars.git',
) {
  if (![head, base].every((ref) => /^[a-f0-9]{40}$/.test(ref)))
    throw new Error('Review source requires immutable commit IDs');
  const git = (args, options = {}) =>
    execFileSync('git', args, {
      cwd: source,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 32 * 1024 * 1024,
      ...options,
    });
  git([
    'clone',
    '--shared',
    '--no-checkout',
    '--single-branch',
    '--no-tags',
    source,
    destination,
  ]);
  const checkout = (...args) => git(['-C', destination, ...args]);
  checkout('remote', 'set-url', 'origin', remote);
  for (const ref of new Set([head, base])) {
    const object = git(
      ['-C', destination, 'cat-file', '--batch-check=%(objecttype)'],
      { input: ref + '\n' },
    ).trim();
    if (object === ref + ' missing')
      checkout('fetch', '--no-tags', 'origin', ref);
    else if (object !== 'commit')
      throw new Error('Unexpected review source object: ' + object);
  }
  checkout('checkout', '--detach', head);
  if (checkout('rev-parse', 'HEAD').trim() !== head)
    throw new Error('Review checkout revision mismatch');
  return destination;
}
