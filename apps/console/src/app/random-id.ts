/** Generate a UUID even when randomUUID is unavailable on an HTTP page. */
export function createRandomId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    try {
      return cryptoApi.randomUUID();
    } catch {
      // randomUUID is restricted to secure contexts in some browsers. The
      // older getRandomValues primitive remains available to HTTP LAN pages.
    }
  }
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('Cryptographic randomness is unavailable');
  }

  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
