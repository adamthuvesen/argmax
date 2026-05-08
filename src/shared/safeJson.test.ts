// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeJsonParse, safeJsonParseArray, safeJsonParseRecord } from "./safeJson.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("safeJsonParse", () => {
  it("returns the parsed value for valid JSON", () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
    expect(safeJsonParse("[1,2,3]", [])).toEqual([1, 2, 3]);
    expect(safeJsonParse('"hello"', "")).toBe("hello");
    expect(safeJsonParse("42", 0)).toBe(42);
    expect(safeJsonParse("true", false)).toBe(true);
    expect(safeJsonParse("null", "fallback")).toBeNull();
  });

  it("returns the fallback for malformed JSON", () => {
    expect(safeJsonParse("{not json", { default: true })).toEqual({ default: true });
    expect(safeJsonParse("[1,", [99])).toEqual([99]);
    expect(safeJsonParse("undefined", "fb")).toBe("fb");
    expect(safeJsonParse("", "fb")).toBe("fb");
  });

  it("returns the fallback for null and undefined inputs", () => {
    expect(safeJsonParse(null, { empty: true })).toEqual({ empty: true });
    expect(safeJsonParse(undefined, [])).toEqual([]);
  });

  it("respects arbitrary fallback types", () => {
    type Config = { feature: boolean; name: string };
    const fallback: Config = { feature: false, name: "default" };
    const parsed = safeJsonParse<Config>("not json at all", fallback);
    expect(parsed).toBe(fallback);

    const arrFallback: number[] = [];
    expect(safeJsonParse<number[]>("oops", arrFallback)).toBe(arrFallback);

    const mapFallback = new Map<string, number>();
    expect(safeJsonParse<Map<string, number>>("nope", mapFallback)).toBe(mapFallback);
  });

  it("logs at most once per context within a minute", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = `safeJsonParseTest-${Math.random()}`;

    safeJsonParse("{bad", null, ctx);
    safeJsonParse("{bad", null, ctx);
    safeJsonParse("{bad", null, ctx);
    expect(warn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    safeJsonParse("{bad", null, ctx);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does not log when no context is provided", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    safeJsonParse("{bad", null);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("safeJsonParseArray", () => {
  const isString = (v: unknown): v is string => typeof v === "string";

  it("returns elements matching the predicate from a valid JSON array", () => {
    expect(safeJsonParseArray('["a","b","c"]', isString)).toEqual(["a", "b", "c"]);
  });

  it("filters out elements that do not satisfy the predicate", () => {
    expect(safeJsonParseArray('["a",1,"b",null,"c"]', isString)).toEqual(["a", "b", "c"]);
  });

  it("returns [] on parse failure", () => {
    expect(safeJsonParseArray("not json", isString)).toEqual([]);
  });

  it("returns [] when the parsed value is not an array", () => {
    expect(safeJsonParseArray('{"a":1}', isString)).toEqual([]);
    expect(safeJsonParseArray("42", isString)).toEqual([]);
    expect(safeJsonParseArray("null", isString)).toEqual([]);
  });

  it("returns [] for null/undefined input", () => {
    expect(safeJsonParseArray(null, isString)).toEqual([]);
    expect(safeJsonParseArray(undefined, isString)).toEqual([]);
  });
});

describe("safeJsonParseRecord", () => {
  it("returns the parsed object for a valid JSON object", () => {
    expect(safeJsonParseRecord('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  it("returns {} on parse failure", () => {
    expect(safeJsonParseRecord("nope")).toEqual({});
  });

  it("returns {} when the parsed value is not a plain object", () => {
    expect(safeJsonParseRecord("[1,2,3]")).toEqual({});
    expect(safeJsonParseRecord("null")).toEqual({});
    expect(safeJsonParseRecord('"str"')).toEqual({});
    expect(safeJsonParseRecord("42")).toEqual({});
  });

  it("returns {} for null/undefined input", () => {
    expect(safeJsonParseRecord(null)).toEqual({});
    expect(safeJsonParseRecord(undefined)).toEqual({});
  });
});
