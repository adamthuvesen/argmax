/**
 * Lazy Mermaid runtime for fenced `mermaid` blocks in chat markdown.
 *
 * The mermaid package is large (d3 + layout), so nothing here is imported
 * from the eager renderer graph. `renderMermaidDiagram` is the only entry,
 * and the first call is what pulls the chunk in. Theme variables are read
 * from live CSS tokens so a Light/Dark/accent swap restyles diagrams without
 * a mermaid-specific palette.
 *
 * Mermaid's theming engine only accepts hex colors, so computed `rgb()` /
 * `oklab()` token values are converted before they reach `initialize`.
 */
import { errorMessage } from "../../shared/error.js";
import { themeAppearance } from "./theme.js";

export const MERMAID_STREAM_DEBOUNCE_MS = 180;

type MermaidBindFunctions = (element: Element) => void;

export type MermaidRenderResult = {
  svg: string;
  bindFunctions?: MermaidBindFunctions;
};

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, source: string) => Promise<MermaidRenderResult>;
};

let mermaidPromise: Promise<MermaidApi> | null = null;
let renderChain: Promise<unknown> = Promise.resolve();
let renderSeq = 0;

function rgbToHex(r: number, g: number, b: number): string {
  const hex = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Convert a CSS color (hex, rgb, rgba) to the `#rrggbb` mermaid accepts. */
export function cssColorToHex(color: string): string | null {
  const trimmed = color.trim();
  if (!trimmed) return null;
  const six = trimmed.match(/^#([0-9a-fA-F]{6})$/);
  if (six) return `#${six[1].toLowerCase()}`;
  const three = trimmed.match(/^#([0-9a-fA-F]{3})$/);
  if (three) {
    const [r, g, b] = three[1];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const comma = trimmed.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i
  );
  if (comma) return rgbToHex(Number(comma[1]), Number(comma[2]), Number(comma[3]));
  const space = trimmed.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/i
  );
  if (space) return rgbToHex(Number(space[1]), Number(space[2]), Number(space[3]));
  return null;
}

function tokenHex(style: CSSStyleDeclaration, name: string): string | null {
  return cssColorToHex(style.getPropertyValue(name));
}

function readProbeTypography(): { fontFamily: string; fontSize: string } {
  if (typeof document === "undefined") {
    return { fontFamily: "Geist Sans, ui-sans-serif, sans-serif", fontSize: "13px" };
  }
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.fontFamily = "var(--font-ui)";
  probe.style.fontSize = "var(--text-sm)";
  document.documentElement.appendChild(probe);
  const computed = getComputedStyle(probe);
  const fontFamily = computed.fontFamily || "Geist Sans, ui-sans-serif, sans-serif";
  const fontSize = computed.fontSize || "13px";
  probe.remove();
  return { fontFamily, fontSize };
}

export function readMermaidThemeVariables(): Record<string, string | boolean> {
  if (typeof document === "undefined") return { darkMode: false };
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const dark = themeAppearance(root.getAttribute("data-theme")) === "dark";
  const { fontFamily, fontSize } = readProbeTypography();

  const well = tokenHex(style, "--tool-block-surface");
  const panel = tokenHex(style, "--panel");
  const panelSoft = tokenHex(style, "--panel-soft");
  const panelSunken = tokenHex(style, "--panel-sunken");
  const ink = tokenHex(style, "--prose-ink");
  const inkStrong = tokenHex(style, "--prose-ink-strong");
  const muted = tokenHex(style, "--muted-strong");
  const line = tokenHex(style, "--line-strong");
  const lineSoft = tokenHex(style, "--line");
  const accent = tokenHex(style, "--accent");
  const accentSoft = tokenHex(style, "--accent-soft");
  const sage = tokenHex(style, "--sage");
  const amber = tokenHex(style, "--amber");
  const rose = tokenHex(style, "--rose");
  const note = tokenHex(style, "--amber-soft");

  const nodeFill = panelSoft ?? panel ?? well;
  const clusterFill = well ?? panelSunken;
  const edgeLabel = well ?? panel;

  const vars: Record<string, string | boolean> = {
    darkMode: dark,
    fontFamily,
    fontSize
  };
  if (well) vars.background = well;
  if (nodeFill) {
    vars.primaryColor = nodeFill;
    vars.mainBkg = nodeFill;
    vars.actorBkg = nodeFill;
  }
  if (ink) {
    vars.primaryTextColor = ink;
    vars.secondaryTextColor = ink;
    vars.tertiaryTextColor = ink;
    vars.nodeTextColor = ink;
    vars.actorTextColor = ink;
    vars.textColor = ink;
    vars.classText = ink;
    vars.labelTextColor = ink;
    vars.signalTextColor = ink;
    vars.loopTextColor = ink;
    vars.pieSectionTextColor = ink;
    vars.pieLegendTextColor = ink;
  }
  if (inkStrong) {
    vars.titleColor = inkStrong;
    vars.pieTitleTextColor = inkStrong;
  }
  if (line) {
    vars.primaryBorderColor = line;
    vars.secondaryBorderColor = line;
    vars.tertiaryBorderColor = line;
    vars.nodeBorder = line;
    vars.clusterBorder = line;
    vars.actorBorder = line;
    vars.actorLineColor = line;
    vars.noteBorderColor = line;
    vars.pieStrokeColor = line;
    vars.pieOuterStrokeColor = line;
  }
  if (muted) {
    vars.lineColor = muted;
    vars.defaultLinkColor = muted;
    vars.signalColor = muted;
  }
  if (clusterFill) {
    vars.tertiaryColor = clusterFill;
    vars.clusterBkg = clusterFill;
    vars.altBackground = clusterFill;
  }
  if (accentSoft) vars.secondaryColor = accentSoft;
  if (edgeLabel) vars.edgeLabelBackground = edgeLabel;
  if (note) vars.noteBkgColor = note;
  if (ink) vars.noteTextColor = ink;
  if (accent) vars.pie1 = accent;
  if (sage) vars.pie2 = sage;
  if (amber) vars.pie3 = amber;
  if (rose) vars.pie4 = rose;
  if (lineSoft) vars.activationBorderColor = lineSoft;
  if (accentSoft) vars.activationBkgColor = accentSoft;
  if (rose) {
    vars.errorBkgColor = rose;
    vars.errorTextColor = well ?? "#ffffff";
  }
  return vars;
}

function mermaidConfig(): Record<string, unknown> {
  const themeVariables = readMermaidThemeVariables();
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    logLevel: "error",
    theme: "base",
    themeVariables,
    fontFamily: themeVariables.fontFamily,
    flowchart: {
      useMaxWidth: false,
      htmlLabels: true,
      curve: "basis",
      padding: 18,
      wrappingWidth: 160,
      nodeSpacing: 32,
      rankSpacing: 40
    },
    sequence: { useMaxWidth: false, actorMargin: 48, boxMargin: 8 },
    gantt: { useMaxWidth: false },
    er: { useMaxWidth: false },
    pie: { useMaxWidth: false, textPosition: 0.75 },
    journey: { useMaxWidth: false },
    timeline: { useMaxWidth: false },
    gitGraph: { useMaxWidth: false },
    class: { useMaxWidth: false },
    state: { useMaxWidth: false },
    mindmap: { useMaxWidth: false },
    sankey: { useMaxWidth: false },
    xyChart: { useMaxWidth: false },
    kanban: { useMaxWidth: false }
  };
}

function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import("mermaid").then((mod) => {
    const mermaid = (mod.default ?? mod) as MermaidApi;
    mermaid.initialize(mermaidConfig());
    return mermaid;
  });
  return mermaidPromise;
}

/**
 * Render one diagram to SVG. Calls are serialized: mermaid keeps layout
 * state on the module, and overlapping `render()` calls can poison later
 * diagrams after a parse error.
 */
export function renderMermaidDiagram(source: string): Promise<MermaidRenderResult> {
  const run = renderChain.then(
    () => renderNow(source),
    () => renderNow(source)
  );
  renderChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function renderNow(source: string): Promise<MermaidRenderResult> {
  const mermaid = await loadMermaid();
  mermaid.initialize(mermaidConfig());
  const id = `argmax-mermaid-${++renderSeq}`;
  return mermaid.render(id, source);
}

export function mermaidErrorMessage(error: unknown): string {
  const raw = errorMessage(error);
  const first = raw.split("\n").find((line) => line.trim()) ?? raw;
  return first.replace(/^Error:\s*/i, "").trim() || "Couldn't draw this diagram.";
}

/** Pixel width mermaid assigned before CSS scales the SVG to the column. */
export function nativeSvgWidth(svg: SVGSVGElement): number {
  const attr = svg.getAttribute("width");
  if (attr) {
    const value = Number.parseFloat(attr);
    if (Number.isFinite(value) && !attr.trim().endsWith("%")) return value;
  }
  try {
    const viewBoxWidth = svg.viewBox.baseVal.width;
    if (viewBoxWidth > 0) return viewBoxWidth;
  } catch {
    // Detached SVGs and jsdom can throw on viewBox.baseVal.
  }
  return 0;
}
