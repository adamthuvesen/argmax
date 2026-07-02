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
  it("keeps tool-summary labels neutral and quieter than assistant prose", () => {
    const chatTurns = readSource("src/renderer/styles/chat-turns.css");
    const chatTools = readSource("src/renderer/styles/chat-tools.css");
    const labelRule = cssRuleBody(chatTurns, ".tool-call-group-eyebrow-label");
    const previewRule = cssRuleBody(chatTurns, ".tool-call-group-preview");
    const rowTargetRule = cssRuleBody(chatTurns, ".tool-call-row-target");
    const filePreviewRule = cssRuleBody(chatTools, ".tool-call-file-preview-header code");

    expect(labelRule).toContain("font-weight: 400;");
    expect(labelRule).toContain("letter-spacing: 0;");
    expect(labelRule).toContain("text-transform: none;");
    expect(labelRule).toContain("color: var(--muted);");
    expect(labelRule).not.toContain("var(--accent-deep)");
    expect(previewRule).toContain("color: var(--muted);");
    expect(rowTargetRule).toContain("color: var(--muted);");
    expect(rowTargetRule).not.toContain("color: var(--text);");
    expect(filePreviewRule).toContain("color: color-mix(in oklab, var(--accent) 14%, var(--muted));");
  });

  it("uses configurable accent tokens for markdown output chrome while file chips stay neutral", () => {
    const chatConversation = readSource("src/renderer/styles/chat-conversation.css");
    const chatComposer = readSource("src/renderer/styles/chat-composer.css");
    const fileChipRule = cssRuleBody(chatComposer, ".file-chip");
    expect(chatConversation).toContain(".markdown code");
    expect(chatConversation).toContain("background: var(--accent-soft);");
    expect(chatConversation).toContain("color: var(--accent-deep);");
    expect(chatComposer).toContain(".file-chip");
    expect(fileChipRule).toContain("background: var(--panel-sunken);");
    expect(fileChipRule).toContain("color: var(--muted-strong);");
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

  it("uses themed user bubble surfaces and launch composer focus", () => {
    const tokens = readSource("src/renderer/styles/tokens.css");
    const chatConversation = readSource("src/renderer/styles/chat-conversation.css");
    const chatChrome = readSource("src/renderer/styles/chat-chrome.css");
    const userBubbleRule = cssRuleBody(chatConversation, ".chat-bubble.user");
    const composerFocusRule = cssRuleBody(chatChrome, ".composer-input:focus-within");

    expect(tokens).toContain("--user-message-bg: color-mix(in oklab, var(--panel-sunken) 72%, var(--panel) 28%);");
    expect(tokens).toContain("--user-message-selection-bg:");
    expect(tokens).not.toContain("--user-message-border:");
    expect(tokens).toContain(':root[data-theme="dark"]');
    expect(tokens).toContain(':root[data-theme="purple"]');
    expect(userBubbleRule).toContain("background: var(--user-message-bg);");
    expect(userBubbleRule).toContain("box-shadow: var(--user-message-shadow);");
    expect(userBubbleRule).not.toContain("border:");
    expect(composerFocusRule).toContain("border-color: color-mix(in oklab, var(--accent) 55%, var(--line-strong));");
    expect(composerFocusRule).toContain("0 0 0 3px color-mix(in oklab, var(--accent) 12%, transparent)");
  });

  it("keeps session composer text aligned with assistant prose size", () => {
    const chatComposerChips = readSource("src/renderer/styles/chat-composer-chips.css");
    const inputRule = cssRuleBody(chatComposerChips, ".session-input input,\n.session-input textarea");
    const highlightRule = cssRuleBody(chatComposerChips, ".composer-highlight-backdrop");

    expect(inputRule).toContain("font-size: var(--text-base);");
    expect(highlightRule).toContain("font-size: var(--text-base);");
  });

  it("keeps the session branch chip ellipsis-safe in narrow grids", () => {
    const chatComposer = readSource("src/renderer/styles/chat-composer.css");
    const chatComposerChips = readSource("src/renderer/styles/chat-composer-chips.css");
    const toolbarRule = cssRuleBody(chatComposerChips, ".session-input-toolbar");
    const modelLabelRule = cssRuleBody(
      chatComposerChips,
      ".session-input-toolbar .model-picker-label"
    );
    const contextRule = cssRuleBody(
      chatComposerChips,
      ".session-input-toolbar .composer-chips-context"
    );
    const footerRule = cssRuleBody(chatComposer, ".session-input-toolbar .composer-footer");
    const chipRule = cssRuleBody(chatComposer, ".session-input-toolbar .composer-footer-chip");
    const branchRule = cssRuleBody(
      chatComposer,
      ".session-input-toolbar .composer-footer-chip--branch"
    );
    const labelRule = cssRuleBody(
      chatComposer,
      ".session-input-toolbar .composer-footer-chip-label"
    );

    expect(toolbarRule).toContain("flex-wrap: wrap;");
    expect(modelLabelRule).toContain("text-overflow: ellipsis;");
    expect(modelLabelRule).toContain("white-space: nowrap;");
    expect(contextRule).toContain("min-width: 0;");
    expect(contextRule).toContain("overflow: hidden;");
    expect(footerRule).toContain("max-width: 100%;");
    expect(footerRule).toContain("overflow: hidden;");
    expect(chipRule).toContain("overflow: hidden;");
    expect(branchRule).toContain("min-width: 0;");
    expect(branchRule).toContain("max-width: 100%;");
    expect(labelRule).toContain("text-overflow: ellipsis;");
    expect(labelRule).toContain("white-space: nowrap;");
    expect(chatComposerChips).toContain('"attach model mode send"');
    expect(chatComposerChips).toContain('"context context context context"');
    expect(chatComposerChips).toContain(".session-input textarea");
    expect(chatComposerChips).toContain("min-height: 56px;");
    expect(chatComposerChips).toContain(".session-input-toolbar .session-send-mascot");
  });

  it("keeps the changed-files card compact-safe in narrow panes", () => {
    const chatTools = readSource("src/renderer/styles/chat-tools.css");
    const headerRule = cssRuleBody(chatTools, ".changed-files-header");
    const titleRule = cssRuleBody(chatTools, ".changed-files-title");
    const actionsRule = cssRuleBody(chatTools, ".changed-files-actions");

    expect(headerRule).toContain("min-width: 0;");
    expect(titleRule).toContain("min-width: 0;");
    expect(titleRule).toContain("text-overflow: ellipsis;");
    expect(titleRule).toContain("white-space: nowrap;");
    expect(actionsRule).toContain("flex: 0 0 auto;");
    expect(actionsRule).toContain("min-width: max-content;");
    expect(chatTools).toContain("@container (max-width: 520px)");
  });

  it("keeps the pane resize floor aligned with the compact composer breakpoint", () => {
    const gridComponent = readSource("src/renderer/components/SessionMultiGrid.tsx");
    const chatConversation = readSource("src/renderer/styles/chat-conversation.css");
    const chatComposerChips = readSource("src/renderer/styles/chat-composer-chips.css");
    const appSource = readSource("src/renderer/App.tsx");
    const sidebarResize = readSource("src/renderer/hooks/useSidebarResize.ts");
    const minWidthMatch = /export const MIN_RESIZABLE_CELL_WIDTH_PX = (?<width>\d+);/.exec(
      gridComponent
    );
    expect(minWidthMatch?.groups?.width).toBeDefined();
    const minWidth = minWidthMatch?.groups?.width ?? "";
    const multigridRule = cssRuleBody(chatConversation, ".session-multigrid");
    const rowRule = cssRuleBody(chatConversation, ".session-multigrid-row");
    const cellRule = cssRuleBody(chatConversation, ".session-multigrid-cell");
    const sessionGridRule = cssRuleBody(chatConversation, ".session-grid");

    expect(gridComponent).toContain("--session-pane-min-width");
    expect(multigridRule).toContain("overflow: hidden;");
    expect(rowRule).toContain("min-width: 0;");
    expect(rowRule).toContain("overflow: hidden;");
    expect(cellRule).toContain("container-type: inline-size;");
    expect(sessionGridRule).toContain("min-width: 0;");
    expect(Number(minWidth)).toBeLessThan(520);
    expect(chatComposerChips).toContain("@container (max-width: 520px)");
    expect(appSource).toContain("requiredGridColumns * MIN_RESIZABLE_CELL_WIDTH_PX");
    expect(appSource).toContain("appWindow.setMinSize");
    expect(sidebarResize).toContain("workspaceMinWidth");
  });
});
