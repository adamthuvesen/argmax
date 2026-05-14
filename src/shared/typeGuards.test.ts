import { describe, expect, it } from "vitest";
import { arrayValue, isPlainObject, objectValue, stringValue } from "./typeGuards.js";

describe("isPlainObject", () => {
  it("returns true for object literals", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it("returns false for null, arrays, and primitives", () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject("string")).toBe(false);
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });

  it("returns true for class instances (intentional: structural check, not prototype)", () => {
    class Foo {}
    expect(isPlainObject(new Foo())).toBe(true);
  });
});

describe("stringValue / objectValue / arrayValue", () => {
  it("stringValue returns non-empty strings or null", () => {
    expect(stringValue("hi")).toBe("hi");
    expect(stringValue("")).toBeNull();
    expect(stringValue(42)).toBeNull();
    expect(stringValue(undefined)).toBeNull();
  });

  it("objectValue returns the plain object or null", () => {
    expect(objectValue({ a: 1 })).toEqual({ a: 1 });
    expect(objectValue(null)).toBeNull();
    expect(objectValue([])).toBeNull();
  });

  it("arrayValue returns the array or null", () => {
    expect(arrayValue([1, 2])).toEqual([1, 2]);
    expect(arrayValue({})).toBeNull();
    expect(arrayValue("array")).toBeNull();
  });
});
