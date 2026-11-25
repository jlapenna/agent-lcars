import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Delivery ids this host has finished with, delivered or not, so a repeat
 * of one is dropped instead of typed twice. Pub/Sub's exactly-once delivery
 * already keeps an acked message from coming back; this covers an ack that
 * did not reach Pub/Sub, a restart between typing and acking, and a router
 * that published the same delivery twice.
 *
 * Kept as a small JSON file under the user's state directory, mode 0600, and
 * pruned to the subscription's retention: an older message cannot return.
 */
export interface DeliveredStore {
  has(deliveryId: string): boolean;
  record(deliveryId: string, at: number): void;
}

export const DELIVERED_FILE = 'delivered.json';
/** The subscription's message retention (infra/terraform/agent_events.tf),
 * plus a day of slack. */
export const DELIVERED_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
/** Bounds the file whatever the rate; the oldest ids go first. */
export const DELIVERED_MAX_ENTRIES = 20_000;

export function fileDeliveredStore(
  directory: string,
  now: () => number = Date.now,
  fileName: string = DELIVERED_FILE,
): DeliveredStore {
  const filePath = path.join(directory, fileName);
  const entries = new Map<string, number>(read(filePath));
  prune(entries, now());
  return {
    has: (deliveryId) => entries.has(deliveryId),
    record: (deliveryId, at) => {
      entries.set(deliveryId, at);
      prune(entries, now());
      write(directory, filePath, fileName, entries);
    },
  };
}

function read(filePath: string): [string, number][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    // Missing or unreadable: start empty. Exactly-once delivery still
    // covers everything acked.
    return [];
  }
  const delivered =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)['delivered']
      : undefined;
  if (typeof delivered !== 'object' || delivered === null) return [];
  return Object.entries(delivered).filter(
    (entry): entry is [string, number] =>
      typeof entry[1] === 'number' && Number.isFinite(entry[1]),
  );
}

function prune(entries: Map<string, number>, now: number): void {
  for (const [id, at] of entries) {
    if (now - at > DELIVERED_RETENTION_MS) entries.delete(id);
  }
  if (entries.size <= DELIVERED_MAX_ENTRIES) return;
  const oldest = [...entries].sort((a, b) => a[1] - b[1]);
  for (const [id] of oldest.slice(0, entries.size - DELIVERED_MAX_ENTRIES)) {
    entries.delete(id);
  }
}

/** Crash-safe rename-into-place, like the hook's session state. */
function write(
  directory: string,
  filePath: string,
  fileName: string,
  entries: Map<string, number>,
): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${fileName}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify({ version: 1, delivered: Object.fromEntries(entries) })}\n`,
      { mode: 0o600 },
    );
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Already gone or never created.
    }
    throw error;
  }
}
