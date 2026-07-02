// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface TauriCapability {
  permissions: string[];
}

function readMainCapability(): TauriCapability {
  return JSON.parse(
    readFileSync(
      new URL("../../../src-tauri/capabilities/default.json", import.meta.url),
      "utf8"
    )
  ) as TauriCapability;
}

describe("Tauri main capability", () => {
  it("allows every window API used by the live grid width floor", () => {
    expect(readMainCapability().permissions).toEqual(
      expect.arrayContaining([
        "core:window:allow-inner-size",
        "core:window:allow-scale-factor",
        "core:window:allow-set-min-size",
        "core:window:allow-set-size"
      ])
    );
  });
});
