import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function cssRuleBody(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)\\s*${escapedSelector}\\s*\\{(?<body>[^}]+)\\}`, "i").exec(source);
  expect(match?.groups?.body).toBeDefined();
  return match?.groups?.body ?? "";
}

describe("accent CSS contract", () => {
  it("keeps tool-summary labels tinted but quieter than assistant prose", () => {
    const chatTurns = readSource("src/renderer/styles/chat-turns.css");
    const chatTools = readSource("src/renderer/styles/chat-tools.css");
    const labelRule = cssRuleBody(chatTurns, ".tool-call-group-eyebrow-label");
    const previewRule = cssRuleBody(chatTurns, ".tool-call-group-preview");
    const rowTargetRule = cssRuleBody(chatTurns, ".tool-call-row-target");
    const filePreviewRule = cssRuleBody(chatTools, ".tool-call-file-preview-header code");

    expect(labelRule).toContain("font-weight: 500;");
    expect(labelRule).toContain("letter-spacing: 0.045em;");
    expect(labelRule).toContain("color: color-mix(in oklab, var(--accent) 20%, var(--muted));");
    expect(labelRule).not.toContain("var(--accent-deep)");
    expect(previewRule).toContain("color: color-mix(in oklab, var(--accent) 14%, var(--muted));");
    expect(rowTargetRule).toContain("color: color-mix(in oklab, var(--accent) 14%, var(--muted));");
    expect(rowTargetRule).not.toContain("color: var(--text);");
    expect(filePreviewRule).toContain("color: color-mix(in oklab, var(--accent) 14%, var(--muted));");
  });

  it("uses configurable accent tokens for markdown output chrome", () => {
    const chatConversation = readSource("src/renderer/styles/chat-conversation.css");
    const chatComposer = readSource("src/renderer/styles/chat-composer.css");
    expect(chatConversation).toContain(".markdown code");
    expect(chatConversation).toContain("background: var(--accent-soft);");
    expect(chatConversation).toContain("color: var(--accent-deep);");
    expect(chatComposer).toContain(".file-chip");
    expect(chatComposer).toContain("color: var(--accent-deep);");
  });

  it("keeps file-change and diff greens on semantic tokens", () => {
    const chatTools = readSource("src/renderer/styles/chat-tools.css");
    const tokens = readSource("src/renderer/styles/tokens.css");
    expect(chatTools).toContain('file-change-card[data-kind="create"]');
    expect(chatTools).toContain("border-left: 3px solid var(--sage-deep);");
    expect(tokens).toContain("--diff-add-bg:");
    expect(tokens).toContain("--diff-add-gutter-fg:");
  });

  it("keeps checks status colors semantic while Purple can still override accent", () => {
    const tokens = readSource("src/renderer/styles/tokens.css");
    expect(tokens).toContain('.checks-row[data-status="passed"] .checks-row-status');
    expect(tokens).toContain("color: var(--sage);");
    expect(tokens).toContain(':root[data-theme="purple"][data-accent="blue"]');
  });
});
