import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Ensure the service worker script (public/sw.js) can be evaluated in tests
// by providing minimal defaults for worker-scope globals when absent.
if (typeof (globalThis as any).self === 'undefined') {
  (globalThis as any).self = globalThis;
}

// Minimal worker-scope defaults so public/sw.js can be executed in a harness.
if (typeof (globalThis as any).addEventListener === 'undefined') {
  (globalThis as any).addEventListener = vi.fn();
}
if (typeof (globalThis as any).skipWaiting === 'undefined') {
  (globalThis as any).skipWaiting = vi.fn();
}
if (typeof (globalThis as any).clients === 'undefined') {
  (globalThis as any).clients = { claim: vi.fn(() => Promise.resolve()), matchAll: vi.fn(() => Promise.resolve([])), openWindow: vi.fn(() => Promise.resolve(null)) };
}

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value.toString();
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    key: vi.fn((index: number) => Object.keys(store)[index] || null),
    length: 0,
  };
})();

vi.stubGlobal('localStorage', localStorageMock);
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
    configurable: true,
    writable: true,
  });
}

