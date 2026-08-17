/// <reference lib="dom" />
import { vi } from 'vitest';

// libs/test-utils's own tsconfig has no "dom" lib (it's consumed by
// node-environment projects too) — this file is only ever loaded as a
// jsdom-environment setupFile, but still needs the `window` ambient type
// for typecheck. The reference directive above scopes that to this file
// alone rather than widening the whole project's lib config.
//
// jsdom does not implement window.matchMedia (a long-standing jsdom gap,
// unrelated to Jest vs Vitest) — anything that reads it during render (e.g.
// Mantine's MantineProvider resolving the OS color-scheme preference)
// throws `TypeError: window.matchMedia is not a function` without this.
//
// Guarded because mixed-environment projects (per-file `@vitest-environment`
// docblocks, e.g. sprinkles' `@repo/competitions`) run this setupFile for their
// node-environment test files too, where `window` doesn't exist.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}
