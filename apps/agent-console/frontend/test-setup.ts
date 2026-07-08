import { ReadableStream } from 'node:stream/web';
import { MessageChannel } from 'node:worker_threads';

import { TextDecoder, TextEncoder } from 'util';

const globalAny = global as typeof global & {
  TextDecoder?: typeof TextDecoder;
  TextEncoder?: typeof TextEncoder;
  ReadableStream?: typeof ReadableStream;
  MessagePort?: unknown;
};

if (!global.TextDecoder) {
  globalAny.TextDecoder = TextDecoder;
}
if (!global.TextEncoder) {
  globalAny.TextEncoder = TextEncoder;
}
if (!global.ReadableStream) {
  globalAny.ReadableStream = ReadableStream;
}
if (!global.MessagePort) {
  globalAny.MessagePort = new MessageChannel().port1.constructor;
}

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(), // deprecated
    removeListener: jest.fn(), // deprecated
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

class ResizeObserver {
  observe() {
    // mock
  }
  unobserve() {
    // mock
  }
  disconnect() {
    // mock
  }
}
window.ResizeObserver = ResizeObserver;

window.HTMLElement.prototype.scrollIntoView = jest.fn();
