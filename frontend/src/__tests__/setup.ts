import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Ensure the service worker script (public/sw.js) can be evaluated in tests
// by providing minimal defaults for worker-scope globals when absent.
if (typeof (globalThis as any).self === 'undefined') {
  (globalThis as any).self = globalThis;
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

