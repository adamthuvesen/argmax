import { useEffect, useState } from "react";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// Eager-loaded curated grammars per Ralph SPEC P4.04. Importing each language
// module explicitly lets Vite tree-shake every grammar shiki bundles by default
// (asciidoc, mdx, wolfram, etc) out of the renderer bundle.
import typescript from "shiki/langs/typescript.mjs";
import tsx from "shiki/langs/tsx.mjs";
import javascript from "shiki/langs/javascript.mjs";
import jsx from "shiki/langs/jsx.mjs";
import python from "shiki/langs/python.mjs";
import go from "shiki/langs/go.mjs";
import rust from "shiki/langs/rust.mjs";
import json from "shiki/langs/json.mjs";
import markdown from "shiki/langs/markdown.mjs";
import html from "shiki/langs/html.mjs";
import css from "shiki/langs/css.mjs";
import shellscript from "shiki/langs/shellscript.mjs";
import sql from "shiki/langs/sql.mjs";
import yaml from "shiki/langs/yaml.mjs";
import toml from "shiki/langs/toml.mjs";
import githubLight from "shiki/themes/github-light.mjs";

export interface HighlightToken {
  content: string;
  color?: string;
}

const THEME_NAME = "github-light";

const CURATED_LANGS = [
  typescript,
  tsx,
  javascript,
  jsx,
  python,
  go,
  rust,
  json,
  markdown,
  html,
  css,
  shellscript,
  sql,
  yaml,
  toml
];

let highlighter: HighlighterCore | null = null;
let highlighterPromise: Promise<HighlighterCore> | null = null;
const readyCallbacks = new Set<() => void>();

function ensureHighlighter(): HighlighterCore | null {
  if (highlighter) return highlighter;
  if (highlighterPromise) return null;
  highlighterPromise = createHighlighterCore({
    themes: [githubLight],
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
      // (e.g. tests that haven't mocked the module).
      highlighterPromise = null;
      throw error;
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
    const result = instance.codeToTokens(content, { theme: THEME_NAME, lang });
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
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  css: "css",
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
