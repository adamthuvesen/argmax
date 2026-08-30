import { describe, expect, it } from "vitest";

import { leadingSkillInvocation, splitSkillTokens } from "./slashHighlight.js";


describe("splitSkillTokens", () => {
  const isSkill = (name: string): boolean => name === "snow" || name === "eli5";

  it("tints a mid-message token and reassembles to the exact input", () => {
    const input = "What is this skill /eli5 about";
    const segments = splitSkillTokens(input, isSkill);
    expect(segments).toEqual([
      { text: "What is this skill ", skill: false },
      { text: "/eli5", skill: true },
      { text: " about", skill: false }
    ]);
    expect(segments?.map((s) => s.text).join("")).toBe(input);
  });

  it("tints multiple tokens but skips unknown names and paths", () => {
    const segments = splitSkillTokens("/snow then /unknown then /eli5", isSkill);
    expect(segments?.filter((s) => s.skill).map((s) => s.text)).toEqual(["/snow", "/eli5"]);
    expect(splitSkillTokens("see src/lib/foo.ts", isSkill)).toBeNull();
    expect(splitSkillTokens("nothing here", isSkill)).toBeNull();
  });
});

describe("leadingSkillInvocation", () => {
  it("splits a skill invocation from its arguments", () => {
    expect(leadingSkillInvocation("/snow How many users?")).toEqual({
      name: "snow",
      rest: "How many users?"
    });
    expect(leadingSkillInvocation("/commit")).toEqual({ name: "commit", rest: "" });
    expect(leadingSkillInvocation("/hookify:help now")).toEqual({
      name: "hookify:help",
      rest: "now"
    });
  });

  it("rejects absolute paths and tokens that are not skill-shaped", () => {
    expect(leadingSkillInvocation("/Users/adam/dev notes")).toBeNull();
    expect(leadingSkillInvocation("/code-review --fix")).toEqual({
      name: "code-review",
      rest: "--fix"
    });
    expect(leadingSkillInvocation("plain message")).toBeNull();
    expect(leadingSkillInvocation("/")).toBeNull();
  });
});
