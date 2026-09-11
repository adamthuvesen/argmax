import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

const rust = readFileSync("src-tauri/src/ipc/browser.rs", "utf8");
const script = rust.match(/const BROWSER_INIT_SCRIPT: &str = r#"([\s\S]*?)"#;/)?.[1];

it.each([
  ["", "about:blank"],
  [undefined, "about:blank"],
  ["https://example.com/login", "https://example.com/login"]
])("preserves a real popup reference for URL %s", (url, expectedUrl) => {
  expect(script).toBeDefined();
  const popup = { closed: false, location: { href: "about:blank" } };
  const nativeOpen = vi.fn<(url: string | undefined, name: string, features: string) => typeof popup>(() => popup);
  const window = { open: nativeOpen, addEventListener: vi.fn() };
  runInNewContext(script!, { window, document: { addEventListener: vi.fn() } });

  expect(window.open(url, "login", "width=500,height=600")).toBe(popup);
  expect(nativeOpen).toHaveBeenCalledWith(expectedUrl, "login", "width=500,height=600");
});

it("leaves popup links and keyboard shortcuts native even after the opener is severed", () => {
  const listeners: Array<(event: object) => void> = [];
  const addEventListener = (_type: string, listener: (event: object) => void) => {
    listeners.push(listener);
  };
  const window = { open: vi.fn(), opener: null, __argmaxBrowserPopup: false, addEventListener };
  runInNewContext(script!, { window, document: { addEventListener } });
  // The popup marker is appended after WebKit's inherited scripts.
  window.__argmaxBrowserPopup = true;
  const preventDefault = vi.fn();
  const closest = vi.fn(() => ({ href: "https://example.com/" }));
  for (const listener of listeners) {
    listener({ metaKey: true, key: "w", button: 3, target: { closest }, preventDefault });
  }

  expect(preventDefault).not.toHaveBeenCalled();
  expect(closest).not.toHaveBeenCalled();
});
