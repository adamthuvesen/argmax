import { describe, expect, it } from "vitest";

import { splitLinkSegments } from "./messageLinks.js";

describe("splitLinkSegments", () => {
  it("splits a pasted URL out of prose and reassembles to the exact input", () => {
    const input = "Can we check https://github.com/mentimeter/revops-backoffice/pull/458 today";
    const segments = splitLinkSegments(input);
    expect(segments).toEqual([
      { text: "Can we check ", link: false },
      { text: "https://github.com/mentimeter/revops-backoffice/pull/458", link: true },
      { text: " today", link: false }
    ]);
    expect(segments?.map((s) => s.text).join("")).toBe(input);
  });

  it("finds every URL on its own line", () => {
    const segments = splitLinkSegments(
      "Two PRs\n\nhttps://github.com/a/pull/1\nhttps://github.com/b/pull/2\n"
    );
    expect(segments?.filter((s) => s.link).map((s) => s.text)).toEqual([
      "https://github.com/a/pull/1",
      "https://github.com/b/pull/2"
    ]);
  });

  it("leaves sentence punctuation outside the link", () => {
    const segments = splitLinkSegments("Read https://menti.com/docs, then https://menti.com/api.");
    expect(segments?.filter((s) => s.link).map((s) => s.text)).toEqual([
      "https://menti.com/docs",
      "https://menti.com/api"
    ]);
    expect(splitLinkSegments("(see https://menti.com/docs)")?.at(1)?.text).toBe(
      "https://menti.com/docs"
    );
  });

  it("keeps a bracket the URL itself opened", () => {
    const segments = splitLinkSegments("https://en.wikipedia.org/wiki/Argmax_(math) wins");
    expect(segments?.at(0)?.text).toBe("https://en.wikipedia.org/wiki/Argmax_(math)");
  });

  it("returns null when there is nothing to link", () => {
    expect(splitLinkSegments("just a prompt about src/lib/foo.ts")).toBeNull();
    // No scheme guessing: a bare domain is text the user did not write a link for.
    expect(splitLinkSegments("go to menti.com now")).toBeNull();
    expect(splitLinkSegments("email me at me@menti.com")).toBeNull();
    // A scheme with no host is not a link.
    expect(splitLinkSegments("https:// is a scheme")).toBeNull();
  });
});
