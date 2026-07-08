import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function readCssSources(): Array<{ path: string; source: string }> {
  const stylesDir = resolve(process.cwd(), "src/renderer/styles");
  const moduleFiles = readdirSync(stylesDir)
    .filter((file) => file.endsWith(".css"))
    .map((file) => `src/renderer/styles/${file}`);
  return ["src/renderer/styles.css", ...moduleFiles].map((path) => ({
    path,
    source: readSource(path)
  }));
}

function cssRuleBody(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)\\s*${escapedSelector}\\s*\\{(?<body>[^}]+)\\}`, "i").exec(source);
  expect(match?.groups?.body).toBeDefined();
  return match?.groups?.body ?? "";
}

describe("accent CSS contract", () => {
  it("keeps text sizes and font families behind typography tokens", () => {
    const rawFontSizes: string[] = [];
    const hardcodedFamilies: string[] = [];

    for (const { path, source } of readCssSources()) {
      for (const match of source.matchAll(/font-size:\s*\d+(?:\.\d+)?px\b/g)) {
        rawFontSizes.push(`${path}: ${match[0]}`);
      }

      for (const match of source.matchAll(/font-family:\s*(?<family>[^;]+);/g)) {
        const family = (match.groups?.family ?? "").trim();
        const before = source.slice(0, match.index ?? 0);
        const isFontFace = before.lastIndexOf("@font-face") > before.lastIndexOf("}");
        if (!isFontFace && !family.startsWith("var(") && family !== "inherit") {
          hardcodedFamilies.push(`${path}: font-family: ${family};`);
        }
      }
    }

    expect(rawFontSizes).toEqual([]);
    expect(hardcodedFamilies).toEqual([]);
  });

  it("keeps light-theme scrollbars soft while dark theme keeps contrast", () => {
    const tokens = readSource("src/renderer/styles/tokens.css");
    const rootRule = cssRuleBody(tokens, ":root");
    const darkRule = cssRuleBody(tokens, ':root[data-theme="dark"]');
    const scrollbarThumbRule = cssRuleBody(tokens, "::-webkit-scrollbar-thumb");
    const scrollbarHoverRule = cssRuleBody(tokens, "::-webkit-scrollbar-thumb:hover");

    expect(rootRule).toContain("--scrollbar-thumb: #dce1e4;");
    expect(rootRule).toContain("--scrollbar-thumb-hover: #cfd5d8;");
    expect(darkRule).toContain("--scrollbar-thumb: var(--line-strong);");
    expect(darkRule).toContain("--scrollbar-thumb-hover: var(--muted);");
    expect(scrollbarThumbRule).toContain("background: var(--scrollbar-thumb);");
    expect(scrollbarHoverRule).toContain("background: var(--scrollbar-thumb-hover);");
  });

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
    const treeLabelRule = cssRuleBody(reviewFiles, ".workspace-tree-label");
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
    expect(reviewFiles).not.toContain(".workspace-tree-row span");
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

  it("keeps purple as an accent, not a theme", () => {
    const tokens = readSource("src/renderer/styles/tokens.css");
    const theme = readSource("src/renderer/lib/theme.ts");

    expect(tokens).toContain(':root[data-accent="purple"]');
    expect(tokens).toContain(':root[data-theme="dark"][data-accent="blue"]');
    expect(tokens).not.toContain('data-theme="purple"');
    expect(theme).not.toContain('"purple"');
  });

  it("uses themed user bubble surfaces and launch composer focus", () => {
    const tokens = readSource("src/renderer/styles/tokens.css");
    const chatConversation = readSource("src/renderer/styles/chat-conversation.css");
    const chatChrome = readSource("src/renderer/styles/chat-chrome.css");
    const chatTools = readSource("src/renderer/styles/chat-tools.css");
    const bubbleRule = cssRuleBody(chatConversation, ".chat-bubble");
    const userBubbleRule = cssRuleBody(chatConversation, ".chat-bubble.user");
    const userBubbleBodyRule = cssRuleBody(chatConversation, ".chat-bubble.user .chat-bubble-body");
    const composerFocusRule = cssRuleBody(chatChrome, ".launcher-surface .composer:focus-within");
    const launchSendButtonRule = cssRuleBody(chatChrome, ".send-button");
    const sessionInputFocusRule = cssRuleBody(chatTools, ".session-input:focus-within");

    expect(tokens).toContain("--user-message-bg: color-mix(in oklab, var(--panel-sunken) 72%, var(--panel) 28%);");
    expect(tokens).toContain("--user-message-selection-bg:");
    expect(tokens).not.toContain("--user-message-border:");
    expect(tokens).toContain(':root[data-theme="dark"]');
    expect(bubbleRule).toContain("box-sizing: border-box;");
    expect(bubbleRule).toContain("min-width: 0;");
    expect(userBubbleRule).toContain("background: var(--user-message-bg);");
    expect(userBubbleRule).toContain("box-shadow: var(--user-message-shadow);");
    expect(userBubbleRule).not.toContain("border:");
    expect(userBubbleBodyRule).toContain("padding-right: 4px;");
    expect(userBubbleBodyRule).toContain("margin-right: -4px;");
    expect(composerFocusRule).toContain("border-color: color-mix(in oklab, var(--accent) 34%, var(--line-strong));");
    expect(composerFocusRule).toContain("0 0 0 2px color-mix(in oklab, var(--accent) 8%, transparent)");
    expect(launchSendButtonRule).toContain("width: 28px;");
    expect(launchSendButtonRule).toContain("height: 28px;");
    expect(launchSendButtonRule).toContain("border-radius: 999px;");
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

  it("keeps the cost table bucket header aligned with bucket labels", () => {
    const shellSessions = readSource("src/renderer/styles/shell-sessions.css");
    const cellsRule = cssRuleBody(shellSessions, ".cost-panel-table th,\n.cost-panel-table td");
    const rowHeaderRule = cssRuleBody(shellSessions, '.cost-panel-table th[scope="row"]');
    const bucketHeaderRule = cssRuleBody(shellSessions, ".cost-panel-table thead th:first-child");

    expect(cellsRule).toContain("text-align: right;");
    expect(rowHeaderRule).toContain("text-align: left;");
    expect(bucketHeaderRule).toContain("text-align: left;");
  });

  it("keeps chat content width modes wired to session padding", () => {
    const chatConversation = readSource("src/renderer/styles/chat-conversation.css");
    const shellSessions = readSource("src/renderer/styles/shell-sessions.css");
    const appSource = readSource("src/renderer/App.tsx");
    const narrowRule = cssRuleBody(chatConversation, '.app-shell[data-chat-width="narrow"]');
    const standardRule = cssRuleBody(chatConversation, ".app-shell,\n.app-shell[data-chat-width=\"standard\"]");
    const wideRule = cssRuleBody(chatConversation, '.app-shell[data-chat-width="wide"]');
    const mainColumnRule = cssRuleBody(chatConversation, ".session-main-column");
    const launcherShellRule = cssRuleBody(shellSessions, ".launcher-shell");
    const launcherSurfaceRule = cssRuleBody(chatConversation, ".session-multigrid-cell .launcher-surface");
    const dockedRule = cssRuleBody(
      chatConversation,
      ".session-grid.review-open .session-main-column,\n.session-grid.log-open .session-main-column"
    );
    const tightRule = cssRuleBody(chatConversation, ".session-grid.review-open.log-open .session-main-column");

    expect(appSource).toContain('data-chat-width={chatWidth}');
    expect(narrowRule).toContain("--chat-content-width: 640px;");
    expect(narrowRule).toContain("--chat-content-width-docked: 600px;");
    expect(narrowRule).toContain("--chat-content-width-tight: 560px;");
    expect(standardRule).toContain("--chat-content-width: 780px;");
    expect(standardRule).toContain("--chat-content-width-docked: 740px;");
    expect(standardRule).toContain("--chat-content-width-tight: 680px;");
    expect(wideRule).toContain("--chat-content-width: 940px;");
    expect(wideRule).toContain("--chat-content-width-docked: 900px;");
    expect(wideRule).toContain("--chat-content-width-tight: 840px;");
    expect(mainColumnRule).toContain("clamp(28px, calc((100% - var(--chat-content-width)) / 2), 2000px)");
    expect(launcherShellRule).toContain("width: min(100%, var(--chat-content-width));");
    expect(launcherSurfaceRule).toContain("width: min(100%, var(--chat-content-width));");
    expect(dockedRule).toContain("clamp(22px, calc((100% - var(--chat-content-width-docked)) / 2), 2000px)");
    expect(tightRule).toContain("clamp(20px, calc((100% - var(--chat-content-width-tight)) / 2), 2000px)");
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

  it("keeps speed submenu opening upward in launcher model picker", () => {
    const chatChrome = readSource("src/renderer/styles/chat-chrome.css");
    const speedRule = cssRuleBody(chatChrome, ".composer-context .model-speed-popover");

    expect(speedRule).toContain("align-self: flex-end;");
    expect(speedRule).toContain("margin-top: 0;");
    expect(speedRule).toContain("margin-bottom: 0;");
  });

  it("keeps project and model picker menus dense", () => {
    const chatChrome = readSource("src/renderer/styles/chat-chrome.css");
    const popoverRule = cssRuleBody(chatChrome, ".project-picker-popover");
    const projectItemRule = cssRuleBody(chatChrome, ".project-picker-item");
    const modelPopoverRule = cssRuleBody(chatChrome, ".model-picker-popover");
    const modelItemRule = cssRuleBody(chatChrome, ".model-picker-popover .project-picker-item");
    const modelSubmenuTriggerRule = cssRuleBody(chatChrome, ".model-picker-item.model-picker-submenu-trigger");
    const groupLabelRule = cssRuleBody(chatChrome, ".project-picker-group-label");

    expect(popoverRule).toContain("padding: 5px;");
    expect(projectItemRule).toContain("padding: 5px 9px;");
    expect(projectItemRule).toContain("font-size: var(--text-sm);");
    expect(projectItemRule).toContain("line-height: 1.35;");
    expect(modelPopoverRule).toContain("min-width: 220px;");
    expect(modelItemRule).toContain("gap: 8px;");
    expect(modelSubmenuTriggerRule).toContain("column-gap: 8px;");
    expect(groupLabelRule).toContain("font-size: var(--text-2xs);");
    expect(groupLabelRule).toContain("line-height: 1.2;");
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
    expect(tokens).toContain(':root[data-font-size="small"]');
    expect(tokens).toContain(':root[data-font-size="large"]');
    expect(tokens).toContain("--text-terminal: 13px;");
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
    expect(mainColumnRule).toContain("--session-inline-padding: clamp(28px, calc((100% - var(--chat-content-width)) / 2), 2000px);");
    expect(dockedColumnRule).toContain("--session-inline-padding: clamp(22px, calc((100% - var(--chat-content-width-docked)) / 2), 2000px);");
    expect(fullyDockedColumnRule).toContain("--session-inline-padding: clamp(20px, calc((100% - var(--chat-content-width-tight)) / 2), 2000px);");
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
    expect(singleItemHeadingRule).toContain("font-size: var(--text-base-plus);");
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
    const toolbarSpacerRule = cssRuleBody(chatComposerChips, ".session-toolbar-spacer");
    const compactContextRule = cssRuleBody(chatComposerChips, ".composer-compact-context");
    const compactContextTriggerRule = cssRuleBody(chatComposerChips, ".composer-compact-context-trigger");
    const compactContextPopoverRule = cssRuleBody(chatComposerChips, ".composer-compact-context-popover");
    const compactContextRowRule = cssRuleBody(chatComposerChips, ".composer-compact-context-row--context");
    const compactContextRingRule = cssRuleBody(
      chatComposerChips,
      ".composer-compact-context-row--context .context-ring-anchor"
    );
    const footerRule = cssRuleBody(chatComposer, ".session-input-toolbar .composer-footer");
    const chipRule = cssRuleBody(chatComposer, ".session-input-toolbar .composer-footer-chip");
    const baseChipRule = cssRuleBody(chatComposer, ".composer-footer-chip");
    const baseChipHoverRule = cssRuleBody(chatComposer, ".composer-footer-chip:hover");
    const branchRule = cssRuleBody(
      chatComposer,
      ".session-input-toolbar .composer-footer-chip--branch"
    );
    const sessionSendButtonRule = cssRuleBody(chatComposerChips, ".session-send-button");
    const labelRule = cssRuleBody(
      chatComposer,
      ".session-input-toolbar .composer-footer-chip-label"
    );

    // The toolbar stays a single row (nowrap): the spacer collapses and the
    // model label ellipsizes under pressure, so the send button never wraps to
    // its own line. Below the compact breakpoint the grid layout takes over.
    expect(toolbarRule).toContain("flex-wrap: nowrap;");
    expect(modelLabelRule).toContain("text-overflow: ellipsis;");
    expect(modelLabelRule).toContain("white-space: nowrap;");
    expect(contextRule).toContain("min-width: 0;");
    expect(contextRule).toContain("overflow: hidden;");
    expect(contextRule).toContain("flex: 0 1 auto;");
    expect(compactContextRule).toContain("display: none;");
    expect(compactContextRule).toContain("position: relative;");
    expect(compactContextTriggerRule).toContain("width: 28px;");
    expect(compactContextTriggerRule).toContain("color: var(--muted);");
    expect(compactContextPopoverRule).toContain("bottom: calc(100% + 8px);");
    expect(compactContextPopoverRule).toContain("box-shadow: var(--shadow-2);");
    expect(compactContextRowRule).toContain("justify-content: space-between;");
    expect(compactContextRingRule).toContain("padding: 0;");
    expect(toolbarSpacerRule).toContain("flex: 1 1 0;");
    expect(toolbarSpacerRule).toContain("min-width: 0;");
    expect(footerRule).toContain("max-width: 100%;");
    expect(footerRule).toContain("overflow: hidden;");
    expect(footerRule).toContain("flex: 0 1 auto;");
    expect(footerRule).toContain("flex-wrap: nowrap;");
    expect(chipRule).toContain("overflow: hidden;");
    expect(baseChipRule).toContain("font-family: var(--font-prose);");
    expect(baseChipRule).toContain("color: var(--muted);");
    expect(baseChipHoverRule).toContain("background: transparent;");
    expect(baseChipHoverRule).toContain("color: var(--muted-strong);");
    expect(branchRule).toContain("flex: 1 1 0;");
    expect(branchRule).toContain("min-width: 0;");
    expect(branchRule).toContain("max-width: 100%;");
    expect(labelRule).toContain("text-overflow: ellipsis;");
    expect(labelRule).toContain("white-space: nowrap;");
    expect(chatComposerChips).toContain("@container (max-width: 720px)");
    expect(chatComposerChips).toContain('"attach model details mode send"');
    expect(chatComposerChips).toContain(".session-input-toolbar .composer-compact-context");
    expect(chatComposerChips).toContain(".session-input-toolbar > .context-ring-anchor");
    expect(chatComposerChips).toContain(".session-input textarea");
    expect(chatComposerChips).toContain("min-height: 56px;");
    expect(chatComposerChips).toContain(".session-input-toolbar .session-send-button");
    expect(sessionSendButtonRule).toContain("width: 28px;");
    expect(sessionSendButtonRule).toContain("height: 28px;");
    expect(sessionSendButtonRule).toContain("border-radius: 999px;");
  });

  it("keeps the composer changed-file summary compact-safe in narrow panes", () => {
    const chatComposer = readSource("src/renderer/styles/chat-composer.css");
    const chatComposerChips = readSource("src/renderer/styles/chat-composer-chips.css");
    const changeButtonRule = cssRuleBody(
      chatComposer,
      ".session-input-toolbar .composer-footer-chip--changes"
    );
    const changeCountRule = cssRuleBody(
      chatComposer,
      ".session-input-toolbar .composer-footer-chip--changes .change-count"
    );
    const changeSeparatorRule = cssRuleBody(
      chatComposer,
      ".session-input-toolbar .composer-footer-chip--changes::before"
    );

    expect(changeButtonRule).toContain("position: relative;");
    expect(changeButtonRule).toContain("flex: 0 0 auto;");
    expect(changeButtonRule).toContain("margin-left: 10px;");
    expect(changeButtonRule).toContain("max-width: none;");
    expect(changeButtonRule).toContain("overflow: visible;");
    expect(changeButtonRule).toContain("font-family: var(--font-mono);");
    expect(changeButtonRule).toContain("font-variant-numeric: tabular-nums;");
    expect(changeSeparatorRule).toContain("width: 1px;");
    expect(changeSeparatorRule).toContain("background: var(--line);");
    expect(changeSeparatorRule).toContain("opacity: 0.6;");
    expect(changeCountRule).toContain("gap: 5px;");
    expect(chatComposerChips).toContain("@container (max-width: 720px)");
    expect(chatComposerChips).toContain(".composer-compact-context-row--changes");
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
    expect(Number(cellMinWidth)).toBeLessThan(720);
    expect(Number(chatMinWidth)).toBe(520);
    expect(chatComposerChips).toContain("@container (max-width: 720px)");
    expect(appSource).toContain("sessionGridRequiredWorkspaceMinWidth");
    expect(appSource).toContain("Math.max(DEFAULT_WORKSPACE_MIN_WIDTH_PX, gridColumnWidth, sessionGridRequiredWorkspaceMinWidth)");
    expect(appSource).toContain("appWindow.setMinSize");
    expect(sidebarResize).toContain("workspaceMinWidth");
  });
});
