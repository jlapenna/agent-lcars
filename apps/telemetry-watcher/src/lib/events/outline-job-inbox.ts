import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  type OutlineSourceJob,
  outlineSourceJobSchema,
} from '@agent-lcars/work';
import { z } from 'zod';

const entrySchema = z.strictObject({
  publishedAt: z.number().int().nonnegative(),
  job: outlineSourceJobSchema,
});
export type OutlineJobEntry = z.infer<typeof entrySchema>;

/** One pending entry per event or fallback. An observation can be requested
 * again after the previous observation completes. */
export function outlineJobId(job: OutlineSourceJob) {
  switch (job.type) {
    case 'outline-event':
      return job.notice.deliveryId;
    case 'outline-fallback':
      return job.id;
    case 'outline-observe':
      return `observe-${job.documentId}`;
  }
}

export const OUTLINE_INBOX_MAX_JOBS = 4096;

/** Journals identifier-only work before releasing the broker lease. A full
 * inbox keeps excess work in Pub/Sub for retry. Only completed jobs leave the
 * inbox, and a restart replays any entries left behind. */
export function openOutlineJobInbox(stateDirectory: string) {
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const directory = path.join(stateDirectory, 'outline-inbox');
  fs.mkdirSync(directory, { mode: 0o700, recursive: true });
  const syncDirectory = (directory: string) => {
    const fd = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  syncDirectory(stateDirectory);
  const filename = (id: string) => path.join(directory, `${id}.json`);
  const loaded = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const entry = entrySchema.parse(
        JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')),
      );
      const id = outlineJobId(entry.job);
      if (path.basename(filename(id)) !== name)
        throw new Error('Outline inbox entry identity mismatch');
      return [id, entry] as const;
    })
    .sort(([, a], [, b]) => a.publishedAt - b.publishedAt);
  const entries = new Map(loaded);

  return {
    entries: entries as ReadonlyMap<string, OutlineJobEntry>,
    enqueue(id: string, entry: OutlineJobEntry) {
      if (entries.has(id)) return;
      if (entries.size >= OUTLINE_INBOX_MAX_JOBS)
        throw new Error('Outline inbox is full');
      const file = filename(id);
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(entry), {
        mode: 0o600,
        flush: true,
      });
      fs.renameSync(temporary, file);
      syncDirectory(directory);
      entries.set(id, entry);
    },
    remove(id: string) {
      fs.rmSync(filename(id), { force: true });
      entries.delete(id);
    },
  };
}
