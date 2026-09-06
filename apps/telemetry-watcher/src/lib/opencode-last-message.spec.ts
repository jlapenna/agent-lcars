import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  extractLastAssistantText,
  OPENCODE_LAST_MESSAGE_MAX_BYTES,
} from './opencode-last-message';

describe('extractLastAssistantText', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-last-message-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeExport(contents: string): string {
    const file = path.join(root, 'ses_1.export.json');
    fs.writeFileSync(file, contents);
    return file;
  }

  it('returns the last assistant text part across multiple messages and parts', () => {
    const file = writeExport(
      JSON.stringify({
        info: { id: 'ses_1' },
        messages: [
          {
            info: { role: 'user' },
            parts: [{ type: 'text', text: 'do the thing' }],
          },
          {
            info: { role: 'assistant' },
            parts: [
              { type: 'tool', tool: 'bash' },
              { type: 'text', text: 'first turn' },
            ],
          },
          {
            info: { role: 'user' },
            parts: [{ type: 'text', text: 'now do the other thing' }],
          },
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'closing turn' }],
          },
        ],
      }),
    );

    expect(extractLastAssistantText(file)).toBe('closing turn');
  });

  it('returns undefined for an export with no assistant text part', () => {
    const file = writeExport(
      JSON.stringify({
        info: { id: 'ses_1' },
        messages: [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'tool', tool: 'bash' }],
          },
          {
            info: { role: 'user' },
            parts: [{ type: 'text', text: 'only the user spoke' }],
          },
        ],
      }),
    );

    expect(extractLastAssistantText(file)).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    const file = writeExport('{not valid json');

    expect(extractLastAssistantText(file)).toBeUndefined();
  });

  it('returns undefined for a missing file', () => {
    const file = path.join(root, 'does-not-exist.export.json');

    expect(extractLastAssistantText(file)).toBeUndefined();
  });

  it('returns undefined when the export has no messages array', () => {
    const file = writeExport(JSON.stringify({ info: { id: 'ses_1' } }));

    expect(extractLastAssistantText(file)).toBeUndefined();
  });

  it('returns undefined when the export is not a JSON object', () => {
    const file = writeExport(JSON.stringify(['not', 'an', 'object']));

    expect(extractLastAssistantText(file)).toBeUndefined();
  });

  it('bounds the returned text to OPENCODE_LAST_MESSAGE_MAX_BYTES', () => {
    const oversized = 'x'.repeat(OPENCODE_LAST_MESSAGE_MAX_BYTES + 5_000);
    const file = writeExport(
      JSON.stringify({
        info: { id: 'ses_1' },
        messages: [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: oversized }],
          },
        ],
      }),
    );

    const result = extractLastAssistantText(file);

    expect(result).toBeDefined();
    expect(Buffer.byteLength(result as string, 'utf8')).toBe(
      OPENCODE_LAST_MESSAGE_MAX_BYTES,
    );
  });

  it('supports an injected readFile for in-memory fixtures', () => {
    const readFile = (filePath: string) => {
      expect(filePath).toBe('virtual-path.json');
      return JSON.stringify({
        info: { id: 'ses_1' },
        messages: [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'from memory' }],
          },
        ],
      });
    };

    expect(extractLastAssistantText('virtual-path.json', readFile)).toBe(
      'from memory',
    );
  });
});
