import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import "./codemirrorMock.js";

function installMemoryStorage(): void {
  const stores = new WeakMap<Storage, Map<string, string>>();
  const storeFor = (storage: Storage): Map<string, string> => {
    let store = stores.get(storage);
    if (!store) {
      store = new Map<string, string>();
      stores.set(storage, store);
    }
    return store;
  };
  Object.defineProperties(Storage.prototype, {
    length: {
      configurable: true,
      get(this: Storage) {
        return storeFor(this).size;
      }
    },
    clear: {
      configurable: true,
      value(this: Storage) {
        storeFor(this).clear();
      }
    },
    getItem: {
      configurable: true,
      value(this: Storage, key: string) {
        return storeFor(this).get(key) ?? null;
      }
    },
    key: {
      configurable: true,
      value(this: Storage, index: number) {
        return Array.from(storeFor(this).keys())[index] ?? null;
      }
    },
    removeItem: {
      configurable: true,
      value(this: Storage, key: string) {
        storeFor(this).delete(key);
      }
    },
    setItem: {
      configurable: true,
      value(this: Storage, key: string, value: string) {
        storeFor(this).set(key, value);
      }
    }
  });
  const storage = Object.create(Storage.prototype) as Storage;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage
  });
}

if (typeof window !== "undefined") {
  try {
    if (typeof window.localStorage.getItem !== "function") {
      installMemoryStorage();
    }
  } catch {
    installMemoryStorage();
  }
}

// jsdom ships no layout engine, so it has no scrollIntoView. Components that
// keep a highlighted row on screen call it; a no-op keeps that out of product
// code as an environment check.
if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

if (typeof HTMLCanvasElement !== "undefined") {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: function getContext(): null {
      return null;
    }
  });
}

// Persisted UI state (panel widths, composer drafts, …) is per-test state: a
// value one test writes must not decide what the next test renders.
afterEach(() => {
  if (typeof window !== "undefined") window.localStorage.clear();
});
