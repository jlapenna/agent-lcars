import * as fs from 'node:fs';
import * as path from 'node:path';

import { z } from 'zod';

import type { OutlineTextBaseline, OutlineTextHashes } from './outline-source';

const stateSchema = z.array(
  z.tuple([
    z.uuid(),
    z.strictObject({
      hash: z.string().regex(/^[a-f0-9]{64}$/u),
      updatedAt: z.iso.datetime(),
      origin: z.enum(['own', 'observed', 'admin']),
    }),
  ]),
);
const MAX_HASHES = 4096;

/** Private content hashes, never Markdown. Corruption is a visible source
 * failure; silently resetting it would turn comment highlights into edits. */
export function fileOutlineTextHashes(directory: string): OutlineTextHashes {
  const filename = path.join(directory, 'outline-text-hashes.json');
  let entries: [string, OutlineTextBaseline][];
  try {
    entries = stateSchema.parse(JSON.parse(fs.readFileSync(filename, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Outline text hash state is unreadable', {
        cause: error,
      });
    entries = [];
  }
  const hashes = new Map(entries);
  return {
    get: (id) => hashes.get(id),
    put: (id, hash) => {
      stateSchema.element.parse([id, hash]);
      const next = new Map(hashes);
      next.delete(id);
      next.set(id, hash);
      while (next.size > MAX_HASHES) {
        const oldest = next.keys().next().value;
        if (oldest === undefined) break;
        next.delete(oldest);
      }
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${filename}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify([...next]), { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, filename);
      hashes.clear();
      for (const [key, value] of next) hashes.set(key, value);
    },
  };
}
