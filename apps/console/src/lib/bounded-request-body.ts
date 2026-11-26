export class RequestBodyTimeoutError extends Error {}

/**
 * Read a request body without allocating past `maximum` bytes. Rejects early on
 * a declared `Content-Length` and cancels the stream as soon as the running
 * total crosses the bound, so an oversized unauthenticated delivery is never
 * buffered whole. Returns `undefined` when the body exceeds the bound and
 * throws RequestBodyTimeoutError if the optional total read deadline expires.
 */
export async function readBoundedRequestBody(
  request: Request,
  maximum: number,
  timeoutMs?: number,
): Promise<Buffer | undefined> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) {
    void request.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timedOut = false;
  const timeout =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          // Cancel settles the pending read even if upstream cleanup is delayed.
          void reader.cancel().catch(() => undefined);
        }, timeoutMs);
  try {
    for (;;) {
      const chunk = await reader.read();
      if (timedOut) throw new RequestBodyTimeoutError();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}
