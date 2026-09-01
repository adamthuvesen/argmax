/**
 * Which broad kind of file a path is, for the one colored glyph the turn's
 * changed-files card shows beside each name. Coarse on purpose: the point is
 * that a stylesheet and a component read as different at a glance, not that
 * every language gets its own hue. Each family maps to an existing theme token
 * in chat-turns.css — no new palette.
 */
export type FileFamily = "script" | "style" | "test" | "rust" | "data" | "shell" | "doc";

const EXTENSION_FAMILIES: Record<string, FileFamily> = {
  ts: "script",
  tsx: "script",
  js: "script",
  jsx: "script",
  mjs: "script",
  cjs: "script",
  rs: "rust",
  toml: "data",
  css: "style",
  scss: "style",
  sass: "style",
  less: "style",
  html: "style",
  svg: "style",
  json: "data",
  jsonc: "data",
  yaml: "data",
  yml: "data",
  sql: "data",
  csv: "data",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  py: "script",
  rb: "script",
  go: "script",
  java: "script",
  kt: "script",
  swift: "script",
  c: "script",
  h: "script",
  cc: "script",
  cpp: "script",
  md: "doc",
  mdx: "doc",
  txt: "doc"
};

/** True for a file whose name marks it as a test or spec, whatever its
 *  extension. Checked before the extension so `foo.test.ts` reads as a test
 *  rather than as one more script. Covers both house styles: the JS/TS infix
 *  (`accentTokens.test.ts`) and the Python/Rust affixes (`test_serving.py`,
 *  `serving_test.go`). */
function isTestPath(fileName: string): boolean {
  return (
    /\.(test|spec)\./.test(fileName) ||
    /^(test|spec)_/.test(fileName) ||
    /_(test|spec)\.[^.]+$/.test(fileName)
  );
}

export function fileFamily(path: string): FileFamily {
  const fileName = path.replace(/\\/g, "/").split("/").pop() ?? path;
  if (isTestPath(fileName)) return "test";
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) return "doc";
  const extension = fileName.slice(dotIndex + 1).toLowerCase();
  return EXTENSION_FAMILIES[extension] ?? "doc";
}
