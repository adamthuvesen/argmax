import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("accent CSS contract", () => {
  it("uses configurable accent tokens for tool-summary labels", () => {
    const chatTurns = readSource("src/renderer/styles/chat-turns.css");
    expect(chatTurns).toContain(".tool-call-group-eyebrow-label");
    expect(chatTurns).toContain("color: var(--accent-deep);");
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
