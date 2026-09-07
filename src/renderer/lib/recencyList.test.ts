// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readIdRecency, sortByIdRecency, touchIdRecency } from "./recencyList.js";

const KEY = "argmax.test.recency";

afterEach(() => {
  window.localStorage.removeItem(KEY);
});

describe("recencyList", () => {
  it("returns an empty list when nothing is stored", () => {
    expect(readIdRecency(KEY)).toEqual([]);
  });

  it("ignores corrupt JSON", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(readIdRecency(KEY)).toEqual([]);
  });

  it("moves a touched id to the front and drops duplicates", () => {
    expect(touchIdRecency(KEY, "a")).toEqual(["a"]);
    expect(touchIdRecency(KEY, "b")).toEqual(["b", "a"]);
    expect(touchIdRecency(KEY, "a")).toEqual(["a", "b"]);
  });

  it("sorts known ids by recency and leaves untouched ids in original order", () => {
    touchIdRecency(KEY, "a");
    touchIdRecency(KEY, "c");
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(sortByIdRecency(items, readIdRecency(KEY), (item) => item.id).map((item) => item.id)).toEqual([
      "c",
      "a",
      "b"
    ]);
  });
});
