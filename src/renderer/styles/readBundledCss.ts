import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Inline-resolve `@import url('./foo.css')` references the way Vite does at
 * build time, returning a single concatenated string. Tests that assert on
 * the shipped CSS contract use this so the cascade is observable from the
 * source tree even after `styles.css` was split into per-section files.
 *
 * Only follows local relative paths — remote `@import url('https://…')` is
 * deliberately left intact so the existing "no remote @import" guard still
 * fires.
 */
export function readBundledCss(entryPath: string): string {
  const seen = new Set<string>();

  function read(path: string): string {
    if (seen.has(path)) return "";
    seen.add(path);
    const content = readFileSync(path, "utf8");
    const dir = dirname(path);
    return content.replace(
      /@import\s+url\(\s*['"]([^'"]+)['"]\s*\)\s*;?/g,
      (match, importPath: string) => {
        if (/^https?:/i.test(importPath)) return match;
        return read(resolve(dir, importPath));
      }
    );
  }

  return read(entryPath);
}
