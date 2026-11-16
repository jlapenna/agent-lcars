import {
  RUN_MESSAGE_MAX_BYTES,
  RUN_MESSAGE_PREVIEW_MAX,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import { MemoryStore } from './memory-store';
import {
  externalizeRunMessage,
  joinRunMessage,
  RUN_MESSAGE_CHUNK_BYTES,
  splitRunMessage,
  withFullRunMessages,
} from './run-message';

describe('splitRunMessage', () => {
  it('keeps a message that fits the preview inline, unchanged', () => {
    const message = 'x'.repeat(RUN_MESSAGE_PREVIEW_MAX);
    expect(splitRunMessage(message)).toEqual({ preview: message });
  });

  it('never splits a surrogate pair at the preview edge', () => {
    const message = `${'x'.repeat(RUN_MESSAGE_PREVIEW_MAX - 1)}😀tail`;
    const { preview, overflow } = splitRunMessage(message);
    expect(preview).toBe('x'.repeat(RUN_MESSAGE_PREVIEW_MAX - 1));
    expect(overflow?.ref.chars).toBe(message.length);
  });

  it('cuts chunks only at code-point boundaries and rejoins them exactly', () => {
    // Three-byte characters never align with the 512 KiB chunk size, so each
    // cut backs off to the previous character and a fourth chunk remains.
    const message = '監'.repeat(RUN_MESSAGE_CHUNK_BYTES);
    const { overflow } = splitRunMessage(message);
    expect(overflow?.chunks.length).toBe(4);
    for (const chunk of overflow?.chunks ?? [])
      expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(
        RUN_MESSAGE_CHUNK_BYTES,
      );
    expect(overflow?.chunks.join('')).toBe(message);
    expect(joinRunMessage(overflow!.ref, overflow!.chunks)).toBe(message);
    expect(
      joinRunMessage(overflow!.ref, overflow!.chunks.slice(1)),
    ).toBeUndefined();
  });

  it('refuses a message past the completion bound rather than cutting it', () => {
    expect(() =>
      splitRunMessage('x'.repeat(RUN_MESSAGE_MAX_BYTES + 1)),
    ).toThrow(RangeError);
  });
});

describe('externalizeRunMessage', () => {
  it('writes nothing out of line for a message that fits inline', async () => {
    const store = new MemoryStore();
    const result = await externalizeRunMessage(store, 'run', {
      ok: true,
      message: 'short',
    });
    expect(result).toEqual({ ok: true, message: 'short' });
  });

  it('round-trips a 200 KB report whole through its run views', async () => {
    const store = new MemoryStore();
    const report = `# Findings\n${'監視 finding 😀 detail\n'.repeat(10_000)}`;
    expect(Buffer.byteLength(report)).toBeGreaterThan(200_000);
    const result = await externalizeRunMessage(store, 'run', {
      ok: true,
      summary: 'report',
      message: report,
    });
    expect(result.message).toHaveLength(RUN_MESSAGE_PREVIEW_MAX);
    const [view] = await withFullRunMessages(store, [{ runId: 'run', result }]);
    expect(view?.result?.message).toBe(report);
    expect(view?.result).not.toHaveProperty('messageOverflow');
  });

  it('keeps the preview and its marker when the stored copy is unreadable', async () => {
    const store = new MemoryStore();
    const { overflow, preview } = splitRunMessage('y'.repeat(20_000));
    const missing: string[] = [];
    const result = {
      ok: true,
      message: preview,
      messageOverflow: overflow!.ref,
    };
    const [view] = await withFullRunMessages(
      store,
      [{ runId: 'run', result }],
      (runId) => missing.push(runId),
    );
    expect(view?.result).toEqual(result);
    expect(missing).toEqual(['run']);
  });
});
