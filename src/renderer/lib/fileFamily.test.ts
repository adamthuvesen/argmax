import { describe, expect, it } from "vitest";
import { fileFamily } from "./fileFamily.js";

describe("fileFamily", () => {
  it("reads the extension", () => {
    expect(fileFamily("src/a.tsx")).toBe("script");
    expect(fileFamily("src/styles/tokens.css")).toBe("style");
    expect(fileFamily("src-tauri/src/main.rs")).toBe("rust");
    expect(fileFamily("package.json")).toBe("data");
    expect(fileFamily("scripts/check.sh")).toBe("shell");
    expect(fileFamily("docs/styling.md")).toBe("doc");
  });

  it("marks a test file as a test whatever its extension or house style", () => {
    expect(fileFamily("src/lib/accentTokens.test.ts")).toBe("test");
    expect(fileFamily("src/lib/foo.spec.tsx")).toBe("test");
    expect(fileFamily("tests/test_run_selector_headroom.py")).toBe("test");
    expect(fileFamily("internal/serving_test.go")).toBe("test");
  });

  it("does not read a name that merely starts with the word test as a test", () => {
    expect(fileFamily("src/testimonials.tsx")).toBe("script");
  });

  it("falls back to doc for an unknown or extensionless name", () => {
    expect(fileFamily("Makefile")).toBe("doc");
    expect(fileFamily("src/data.parquet")).toBe("doc");
    expect(fileFamily(".gitignore")).toBe("doc");
  });
});
