import 'server-only';

import { createHash } from 'node:crypto';

import sharp from 'sharp';

import {
  QUICK_TASK_EVIDENCE_INPUT_MIME_TYPES,
  QUICK_TASK_EVIDENCE_MAX_DIMENSION,
  QUICK_TASK_EVIDENCE_MAX_INPUT_BYTES,
  QUICK_TASK_EVIDENCE_MAX_OUTPUT_BYTES,
  QUICK_TASK_EVIDENCE_MAX_PIXELS,
  QUICK_TASK_EVIDENCE_OUTPUT_MIME_TYPE,
  QuickTaskEvidenceError,
  type QuickTaskNormalizedEvidence,
} from './quick-task-evidence-contract';

export async function normalizeQuickTaskEvidence(
  input: Uint8Array,
): Promise<QuickTaskNormalizedEvidence> {
  if (
    !input.byteLength ||
    input.byteLength > QUICK_TASK_EVIDENCE_MAX_INPUT_BYTES
  ) {
    throw new QuickTaskEvidenceError(413, 'Evidence exceeds the input limit');
  }
  let image: sharp.Sharp;
  try {
    image = sharp(input, {
      animated: false,
      pages: 1,
      limitInputPixels: QUICK_TASK_EVIDENCE_MAX_PIXELS,
    });
    const metadata = await image.metadata();
    if (
      !metadata.format ||
      !QUICK_TASK_EVIDENCE_INPUT_MIME_TYPES.includes(
        `image/${metadata.format === 'jpg' ? 'jpeg' : metadata.format}` as (typeof QUICK_TASK_EVIDENCE_INPUT_MIME_TYPES)[number],
      )
    ) {
      throw new QuickTaskEvidenceError(415, 'Unsupported evidence type');
    }
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > QUICK_TASK_EVIDENCE_MAX_DIMENSION ||
      metadata.height > QUICK_TASK_EVIDENCE_MAX_DIMENSION ||
      metadata.width * metadata.height > QUICK_TASK_EVIDENCE_MAX_PIXELS ||
      (metadata.pages ?? 1) > 1
    ) {
      throw new QuickTaskEvidenceError(422, 'Invalid evidence image');
    }
    const bytes = await image.rotate().webp({ lossless: true }).toBuffer();
    if (bytes.byteLength > QUICK_TASK_EVIDENCE_MAX_OUTPUT_BYTES)
      throw new QuickTaskEvidenceError(
        413,
        'Evidence output exceeds the limit',
      );
    return {
      bytes,
      contentType: QUICK_TASK_EVIDENCE_OUTPUT_MIME_TYPE,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      width: metadata.width,
      height: metadata.height,
    };
  } catch (error) {
    if (error instanceof QuickTaskEvidenceError) throw error;
    throw new QuickTaskEvidenceError(422, 'Invalid evidence image');
  }
}
