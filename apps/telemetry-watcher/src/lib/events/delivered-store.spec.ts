import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DELIVERED_FILE,
  DELIVERED_MAX_ENTRIES,
  DELIVERED_RETENTION_MS,
  fileDeliveredStore,
} from './delivered-store';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-delivered-'));
  roots.push(root);
  return path.join(root, 'events-agent');
}

describe('fileDeliveredStore', () => {
  it('remembers finished deliveries across restarts, privately', () => {
    const directory = tempDirectory();
    const now = 1_000_000;
    fileDeliveredStore(directory, () => now).record('sub:evt-1', now);

    const reopened = fileDeliveredStore(directory, () => now);
    expect(reopened.has('sub:evt-1')).toBe(true);
    expect(reopened.has('sub:evt-2')).toBe(false);
    expect(fs.statSync(path.join(directory, DELIVERED_FILE)).mode & 0o777).toBe(
      0o600,
    );
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
  });

  it('forgets deliveries older than the subscription can redeliver', () => {
    const directory = tempDirectory();
    let now = 1_000_000;
    const store = fileDeliveredStore(directory, () => now);
    store.record('old', now);
    now += DELIVERED_RETENTION_MS + 1;
    store.record('new', now);
    expect(store.has('old')).toBe(false);
    expect(fileDeliveredStore(directory, () => now).has('old')).toBe(false);
    expect(store.has('new')).toBe(true);
  });

  it('keeps only the newest entries past its bound', () => {
    const directory = tempDirectory();
    fs.mkdirSync(directory, { recursive: true });
    const delivered = Object.fromEntries(
      Array.from({ length: DELIVERED_MAX_ENTRIES }, (_, i) => [
        `id-${i}`,
        i + 1,
      ]),
    );
    fs.writeFileSync(
      path.join(directory, DELIVERED_FILE),
      JSON.stringify({ version: 1, delivered }),
    );
    const store = fileDeliveredStore(
      directory,
      () => DELIVERED_MAX_ENTRIES + 5,
    );
    store.record('latest', DELIVERED_MAX_ENTRIES + 5);
    expect(store.has('latest')).toBe(true);
    expect(store.has('id-0')).toBe(false);
    expect(store.has('id-1')).toBe(true);
  });

  it('starts empty from a missing or corrupt file', () => {
    const directory = tempDirectory();
    expect(fileDeliveredStore(directory).has('x')).toBe(false);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, DELIVERED_FILE), '{not json');
    expect(fileDeliveredStore(directory).has('x')).toBe(false);
  });
});
