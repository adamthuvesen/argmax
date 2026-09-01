const LANGUAGE_CLASS_PREFIX = "language-";
const MERMAID_FENCE_TAGS = new Set(["mermaid", "mmd"]);

/** True for fenced `mermaid` / `mmd` blocks. Kept off the mermaid runtime
 *  so the chat markdown path can detect a diagram without pulling d3. */
export function isMermaidFenceClass(className: string | undefined): boolean {
  if (!className) return false;
  for (const token of className.split(/\s+/)) {
    if (!token.startsWith(LANGUAGE_CLASS_PREFIX)) continue;
    const tag = token.slice(LANGUAGE_CLASS_PREFIX.length).trim().toLowerCase();
    if (MERMAID_FENCE_TAGS.has(tag)) return true;
  }
  return false;
}
