// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  PERMISSION_MODE_KEY,
  PROVIDER_PERMISSION_MODES_KEY,
  readStoredPermissionMode,
  readStoredProviderPermissionModes
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

describe("provider permission mode preferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it.each(["provider-defaults", "auto-approve", "ask-each-time"] as const)(
    "migrates legacy %s mode to every provider",
    (legacyMode) => {
      window.localStorage.setItem(PERMISSION_MODE_KEY, legacyMode);

      const modes = readStoredProviderPermissionModes();

      expect(Object.keys(modes)).toHaveLength(5);
      for (const mode of Object.values(modes)) {
        expect(mode).toBe(legacyMode);
      }
    }
  );

  it("uses persisted per-provider modes and legacy for unconfigured providers", () => {
    window.localStorage.setItem(PERMISSION_MODE_KEY, "ask-each-time");
    window.localStorage.setItem(
      PROVIDER_PERMISSION_MODES_KEY,
      JSON.stringify({
        codex: "provider-defaults",
        claude: "auto-approve"
      })
    );

    const modes = readStoredProviderPermissionModes();

    expect(modes.codex).toBe("provider-defaults");
    expect(modes.claude).toBe("auto-approve");
    expect(modes.cursor).toBe("ask-each-time");

    for (const [providerId, mode] of Object.entries(modes)) {
      if (providerId === "codex" || providerId === "claude") {
        continue;
      }
      expect(mode).toBe("ask-each-time");
    }
  });

  it("falls back to legacy when provider map JSON is malformed", () => {
    window.localStorage.setItem(PERMISSION_MODE_KEY, "auto-approve");
    window.localStorage.setItem(PROVIDER_PERMISSION_MODES_KEY, "{not-json");

    const modes = readStoredProviderPermissionModes();

    expect(Object.keys(modes)).toHaveLength(5);
    for (const mode of Object.values(modes)) {
      expect(mode).toBe("auto-approve");
    }
  });

  it("falls back to legacy for invalid map entries", () => {
    window.localStorage.setItem(PERMISSION_MODE_KEY, "ask-each-time");
    window.localStorage.setItem(
      PROVIDER_PERMISSION_MODES_KEY,
      JSON.stringify({
        codex: "provider-defaults",
        claude: "not-a-mode"
      })
    );

    const modes = readStoredProviderPermissionModes();

    expect(modes.codex).toBe("provider-defaults");
    expect(modes.claude).toBe("ask-each-time");
    expect(modes.cursor).toBe("ask-each-time");

    for (const [providerId, mode] of Object.entries(modes)) {
      if (providerId === "codex") {
        continue;
      }
      expect(mode).toBe("ask-each-time");
    }
  });
});
