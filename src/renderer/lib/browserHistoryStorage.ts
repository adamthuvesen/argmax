import type { BrowserHistoryEntry } from "./browserHistory.js";

export interface BrowserHistoryStorage {
  load(): Promise<unknown>;
  save(entries: BrowserHistoryEntry[]): Promise<void>;
}

const DATABASE_NAME = "argmax.browser";
const STORE_NAME = "history";
const ENTRIES_KEY = "entries";

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      if (settled) request.result.close();
      else {
        settled = true;
        resolve(request.result);
      }
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("Could not open browser history storage."));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error("Browser history storage is blocked by another window."));
    };
  });
}

export const indexedDbBrowserHistoryStorage: BrowserHistoryStorage = {
  async load(): Promise<unknown> {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readonly");
        const request = transaction.objectStore(STORE_NAME).get(ENTRIES_KEY);
        let value: unknown;
        request.onsuccess = () => { value = request.result; };
        transaction.oncomplete = () => resolve(value);
        transaction.onerror = () => reject(transaction.error ?? new Error("Could not read browser history."));
        transaction.onabort = () => reject(transaction.error ?? new Error("Could not read browser history."));
      });
    } finally {
      database.close();
    }
  },

  async save(entries: BrowserHistoryEntry[]): Promise<void> {
    const database = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put(entries, ENTRIES_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("Could not save browser history."));
        transaction.onabort = () => reject(transaction.error ?? new Error("Could not save browser history."));
      });
    } finally {
      database.close();
    }
  }
};
