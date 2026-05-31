import { describe, expect, it } from "vitest";
import { errorMessage } from "./error.js";

describe("errorMessage", () => {
  it("returns the message field for Error instances", () => {
    expect(errorMessage(new Error("kaboom"))).toBe("kaboom");
  });

  it("returns the message field for Error subclasses", () => {
    class CustomError extends Error {}
    expect(errorMessage(new CustomError("custom"))).toBe("custom");
  });

  it("stringifies primitives and unknown shapes", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage(null)).toBe("null");
  });

  it("returns message fields from serialized command errors", () => {
    expect(errorMessage({ code: "SERVICE_ERROR", message: "object literal" })).toBe(
      "object literal"
    );
  });

  it("stringifies objects without a usable message", () => {
    expect(errorMessage({ code: "SERVICE_ERROR" })).toBe("[object Object]");
  });
});
