const LANGUAGE_LABELS: Record<string, string> = {
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  html: "HTML",
  htm: "HTML",
  json: "JSON",
  json5: "JSON5",
  md: "Markdown",
  markdown: "Markdown",
  py: "Python",
  go: "Go",
  rs: "Rust",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  toml: "TOML",
  sql: "SQL",
  yaml: "YAML",
  yml: "YAML"
};

/** Human name for the status bar. Unknown extensions read as their own
 *  suffix (".lock" → "LOCK") rather than a flat "Plain text" for everything. */
export function languageLabelFor(path: string | null): string {
  if (!path) return "";
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "Plain text";
  const ext = name.slice(dot + 1).toLowerCase();
  return LANGUAGE_LABELS[ext] ?? ext.toUpperCase();
}

