import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_IDE_KEY, NO_DEFAULT_IDE, readStoredDefaultIde } from "./ide.js";

describe("readStoredDefaultIde", () => {
  afterEach(() => {
    window.localStorage.removeItem(DEFAULT_IDE_KEY);
  });

  it("falls back to Cursor when nothing is stored", () => {
    expect(readStoredDefaultIde()).toBe("cursor");
  });

  it("returns the stored pick", () => {
    window.localStorage.setItem(DEFAULT_IDE_KEY, "zed");
    expect(readStoredDefaultIde()).toBe("zed");
  });

  it("keeps an explicit Ask-each-time choice as null", () => {
    window.localStorage.setItem(DEFAULT_IDE_KEY, NO_DEFAULT_IDE);
    expect(readStoredDefaultIde()).toBeNull();
  });

  it("treats an unknown stored value as the factory default", () => {
    window.localStorage.setItem(DEFAULT_IDE_KEY, "emacs");
    expect(readStoredDefaultIde()).toBe("cursor");
  });
});
