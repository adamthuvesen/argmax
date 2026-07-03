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
    const resourceRowRule = cssRuleBody(chatTools, ".tool-call-resource-row code");

    expect(labelRule).toContain("font-weight: 400;");
    expect(labelRule).toContain("letter-spacing: 0;");
    expect(labelRule).toContain("text-transform: none;");
    expect(labelRule).toContain("color: var(--muted);");
    expect(labelRule).not.toContain("var(--accent-deep)");
    expect(previewRule).toContain("font-family: var(--font-code);");
    expect(previewRule).toContain("color: var(--muted);");
    expect(rowTargetRule).toContain("font-family: var(--font-code);");
    expect(rowTargetRule).toContain("color: var(--muted);");
    expect(rowTargetRule).not.toContain("color: var(--text);");
    expect(resourceRowRule).toContain("color: color-mix(in oklab, var(--accent) 14%, var(--muted));");
  });

  it("keeps expanded tool details quiet and preview-like", () => {
    const chatTurns = readSource("src/renderer/styles/chat-turns.css");
    const chatTools = readSource("src/renderer/styles/chat-tools.css");
    const detailRule = cssRuleBody(chatTurns, ".tool-call-detail");
    const rowDetailRule = cssRuleBody(chatTools, ".tool-call-row > .tool-call-detail");
    const labelRule = cssRuleBody(chatTurns, ".tool-call-section-label");
    const codeRule = cssRuleBody(chatTurns, ".tool-call-code");
    const commandLineRule = cssRuleBody(chatTurns, ".tool-call-command-line");
    const terminalRule = cssRuleBody(chatTurns, ".tool-call-code--terminal");
    const rawSummaryRule = cssRuleBody(chatTurns, ".tool-call-raw-input summary");
    const runningItemRule = cssRuleBody(
      chatTurns,
      ".tool-call-item[data-status=\"running\"]:not(.tool-call-item--nested)"
    );
    const errorItemRule = cssRuleBody(
      chatTurns,
      ".tool-call-item[data-status=\"error\"]:not(.tool-call-item--nested)"
    );

    expect(detailRule).toContain("gap: 10px;");
    expect(detailRule).toContain("border-top: 1px solid color-mix(in oklab, var(--line-soft) 58%, transparent);");
    expect(rowDetailRule).toContain("padding: 7px 0 8px;");
    expect(rowDetailRule).not.toContain("border-left");
    expect(chatTools).not.toContain(".tool-call-row[data-status=\"error\"] > .tool-call-detail");
    expect(runningItemRule).not.toContain("box-shadow");
    expect(errorItemRule).not.toContain("box-shadow");
    expect(labelRule).toContain("font-weight: 450;");
    expect(labelRule).toContain("color: color-mix(in oklab, var(--muted) 88%, var(--text-soft) 12%);");
    expect(codeRule).toContain("background: color-mix(in oklab, var(--code-surface) 46%, transparent);");
    expect(codeRule).toContain("border: 1px solid color-mix(in oklab, var(--line-soft) 64%, transparent);");
    expect(codeRule).toContain("line-height: 1.7;");
    expect(codeRule).toContain("max-height: 300px;");
    expect(commandLineRule).toContain("background: color-mix(in oklab, var(--code-surface) 28%, transparent);");
    expect(commandLineRule).toContain("line-height: 1.55;");
    expect(commandLineRule).toContain("white-space: pre;");
    expect(terminalRule).toContain("background: color-mix(in oklab, var(--code-surface) 52%, transparent);");
    expect(terminalRule).toContain("border-color: color-mix(in oklab, var(--line) 58%, transparent);");
    expect(rawSummaryRule).toContain("font-weight: 450;");
  });

  it("keeps inline markdown code and file refs quiet, colored, and unfilled", () => {
    const chatConversation = readSource("src/renderer/styles/chat-conversation.css");
    const chatComposer = readSource("src/renderer/styles/chat-composer.css");
    const markdownCodeRule = cssRuleBody(chatConversation, ".markdown code");
    const fileChipRule = cssRuleBody(chatComposer, ".file-chip");

    expect(markdownCodeRule).toContain("background: transparent;");
    expect(markdownCodeRule).toContain("font-family: var(--font-code);");
    expect(markdownCodeRule).toContain("border: 0;");
    expect(markdownCodeRule).toContain("color: color-mix(in oklab, var(--accent-deep) 32%, var(--text-soft) 68%);");
    expect(chatComposer).toContain(".file-chip");
    expect(fileChipRule).toContain("background: transparent;");
    expect(fileChipRule).toContain("font-family: var(--font-code);");
    expect(fileChipRule).toContain("color: color-mix(in oklab, var(--accent-deep) 22%, var(--muted-strong));");
    expect(fileChipRule).toContain("text-decoration-line: none;");
    expect(readSource("src/renderer/components/FileChip.tsx")).not.toContain("Code2");
  });

  it("keeps file-change and diff greens on semantic tokens", () => {
    const chatTools = readSource("src/renderer/styles/chat-tools.css");
    const tokens = readSource("src/renderer/styles/tokens.css");
    expect(chatTools).toContain('file-change-card[data-kind="create"]');
    expect(chatTools).toContain("border-left: 2px solid color-mix(in oklab, var(--sage-deep) 58%, var(--line-soft));");
    expect(tokens).toContain("--diff-add-bg:");
    expect(tokens).toContain("--diff-add-gutter-fg:");
  });

  it("keeps review file names on UI type and file contents on compact code type", () => {
    const review = readSource("src/renderer/styles/overlays-review.css");
    const reviewFiles = readSource("src/renderer/styles/overlays-review-files.css");
    const treeRule = cssRuleBody(reviewFiles, ".workspace-tree");
    const treeLabelRule = cssRuleBody(reviewFiles, ".workspace-tree-row span");
    const treeIconRule = cssRuleBody(reviewFiles, ".workspace-tree-row > svg");
    const treeChevronRule = cssRuleBody(reviewFiles, ".workspace-tree-chevron");
    const treeChevronSpacerRule = cssRuleBody(reviewFiles, ".workspace-tree-chevron-spacer");
    const tabRule = cssRuleBody(reviewFiles, ".file-tab");
    const editorScrollerRule = cssRuleBody(reviewFiles, ".file-preview-editor .cm-scroller");
    const previewBodyRule = cssRuleBody(reviewFiles, ".file-preview-body");
    const diffRule = cssRuleBody(reviewFiles, ".diff-blocks");
    const changedFileRule = cssRuleBody(review, ".review-changed-file-toggle");

    expect(treeRule).toContain("font-family: var(--font-ui);");
    expect(treeRule).toContain("font-size: var(--text-sm);");
    expect(treeLabelRule).toContain("flex: 1 1 auto;");
    expect(treeIconRule).toContain("flex: 0 0 13px;");
    expect(treeChevronRule).toContain("flex: 0 0 12px;");
    expect(treeChevronRule).toContain("min-width: 12px;");
    expect(treeChevronSpacerRule).toContain("flex: 0 0 12px;");
    expect(treeChevronSpacerRule).toContain("min-width: 12px;");
    expect(tabRule).toContain("font-family: var(--font-ui);");
    expect(tabRule).toContain("font-size: var(--text-sm);");
    expect(editorScrollerRule).toContain("font-family: var(--font-code);");
    expect(editorScrollerRule).toContain("font-size: var(--text-sm);");
    expect(previewBodyRule).toContain("font-family: var(--font-code);");
    expect(previewBodyRule).toContain("font-size: var(--text-sm);");
    expect(diffRule).toContain("font-family: var(--font-code);");
    expect(diffRule).toContain("font-size: var(--text-sm);");
    expect(changedFileRule).toContain("font-size: var(--text-sm);");
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
    const chatTools = readSource("src/renderer/styles/chat-tools.css");
    const userBubbleRule = cssRuleBody(chatConversation, ".chat-bubble.user");
    const composerFocusRule = cssRuleBody(chatChrome, ".composer-input:focus-within");
    const sessionInputFocusRule = cssRuleBody(chatTools, ".session-input:focus-within");

    expect(tokens).toContain("--user-message-bg: color-mix(in oklab, var(--panel-sunken) 72%, var(--panel) 28%);");
    expect(tokens).toContain("--user-message-selection-bg:");
    expect(tokens).not.toContain("--user-message-border:");
    expect(tokens).toContain(':root[data-theme="dark"]');
    expect(tokens).toContain(':root[data-theme="purple"]');
    expect(userBubbleRule).toContain("background: var(--user-message-bg);");
    expect(userBubbleRule).toContain("box-shadow: var(--user-message-shadow);");
    expect(userBubbleRule).not.toContain("border:");
    expect(composerFocusRule).toContain("border-color: color-mix(in oklab, var(--accent) 34%, var(--line-strong));");
    expect(composerFocusRule).toContain("0 0 0 2px color-mix(in oklab, var(--accent) 8%, transparent)");
    expect(sessionInputFocusRule).toContain("border-color: color-mix(in oklab, var(--accent) 34%, var(--line-strong));");
    expect(sessionInputFocusRule).toContain("0 0 0 2px color-mix(in oklab, var(--accent) 8%, transparent)");
  });

  it("keeps session composer text aligned with assistant prose size", () => {
    const chatComposerChips = readSource("src/renderer/styles/chat-composer-chips.css");
    const inputRule = cssRuleBody(chatComposerChips, ".session-input input,\n.session-input textarea");
    const highlightRule = cssRuleBody(chatComposerChips, ".composer-highlight-backdrop");

    expect(inputRule).toContain("font-family: var(--font-prose);");
    expect(inputRule).toContain("font-size: var(--text-base);");
    expect(inputRule).toContain("line-height: 1.55;");
    expect(highlightRule).toContain("font-family: var(--font-prose);");
    expect(highlightRule).toContain("font-size: var(--text-base);");
    expect(highlightRule).toContain("line-height: 1.55;");
  });

  it("keeps launch composer copy and context chips calm", () => {
    const launchSurface = readSource("src/renderer/components/LaunchSurface.tsx");
    const chatChrome = readSource("src/renderer/styles/chat-chrome.css");
    const contextChipRule = cssRuleBody(chatChrome, ".composer-context-chip");
    const contextChipHoverRule = cssRuleBody(chatChrome, ".composer-context-chip:hover");

    expect(launchSurface).toContain('placeholderText = "Ask your agent to inspect, build, or fix something"');
    expect(launchSurface).not.toContain("Coffee and code time?");
    expect(launchSurface).not.toContain("Time to ship.");
    expect(launchSurface).not.toContain("What are we hacking on?");
    expect(contextChipRule).toContain("background: transparent;");
    expect(contextChipRule).toContain("color: var(--muted);");
    expect(contextChipRule).toContain("font-size: var(--text-xs);");
    expect(contextChipHoverRule).toContain("background: transparent;");
    expect(contextChipHoverRule).toContain("color: var(--muted-strong);");
  });

  it("keeps chat paragraphs airy without changing text size", () => {
    const tokens = readSource("src/renderer/styles/tokens.css");
    const chatConversation = readSource("src/renderer/styles/chat-conversation.css");
    const bubbleParagraphRule = cssRuleBody(chatConversation, ".chat-bubble p");
    const markdownRule = cssRuleBody(chatConversation, ".markdown");
    const readableMeasureRule = cssRuleBody(
      chatConversation,
      ".markdown > :where(p, ul, ol, blockquote, h1, h2, h3, h4)"
    );

    expect(tokens).toContain("--font-prose: \"Inter Variable\", Inter, ui-sans-serif");
    expect(tokens).toContain(':root[data-font="lilex"]');
    expect(tokens).toContain("--font-ui: \"Inter Variable\", Inter, ui-sans-serif");
    expect(bubbleParagraphRule).toContain("font-family: var(--font-prose);");
    expect(bubbleParagraphRule).toContain("font-size: var(--text-base);");
    expect(bubbleParagraphRule).toContain("line-height: 1.68;");
    expect(markdownRule).toContain("font-family: var(--font-prose);");
    expect(markdownRule).toContain("font-size: var(--text-base);");
    expect(markdownRule).toContain("line-height: 1.9;");
    expect(markdownRule).toContain("color: color-mix(in oklab, var(--text) 91%, var(--text-soft) 9%);");
    expect(readableMeasureRule).toContain("max-width: 780px;");
  });

  it("keeps narrow chat panes away from the borders", () => {
    const chatConversation = readSource("src/renderer/styles/chat-conversation.css");
    const launcherPanels = readSource("src/renderer/styles/overlays-launcher-panels.css");
    const sessionGridRule = cssRuleBody(chatConversation, ".session-grid");
    const reviewOpenGridRule = cssRuleBody(chatConversation, ".session-grid.review-open");
    const logOpenGridRule = cssRuleBody(chatConversation, ".session-grid.log-open");
    const bothOpenGridRule = cssRuleBody(chatConversation, ".session-grid.review-open.log-open");
    const mainColumnRule = cssRuleBody(chatConversation, ".session-main-column");
    const dockedColumnRule = cssRuleBody(
      chatConversation,
      ".session-grid.review-open .session-main-column,\n.session-grid.log-open .session-main-column"
    );
    const fullyDockedColumnRule = cssRuleBody(
      chatConversation,
      ".session-grid.review-open.log-open .session-main-column"
    );

    expect(sessionGridRule).toContain("--session-main-column-min-width: 520px;");
    expect(sessionGridRule).toContain("position: relative;");
    expect(reviewOpenGridRule).toContain("minmax(var(--session-main-column-min-width), 1fr)");
    expect(logOpenGridRule).toContain("minmax(var(--session-main-column-min-width), 1fr)");
    expect(bothOpenGridRule).toContain("minmax(var(--session-main-column-min-width), 1fr)");
    expect(launcherPanels).not.toContain("@media (max-width: 1080px)");
    expect(launcherPanels).not.toContain("width: min(420px, max(300px, calc(100% - 320px)));");
    expect(launcherPanels).not.toContain(".review-panel,\n  .log-panel {\n    position: fixed;");
    expect(mainColumnRule).toContain("--session-inline-padding: clamp(28px, calc((100% - 820px) / 2), 2000px);");
    expect(dockedColumnRule).toContain("--session-inline-padding: clamp(22px, calc((100% - 780px) / 2), 2000px);");
    expect(fullyDockedColumnRule).toContain("--session-inline-padding: clamp(20px, calc((100% - 720px) / 2), 2000px);");
  });

  it("keeps markdown hierarchy restrained in chat", () => {
    const chatConversation = readSource("src/renderer/styles/chat-conversation.css");
    const leadInRule = cssRuleBody(chatConversation, ".markdown p:has(+ ul),\n.markdown p:has(+ ol)");
    const strongRule = cssRuleBody(chatConversation, ".markdown strong");
    const listRule = cssRuleBody(chatConversation, ".markdown ul,\n.markdown ol");
    const listItemRule = cssRuleBody(chatConversation, ".markdown li");
    const singleItemHeadingRule = cssRuleBody(chatConversation, ".markdown ol > li:only-child");
    const headingRule = cssRuleBody(
      chatConversation,
      ".markdown h1,\n.markdown h2,\n.markdown h3,\n.markdown h4"
    );
    const h1Rule = cssRuleBody(chatConversation, ".markdown h1");
    const h2Rule = cssRuleBody(chatConversation, ".markdown h2");

    expect(leadInRule).toContain("font-size: var(--text-base);");
    expect(leadInRule).toContain("font-weight: 520;");
    expect(strongRule).toContain("font-weight: 520;");
    expect(listRule).toContain("margin: 8px 0 20px;");
    expect(listRule).toContain("padding-left: 24px;");
    expect(listItemRule).toContain("margin: 5px 0;");
    expect(listItemRule).toContain("line-height: 1.6;");
    expect(singleItemHeadingRule).toContain("font-size: 14px;");
    expect(singleItemHeadingRule).toContain("font-weight: 520;");
    expect(headingRule).toContain("font-weight: 450;");
    expect(headingRule).toContain("letter-spacing: 0;");
    expect(h1Rule).toContain("font-size: var(--text-lg);");
    expect(h2Rule).toContain("font-size: var(--text-md);");
    expect(chatConversation).toContain(".markdown h4 {\n  font-size: var(--text-sm);\n  color: var(--muted-strong);\n  text-transform: none;");
  });

  it("keeps turn metadata as a quiet reading separator", () => {
    const chatTurns = readSource("src/renderer/styles/chat-turns.css");
    const headerRule = cssRuleBody(chatTurns, ".turn-block-header");
    const headerLineRule = cssRuleBody(chatTurns, ".turn-block-header::after");
    const chipRule = cssRuleBody(chatTurns, ".turn-block-chip");
    const thoughtHeaderRule = cssRuleBody(chatTurns, ".thought-block-header");
    const thoughtChevronRule = cssRuleBody(chatTurns, ".thought-block-chevron");

    expect(headerRule).toContain("min-height: 20px;");
    expect(headerLineRule).toContain("background: color-mix(in oklab, var(--line-soft) 72%, transparent);");
    expect(chipRule).toContain("font-family: var(--font-prose);");
    expect(chipRule).toContain("color: var(--muted);");
    expect(chipRule).toContain("background: transparent;");
    expect(thoughtHeaderRule).toContain("display: inline-flex;");
    expect(thoughtHeaderRule).toContain("width: max-content;");
    expect(thoughtChevronRule).toContain("opacity: 0.62;");
    expect(chatTurns).not.toContain(".thought-block-toggle");
  });

  it("keeps markdown tables and scroll affordances quiet", () => {
    const chatConversation = readSource("src/renderer/styles/chat-conversation.css");
    const tableRule = cssRuleBody(chatConversation, ".markdown table");
    const tableHeaderRule = cssRuleBody(chatConversation, ".markdown th");
    const fabRule = cssRuleBody(chatConversation, ".scroll-to-bottom-fab");

    expect(tableRule).toContain("box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--line-soft) 68%, transparent);");
    expect(tableHeaderRule).toContain("font-weight: 520;");
    expect(tableHeaderRule).toContain("background: color-mix(in oklab, var(--panel-soft) 72%, transparent);");
    expect(fabRule).toContain("border: 1px solid color-mix(in oklab, var(--line) 88%, transparent);");
    expect(fabRule).toContain("background: color-mix(in oklab, var(--panel) 88%, transparent);");
    expect(fabRule).toContain("color: var(--muted-strong);");
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
    const baseChipRule = cssRuleBody(chatComposer, ".composer-footer-chip");
    const baseChipHoverRule = cssRuleBody(chatComposer, ".composer-footer-chip:hover");
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
    expect(baseChipRule).toContain("font-family: var(--font-prose);");
    expect(baseChipRule).toContain("color: var(--muted);");
    expect(baseChipHoverRule).toContain("background: transparent;");
    expect(baseChipHoverRule).toContain("color: var(--muted-strong);");
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
    const sessionPane = readSource("src/renderer/components/SessionPane.tsx");
    const layoutConstants = readSource("src/renderer/lib/layoutConstants.ts");
    const chatConversation = readSource("src/renderer/styles/chat-conversation.css");
    const chatComposerChips = readSource("src/renderer/styles/chat-composer-chips.css");
    const appSource = readSource("src/renderer/App.tsx");
    const sidebarResize = readSource("src/renderer/hooks/useSidebarResize.ts");
    const cellWidthMatch = /export const SESSION_CELL_MIN_WIDTH_PX = (?<width>\d+);/.exec(
      layoutConstants
    );
    const chatWidthMatch = /export const CHAT_PANE_MIN_WIDTH_PX = (?<width>\d+);/.exec(
      layoutConstants
    );
    expect(cellWidthMatch?.groups?.width).toBeDefined();
    expect(chatWidthMatch?.groups?.width).toBeDefined();
    const cellMinWidth = cellWidthMatch?.groups?.width ?? "";
    const chatMinWidth = chatWidthMatch?.groups?.width ?? "";
    const multigridRule = cssRuleBody(chatConversation, ".session-multigrid");
    const rowRule = cssRuleBody(chatConversation, ".session-multigrid-row");
    const cellRule = cssRuleBody(chatConversation, ".session-multigrid-cell");
    const sessionGridRule = cssRuleBody(chatConversation, ".session-grid");

    expect(gridComponent).toContain("MIN_RESIZABLE_CELL_WIDTH_PX = SESSION_CELL_MIN_WIDTH_PX");
    expect(sessionPane).toContain("--session-main-column-min-width");
    expect(sessionPane).toContain("onRightPanelWidthChange");
    expect(gridComponent).toContain("onWorkspaceMinWidthChange");
    expect(gridComponent).toContain("CHAT_PANE_MIN_WIDTH_PX + rightPanelWidth");
    expect(gridComponent).toContain("--session-pane-min-width");
    expect(multigridRule).toContain("overflow: hidden;");
    expect(rowRule).toContain("min-width: 0;");
    expect(rowRule).toContain("overflow: hidden;");
    expect(cellRule).toContain("container-type: inline-size;");
    expect(sessionGridRule).toContain("min-width: 0;");
    expect(Number(cellMinWidth)).toBeLessThan(520);
    expect(Number(chatMinWidth)).toBe(520);
    expect(chatComposerChips).toContain("@container (max-width: 520px)");
    expect(appSource).toContain("sessionGridRequiredWorkspaceMinWidth");
    expect(appSource).toContain("Math.max(DEFAULT_WORKSPACE_MIN_WIDTH_PX, gridColumnWidth, sessionGridRequiredWorkspaceMinWidth)");
    expect(appSource).toContain("appWindow.setMinSize");
    expect(sidebarResize).toContain("workspaceMinWidth");
  });
});
