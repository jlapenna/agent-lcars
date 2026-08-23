export function isBrowser(): boolean {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') {
    return false;
  }
  return 'window' in globalThis;
}

export function assertNotBrowser(): void {
  if (isBrowser()) {
    throw new Error(
      'This module cannot be imported from a Client Component. It should only be used from a Server Component or Node.js environment.',
    );
  }
}
