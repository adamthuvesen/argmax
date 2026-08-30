import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// DOM-only test scaffolding. Node-environment tests (pure logic) never render
// CodeMirror, and the mock's import chain touches browser globals that emit
// warnings in node.
if (typeof window !== "undefined") {
  await import("./codemirrorMock.js");
}

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

// Unconditional in a DOM environment, with no "is the native one usable?"
// probe first: jsdom's own `localStorage` is not what survives onto the test
// global, so that probe always ended up here anyway — and reading the global
// to find out tripped Node's experimental webstorage getter, which warned
// once per test file.
if (typeof window !== "undefined" && typeof Storage !== "undefined") {
  installMemoryStorage();
}

// jsdom has no ResizeObserver; components that glue native views to DOM rects
// (BrowserPanel) observe elements but never need real measurements in tests.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

// jsdom ships no matchMedia. Components ask it for `prefers-reduced-motion`
// and `pointer: coarse`; "no match" is the desktop default the suite wants,
// and a real function is also what `vi.spyOn(window, "matchMedia")` needs —
// Vitest 4 refuses to spy on an undefined property.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false
      }) as MediaQueryList
  });
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
