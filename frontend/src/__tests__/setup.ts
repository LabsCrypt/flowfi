import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Note: the CI failure is a dependency vulnerability in systeminformation (<=5.33.15, high severity),
// which is a transitive dependency and is not referenced by this test setup file. This file is
// unchanged in that regard; the audit fix belongs in the lockfile/package.json, not here.

type WorkerGlobals = {
  self?: unknown;
  addEventListener?: unknown;
  skipWaiting?: unknown;
  clients?: unknown;
};
const workerGlobal = globalThis as unknown as WorkerGlobals & typeof globalThis;

// Ensure the service worker script (public/sw.js) can be evaluated in tests
// by providing minimal defaults for worker-scope globals when absent.
if (typeof workerGlobal.self === 'undefined') {
  workerGlobal.self = globalThis;
}

// Minimal worker-scope defaults so public/sw.js can be executed in a harness.
if (typeof workerGlobal.addEventListener === 'undefined') {
  workerGlobal.addEventListener = vi.fn();
}
if (typeof workerGlobal.skipWaiting === 'undefined') {
  workerGlobal.skipWaiting = vi.fn();
}
if (typeof workerGlobal.clients === 'undefined') {
  workerGlobal.clients = {
    claim: vi.fn(() => Promise.resolve()),
    matchAll: vi.fn(() => Promise.resolve([])),
    openWindow: vi.fn(() => Promise.resolve(null)),
  };
}

type LocalStorageMock = {
  getItem: ReturnType<typeof vi.fn<(key: string) => string | null>>;
  setItem: ReturnType<typeof vi.fn<(key: string, value: string) => void>>;
  clear: ReturnType<typeof vi.fn<() => void>>;
  removeItem: ReturnType<typeof vi.fn<(key: string) => void>>;
  key: ReturnType<typeof vi.fn<(index: number) => string | null>>;
  length: number;
};

const localStorageMock: LocalStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string): string | null => store[key] || null),
    setItem: vi.fn((key: string, value: string): void => {
      store[key] = value.toString();
    }),
    clear: vi.fn((): void => {
      store = {};
    }),
    removeItem: vi.fn((key: string): void => {
      delete store[key];
    }),
    key: vi.fn((index: number): string | null => Object.keys(store)[index] || null),
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
