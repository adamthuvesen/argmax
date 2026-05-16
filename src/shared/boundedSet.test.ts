// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BoundedMap, BoundedSet } from "./boundedSet.js";

describe("BoundedSet", () => {
  it("rejects capacity < 1", () => {
    expect(() => new BoundedSet<string>(0)).toThrow();
  });

  it("dedupes membership", () => {
    const set = new BoundedSet<string>(3);
    expect(set.add("a")).toBe(true);
    expect(set.add("a")).toBe(false);
    expect(set.size).toBe(1);
  });

  it("evicts the oldest entry when capacity is exceeded", () => {
    const set = new BoundedSet<string>(2);
    set.add("a");
    set.add("b");
    set.add("c");
    expect(set.has("a")).toBe(false);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("delete removes a value", () => {
    const set = new BoundedSet<string>(2);
    set.add("a");
    expect(set.delete("a")).toBe(true);
    expect(set.has("a")).toBe(false);
  });
});

describe("BoundedMap", () => {
  it("returns the stored value", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1);
    expect(map.get("a")).toBe(1);
  });

  it("evicts oldest on insert past capacity", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    expect(map.has("a")).toBe(false);
    expect(map.get("c")).toBe(3);
    expect(map.size).toBe(2);
  });

  it("updating an existing key does not evict", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("a", 99);
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(true);
    expect(map.size).toBe(2);
  });
});
