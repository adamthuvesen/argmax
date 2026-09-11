// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const RENDERER = new URL("../", import.meta.url);

/** How much of the call to read after `lazy(` when looking for the loader. */
const CALL_WINDOW = 240;

function rendererSources(): string[] {
  return readdirSync(RENDERER, { recursive: true, encoding: "utf8" }).filter(
    (path) => /\.tsx?$/.test(path) && !path.includes(".test.")
  );
}

function lazyCallsWithoutRecovery(source: string): string[] {
  const offenders: string[] = [];
  for (let index = source.indexOf("lazy("); index !== -1; index = source.indexOf("lazy(", index + 1)) {
    const call = source.slice(index, index + CALL_WINDOW);
    if (!call.includes("importChunk(")) offenders.push(call.split("\n").slice(0, 3).join(" "));
  }
  return offenders;
}

describe("lazy chunk call sites", () => {
  // A paired phone keeps its page alive across renderer rebuilds, so a hashed
  // chunk it asks for later is gone. A rejected lazy load has no local
  // fallback — it reaches the app error boundary and takes the whole page
  // with it — so every split point loads through importChunk, which reloads
  // the page once to pick up the current bundle.
  it("load every split chunk through importChunk", () => {
    const offenders = rendererSources().flatMap((path) => {
      const source = readFileSync(new URL(path, RENDERER), "utf8");
      return lazyCallsWithoutRecovery(source).map((call) => `${path}: ${call}`);
    });

    expect(offenders).toEqual([]);
  });
});
