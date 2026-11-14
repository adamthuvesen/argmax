import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageInput,
  type ThemeInput,
} from "shiki/core";
import { createJavaScriptRawEngine, createJavaScriptRegexEngine } from "shiki/engine/javascript";

// Each curated grammar is a thunk, not a static import: `createHighlighterCore`
// takes `MaybeGetter` inputs and awaits them, so Vite emits one chunk per
// grammar instead of one ~1.1 MB chunk.
//
// Precompiled grammars carry their Oniguruma patterns already translated to
// JavaScript regexes, so the raw engine runs them as they are. Translating at
// runtime made the first TypeScript fence a 786 ms task in WKWebView (measured
// 2026-11-13, bench profile, first chat with a TS fence; 466 ms precompiled).
// They are regex literals with the `v` flag, which WebKit parses only from
// Safari 17, while Argmax supports macOS 11. Older WebKit keeps the
// runtime translation. Keep both lists to the same languages.
const PRECOMPILED_LANGS: LanguageInput[] = [
  () => import("@shikijs/langs-precompiled/typescript"),
  () => import("@shikijs/langs-precompiled/tsx"),
  () => import("@shikijs/langs-precompiled/javascript"),
  () => import("@shikijs/langs-precompiled/jsx"),
  () => import("@shikijs/langs-precompiled/python"),
  () => import("@shikijs/langs-precompiled/go"),
  () => import("@shikijs/langs-precompiled/rust"),
  () => import("@shikijs/langs-precompiled/json"),
  () => import("@shikijs/langs-precompiled/markdown"),
  () => import("@shikijs/langs-precompiled/html"),
  () => import("@shikijs/langs-precompiled/css"),
  () => import("@shikijs/langs-precompiled/shellscript"),
  () => import("@shikijs/langs-precompiled/sql"),
  () => import("@shikijs/langs-precompiled/yaml"),
  () => import("@shikijs/langs-precompiled/toml"),
];

const RUNTIME_LANGS: LanguageInput[] = [
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
  () => import("shiki/langs/toml.mjs"),
];

const CURATED_THEMES: ThemeInput[] = [
  () => import("shiki/themes/vitesse-light.mjs"),
  () => import("shiki/themes/vitesse-dark.mjs"),
];

function supportsUnicodeSetsRegex(): boolean {
  try {
    new RegExp("", "v");
    return true;
  } catch {
    return false;
  }
}

/** The one Shiki setup, shared by the highlight worker and the main-thread fallback. */
export function createArgmaxHighlighter(): Promise<HighlighterCore> {
  const precompiled = supportsUnicodeSetsRegex();
  return createHighlighterCore({
    themes: CURATED_THEMES,
    langs: precompiled ? PRECOMPILED_LANGS : RUNTIME_LANGS,
    engine: precompiled ? createJavaScriptRawEngine() : createJavaScriptRegexEngine(),
  });
}
