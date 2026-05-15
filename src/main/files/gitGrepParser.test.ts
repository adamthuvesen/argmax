import { describe, expect, it } from "vitest";
import { parseGitGrepOutput } from "./gitGrepParser.js";

const NUL = "\0";

describe("parseGitGrepOutput", () => {
  it("returns empty when stdout is empty", () => {
    expect(parseGitGrepOutput("", { maxFiles: 10, maxMatchesPerFile: 10 })).toEqual({
      files: [],
      truncated: false
    });
  });

  it("groups matches by file in the order they appear", () => {
    const raw = [
      `src/a.ts${NUL}3${NUL}var abc = 1;${NUL}`,
      `src/a.ts${NUL}9${NUL}return abc;${NUL}`,
      `src/b.ts${NUL}12${NUL}const abc = 'two';${NUL}`
    ].join("");
    const result = parseGitGrepOutput(raw, { maxFiles: 10, maxMatchesPerFile: 10 });
    expect(result.truncated).toBe(false);
    expect(result.files).toEqual([
      {
        path: "src/a.ts",
        matches: [
          { line: 3, preview: "var abc = 1;" },
          { line: 9, preview: "return abc;" }
        ]
      },
      { path: "src/b.ts", matches: [{ line: 12, preview: "const abc = 'two';" }] }
    ]);
  });

  it("strips a legacy leading colon between line number and content", () => {
    // Older git versions emit `<path>\0<line>\0:<content>` with the colon
    // separator. The parser strips it so renderer rows stay clean.
    const raw = `src/a.ts${NUL}3${NUL}:var abc = 1;${NUL}`;
    const result = parseGitGrepOutput(raw, { maxFiles: 10, maxMatchesPerFile: 10 });
    expect(result.files[0].matches[0].preview).toBe("var abc = 1;");
  });

  it("caps matches per file and flags truncated", () => {
    const records: string[] = [];
    for (let i = 1; i <= 6; i += 1) {
      records.push(`src/a.ts${NUL}${i}${NUL}line ${i};${NUL}`);
    }
    const result = parseGitGrepOutput(records.join(""), { maxFiles: 10, maxMatchesPerFile: 3 });
    expect(result.files[0].matches).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("caps files and flags truncated", () => {
    const records = [
      `a.ts${NUL}1${NUL}x${NUL}`,
      `b.ts${NUL}1${NUL}x${NUL}`,
      `c.ts${NUL}1${NUL}x${NUL}`
    ].join("");
    const result = parseGitGrepOutput(records, { maxFiles: 2, maxMatchesPerFile: 10 });
    expect(result.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(result.truncated).toBe(true);
  });

  it("truncates absurdly long previews so the IPC envelope stays bounded", () => {
    const long = "x".repeat(2000);
    const raw = `a.ts${NUL}1${NUL}${long}${NUL}`;
    const result = parseGitGrepOutput(raw, { maxFiles: 10, maxMatchesPerFile: 10 });
    expect(result.files[0].matches[0].preview.length).toBeLessThanOrEqual(320);
  });
});
