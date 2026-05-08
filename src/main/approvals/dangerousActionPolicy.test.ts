// @vitest-environment node
import { describe, expect, it } from "vitest";
import { classifyCommandRisk } from "./dangerousActionPolicy.js";

describe("classifyCommandRisk", () => {
  it("requires high-risk approval for destructive shell and git commands", () => {
    expect(classifyCommandRisk("rm -rf dist")).toMatchObject({ requiresApproval: true, riskLevel: "high" });
    expect(classifyCommandRisk("git reset --hard HEAD~1")).toMatchObject({ requiresApproval: true, riskLevel: "high" });
    expect(classifyCommandRisk("git push --force-with-lease")).toMatchObject({ requiresApproval: true, riskLevel: "high" });
  });

  it("requires medium-risk approval for dependency and remote mutations", () => {
    expect(classifyCommandRisk("git add src/app.ts")).toMatchObject({ requiresApproval: true, riskLevel: "medium" });
    expect(classifyCommandRisk("git commit -m test")).toMatchObject({ requiresApproval: true, riskLevel: "medium" });
    expect(classifyCommandRisk("npm install left-pad")).toMatchObject({ requiresApproval: true, riskLevel: "medium" });
    expect(classifyCommandRisk("git push origin feature")).toMatchObject({ requiresApproval: true, riskLevel: "medium" });
  });

  it("requires approval for PR and delete mutations", () => {
    expect(classifyCommandRisk("gh pr create --fill")).toMatchObject({ requiresApproval: true, riskLevel: "high" });
    expect(classifyCommandRisk("git branch -d old-branch")).toMatchObject({ requiresApproval: true, riskLevel: "high" });
  });

  it("allows low-risk read commands without approval", () => {
    expect(classifyCommandRisk("git status --short")).toEqual({
      requiresApproval: false,
      riskLevel: "low",
      reason: "Read-only or low-risk command"
    });
  });
});
