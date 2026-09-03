// @vitest-environment jsdom
import { FolderIcon } from "@react-symbols/icons/utils";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fontSizeBasePx } from "../lib/fonts.js";

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
  it("draws multitasks on a card cut from the composer's surface, sat just above it", () => {
    const chatTools = readSource("src/renderer/styles/chat-tools.css");
    const laneRule = cssRuleBody(chatTools, ".multitask-composer-lane");
    const attachedComposerRule = cssRuleBody(
      chatTools,
      ".multitask-composer-lane + .session-composer-stack"
    );

    expect(laneRule).toContain("max-height: min(180px, 30vh);");
    expect(laneRule).toContain("margin: 16px var(--session-inline-padding) 0;");
    expect(laneRule).toContain("padding: 6px 15px;");
    expect(laneRule).toContain("border-radius: var(--radius-xl);");
    expect(laneRule).toContain("background: var(--composer-surface);");
    expect(attachedComposerRule).toContain("margin-top: var(--space-2);");
  });

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

  it("routes text weight through tokens and runs dark under regular", () => {
    const tokens = readSource("src/renderer/styles/tokens.css");
    const rootRule = cssRuleBody(tokens, ":root");
    const darkRule = cssRuleBody(tokens, ':root[data-theme="dark"]');
    const bodyRule = cssRuleBody(tokens, "body");

    expect(rootRule).toContain("--weight-ui: 400;");
    expect(rootRule).toContain("--weight-prose: 400;");
    expect(rootRule).toContain("font-weight: var(--weight-ui);");
    // Inter Variable's wght axis lets dark shave a few units off regular so
    // light-on-dark strokes stop reading as semi-bold.
    expect(darkRule).toContain("--weight-ui: 380;");
    expect(darkRule).toContain("--weight-prose: 390;");
    expect(bodyRule).toContain("-webkit-font-smoothing: antialiased;");
    expect(bodyRule).toContain("-moz-osx-font-smoothing: grayscale;");
  });

  it("keeps dark ink off paper-white while light ink stays readable", () => {
    const tokens = readSource("src/renderer/styles/tokens.css");
    const rootRule = cssRuleBody(tokens, ":root");
    const darkRule = cssRuleBody(tokens, ':root[data-theme="dark"]');

    const readHex = (rule: string, token: string): string => {
      const match = new RegExp(`--${token}:\\s*(?<hex>#[0-9a-f]{6});`, "i").exec(rule);
      expect(match?.groups?.hex).toBeDefined();
      return match?.groups?.hex ?? "";
    };
    const relativeLuminance = (hex: string): number => {
      const channels = [1, 3, 5].map((offset) => {
        const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const contrast = (a: string, b: string): number => {
      const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
      return (lighter + 0.05) / (darker + 0.05);
    };

    const darkText = readHex(darkRule, "text");
    const darkTextSoft = readHex(darkRule, "text-soft");
    expect(darkText).not.toBe("#f4f2ec");
    // Chrome labels sit on --text-soft, so it has to stay quieter than --text
    // while both clear body-copy contrast against the dark background.
    expect(relativeLuminance(darkTextSoft)).toBeLessThan(relativeLuminance(darkText));
    // Rendered prose is the one thing in dark that runs brighter than chrome
    // ink: the bloom that keeps labels off paper-white is a weight problem at
    // label size, and prose pays for the luminance with --weight-prose and an
    // open line box. Emphasis then has to clear the body it emphasizes, or
    // bold reads dimmer than the sentence around it.
    const darkProseInk = readHex(darkRule, "prose-ink");
    expect(relativeLuminance(darkProseInk)).toBeGreaterThan(relativeLuminance(darkText));
    expect(relativeLuminance(readHex(darkRule, "prose-ink-strong"))).toBeGreaterThan(
      relativeLuminance(darkProseInk)
    );
    expect(contrast(darkText, readHex(darkRule, "bg"))).toBeGreaterThan(10);
    expect(contrast(darkTextSoft, readHex(darkRule, "bg"))).toBeGreaterThan(7);
    expect(contrast(readHex(rootRule, "text"), readHex(rootRule, "bg"))).toBeGreaterThan(10);
    expect(contrast(readHex(rootRule, "text-soft"), readHex(rootRule, "bg"))).toBeGreaterThan(7);
  });

  it("keeps chat prose on the prose weight with emphasis only a step above", () => {
    const chatConversation = readSource("src/renderer/styles/chat-conversation.css");
    const markdownRule = cssRuleBody(chatConversation, ".markdown");
    const bubbleParagraphRule = cssRuleBody(chatConversation, ".chat-bubble p");
    const strongRule = cssRuleBody(chatConversation, ".markdown strong");
    const codeRule = cssRuleBody(chatConversation, ".markdown code");

    expect(markdownRule).toContain("font-weight: var(--weight-prose);");
    expect(bubbleParagraphRule).toContain("font-weight: var(--weight-prose);");
    // Emphasis reads bolder than body without landing on 600+.
    const strongWeight = Number(/font-weight:\s*(?<weight>\d+);/.exec(strongRule)?.groups?.weight);
    expect(strongWeight).toBeGreaterThanOrEqual(500);
    expect(strongWeight).toBeLessThanOrEqual(600);
    // Mono has no wght axis to shave, so code pins regular instead of inheriting.
    expect(codeRule).toContain("font-weight: 400;");
  });

  it("keeps palette, sidebar, and settings list labels off semi-bold", () => {
    const chromeFiles = [
      "src/renderer/styles/overlays-inkwell.css",
      "src/renderer/styles/shell-layout.css",
      "src/renderer/styles/shell-sessions.css",
      "src/renderer/styles/settings-layout.css",
      "src/renderer/styles/settings-diagnostics.css"
    ];
    const heavyLabels: string[] = [];

    for (const path of chromeFiles) {
      const source = readSource(path);
      for (const match of source.matchAll(/font-weight:\s*(?<weight>\d+)/g)) {
        const weight = Number(match.groups?.weight);
        const declaration = source.slice(0, match.index ?? 0);
        const selector = declaration.slice(declaration.lastIndexOf("\n\n") + 2).split("{")[0]?.trim();
        // `strong` is real emphasis inside prose; everything else in chrome caps
        // at 500 so no list label renders semi-bold.
        if (weight > 500 && !selector?.endsWith("strong")) {
          heavyLabels.push(`${path}: ${selector} → ${weight}`);
        }
      }
    }

    expect(heavyLabels).toEqual([]);
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
    const labelRule = cssRuleBody(chatTurns, ".tool-call-group-eyebrow-label");
    const previewRule = cssRuleBody(chatTurns, ".tool-call-group-preview");
    const detailRule = cssRuleBody(chatTurns, ".tool-call-group-eyebrow-detail");
    const verbRule = cssRuleBody(chatTurns, ".tool-call-row-verb");
    const rowTargetRule = cssRuleBody(chatTurns, ".tool-call-row-target");
    const bashTargetRule = cssRuleBody(
      chatTurns,
      '.tool-call-row[data-tool-type="bash"] .tool-call-row-target'
    );

    expect(labelRule).toContain("font-weight: 400;");
    expect(labelRule).toContain("letter-spacing: 0;");
    expect(labelRule).toContain("text-transform: none;");
    expect(labelRule).not.toContain("var(--accent-deep)");
    expect(previewRule).toContain("font-family: var(--font-code);");
    expect(previewRule).toContain("color: var(--muted);");
    // One grammar for rows and headlines: the leading verb sits a token above
    // what it acted on, and both stay below `--text` so the transcript reads
    // quieter than the assistant prose beside it. The step is a token step, not
    // an opacity fade — fading `--muted` put the file name at 2.4:1 in light.
    expect(labelRule).toContain("color: var(--muted-strong);");
    expect(verbRule).toContain("color: var(--muted-strong);");
    expect(detailRule).toContain("color: var(--muted);");
    expect(detailRule).not.toContain("opacity:");
    expect(rowTargetRule).toContain("color: var(--muted);");
    expect(rowTargetRule).not.toContain("opacity:");
    expect(rowTargetRule).not.toContain("color: var(--text);");
    // File names read in the UI face; monospace is reserved for the diff body
    // and for shell commands, which really are code.
    expect(rowTargetRule).toContain("font-family: inherit;");
    expect(bashTargetRule).toContain("font-family: var(--font-code);");
  });

  it("keeps expanded tool details quiet and preview-like", () => {
    const chatTurns = readSource("src/renderer/styles/chat-turns.css");
    const chatTools = readSource("src/renderer/styles/chat-tools.css");
    const detailRule = cssRuleBody(chatTurns, ".tool-call-detail");
    const rowDetailRule = cssRuleBody(chatTools, ".tool-call-row > .tool-call-detail");
    const blockRule = cssRuleBody(chatTurns, ".tool-call-block");
    const blockBodyRule = cssRuleBody(chatTurns, ".tool-call-block-body");
    const ruleRule = cssRuleBody(chatTurns, ".tool-call-block-rule");
    const footRule = cssRuleBody(chatTurns, ".tool-call-block-foot");
    const argsRule = cssRuleBody(chatTurns, ".tool-call-args");
    const labelRule = cssRuleBody(chatTurns, ".tool-call-part-label");
    const codeRule = cssRuleBody(chatTurns, ".tool-call-code");
    const errorRule = cssRuleBody(chatTurns, ".tool-call-code--error");
    const logBlockRule = cssRuleBody(chatTurns, ".log-block");
    const logErrorRule = cssRuleBody(chatTurns, ".log-record[data-level=\"error\"] .log-record-message");
    const bashTargetRule = cssRuleBody(
      chatTurns,
      ".tool-call-row[data-tool-type=\"bash\"] .tool-call-row-target"
    );
    const runningItemRule = cssRuleBody(
      chatTurns,
      ".tool-call-item[data-status=\"running\"]:not(.tool-call-item--nested)"
    );
    const errorItemRule = cssRuleBody(
      chatTurns,
      ".tool-call-item[data-status=\"error\"]:not(.tool-call-item--nested)"
    );

    expect(detailRule).toContain("gap: var(--space-2_5);");
    // Flush with the row's own left edge and with no rail of its own.
    expect(rowDetailRule).toContain("margin: 2px 0 8px;");
    expect(rowDetailRule).not.toContain("border-left");
    expect(chatTools).not.toContain(".tool-call-row[data-status=\"error\"] > .tool-call-detail");
    expect(runningItemRule).not.toContain("box-shadow");
    expect(errorItemRule).not.toContain("box-shadow");

    // One soft fill per tool call: no border, no rail, one radius, hugging its
    // own content instead of stretching the column.
    expect(blockRule).toContain("width: fit-content;");
    // Paper sinks, charcoal lifts: the fill is a token, because a single
    // --code-surface mix put the dark block *below* the transcript ground.
    expect(blockRule).toContain("background: var(--tool-block-surface);");
    expect(blockRule).toContain("border-radius: var(--radius-md);");
    expect(blockRule).not.toContain("border:");
    expect(blockRule).not.toContain("border-left");

    // One scroller, and it is the block's body — never a max-height per payload.
    expect(blockBodyRule).toContain("max-height: calc(16 * 1.65em);");
    expect(blockBodyRule).toContain("overflow: auto;");
    expect(codeRule).not.toContain("max-height");
    expect(codeRule).toContain("border: 0;");
    expect(codeRule).toContain("background: transparent;");
    expect(codeRule).toContain("line-height: 1.7;");
    // The payload reads a notch under the assistant prose beside it.
    expect(codeRule).toContain("color: color-mix(in oklab, var(--text) 72%, var(--muted-strong) 28%);");

    // Parts are separated inside the fill by a hairline, not by a box each.
    expect(ruleRule).toContain("background: color-mix(in oklab, var(--line) 74%, transparent);");
    expect(ruleRule).toContain("height: 1px;");

    // Arguments read as a key/value list; the footer is the one meta row.
    expect(argsRule).toContain("font-feature-settings: var(--code-font-features);");
    expect(argsRule).toContain("grid-template-columns: max-content minmax(0, 1fr);");
    expect(footRule).toContain("font-size: var(--text-xs);");
    expect(footRule).toContain("color: var(--muted);");

    // Error and Preview are the only labelled parts, and a failure is rose text
    // rather than a rose box.
    expect(labelRule).toContain("font-weight: 450;");
    expect(labelRule).toContain("color: color-mix(in oklab, var(--muted) 88%, var(--text-soft) 12%);");
    expect(errorRule).toContain("color: color-mix(in oklab, var(--rose) 72%, var(--text));");
    expect(errorRule).not.toContain("background:");

    // Conversation log dumps share the tool-block fill. A failure is rose text
    // on that fill, not a rose box.
    expect(logBlockRule).toContain("background: var(--tool-block-surface);");
    expect(logErrorRule).toContain("color: color-mix(in oklab, var(--rose) 72%, var(--text));");
    expect(logBlockRule).not.toContain("border:");

    // A bash row shows text the app did not author, so ligatures stay off or a
    // run of `=` fuses into one bar and the command reads as struck through.
    expect(bashTargetRule).toContain("font-feature-settings: var(--code-font-features);");
  });

  it("keeps inline markdown code and file refs quiet, colored, and unfilled", () => {
    const chatConversation = readSource("src/renderer/styles/chat-conversation.css");
    const chatComposer = readSource("src/renderer/styles/chat-composer.css");
    const markdownCodeRule = cssRuleBody(chatConversation, ".markdown code");
    const fileChipRule = cssRuleBody(chatComposer, ".file-chip");

    expect(markdownCodeRule).toContain("background: transparent;");
    expect(markdownCodeRule).toContain("font-family: var(--font-code);");
    expect(markdownCodeRule).toContain("border: 0;");
    expect(markdownCodeRule).toContain("color: var(--code-ink);");
    expect(chatComposer).toContain(".file-chip");
    expect(fileChipRule).toContain("background: transparent;");
    expect(fileChipRule).toContain("font-family: var(--font-code);");
    expect(fileChipRule).toContain("color: var(--code-ink);");
    expect(fileChipRule).toContain("text-decoration-line: none;");
    expect(readSource("src/renderer/components/FileChip.tsx")).not.toContain("Code2");
  });

  it("keeps file-change and diff greens on semantic tokens", () => {
    const chatTools = readSource("src/renderer/styles/chat-tools.css");
    const tokens = readSource("src/renderer/styles/tokens.css");
    expect(chatTools).toContain('file-change-card[data-kind="create"]');
    // The create signal is the sage file icon plus the shared add wash, not a
    // coloured rail: the transcript keeps exactly one border, the hairline
    // around the diff itself.
    expect(chatTools).toContain("color: var(--sage-deep);");
    expect(chatTools).not.toContain("border-left: 2px solid");
    expect(tokens).toContain("--diff-add-bg:");
    expect(tokens).toContain("--diff-add-gutter-fg:");
  });

  it("turns programming ligatures off on every surface that renders machine text", () => {
    const tokens = readSource("src/renderer/styles/tokens.css");
    // A run of `=` in a pytest banner ligates into one solid bar, which reads
    // as struck-through output. `font-variant-ligatures: none` is not enough:
    // the root enables `calt` through `font-feature-settings`, and that
    // property outranks font-variant in font feature resolution, so the reset
    // has to use the same property to reach calt-based fonts like Fira Code.
    expect(cssRuleBody(tokens, ":root")).toContain(
      '--code-font-features: "liga" 0, "clig" 0, "calt" 0;'
    );

    const surfaces: [string, string][] = [
      ["src/renderer/styles/chat-turns.css", ".tool-call-code"],
      ["src/renderer/styles/chat-turns.css", ".tool-call-command-line"],
      ["src/renderer/styles/chat-conversation.css", ".markdown code"],
      ["src/renderer/styles/chat-conversation.css", ".terminal-transcript pre"],
      ["src/renderer/styles/chat-conversation.css", ".mermaid-diagram-source"],
      ["src/renderer/styles/chat-composer.css", ".code-block pre"],
      ["src/renderer/styles/chat-tools.css", ".checks-row-log"],
      ["src/renderer/styles/overlays-review-files.css", ".diff-blocks"],
      ["src/renderer/styles/overlays-launcher-panels.css", ".debug-rows"]
    ];
    for (const [file, selector] of surfaces) {
      expect(
        cssRuleBody(readSource(file), selector),
        `${selector} in ${file} must disable ligatures`
      ).toContain("font-feature-settings: var(--code-font-features);");
    }
  });

  it("overlays the copy control on unlabeled fenced code instead of reserving a header strip", () => {
    const css = readSource("src/renderer/styles/chat-composer.css");
    expect(cssRuleBody(css, ".code-block:not([data-label]) .code-block-header")).toContain(
      "position: absolute"
    );
  });

  it("paints mermaid diagrams as a hugging well, not a labelled code block", () => {
    const rule = cssRuleBody(
      readSource("src/renderer/styles/chat-conversation.css"),
      ".mermaid-diagram"
    );
    expect(rule).toContain("background: var(--tool-block-surface);");
    expect(rule).toContain("width: fit-content;");
    expect(rule).toContain("max-width: 100%;");
    expect(rule).toContain("overflow: hidden;");
    expect(
      cssRuleBody(readSource("src/renderer/styles/chat-conversation.css"), ".mermaid-diagram-canvas svg")
    ).toContain("max-width: 100%;");
  });

  it("keeps review file names on UI type and file contents on compact code type", () => {
    const review = readSource("src/renderer/styles/overlays-review.css");
    const reviewFiles = readSource("src/renderer/styles/overlays-review-files.css");
    const treeRule = cssRuleBody(reviewFiles, ".workspace-tree");
    const treeLabelRule = cssRuleBody(reviewFiles, ".workspace-tree-label");
    const treeIconRule = cssRuleBody(reviewFiles, ".workspace-tree-icon");
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
    expect(treeIconRule).toContain("flex: 0 0 14px;");
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

  it("puts review folder glyphs on the accent without recoloring type marks", () => {
    const reviewFiles = readSource("src/renderer/styles/overlays-review-files.css");
    const fillRule = cssRuleBody(
      reviewFiles,
      '.workspace-tree-dir .workspace-tree-icon [fill="#64748b" i]'
    );
    const strokeRule = cssRuleBody(
      reviewFiles,
      '.workspace-tree-dir .workspace-tree-icon [stroke="#64748b" i]'
    );
    // The retint keys off the one slate @react-symbols paints folder bodies in,
    // so a library color change has to move the selectors with it. The badge
    // hue (orange on `src`) is what must survive the retint.
    const folderMarkup = renderToStaticMarkup(createElement(FolderIcon, { folderName: "src" }));

    expect(folderMarkup).toContain("#64748B");
    expect(folderMarkup).toContain("#EA580C");
    expect(fillRule).toContain("fill: var(--accent);");
    expect(strokeRule).toContain("stroke: var(--accent);");
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
    const composerRule = cssRuleBody(chatChrome, ".composer");
    const composerFocusRule = cssRuleBody(chatChrome, ".launcher-surface .composer:focus-within");
    const launchSendButtonRule = cssRuleBody(chatChrome, ".send-button");
    const sessionInputRule = cssRuleBody(chatTools, ".session-input");
    const sessionInputFocusRule = cssRuleBody(chatTools, ".session-input:focus-within");

    expect(tokens).toContain("--user-message-bg: var(--accent);");
    expect(tokens).toContain("--user-message-fg: var(--bubble-on-ink);");
    expect(tokens).toContain(
      "--user-message-selection-bg: color-mix(in oklab, var(--user-message-fg) 26%, transparent);"
    );
    const darkRule = cssRuleBody(tokens, ':root[data-theme="dark"]');
    const darkPurpleRule = cssRuleBody(tokens, ':root[data-theme="dark"][data-accent="purple"]');
    const darkOrangeRule = cssRuleBody(tokens, ':root[data-theme="dark"][data-accent="orange"]');
    const darkBlueRule = cssRuleBody(tokens, ':root[data-theme="dark"][data-accent="blue"]');
    const darkNeutralRule = cssRuleBody(tokens, ':root[data-theme="dark"][data-accent="neutral"]');
    expect(darkRule).toContain("--user-message-bg: #3a664c;");
    expect(darkRule).toContain("--user-message-fg: #ffffff;");
    expect(darkPurpleRule).toContain("--user-message-bg: var(--accent);");
    expect(darkPurpleRule).toContain("--user-message-fg: var(--on-accent);");
    expect(darkOrangeRule).toContain("--user-message-bg: #89442e;");
    expect(darkOrangeRule).toContain("--user-message-fg: #ffffff;");
    expect(darkBlueRule).toContain("--user-message-bg: #3d5d83;");
    expect(darkBlueRule).toContain("--user-message-fg: #ffffff;");
    expect(darkNeutralRule).toContain("--user-message-bg: #4f4d47;");
    expect(darkNeutralRule).toContain("--user-message-fg: #ffffff;");
    const neutralRule = cssRuleBody(tokens, ':root[data-user-bubble="neutral"]');
    const darkNeutralBubbleRule = cssRuleBody(
      tokens,
      ':root[data-theme="dark"][data-user-bubble="neutral"]'
    );
    expect(neutralRule).toContain("--user-message-bg: var(--panel-sunken);");
    expect(neutralRule).toContain("--user-message-fg: var(--text);");
    expect(darkNeutralBubbleRule).toContain("--user-message-bg: var(--panel-soft);");
    expect(darkNeutralBubbleRule).toContain("--user-message-fg: #f4f2ec;");
    // Same specificity as the dark per-accent blocks, so only source order
    // keeps the opt-out from losing to whichever accent is selected.
    for (const accent of ["purple", "neutral", "orange", "blue", "coral"]) {
      expect(tokens.indexOf(':root[data-theme="dark"][data-user-bubble="neutral"]')).toBeGreaterThan(
        tokens.indexOf(`:root[data-theme="dark"][data-accent="${accent}"]`)
      );
    }
    expect(tokens).not.toContain("--user-message-border:");
    expect(tokens).toContain(':root[data-theme="dark"]');
    expect(bubbleRule).toContain("box-sizing: border-box;");
    expect(bubbleRule).toContain("min-width: 0;");
    expect(userBubbleRule).toContain("background: var(--user-message-bg);");
    expect(userBubbleRule).toContain("box-shadow: var(--user-message-shadow);");
    expect(userBubbleRule).toContain("border-radius: var(--radius-2xl);");
    const planCardRule = cssRuleBody(
      readSource("src/renderer/styles/overlays-launcher-cards.css"),
      ".plan-card"
    );
    const agentCardRule = cssRuleBody(chatConversation, ".agent-activity-summary,\n.agent-activity-final");
    expect(planCardRule).toContain("border-radius: var(--radius-2xl);");
    expect(agentCardRule).toContain("border-radius: var(--radius-2xl);");
    expect(userBubbleRule).not.toContain("border:");
    expect(userBubbleBodyRule).toContain("padding-right: var(--space-1);");
    expect(userBubbleBodyRule).toContain("margin-right: -4px;");
    // Both composers are borderless and share the same focus lift.
    expect(composerRule).toContain("border: 0;");
    expect(composerFocusRule).not.toContain("border-color:");
    expect(composerFocusRule).not.toContain("var(--accent)");
    expect(launchSendButtonRule).toContain("width: 28px;");
    expect(launchSendButtonRule).toContain("height: 28px;");
    expect(launchSendButtonRule).toContain("border-radius: 999px;");
    // The session composer is borderless too: its panel fill seats it on the
    // surface, and focus deepens the lift rather than drawing an accent ring
    // that would read as the border it doesn't have.
    expect(sessionInputRule).toContain("border: 0;");
    expect(sessionInputFocusRule).not.toContain("border-color:");
    expect(sessionInputFocusRule).not.toContain("var(--accent)");
  });

  it("keeps session composer text aligned with assistant prose size", () => {
    const chatComposerChips = readSource("src/renderer/styles/chat-composer-chips.css");
    const inputRule = cssRuleBody(chatComposerChips, ".session-input input,\n.session-input textarea");
    const textareaRule = cssRuleBody(chatComposerChips, ".session-input-field > textarea");
    const highlightRule = cssRuleBody(chatComposerChips, ".composer-highlight-backdrop");

    expect(inputRule).toContain("font-family: var(--font-prose);");
    expect(inputRule).toContain("font-size: var(--text-base);");
    expect(inputRule).toContain("line-height: 1.55;");
    expect(textareaRule).toContain("overflow-x: hidden;");
    expect(highlightRule).toContain("font-family: var(--font-prose);");
    expect(highlightRule).toContain("font-size: var(--text-base);");
    expect(highlightRule).toContain("line-height: 1.55;");
  });

  it("keeps session composer placeholder on the muted token", () => {
    const chatComposerChips = readSource("src/renderer/styles/chat-composer-chips.css");
    const placeholderRule = cssRuleBody(
      chatComposerChips,
      ".session-input input::placeholder,\n.session-input textarea::placeholder"
    );

    expect(placeholderRule).toContain("color: var(--muted);");
    expect(placeholderRule).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("keeps unselected session titles quieter than the selected row", () => {
    const shellSessions = readSource("src/renderer/styles/shell-sessions.css");
    const linkRule = cssRuleBody(shellSessions, ".session-link");
    const activeRule = cssRuleBody(shellSessions, ".session-link.active");
    const subtitleRule = cssRuleBody(shellSessions, ".session-link-subtitle");

    expect(linkRule).toContain("color: var(--text-soft);");
    expect(activeRule).toContain("color: var(--text);");
    expect(subtitleRule).toContain("color: var(--muted);");
    expect(subtitleRule).toContain("font-size: var(--text-xs);");
  });

  it("keeps command palette rows light: regular titles, quiet meta, one line", () => {
    const inkwell = readSource("src/renderer/styles/overlays-inkwell.css");
    const palette = readSource("src/renderer/components/CommandPalette.tsx");
    const rowRule = cssRuleBody(inkwell, ".command-palette-result");
    const selectedRule = cssRuleBody(inkwell, ".command-palette-result.selected");
    const labelRule = cssRuleBody(inkwell, ".command-palette-result-label");
    const bodyRule = cssRuleBody(inkwell, ".command-palette-result-body");
    const groupRule = cssRuleBody(inkwell, ".command-palette-group");
    const countRule = cssRuleBody(inkwell, ".command-palette-count");
    const tabRule = cssRuleBody(inkwell, ".command-palette-tab");
    const selectedTabRule = cssRuleBody(inkwell, ".command-palette-tab.selected");
    const secondaryRule = cssRuleBody(
      inkwell,
      ".command-palette-result-subtitle,\n.command-palette-result-snippet,\n.command-palette-result-meta"
    );

    // Unselected rows read soft, the selected row reads brighter — never bolder.
    expect(rowRule).toContain("color: var(--text-soft);");
    expect(selectedRule).toContain("color: var(--text);");
    expect(labelRule).toContain("color: inherit;");
    expect(labelRule).toContain("font-weight: 400;");
    expect(bodyRule).toContain("display: flex;");
    expect(secondaryRule).toContain("color: var(--muted);");
    expect(groupRule).toContain("font-weight: 400;");
    expect(groupRule).toContain("text-transform: none;");
    expect(countRule).toContain("text-transform: none;");
    expect(tabRule).toContain("font-weight: 400;");
    expect(selectedTabRule).toContain("background: var(--overlay-panel-raised);");
    expect(inkwell).not.toContain(".command-palette-result-hint");
    expect(palette).not.toContain("command-palette-result-hint");
  });

  it("centers the search palette in the window instead of pinning it near the top", () => {
    const inkwell = readSource("src/renderer/styles/overlays-inkwell.css");
    const backdropRule = cssRuleBody(inkwell, ".command-palette-overlay");
    const paletteRule = cssRuleBody(inkwell, ".command-palette");

    expect(backdropRule).toContain("place-items: center;");
    expect(backdropRule).not.toContain("place-items: start center;");
    expect(backdropRule).not.toContain("padding-top: 12vh;");
    // Capped height keeps a long result list scrolling inside the dialog rather
    // than pushing a centered overlay past the window edges. The px cap holds
    // the dialog short on a tall display, where 72vh alone would stretch a
    // recents list down the whole screen.
    expect(paletteRule).toContain("max-height: min(540px, 72vh);");
    // Every search chord opens this one dialog — no second search modal.
    expect(inkwell).not.toContain(".search-modal");
  });

  it("keeps chat content width modes wired to session padding", () => {
    const chatConversation = readSource("src/renderer/styles/chat-conversation.css");
    const shellSessions = readSource("src/renderer/styles/shell-sessions.css");
    const appSource = readSource("src/renderer/App.tsx");
    const narrowestRule = cssRuleBody(chatConversation, '.app-shell[data-chat-width="1"]');
    const narrowRule = cssRuleBody(chatConversation, '.app-shell[data-chat-width="2"]');
    const standardRule = cssRuleBody(chatConversation, ".app-shell,\n.app-shell[data-chat-width=\"3\"]");
    const wideRule = cssRuleBody(chatConversation, '.app-shell[data-chat-width="4"]');
    const widestRule = cssRuleBody(chatConversation, '.app-shell[data-chat-width="5"]');
    const mainColumnRule = cssRuleBody(chatConversation, ".session-main-column");
    const launcherShellRule = cssRuleBody(shellSessions, ".launcher-shell");
    const launcherSurfaceRule = cssRuleBody(chatConversation, ".session-multigrid-cell .launcher-surface");
    const dockedRule = cssRuleBody(
      chatConversation,
      ".session-grid.review-open .session-main-column,\n.session-grid.log-open .session-main-column"
    );
    const tightRule = cssRuleBody(chatConversation, ".session-grid.review-open.log-open .session-main-column");

    expect(appSource).toContain('data-chat-width={String(chatWidth)}');
    // Levels 2–4 keep the widths the old narrow/default/wide setting shipped.
    expect(narrowestRule).toContain("--chat-content-width: 520px;");
    expect(widestRule).toContain("--chat-content-width: 1100px;");
    expect(narrowRule).toContain("--chat-content-width: 640px;");
    expect(narrowRule).toContain("--chat-content-width-docked: 600px;");
    expect(narrowRule).toContain("--chat-content-width-tight: 560px;");
    expect(standardRule).toContain("--chat-content-width: 780px;");
    expect(standardRule).toContain("--chat-content-width-docked: 740px;");
    expect(standardRule).toContain("--chat-content-width-tight: 680px;");
    expect(wideRule).toContain("--chat-content-width: 940px;");
    expect(wideRule).toContain("--chat-content-width-docked: 900px;");
    expect(wideRule).toContain("--chat-content-width-tight: 840px;");
    expect(mainColumnRule).toContain("clamp(var(--session-inline-padding-min), calc((100% - var(--chat-content-width)) / 2), 2000px)");
    // The launcher shell is deliberately decoupled from the chat width
    // setting: the composer keeps one fixed comfortable measure.
    expect(launcherShellRule).toContain("width: min(100%, 760px);");
    expect(launcherSurfaceRule).toContain("width: min(100%, var(--chat-content-width));");
    expect(dockedRule).toContain("clamp(var(--session-inline-padding-min), calc((100% - var(--chat-content-width-docked)) / 2), 2000px)");
    expect(tightRule).toContain("clamp(var(--session-inline-padding-min), calc((100% - var(--chat-content-width-tight)) / 2), 2000px)");
  });

  it("keeps launch composer copy and context chips calm", () => {
    const launchSurface = readSource("src/renderer/components/LaunchSurface.tsx");
    const chatChrome = readSource("src/renderer/styles/chat-chrome.css");
    const contextChipRule = cssRuleBody(chatChrome, ".composer-context-chip");
    const contextChipHoverRule = cssRuleBody(chatChrome, ".composer-context-chip:hover");

    expect(launchSurface).toContain('"Ask your agent to inspect, build, or fix something"');
    expect(launchSurface).not.toContain("Coffee and code time?");
    expect(launchSurface).not.toContain("Time to ship.");
    expect(launchSurface).not.toContain("What are we hacking on?");
    expect(contextChipRule).toContain("background: transparent;");
    expect(contextChipRule).toContain("color: var(--muted);");
    expect(contextChipRule).toContain("font-size: var(--text-xs);");
    expect(contextChipHoverRule).toContain("background: transparent;");
    expect(contextChipHoverRule).toContain("color: var(--muted-strong);");
  });

  it("folds project and branch pickers into compact launcher details", () => {
    const launchSurface = readSource("src/renderer/components/LaunchSurface.tsx");
    const chatChrome = readSource("src/renderer/styles/chat-chrome.css");
    const chatComposerChips = readSource("src/renderer/styles/chat-composer-chips.css");
    const wideChatComposerChips = chatComposerChips.split("@container (max-width: 720px)")[0] ?? "";
    const chatConversation = readSource("src/renderer/styles/chat-conversation.css");
    const shellSessions = readSource("src/renderer/styles/shell-sessions.css");
    const contextRule = cssRuleBody(chatChrome, ".composer-context");
    const workspaceGroupRule = cssRuleBody(
      chatChrome,
      ".composer-context-group--workspace"
    );
    const workspaceAnchorRule = cssRuleBody(
      chatChrome,
      ".composer-context-group--workspace .project-picker-anchor"
    );
    const workspaceChipRule = cssRuleBody(
      chatChrome,
      ".composer-context-group--workspace .composer-context-chip"
    );
    const behaviorGroupRule = cssRuleBody(chatChrome, ".composer-context-group--behavior");
    const labelRule = cssRuleBody(chatChrome, ".composer-context-chip-label");
    const launcherScrollRule = cssRuleBody(shellSessions, ".launcher-scroll");
    const launcherSurfaceRule = cssRuleBody(shellSessions, ".launcher-surface");
    const launcherCellRule = cssRuleBody(chatConversation, ".session-multigrid-cell");
    const compactTriggerRule = cssRuleBody(
      chatComposerChips,
      ".composer-context-group--workspace > .composer-compact-context-trigger"
    );
    const compactPickersRule = cssRuleBody(chatComposerChips, ".launch-workspace-pickers");
    const compactOpenRule = cssRuleBody(
      chatComposerChips,
      '.composer-context-group--workspace[data-compact-open="true"] > .launch-workspace-pickers'
    );
    const wideModelLabelRule = cssRuleBody(
      wideChatComposerChips,
      ".launcher-surface .composer-context-group--model .model-picker-label"
    );
    const compactModelLabelRule = cssRuleBody(
      chatComposerChips.slice(chatComposerChips.indexOf("@container (max-width: 720px)")),
      ".launcher-surface .composer-context-group--model .model-picker-label"
    );

    expect(launchSurface).toContain('title={contextChipLabel}');
    expect(launchSurface).toContain(
      '<span className="composer-context-chip-label">{contextChipLabel}</span>'
    );
    expect(contextRule).toContain("flex-wrap: nowrap;");
    expect(workspaceGroupRule).toContain("flex: 0 1 auto;");
    expect(workspaceGroupRule).toContain("min-width: 0;");
    expect(workspaceAnchorRule).toContain("flex: 0 1 auto;");
    expect(workspaceAnchorRule).toContain("min-width: 0;");
    expect(workspaceChipRule).toContain("max-width: 100%;");
    expect(workspaceChipRule).toContain("min-width: 0;");
    expect(behaviorGroupRule).toContain("flex: 0 0 auto;");
    expect(labelRule).toContain("text-overflow: ellipsis;");
    expect(labelRule).toContain("white-space: nowrap;");
    expect(launchSurface).toContain("<MoreHorizontal");
    expect(launchSurface).toContain('aria-label={compactContextOpen ? "Project and branch" : undefined}');
    expect(launcherScrollRule).toContain("container-type: inline-size;");
    expect(launcherSurfaceRule).not.toContain("container-type:");
    expect(launcherCellRule).toContain("container-type: inline-size;");
    expect(compactTriggerRule).toContain("display: none;");
    expect(compactPickersRule).toContain("display: inline-flex;");
    expect(wideModelLabelRule).toContain("white-space: nowrap;");
    expect(compactOpenRule).toContain("display: flex;");
    expect(chatComposerChips).toContain('grid-template-areas: "attach model details behavior";');
    expect(compactModelLabelRule).toContain("text-overflow: ellipsis;");
    expect(compactModelLabelRule).toContain("white-space: nowrap;");
  });

  // Which side the model menus open on is decided at runtime by
  // `useAnchoredPopover`, which flips when the preferred side won't fit. A side
  // re-added in CSS would win over the inline styles on one axis and fight the
  // flip on the other, so the stylesheet must stay out of placement entirely.
  it("leaves model picker placement to the anchored-popover primitive", () => {
    const chatChrome = readSource("src/renderer/styles/chat-chrome.css");
    const flyoutRule = cssRuleBody(chatChrome, ".model-picker-flyout");
    const speedRule = cssRuleBody(chatChrome, ".model-speed-popover");

    for (const rule of [flyoutRule, speedRule]) {
      expect(rule).not.toMatch(/^\s*(top|bottom|left|right|position)\s*:/m);
    }
    expect(flyoutRule).toContain("z-index: 30;");
    expect(speedRule).toContain("min-width: 230px;");
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
    expect(projectItemRule).toContain("font-size: var(--text-xs-plus);");
    expect(projectItemRule).toContain("line-height: 1.35;");
    expect(modelPopoverRule).toContain("min-width: 220px;");
    expect(modelItemRule).toContain("gap: var(--space-2);");
    expect(modelSubmenuTriggerRule).toContain("column-gap: var(--space-2);");
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

    expect(tokens).toContain("--font-prose: \"Geist Sans\", ui-sans-serif");
    expect(tokens).toContain(':root[data-font="lilex"]');
    // One scale shifted by --type-step across ten levels; 6 is the shipped
    // size. Assert every level: a missing block silently inherits `:root`'s
    // `--type-step: 0px`, so that level would render identical to the default
    // while Settings still captions it a different px size.
    for (let level = 1; level <= 10; level += 1) {
      expect(tokens).toContain(`[data-font-size="${level}"]`);
    }
    // Body text is `9 + level` px, which `fontSizeBasePx` mirrors in TS. Pin
    // both ends of the step range so the two cannot drift apart.
    expect(tokens).toContain("--type-step: -3px;");
    expect(tokens).toContain("--type-step: 6px;");
    expect(fontSizeBasePx(1)).toBe(13 - 3);
    expect(fontSizeBasePx(10)).toBe(13 + 6);
    expect(tokens).toContain("--text-terminal: calc(13px + var(--type-step));");
    expect(tokens).toContain("--font-ui: \"Geist Sans\", ui-sans-serif");
    expect(bubbleParagraphRule).toContain("font-family: var(--font-prose);");
    expect(bubbleParagraphRule).toContain("font-size: var(--text-base);");
    expect(bubbleParagraphRule).toContain("line-height: 1.68;");
    expect(markdownRule).toContain("font-family: var(--font-prose);");
    expect(markdownRule).toContain("font-size: var(--text-base);");
    expect(markdownRule).toContain("line-height: 1.74;");
    expect(markdownRule).toContain("color: var(--prose-ink);");
    // Agent paragraphs are painted by `.chat-bubble p`, not by the inherited
    // `.markdown` ink — a rule landing on the element beats inheritance. The
    // two have to name the same token or the paragraphs of an answer render
    // at a different brightness than its lists, headings, and tables.
    expect(bubbleParagraphRule).toContain("color: var(--prose-ink);");
    expect(readableMeasureRule).toContain("max-width: 780px;");
  });

  it("keeps narrow chat panes away from the borders", () => {
    const chatConversation = readSource("src/renderer/styles/chat-conversation.css");
    const launcherPanels = readSource("src/renderer/styles/overlays-launcher-panels.css");
    const reviewOverlay = readSource("src/renderer/styles/overlays-review.css");
    const sessionGridRule = cssRuleBody(chatConversation, ".session-grid");
    const reviewOpenGridRule = cssRuleBody(chatConversation, ".session-grid.review-open");
    const logOpenGridRule = cssRuleBody(chatConversation, ".session-grid.log-open");
    const bothOpenGridRule = cssRuleBody(chatConversation, ".session-grid.review-open.log-open");
    const mainColumnRule = cssRuleBody(chatConversation, ".session-main-column");
    const agentActivityRule = cssRuleBody(chatConversation, ".agent-activity");
    const multitaskPanelRule = cssRuleBody(reviewOverlay, ".multitask-panel");
    const dockedColumnRule = cssRuleBody(
      chatConversation,
      ".session-grid.review-open .session-main-column,\n.session-grid.log-open .session-main-column"
    );
    const fullyDockedColumnRule = cssRuleBody(
      chatConversation,
      ".session-grid.review-open.log-open .session-main-column"
    );

    expect(sessionGridRule).toContain("--session-main-column-min-width: 320px;");
    expect(sessionGridRule).toContain("--session-inline-padding-min: 28px;");
    expect(sessionGridRule).toContain("position: relative;");
    expect(reviewOpenGridRule).toContain("--session-inline-padding-min: 22px;");
    expect(logOpenGridRule).toContain("--session-inline-padding-min: 22px;");
    expect(bothOpenGridRule).toContain("--session-inline-padding-min: 20px;");
    expect(reviewOpenGridRule).toContain("minmax(var(--session-main-column-min-width), 1fr)");
    expect(logOpenGridRule).toContain("minmax(var(--session-main-column-min-width), 1fr)");
    expect(bothOpenGridRule).toContain("minmax(var(--session-main-column-min-width), 1fr)");
    expect(launcherPanels).not.toContain("@media (max-width: 1080px)");
    expect(launcherPanels).not.toContain("width: min(420px, max(300px, calc(100% - 320px)));");
    expect(launcherPanels).not.toContain(".review-panel,\n  .log-panel {\n    position: fixed;");
    expect(mainColumnRule).toContain("--session-inline-padding: clamp(var(--session-inline-padding-min), calc((100% - var(--chat-content-width)) / 2), 2000px);");
    expect(dockedColumnRule).toContain("--session-inline-padding: clamp(var(--session-inline-padding-min), calc((100% - var(--chat-content-width-docked)) / 2), 2000px);");
    expect(fullyDockedColumnRule).toContain("--session-inline-padding: clamp(var(--session-inline-padding-min), calc((100% - var(--chat-content-width-tight)) / 2), 2000px);");
    expect(agentActivityRule).toContain("--session-inline-padding: clamp(var(--session-inline-padding-min, 22px), calc((100% - var(--chat-content-width)) / 2), 2000px);");
    expect(multitaskPanelRule).toContain("--session-inline-padding: clamp(var(--session-inline-padding-min, 22px), calc((100% - var(--chat-content-width)) / 2), 2000px);");
  });

  it("keeps the markdown ink and weight ladder monotonic in chat", () => {
    const chatConversation = readSource("src/renderer/styles/chat-conversation.css");
    const markdownRule = cssRuleBody(chatConversation, ".markdown");
    const leadInRule = cssRuleBody(chatConversation, ".markdown p:has(+ ul),\n.markdown p:has(+ ol)");
    const strongRule = cssRuleBody(chatConversation, ".markdown strong");
    const listRule = cssRuleBody(chatConversation, ".markdown ul,\n.markdown ol");
    const listItemRule = cssRuleBody(chatConversation, ".markdown li");
    const singleItemHeadingRule = cssRuleBody(chatConversation, ".markdown ol > li:only-child");
    const h1Rule = cssRuleBody(chatConversation, ".markdown h1");
    const h2Rule = cssRuleBody(chatConversation, ".markdown h2");
    const h3Rule = cssRuleBody(chatConversation, ".markdown h3");
    const h4Rule = cssRuleBody(chatConversation, ".markdown h4");

    const weightOf = (rule: string) =>
      Number(/font-weight:\s*(?<weight>\d+);/.exec(rule)?.groups?.weight);
    const marginsOf = (rule: string) => {
      // Spacing tokens resolve to 4px steps, halves included: --space-N is
      // N * 4px with `_` as the decimal point (--space-1_5 is 6px).
      const toPx = (value: string) => {
        const token = /var\(--space-(?<step>[\d_]+)\)/.exec(value)?.groups?.step;
        if (token !== undefined) return Number(token.replace("_", ".")) * 4;
        return Number(value.replace("px", ""));
      };
      const parts = /margin:\s*(?<values>[^;]+);/.exec(rule)?.groups?.values.split(/\s+/);
      return { top: toPx(parts?.[0] ?? ""), bottom: toPx(parts?.[2] ?? "") };
    };

    // The bug this pins: headings used to be painted from --text-soft/--muted at
    // weight 450, so every heading sat *behind* the paragraphs it introduced and
    // `strong` outranked all of them. A heading-heavy answer then read as one
    // flat river with bold body text as the de-facto heading. The ladder has to
    // stay monotonic — headings at or above emphasis, emphasis above body.
    expect(markdownRule).toContain("color: var(--prose-ink);");
    expect(strongRule).toContain("color: var(--prose-ink-strong);");
    for (const rule of [h1Rule, h2Rule, h3Rule]) {
      expect(rule).toContain("color: var(--prose-ink-strong);");
      expect(weightOf(rule)).toBeGreaterThanOrEqual(weightOf(strongRule));
    }
    expect(weightOf(strongRule)).toBeGreaterThan(400);

    // Size does little of the work: one token wider than the body, so an answer
    // full of `##` never shouts inside a 780px prose column.
    expect(h1Rule).toContain("font-size: var(--text-lg);");
    expect(h2Rule).toContain("font-size: var(--text-md);");
    expect(h3Rule).toContain("font-size: var(--text-base-plus);");
    // Proximity alone marks a lead-in. A weight or ink lift here made a
    // lead-in that ran past one line render as a wall of semibold heavier than
    // the real h3 above it, so the treatment is the tightened gap and nothing
    // else.
    expect(leadInRule).toContain("margin-bottom: var(--space-2);");
    expect(leadInRule).not.toContain("font-weight");
    expect(leadInRule).not.toContain("color:");

    // Space is asymmetric — generous above (the previous section ends), tight
    // below (this heading owns what follows) — and the following block never
    // stacks its own top margin on that tight gap.
    for (const rule of [h1Rule, h2Rule, h3Rule, h4Rule]) {
      const { top, bottom } = marginsOf(rule);
      expect(top).toBeGreaterThan(bottom * 2);
    }
    // `:where()` contributes zero specificity, so `.markdown :where(h1, h2,
    // h3, h4) + *` scores (0,1,0) and loses to `.markdown pre` (0,1,1) — the
    // reset silently does nothing. `:is()` plus an explicit target list scores
    // (0,1,2) and actually wins. Headings stay out of the target list so a
    // subheading under its parent keeps its own space.
    const headingResetRule = cssRuleBody(
      chatConversation,
      ".markdown :is(h1, h2, h3, h4) + :is(p, ul, ol, pre, blockquote, .markdown-table-scroll, .katex-display, .mermaid-diagram)"
    );
    expect(headingResetRule).toContain("margin-top: 0;");

    // h4 is the only small-caps step; below body size it needs case and
    // tracking to register as a label rather than as shrunken prose.
    expect(h4Rule).toContain("font-size: var(--text-sm);");
    expect(h4Rule).toContain("color: var(--muted-strong);");
    expect(h4Rule).toContain("text-transform: uppercase;");
    expect(h4Rule).toContain("letter-spacing: 0.085em;");

    // The single-item ordered list is the LLM's pseudo-heading. It imitates an
    // h3, so it has to match one rather than run a third parallel scale.
    expect(singleItemHeadingRule).toContain("font-size: var(--text-base-plus);");
    expect(weightOf(singleItemHeadingRule)).toBe(weightOf(h3Rule));

    // The gutter is em-based: `--type-step` runs the body from 10px to 19px,
    // and a px gutter that fits "11." at 13px is overflowed by it at 19px,
    // which shunts the whole list left.
    expect(listRule).toContain("margin: 6px 0 18px;");
    expect(listRule).toMatch(/padding-left:\s*[\d.]+em;/);

    // A row's gap has to beat its own leading or a wrapped continuation line
    // reads as the next bullet — 21.8px of leading over a 5px item gap did
    // exactly that. Nested rows sit one step tighter so depth reads as depth.
    const listItemGapRule = cssRuleBody(chatConversation, ".markdown li + li");
    const nestedListItemGapRule = cssRuleBody(chatConversation, ".markdown li li + li");
    const gapOf = (rule: string) => {
      const raw = /margin-top:\s*(?<gap>[^;]+);/.exec(rule)?.groups?.gap.trim() ?? "";
      const token = /var\(--space-(?<step>[\d_]+)\)/.exec(raw)?.groups?.step;
      if (token !== undefined) return Number(token.replace("_", ".")) * 4;
      return Number(raw.replace("px", ""));
    };
    expect(listItemRule).toContain("margin: 0;");
    expect(listItemRule).toContain("line-height: 1.6;");
    expect(gapOf(listItemGapRule)).toBeGreaterThanOrEqual(8);
    expect(gapOf(nestedListItemGapRule)).toBeLessThan(gapOf(listItemGapRule));

    // pre, blockquote and the table's scroller are all "not prose" and share
    // one gap; three different values between unlike blocks reads as drift,
    // not rhythm. The gap belongs to `.markdown-table-scroll`, never to the
    // table: the wrapper is a BFC (overflow-x), so a margin on the table adds
    // inside it instead of collapsing out.
    const blockGaps = [".markdown pre", ".markdown blockquote", ".markdown-table-scroll"].map(
      (selector) => cssRuleBody(chatConversation, selector).match(/margin:\s*([^;]+);/)?.[1]
    );
    expect(blockGaps).toEqual(["18px 0", "18px 0", "18px 0"]);
    expect(cssRuleBody(chatConversation, ".markdown table")).not.toMatch(
      /(?:^|\n)\s*margin[a-z-]*:/
    );
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
    const modelGroupRule = cssRuleBody(
      chatComposerChips,
      ".session-input-toolbar .composer-chips-model"
    );
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
    const footerRule = cssRuleBody(chatComposer, ".session-input-toolbar .composer-footer");
    const chipRule = cssRuleBody(chatComposer, ".session-input-toolbar .composer-footer-chip");
    const baseChipRule = cssRuleBody(chatComposer, ".composer-footer-chip");
    const baseChipHoverRule = cssRuleBody(chatComposer, ".composer-footer-chip:hover");
    const sessionSendButtonRule = cssRuleBody(chatComposerChips, ".session-send-button");
    const labelRule = cssRuleBody(
      chatComposer,
      ".session-input-toolbar .composer-footer-chip-label"
    );

    // The toolbar stays a single row (nowrap): workspace details ellipsize
    // before the model, and the compact grid folds them away before the pane
    // can force the send button onto another line.
    expect(toolbarRule).toContain("flex-wrap: nowrap;");
    expect(modelGroupRule).toContain("flex: 0 0 auto;");
    expect(modelLabelRule).toContain("text-overflow: ellipsis;");
    expect(modelLabelRule).toContain("white-space: nowrap;");
    expect(contextRule).toContain("min-width: 0;");
    expect(contextRule).toContain("overflow: hidden;");
    expect(contextRule).toContain("flex: 0 1 auto;");
    // The "…" trigger is permanent, not a compact-only fallback: it is the home
    // for every secondary workspace action at every width.
    expect(compactContextRule).toContain("display: inline-flex;");
    expect(compactContextRule).toContain("position: relative;");
    expect(compactContextTriggerRule).toContain("width: 28px;");
    expect(compactContextTriggerRule).toContain("color: var(--muted);");
    // Placement is Floating UI's job now (bottom-start + flip), shared with the
    // model, effort and context-ring popovers — the stylesheet only carries the
    // panel's own surface.
    expect(compactContextPopoverRule).not.toContain("position: absolute;");
    expect(compactContextPopoverRule).toContain("box-shadow: var(--shadow-2);");
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
    expect(labelRule).toContain("text-overflow: ellipsis;");
    expect(labelRule).toContain("white-space: nowrap;");
    expect(chatComposerChips).toContain("@container (max-width: 720px)");
    expect(chatComposerChips).toContain('"model details mode send"');
    expect(chatComposerChips).toContain(".session-input-toolbar .composer-compact-context");
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
    expect(changeButtonRule).toContain("flex: 0 0 auto;");
    expect(changeButtonRule).toContain("max-width: none;");
    expect(changeButtonRule).toContain("font-family: var(--font-mono);");
    expect(changeButtonRule).toContain("font-variant-numeric: tabular-nums;");
    // The counts group with the branch by spacing alone — the hairline that
    // used to sit between them went out with the control shelf.
    expect(chatComposer).not.toContain(".composer-footer-chip--changes::before");
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
    expect(Number(chatMinWidth)).toBe(320);
    expect(chatComposerChips).toContain("@container (max-width: 720px)");
    expect(appSource).toContain("sessionGridRequiredWorkspaceMinWidth");
    expect(appSource).toContain("Math.max(DEFAULT_WORKSPACE_MIN_WIDTH_PX, gridColumnWidth, sessionGridRequiredWorkspaceMinWidth)");
    expect(appSource).toContain("appWindow.setMinSize");
    expect(sidebarResize).toContain("workspaceMinWidth");
  });

  it("opens the review scope menu downward instead of collapsing it to a strip", () => {
    // `.project-picker-popover` is a composer menu: it opens UPWARD off
    // `bottom`. The review chip reuses its chrome but sits at the panel's top
    // edge, so it has to open downward. Setting `top` without clearing the
    // inherited `bottom` pins both edges of an auto-height absolute box, which
    // renders as an empty collapsed strip. The menu looks broken, not moved.
    const base = cssRuleBody(readSource("src/renderer/styles/chat-chrome.css"), ".project-picker-popover");
    const scopeRule = cssRuleBody(
      readSource("src/renderer/styles/overlays-review.css"),
      ".review-scope-popover"
    );

    expect(base).toContain("bottom: calc(100% + 6px);");
    expect(scopeRule).toContain("top: calc(100% + 4px);");
    expect(scopeRule).toContain("bottom: auto;");
    expect(scopeRule).toContain("left: auto;");
  });

  it("registers --text-terminal so JS reads pixels instead of a calc() string", () => {
    // xterm renders to canvas and cannot inherit CSS, so
    // `resolveTerminalFontSize()` reads this token back through
    // `getPropertyValue`. An UNregistered custom property is substituted, not
    // computed: the read returns the literal "calc(13px + var(--type-step))",
    // the px parse fails, and the terminal silently pins to the fallback while
    // every other surface resizes. jsdom resolves neither calc() nor
    // @property, so the source is the only place this can be guarded.
    const tokens = readSource("src/renderer/styles/tokens.css");
    const registration = /@property\s+--text-terminal\s*\{(?<body>[^}]+)\}/.exec(tokens);

    expect(registration?.groups?.body).toBeDefined();
    expect(registration?.groups?.body).toContain('syntax: "<length>"');
    // The token is declared per-container (`:root, [data-font-size]`), so it
    // has to inherit for a nested scale to reach the terminal.
    expect(registration?.groups?.body).toContain("inherits: true");
  });

  it("clears the collapsed-sidebar repo title past the fixed sidebar toggle", () => {
    const shellLayout = readSource("src/renderer/styles/shell-layout.css");
    const chatConversation = readSource("src/renderer/styles/chat-conversation.css");
    const appShellRule = cssRuleBody(shellLayout, ".app-shell");
    const toggleRule = cssRuleBody(shellLayout, ".sidebar-toggle");
    const headingRule = cssRuleBody(
      chatConversation,
      '.app-shell[data-sidebar-collapsed="true"]\n  .session-multigrid-cell:first-child\n  .conversation-surface\n  > .section-heading'
    );

    expect(appShellRule).toContain("--titlebar-leading-inset:");
    expect(appShellRule).toContain("--titlebar-center:");
    expect(appShellRule).toContain("--titlebar-strip-height:");
    expect(toggleRule).toContain("left: var(--titlebar-toggle-left);");
    expect(toggleRule).toContain("top: calc(var(--titlebar-center) - 15px);");
    expect(headingRule).toContain("padding-left: var(--titlebar-leading-inset);");
    expect(headingRule).toContain("min-height: var(--titlebar-strip-height);");
    expect(headingRule).toContain("padding-top: calc(var(--titlebar-center) - 15px);");
  });
});
