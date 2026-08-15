import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { normalizeQuickTaskEvidence } from './quick-task-image';

describe('normalizeQuickTaskEvidence', () => {
  it('re-encodes image pixels without retaining source metadata', async () => {
    const input = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#123456' },
    })
      .withMetadata({ exif: { IFD0: { Artist: 'private source metadata' } } })
      .jpeg()
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const normalized = await normalizeQuickTaskEvidence(input);
    const outputMetadata = await sharp(normalized.bytes).metadata();

    expect(normalized.contentType).toBe('image/webp');
    expect(outputMetadata.exif).toBeUndefined();
    expect(outputMetadata.xmp).toBeUndefined();
    expect(outputMetadata.icc).toBeUndefined();
  });
});
