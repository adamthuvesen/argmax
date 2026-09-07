import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHAT_PANE_MIN_WIDTH_PX, SESSION_CELL_MIN_WIDTH_PX } from "../lib/layoutConstants.js";

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function cssRuleBody(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)\\s*${escapedSelector}\\s*\\{(?<body>[^}]+)\\}`, "i").exec(source);
  expect(match?.groups?.body).toBeDefined();
  return match?.groups?.body ?? "";
}

describe("CSS contracts that cannot be exercised in jsdom", () => {
  it("registers the terminal length token consumed by the canvas renderer", () => {
    const tokens = readSource("src/renderer/styles/tokens.css");
    const registration = /@property\s+--text-terminal\s*\{(?<body>[^}]+)\}/.exec(tokens);

    expect(registration?.groups?.body).toContain('syntax: "<length>"');
    expect(registration?.groups?.body).toContain("inherits: true");
  });

  it("keeps body text above the browser contrast floor", () => {
    const tokens = readSource("src/renderer/styles/tokens.css");
    const readHex = (rule: string, token: string): string => {
      const match = new RegExp(`--${token}:\\s*(?<hex>#[0-9a-f]{6});`, "i").exec(rule);
      expect(match?.groups?.hex).toBeDefined();
      return match?.groups?.hex ?? "";
    };
    const luminance = (hex: string): number =>
      [1, 3, 5]
        .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
        .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const contrast = (foreground: string, background: string): number => {
      const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    const light = cssRuleBody(tokens, ":root");
    const dark = cssRuleBody(tokens, ':root[data-theme="dark"]');

    expect(contrast(readHex(light, "text"), readHex(light, "bg"))).toBeGreaterThan(10);
    expect(contrast(readHex(light, "text-soft"), readHex(light, "bg"))).toBeGreaterThan(7);
    expect(contrast(readHex(dark, "text"), readHex(dark, "bg"))).toBeGreaterThan(10);
    expect(contrast(readHex(dark, "text-soft"), readHex(dark, "bg"))).toBeGreaterThan(7);
  });

  it("keeps review scope menus below their trigger", () => {
    const base = cssRuleBody(readSource("src/renderer/styles/chat-chrome.css"), ".project-picker-popover");
    const scope = cssRuleBody(readSource("src/renderer/styles/overlays-review.css"), ".review-scope-popover");

    expect(base).toContain("bottom: calc(100% + 6px);");
    expect(scope).toContain("top: calc(100% + 4px);");
    expect(scope).toContain("bottom: auto;");
    expect(scope).toContain("left: auto;");
  });

  it("keeps the pane minimum width aligned with the compact composer breakpoint", () => {
    const chatComposer = readSource("src/renderer/styles/chat-composer-chips.css");

    expect(SESSION_CELL_MIN_WIDTH_PX).toBeLessThan(720);
    expect(CHAT_PANE_MIN_WIDTH_PX).toBeLessThan(SESSION_CELL_MIN_WIDTH_PX);
    expect(chatComposer).toContain("@container (max-width: 720px)");
  });

  it("disables programming ligatures on shipped machine-text surfaces", () => {
    const tokens = readSource("src/renderer/styles/tokens.css");
    expect(cssRuleBody(tokens, ":root")).toContain(
      '--code-font-features: "liga" 0, "clig" 0, "calt" 0;'
    );

    const surfaces: [string, string][] = [
      ["src/renderer/styles/chat-turns.css", ".tool-call-code"],
      ["src/renderer/styles/chat-conversation.css", ".markdown code"],
      ["src/renderer/styles/chat-conversation.css", ".terminal-transcript pre"],
      ["src/renderer/styles/overlays-review-files.css", ".diff-blocks"]
    ];
    for (const [file, selector] of surfaces) {
      expect(cssRuleBody(readSource(file), selector)).toContain(
        "font-feature-settings: var(--code-font-features);"
      );
    }
  });

  it("dissolves scroller edges with the shared fade rather than a hard clip", () => {
    const tokens = cssRuleBody(readSource("src/renderer/styles/tokens.css"), ":root");
    expect(tokens).toContain("--scroll-edge-fade: 32px;");
    expect(tokens).toContain("--scroll-edge-fade-color: var(--bg);");

    const fade = readSource("src/renderer/styles/scroll-fade.css");
    expect(fade).toContain(
      "background: linear-gradient(to bottom, var(--scroll-edge-fade-color), transparent);"
    );
    expect(fade).toContain(
      "background: linear-gradient(to top, var(--scroll-edge-fade-color), transparent);"
    );

    const sidebar = cssRuleBody(readSource("src/renderer/styles/shell-layout.css"), ".project-list-scroll");
    expect(sidebar).toContain("--scroll-edge-fade-color: var(--sidebar);");

    const conversation = cssRuleBody(readSource("src/renderer/styles/chat-conversation.css"), ".conversation-scroll");
    expect(conversation).toContain("--scroll-edge-fade: var(--conversation-edge-fade);");
    expect(conversation).toContain("--scroll-edge-fade-color: var(--conversation-fade, var(--bg));");

    const settings = cssRuleBody(readSource("src/renderer/styles/settings-layout.css"), ".standalone-page-fade");
    expect(settings).toContain("--scroll-edge-fade-color: var(--bg);");
    expect(settings).toContain("pointer-events: none;");
  });

  it("gates the workspace card on a gutter that actually fits it, per chat width", () => {
    const conversation = readSource("src/renderer/styles/chat-conversation.css");
    const card = readSource("src/renderer/styles/chat-workspace-card.css");
    const cardBody = cssRuleBody(card, ".workspace-card");
    const pixels = (body: string, property: string): number => {
      const match = new RegExp(`${property}:\\s*(?<value>\\d+)px;`).exec(body);
      expect(match?.groups?.value).toBeDefined();
      return Number(match?.groups?.value);
    };
    // One card column on each side: the card itself, its inset from the pane
    // edge, and the clearance that keeps it off the transcript.
    const gutter = pixels(cardBody, "--workspace-card-width") + pixels(cardBody, "right") + 14;

    const measure = (width: number, suffix: string): number => {
      const body = cssRuleBody(conversation, `.app-shell[data-chat-width="${width}"]`);
      return pixels(body, `--chat-content-width${suffix}`);
    };
    const suffixes: Record<string, string> = {
      "": "",
      " :is(.session-grid.review-open, .session-grid.log-open)": "-docked",
      " .session-grid.review-open.log-open": "-tight"
    };

    const rules = [
      ...card.matchAll(
        /@container \(min-width: (?<threshold>\d+)px\) \{\s*(?<selector>[^{]*?)\s*\.workspace-card \{\s*display: flex;/g
      )
    ];
    expect(rules).toHaveLength(15);

    for (const rule of rules) {
      const selector = rule.groups?.selector ?? "";
      // A bare `.app-shell` reads as "the default width" but matches every
      // shell, which would hand widths 4 and 5 width 3's lower threshold and
      // drop the card onto the transcript.
      const shell = /^\.app-shell\[data-chat-width="(?<width>\d)"\]/.exec(selector);
      expect(shell?.groups?.width, selector).toBeDefined();
      const width = Number(shell?.groups?.width);
      const suffix = suffixes[selector.slice(shell?.[0].length)];
      expect(suffix, selector).toBeDefined();

      expect(Number(rule.groups?.threshold), selector).toBe(measure(width, suffix) + gutter * 2);
    }
  });
});
