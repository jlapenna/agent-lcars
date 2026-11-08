import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import manifest from './manifest';

const publicDir = join(__dirname, '..', '..', 'public');

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): string {
  const bytes = readFileSync(join(publicDir, file));
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

describe('web app manifest', () => {
  const m = manifest();

  it('meets Chrome installability: names, standalone display, root start URL', () => {
    expect(m.name).toBe('Agent LCARS');
    expect(m.short_name).toBeTruthy();
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
  });

  it('ships 192px and 512px icons, each also maskable, that exist at their declared size', () => {
    for (const purpose of ['any', 'maskable']) {
      const sizes = m.icons
        ?.filter((icon) => icon.purpose === purpose)
        .map((icon) => icon.sizes);
      expect(sizes).toEqual(['192x192', '512x512']);
    }
    for (const icon of m.icons ?? []) {
      expect(pngSize(icon.src.replace(/^\//, ''))).toBe(icon.sizes);
    }
  });

  it('provides the apple touch icon referenced by the layout metadata', () => {
    expect(pngSize('apple-touch-icon.png')).toBe('180x180');
  });
});
