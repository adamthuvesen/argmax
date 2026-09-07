// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  PERMISSION_MODE_KEY,
  readStoredPermissionMode
} from "./permissionMode.js";

describe("permission mode preferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults new and invalid preferences to provider defaults", () => {
    expect(DEFAULT_PERMISSION_MODE).toBe("provider-defaults");
    expect(readStoredPermissionMode()).toBe("provider-defaults");

    window.localStorage.setItem(PERMISSION_MODE_KEY, "invalid");
    expect(readStoredPermissionMode()).toBe("provider-defaults");
  });

  it.each(["provider-defaults", "auto-approve", "ask-each-time"] as const)(
    "preserves the stored %s mode",
    (mode) => {
      window.localStorage.setItem(PERMISSION_MODE_KEY, mode);

      expect(isPermissionMode(mode)).toBe(true);
      expect(readStoredPermissionMode()).toBe(mode);
    }
  );
});
