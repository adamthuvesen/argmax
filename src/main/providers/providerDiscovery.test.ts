// @vitest-environment node
import { describe, expect, it } from "vitest";
import { discoverProviderById, discoverProviders, type ProviderDiscoveryRunner } from "./providerDiscovery.js";

describe("provider discovery", () => {
  it("reports installed provider capabilities", async () => {
    const runner: ProviderDiscoveryRunner = {
      resolveBinary: (binaryName) => Promise.resolve(`/usr/local/bin/${binaryName}`),
      readVersion: () => Promise.resolve("1.2.3")
    };

    const codex = await discoverProviderById("codex", runner);

    expect(codex.installed).toBe(true);
    expect(codex.binaryPath).toBe("/usr/local/bin/codex");
    expect(codex.version).toBe("1.2.3");
    expect(codex.modes).toEqual(["interactive-pty", "structured-json"]);
    expect(codex.setupGuidance).toBeNull();
  });

  it("returns setup guidance when provider binaries are missing", async () => {
    const runner: ProviderDiscoveryRunner = {
      resolveBinary: () => Promise.resolve(null),
      readVersion: () => Promise.resolve(null)
    };

    const providers = await discoverProviders(runner);

    expect(providers).toHaveLength(3);
    expect(providers.every((provider) => !provider.installed)).toBe(true);
    expect(providers.find((provider) => provider.provider === "claude")?.setupGuidance).toContain("Claude Code");
    expect(providers.find((provider) => provider.provider === "codex")?.setupGuidance).toContain("Codex CLI");
    expect(providers.find((provider) => provider.provider === "cursor")?.setupGuidance).toContain("Cursor CLI");
  });

  it("reports cursor as structured-json only", async () => {
    const runner: ProviderDiscoveryRunner = {
      resolveBinary: (binaryName) => Promise.resolve(`/usr/local/bin/${binaryName}`),
      readVersion: () => Promise.resolve("2026.05.09")
    };

    const cursor = await discoverProviderById("cursor", runner);

    expect(cursor.installed).toBe(true);
    expect(cursor.binaryPath).toBe("/usr/local/bin/cursor-agent");
    expect(cursor.binaryName).toBe("cursor-agent");
    expect(cursor.modes).toEqual(["structured-json"]);
  });
});
