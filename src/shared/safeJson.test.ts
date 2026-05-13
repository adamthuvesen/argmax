// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeJsonParse, safeJsonParseArray, safeJsonParseRecord } from "./safeJson.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("safeJsonParse — always returns unknown", () => {
  it("returns the parsed value for valid JSON", () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeJsonParse("[1,2,3]")).toEqual([1, 2, 3]);
    expect(safeJsonParse('"hello"')).toBe("hello");
    expect(safeJsonParse("42")).toBe(42);
    expect(safeJsonParse("true")).toBe(true);
    expect(safeJsonParse("null")).toBeNull();
  });

  it("returns undefined for malformed JSON", () => {
    expect(safeJsonParse("{not json")).toBeUndefined();
    expect(safeJsonParse("[1,")).toBeUndefined();
    expect(safeJsonParse("undefined")).toBeUndefined();
    expect(safeJsonParse("")).toBeUndefined();
  });

  it("returns undefined for null and undefined inputs", () => {
    expect(safeJsonParse(null)).toBeUndefined();
    expect(safeJsonParse(undefined)).toBeUndefined();
  });

  it("logs at most once per context within a minute", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = `safeJsonParseTest-${Math.random()}`;

    safeJsonParse("{bad", ctx);
    safeJsonParse("{bad", ctx);
    safeJsonParse("{bad", ctx);
    expect(warn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    safeJsonParse("{bad", ctx);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does not log when no context is provided", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    safeJsonParse("{bad");
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
