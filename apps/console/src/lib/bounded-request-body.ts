/**
 * Read a request body without allocating past `maximum` bytes. Rejects early on
 * a declared `Content-Length` and cancels the stream as soon as the running
 * total crosses the bound, so an oversized unauthenticated delivery is never
 * buffered whole. Returns `undefined` when the body exceeds the bound.
 */
export async function readBoundedRequestBody(
  request: Request,
  maximum: number,
): Promise<Buffer | undefined> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) {
    await request.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}
