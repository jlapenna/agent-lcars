import { readFile, stat, statfs } from 'node:fs/promises';

// The image build measures immutable filesystem bytes and seals this receipt
// before publication. Runtime has a read-only root and memory-only scratch;
// the job cgroup charges every tmpfs page, including /dev/shm and descendants.
export async function verifyGooseStorage(storage, memory) {
  const receiptPath = '/usr/local/share/lcars-goose-image-budget.json';
  const metadata = await stat(receiptPath);
  if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0)
    throw new Error('Untrusted image budget receipt');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (
    receipt.version !== 1 ||
    !Number.isSafeInteger(receipt.filesystemBytes) ||
    receipt.filesystemBytes <= 0 ||
    receipt.filesystemBytes > 8 * 1024 ** 3
  )
    throw new Error('Invalid image budget receipt');
  const entries = (await readFile('/proc/self/mountinfo', 'utf8'))
    .trim()
    .split('\n')
    .map((line) => {
      const [mount, filesystem] = line.split(' - ');
      const fields = mount.split(' ');
      return {
        path: fields[4],
        options: fields[5].split(','),
        type: filesystem.split(' ')[0],
      };
    });
  if (
    !entries.find((entry) => entry.path === '/' && entry.options.includes('ro'))
  )
    throw new Error('Goose root must be read-only');
  for (const entry of entries) {
    if (!entry.options.includes('rw')) continue;
    if (
      ['tmpfs', 'proc', 'devpts', 'mqueue', 'sysfs', 'cgroup2'].includes(
        entry.type,
      )
    )
      continue;
    // Runtime-owned single files are root-owned and not writable by this uid.
    const value = await stat(entry.path);
    if (
      !value.isFile() ||
      value.uid === process.getuid() ||
      (value.mode & 0o022) !== 0
    )
      throw new Error('Unbounded writable filesystem in recipe allocation');
  }
  if ((await statfs('/tmp')).type !== 0x01021994)
    throw new Error('Recipe scratch must be tmpfs');
  // Reserve 1 GiB for bounded runtime metadata, credentials and logs as well
  // as all immutable image bytes and the entire memory-backed write envelope.
  if (
    2 * receipt.filesystemBytes + parseInt(memory, 10) * 1024 ** 3 + 1024 ** 3 >
    parseInt(storage, 10) * 1024 ** 3
  )
    throw new Error('Complete storage envelope exceeds allocation');
  return true;
}
