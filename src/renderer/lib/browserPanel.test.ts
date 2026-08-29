import { describe, expect, it, vi } from "vitest";
import { normalizeBrowserUrl, onBrowserPanelRequest, openInBrowserPanel } from "./browserPanel.js";

describe("normalizeBrowserUrl", () => {
  it("passes http(s) URLs through unchanged", () => {
    expect(normalizeBrowserUrl("https://github.com/login")).toBe("https://github.com/login");
    expect(normalizeBrowserUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("upgrades bare hosts to https", () => {
    expect(normalizeBrowserUrl("github.com")).toBe("https://github.com");
    expect(normalizeBrowserUrl("github.com/argmax?tab=repos")).toBe(
      "https://github.com/argmax?tab=repos"
    );
    expect(normalizeBrowserUrl("localhost:5173")).toBe("https://localhost:5173");
  });

  it("rejects other schemes, spaces, and non-hosts", () => {
    expect(normalizeBrowserUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeBrowserUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeBrowserUrl("what is tauri")).toBeNull();
    expect(normalizeBrowserUrl("notaurl")).toBeNull();
    expect(normalizeBrowserUrl("   ")).toBeNull();
  });
});

describe("browser panel request bus", () => {
  it("delivers open requests to the subscriber and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = onBrowserPanelRequest(listener);
    openInBrowserPanel("https://github.com");
    expect(listener).toHaveBeenCalledWith("https://github.com");
    unsubscribe();
    openInBrowserPanel("https://example.com");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
