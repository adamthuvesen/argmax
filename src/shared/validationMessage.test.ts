import { describe, expect, it } from "vitest";
import { validationMessage } from "./validationMessage.js";

describe("validationMessage", () => {
  it("joins the issues of a serialized InvalidInput error", () => {
    expect(
      validationMessage({
        code: "INVALID_INPUT",
        issues: [
          { path: ["branchTemplate"], code: "BRANCH_TEMPLATE_INVALID", message: "Unknown placeholder {nope}." },
          { path: ["x"], code: "Y", message: "Second." }
        ]
      })
    ).toBe("Unknown placeholder {nope}. Second.");
  });

  it("falls back to the message of a service error or an Error", () => {
    expect(validationMessage({ code: "SERVICE_ERROR", sub_code: "LINKED_REPO_CONFLICT", message: "Already linked." })).toBe("Already linked.");
    expect(validationMessage(new Error("boom"))).toBe("boom");
    expect(validationMessage({ code: "INVALID_INPUT", issues: [] })).not.toBe("");
  });
});
