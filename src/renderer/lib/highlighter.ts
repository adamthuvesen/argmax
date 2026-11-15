import { useSyncExternalStore } from "react";
import type { GrammarState, HighlighterCore } from "shiki/core";
import { errorMessage } from "../../shared/error.js";
import { logger } from "../../shared/logger.js";
import type { HighlightWorkerReply, HighlightWorkerRequest } from "./highlight.worker.js";
import { themeAppearance } from "./theme.js";

export interface HighlightToken {
  content: string;
  color?: string;
}

const LIGHT_THEME = "vitesse-light";
const DARK_THEME = "vitesse-dark";

export type HighlightAppearance = "light" | "dark";

function activeThemeName(appearance?: HighlightAppearance): string {
  if (appearance) return appearance === "dark" ? DARK_THEME : LIGHT_THEME;
  if (typeof document === "undefined") return LIGHT_THEME;
  return themeAppearance(document.documentElement.getAttribute("data-theme")) === "dark"
    ? DARK_THEME
    : LIGHT_THEME;
}

function subscribeToThemeAttribute(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

function readThemeAppearance(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return themeAppearance(document.documentElement.getAttribute("data-theme"));
}

/**
 * Shiki resolves its palette from the live document theme. Components that
 * memoize token output must subscribe to the same attribute or a theme switch
 * would repaint the surface while leaving the old token colors in place.
 */
export function useHighlightThemeAppearance(): "light" | "dark" {
  return useSyncExternalStore(subscribeToThemeAttribute, readThemeAppearance, () => "light");
}

/**
 * Fence and diff colors arrive asynchronously: a caller paints plain text,
 * asks for tokens, and repaints when they land. Shiki normally runs in a
 * worker ([highlight.worker.ts](./highlight.worker.ts)), because its first
 * tokenization was one 466 ms main-thread task in WKWebView. Where the worker
 * cannot start, the same request runs on the main thread a slice at a time.
 * Nothing is loaded until the first request: warming Shiki at idle made one
 * 315 ms task with nothing visible to show for it.
 */
type HighlightJob = {
  code: string;
  lang: string;
  theme: string;
  done: (lines: HighlightToken[][] | null) => void;
  cancel: () => void;
};

// --- Main-thread fallback -------------------------------------------------

let highlighter: HighlighterCore | null = null;
// An in-flight re-entrancy guard, never awaited by callers.
let highlighterPromise: Promise<unknown> | null = null;
const readyCallbacks = new Set<() => void>();

function onHighlighterReady(cb: () => void): () => void {
  if (highlighter) {
    cb();
    return () => {};
  }
  readyCallbacks.add(cb);
  highlighterPromise ??= import("./shikiCore.js")
    .then(({ createArgmaxHighlighter }) => createArgmaxHighlighter())
    .then((instance) => {
      highlighter = instance;
      for (const ready of readyCallbacks) ready();
      readyCallbacks.clear();
    })
    .catch((error) => {
      // Plain text beats a crashed pane. Clear the promise so a later request
      // retries, and log so a degraded environment is not a silent fallback.
      logger.warn("renderer.highlighter", "shiki init failed; falling back to plain text", {
        error: errorMessage(error),
      });
      highlighterPromise = null;
    });
  return () => {
    readyCallbacks.delete(cb);
  };
}

/**
 * Main-thread steps run a few milliseconds at a time between frames, in the
 * order they were queued. A step returns true while its job has more to do.
 */
const highlightSteps = new Set<() => boolean>();
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
const HIGHLIGHT_SLICE_MS = 6;
const FALLBACK_CHUNK_LINES = 200;

function runHighlightSlice(): void {
  highlightTimer = null;
  const deadline = performance.now() + HIGHLIGHT_SLICE_MS;
  for (const step of highlightSteps) {
    highlightSteps.delete(step);
    if (step()) highlightSteps.add(step);
    if (performance.now() >= deadline) break;
  }
  if (highlightSteps.size > 0) highlightTimer = setTimeout(runHighlightSlice, 0);
}

/** Tokenizes `FALLBACK_CHUNK_LINES` lines per step, carrying the grammar state
    so a string or comment that spans chunks colors as one block would. */
function tokenizeOnMainThread(job: HighlightJob): void {
  const sourceLines = job.code.split("\n");
  const lines: HighlightToken[][] = [];
  let grammarState: GrammarState | undefined;
  let start = 0;
  const step = (): boolean => {
    if (!highlighter) return false;
    try {
      const result = highlighter.codeToTokens(
        sourceLines.slice(start, start + FALLBACK_CHUNK_LINES).join("\n"),
        { theme: job.theme, lang: job.lang, grammarState },
      );
      grammarState = result.grammarState;
      for (const line of result.tokens) lines.push(toHighlightTokens(line));
    } catch {
      job.done(null);
      return false;
    }
    start += FALLBACK_CHUNK_LINES;
    if (start < sourceLines.length) return true;
    job.done(lines);
    return false;
  };
  let cancelled = false;
  const stopWaiting = onHighlighterReady(() => {
    if (cancelled) return;
    highlightSteps.add(step);
    highlightTimer ??= setTimeout(runHighlightSlice, 0);
  });
  job.cancel = () => {
    cancelled = true;
    stopWaiting();
    highlightSteps.delete(step);
  };
}

function toHighlightTokens(line: readonly { content: string; color?: string }[]): HighlightToken[] {
  return line.map((token) => ({ content: token.content, color: token.color }));
}

// --- Worker ---------------------------------------------------------------

/** Undefined until first asked for; null once it cannot be used. */
let worker: Worker | null | undefined;
let nextJobId = 1;
const workerJobs = new Map<number, HighlightJob>();

function post(target: Worker, message: HighlightWorkerRequest): void {
  target.postMessage(message);
}

/** Moves every job the worker still owes to the main thread, and stops using it. */
function abandonWorker(reason: string): void {
  if (worker === null) return;
  logger.warn(
    "renderer.highlighter",
    "highlight worker unavailable; highlighting on the main thread",
    {
      error: reason,
    },
  );
  worker?.terminate();
  worker = null;
  const orphaned = [...workerJobs.values()];
  workerJobs.clear();
  for (const job of orphaned) tokenizeOnMainThread(job);
}

function highlightWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === "undefined") return (worker = null);
  let started: Worker;
  try {
    started = new Worker(new URL("./highlight.worker.ts", import.meta.url), {
      type: "module",
      name: "highlight",
    });
  } catch (error) {
    abandonWorker(errorMessage(error));
    return null;
  }
  started.addEventListener("message", (event: MessageEvent<HighlightWorkerReply>) => {
    const reply = event.data;
    if (reply.type === "init-failed") {
      abandonWorker(reply.error);
      return;
    }
    const job = workerJobs.get(reply.id);
    if (!job) return;
    workerJobs.delete(reply.id);
    job.done(reply.lines);
  });
  // A module worker WebKit cannot load or parse reports only this event.
  started.addEventListener("error", (event) => {
    event.preventDefault();
    abandonWorker(event.message || "worker failed to load");
  });
  started.addEventListener("messageerror", () => abandonWorker("worker reply could not be read"));
  worker = started;
  return started;
}

function tokenizeInWorker(target: Worker, job: HighlightJob): void {
  const id = nextJobId++;
  workerJobs.set(id, job);
  post(target, { type: "tokenize", id, code: job.code, lang: job.lang, theme: job.theme });
  job.cancel = () => {
    if (!workerJobs.delete(id)) return;
    if (worker) post(worker, { type: "cancel", id });
  };
}

// --- Requests -------------------------------------------------------------

/** One plain (uncolored) token per line: what a block shows until its colors land. */
export function plainCodeLines(code: string): HighlightToken[][] {
  return code.split("\n").map((line) => [{ content: line }]);
}

/** Highlighted fences, keyed by theme, language, and source, so a chat
    reopened after a switch paints its code colored at once. Bounded by
    source characters. */
const highlighted = new Map<string, HighlightToken[][]>();
let highlightedChars = 0;
const HIGHLIGHTED_CHAR_LIMIT = 2_000_000;

function highlightedKey(code: string, lang: string, appearance?: HighlightAppearance): string {
  return `${activeThemeName(appearance)}\u0000${lang}\u0000${code}`;
}

function remember(key: string, lines: HighlightToken[][]): void {
  // Two fences with the same code can both miss and both land a reply; count the key once.
  if (highlighted.delete(key)) highlightedChars -= key.length;
  highlighted.set(key, lines);
  highlightedChars += key.length;
  for (const [oldest] of highlighted) {
    if (highlightedChars <= HIGHLIGHTED_CHAR_LIMIT) break;
    highlighted.delete(oldest);
    highlightedChars -= oldest.length;
  }
}

/** The colors already computed for this fence, without computing them. */
export function peekHighlightedCode(
  code: string,
  lang: string | null,
  appearance?: HighlightAppearance,
): HighlightToken[][] | null {
  if (!lang) return null;
  const key = highlightedKey(code, lang, appearance);
  const cached = highlighted.get(key);
  if (!cached) return null;
  highlighted.delete(key);
  highlighted.set(key, cached);
  return cached;
}

/**
 * Asks for `code`'s tokens and calls `done` once, with one token array per
 * line, or null when the language cannot be tokenized. Returns a cancel; after
 * it `done` is never called. `keep: false` is for text whose exact contents are
 * never asked for again, such as a fence still being written or a diff side.
 */
export function requestHighlight(
  code: string,
  lang: string,
  appearance: HighlightAppearance,
  done: (lines: HighlightToken[][] | null) => void,
  { keep = true }: { keep?: boolean } = {},
): () => void {
  const key = highlightedKey(code, lang, appearance);
  let cancelled = false;
  const job: HighlightJob = {
    code,
    lang,
    theme: activeThemeName(appearance),
    done: (lines) => {
      if (cancelled) return;
      if (lines && keep) remember(key, lines);
      done(lines);
    },
    cancel: () => {},
  };
  const target = highlightWorker();
  if (target) tokenizeInWorker(target, job);
  else tokenizeOnMainThread(job);
  return () => {
    cancelled = true;
    job.cancel();
  };
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
  toml: "toml",
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
  toml: "toml",
};

export function langFromPath(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const segments = filePath.split(".");
  if (segments.length < 2) return null;
  const ext = segments[segments.length - 1]?.toLowerCase();
  if (!ext) return null;
  return EXTENSION_TO_LANG[ext] ?? null;
}
