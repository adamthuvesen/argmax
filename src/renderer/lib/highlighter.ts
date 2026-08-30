import { useEffect, useState } from "react";
import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageInput,
  type ThemeInput
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { errorMessage } from "../../shared/error.js";
import { logger } from "../../shared/logger.js";
import { themeAppearance } from "./theme.js";

export interface HighlightToken {
  content: string;
  color?: string;
}

const LIGHT_THEME = "vitesse-light";
const DARK_THEME = "vitesse-dark";

function activeThemeName(): string {
  if (typeof document === "undefined") return LIGHT_THEME;
  return themeAppearance(document.documentElement.getAttribute("data-theme")) === "dark"
    ? DARK_THEME
    : LIGHT_THEME;
}

// Each curated grammar is a thunk, not a static import: `createHighlighterCore`
// takes `MaybeGetter` inputs and awaits them, so Vite emits one on-demand chunk
// per grammar instead of hoisting ~1.1 MB of grammar JSON into the eagerly
// loaded chunk both entries preload. Nothing is fetched until the first code
// block asks for highlighting; until then callers render plain text.
const CURATED_LANGS: LanguageInput[] = [
  () => import("shiki/langs/typescript.mjs"),
  () => import("shiki/langs/tsx.mjs"),
  () => import("shiki/langs/javascript.mjs"),
  () => import("shiki/langs/jsx.mjs"),
  () => import("shiki/langs/python.mjs"),
  () => import("shiki/langs/go.mjs"),
  () => import("shiki/langs/rust.mjs"),
  () => import("shiki/langs/json.mjs"),
  () => import("shiki/langs/markdown.mjs"),
  () => import("shiki/langs/html.mjs"),
  () => import("shiki/langs/css.mjs"),
  () => import("shiki/langs/shellscript.mjs"),
  () => import("shiki/langs/sql.mjs"),
  () => import("shiki/langs/yaml.mjs"),
  () => import("shiki/langs/toml.mjs")
];

const CURATED_THEMES: ThemeInput[] = [
  () => import("shiki/themes/vitesse-light.mjs"),
  () => import("shiki/themes/vitesse-dark.mjs")
];

let highlighter: HighlighterCore | null = null;
// Used only as an in-flight re-entrancy guard (null-checked, never awaited by
// callers), so the resolved value is unused — on init failure the catch above
// resolves it to undefined rather than re-throwing.
let highlighterPromise: Promise<unknown> | null = null;
const readyCallbacks = new Set<() => void>();

function ensureHighlighter(): HighlighterCore | null {
  if (highlighter) return highlighter;
  if (highlighterPromise) return null;
  highlighterPromise = createHighlighterCore({
    themes: CURATED_THEMES,
    langs: CURATED_LANGS,
    engine: createJavaScriptRegexEngine()
  })
    .then((instance) => {
      highlighter = instance;
      for (const cb of readyCallbacks) cb();
      readyCallbacks.clear();
      return instance;
    })
    .catch((error) => {
      // If shiki itself fails to initialize, we prefer plain-text output to
      // crashing the whole review pane. Clear the promise so a future call
      // can retry; in practice this only fires in degraded environments
      // (e.g. tests that haven't mocked the module). Log a breadcrumb so a
      // degraded environment isn't a silent fallback (R-042). Don't re-throw:
      // this promise is an unawaited re-entrancy guard, so a rejection would
      // surface as an unhandledrejection with no consumer to catch it.
      logger.warn("renderer.highlighter", "shiki init failed; falling back to plain text", {
        error: errorMessage(error)
      });
      highlighterPromise = null;
    });
  return null;
}

export function onHighlighterReady(cb: () => void): () => void {
  if (highlighter) {
    cb();
    return () => {};
  }
  readyCallbacks.add(cb);
  ensureHighlighter();
  return () => {
    readyCallbacks.delete(cb);
  };
}

export function useHighlighterReady(): boolean {
  const [ready, setReady] = useState<boolean>(() => highlighter !== null);
  useEffect(() => {
    if (ready) return;
    return onHighlighterReady(() => setReady(true));
  }, [ready]);
  return ready;
}

export function highlightLine(content: string, lang: string | null): HighlightToken[] {
  if (!lang) return [{ content }];
  const instance = ensureHighlighter();
  if (!instance) return [{ content }];
  try {
    const result = instance.codeToTokens(content, { theme: activeThemeName(), lang });
    const firstLine = result.tokens[0];
    if (!firstLine) return [{ content }];
    return firstLine.map((token) => ({ content: token.content, color: token.color }));
  } catch {
    // codeToTokens throws on unloaded grammars; we already restrict to the
    // curated set, but a stale alias slipping through shouldn't break the
    // review pane. Fall back to plain text.
    return [{ content }];
  }
}

/** One plain (uncolored) token per line — the highlighter's fallback shape,
 * reused while a streaming code fence is still growing so we don't run shiki's
 * synchronous tokenizer on every keystroke. */
export function plainCodeLines(code: string): HighlightToken[][] {
  return code.split("\n").map((line) => [{ content: line }]);
}

export function highlightCode(code: string, lang: string | null): HighlightToken[][] {
  if (!lang) return plainCodeLines(code);
  const instance = ensureHighlighter();
  if (!instance) return plainCodeLines(code);
  try {
    const result = instance.codeToTokens(code, { theme: activeThemeName(), lang });
    return result.tokens.map((line) =>
      line.map((token) => ({ content: token.content, color: token.color }))
    );
  } catch {
    return plainCodeLines(code);
  }
}

// Fence tags from markdown (```ts, ```bash, etc.) map to shiki language ids.
// Shiki itself accepts most aliases via the grammar files, but we normalize
// here so unknown tags fall back to plain text instead of throwing.
const FENCE_LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  python: "python",
  go: "go",
  golang: "go",
  rs: "rust",
  rust: "rust",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  xml: "html",
  css: "css",
  scss: "css",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  shellscript: "shellscript",
  console: "shellscript",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml"
};

export function resolveFenceLang(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const normalized = tag.toLowerCase().trim();
  return FENCE_LANG_ALIASES[normalized] ?? null;
}

const EXTENSION_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  json: "json",
  json5: "json",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  less: "css",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml"
};

export function langFromPath(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const segments = filePath.split(".");
  if (segments.length < 2) return null;
  const ext = segments[segments.length - 1]?.toLowerCase();
  if (!ext) return null;
  return EXTENSION_TO_LANG[ext] ?? null;
}
