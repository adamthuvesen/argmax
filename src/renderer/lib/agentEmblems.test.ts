import { describe, expect, it } from "vitest";
import { HEADLINE_COUNT, SCIENTIST_NAMES } from "./agentNames.js";
import { SESSION_ICON_COLORS } from "./sessionIcons.js";
import {
  EMBLEM_BY_CODENAME,
  EMBLEM_HUES,
  EMBLEM_PATHS,
  EMBLEM_SHAPES,
  emblemForCodename
} from "./agentEmblems.js";

const pairs = SCIENTIST_NAMES.map((name) => emblemForCodename(name));

describe("the emblem table", () => {
  it("covers every codename from the table rather than the hash fallback", () => {
    for (const name of SCIENTIST_NAMES) {
      expect(EMBLEM_BY_CODENAME[name], name).toBeDefined();
    }
    expect(Object.keys(EMBLEM_BY_CODENAME)).toHaveLength(SCIENTIST_NAMES.length);
  });

  it("gives all 100 names a distinct shape-and-hue pair", () => {
    const seen = new Set(pairs.map((emblem) => `${emblem.shape}/${emblem.hue}`));
    expect(seen.size).toBe(SCIENTIST_NAMES.length);
  });

  it("spans ten shapes and nine hues across the headline names", () => {
    // A session's first spawns draw from the headline slots, so those marks
    // have to be as unlike each other as the set allows.
    const headline = pairs.slice(0, HEADLINE_COUNT);
    expect(new Set(headline.map((emblem) => emblem.shape)).size).toBe(HEADLINE_COUNT);
    expect(new Set(headline.map((emblem) => emblem.hue)).size).toBe(EMBLEM_HUES.length);
  });

  it("never repeats a hue on consecutive names", () => {
    // The codename probe steps to the next name in the list when one is taken,
    // so neighbours have to differ in colour or the probe buys nothing.
    for (let i = 1; i < pairs.length; i += 1) {
      expect(pairs[i].hue, `${SCIENTIST_NAMES[i - 1]} → ${SCIENTIST_NAMES[i]}`).not.toBe(
        pairs[i - 1].hue
      );
    }
  });

  it("uses every shape and every hue at least seven times", () => {
    for (const shape of EMBLEM_SHAPES) {
      expect(pairs.filter((emblem) => emblem.shape === shape).length, shape).toBeGreaterThanOrEqual(7);
    }
    for (const hue of EMBLEM_HUES) {
      expect(pairs.filter((emblem) => emblem.hue === hue).length, hue).toBeGreaterThanOrEqual(7);
    }
  });

  it("rides the session icon palette rather than a second colour list", () => {
    expect([...EMBLEM_HUES]).toEqual([...SESSION_ICON_COLORS]);
  });

  it("marks even-odd only on the shapes that carry a hole", () => {
    // Even-odd is what opens the orbit's ring, the bloom's centre and the gem's
    // facets. Setting it on a shape built from overlapping subpaths would punch
    // holes where they cross instead, which is how the shell lost its tail.
    const holed = EMBLEM_SHAPES.filter((shape) => EMBLEM_PATHS[shape].evenOdd === true);
    expect(holed).toEqual(["orbit", "bloom", "gem"]);
    for (const shape of EMBLEM_SHAPES) {
      expect(EMBLEM_PATHS[shape].d.startsWith("M"), shape).toBe(true);
    }
  });

  it("gives an off-table name a stable mark instead of an empty box", () => {
    const first = emblemForCodename("Fix the changelog date");
    expect(EMBLEM_SHAPES).toContain(first.shape);
    expect(EMBLEM_HUES).toContain(first.hue);
    expect(emblemForCodename("Fix the changelog date")).toEqual(first);
  });
});
