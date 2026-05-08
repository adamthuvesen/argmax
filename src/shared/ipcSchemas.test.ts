// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createWorkspaceInputSchema,
  ipcSchemas,
  launchProviderSessionInputSchema,
  loadDiffInputSchema,
  prepareCommitInputSchema,
  registerProjectInputSchema,
  resolveApprovalInputSchema
} from "./ipcSchemas.js";

describe("ipcSchemas", () => {
  it("exposes a schema for every payload-bearing IPC channel", () => {
    const channels = Object.keys(ipcSchemas);
    expect(channels).toContain("projects:register");
    expect(channels).toContain("providers:launch");
    expect(channels).toContain("review:load-diff");
    expect(channels).toContain("dashboard:load");
  });

  // -------------------------- valid payloads --------------------------

  it("accepts a valid registerProject payload", () => {
    expect(registerProjectInputSchema.parse({ repoPath: "/Users/me/repo" })).toEqual({
      repoPath: "/Users/me/repo"
    });
  });

  it("accepts a valid launchProviderSession payload", () => {
    const parsed = launchProviderSessionInputSchema.parse({
      workspaceId: "ws-1",
      provider: "claude",
      prompt: "build a thing",
      modelLabel: "claude-3.5-sonnet",
      cols: 120,
      rows: 30
    });
    expect(parsed.provider).toBe("claude");
    expect(parsed.cols).toBe(120);
  });

  it("accepts createWorkspace without baseRef (optional field)", () => {
    expect(
      createWorkspaceInputSchema.parse({ projectId: "p-1", taskLabel: "fix-bug" })
    ).toEqual({ projectId: "p-1", taskLabel: "fix-bug" });
  });

  it("accepts a valid loadDiff tuple with and without filePath", () => {
    expect(loadDiffInputSchema.parse(["ws-1", undefined])).toEqual(["ws-1", undefined]);
    expect(loadDiffInputSchema.parse(["ws-1", "src/index.ts"])).toEqual(["ws-1", "src/index.ts"]);
  });

  it("accepts a valid resolveApproval payload", () => {
    expect(resolveApprovalInputSchema.parse({ approvalId: "a-1", status: "approved" })).toEqual({
      approvalId: "a-1",
      status: "approved"
    });
  });

  // -------------------------- invalid payloads --------------------------

  it("rejects registerProject without repoPath", () => {
    expect(() => registerProjectInputSchema.parse({})).toThrow();
    expect(() => registerProjectInputSchema.parse({ repoPath: "" })).toThrow();
  });

  it("rejects launchProviderSession with a prompt containing newlines", () => {
    expect(() =>
      launchProviderSessionInputSchema.parse({
        workspaceId: "ws-1",
        provider: "claude",
        prompt: "line1\nline2",
        modelLabel: "claude-3.5",
        cols: 120,
        rows: 30
      })
    ).toThrow();
  });

  it("rejects launchProviderSession with a prompt starting with '-'", () => {
    expect(() =>
      launchProviderSessionInputSchema.parse({
        workspaceId: "ws-1",
        provider: "claude",
        prompt: "-rf .",
        modelLabel: "claude-3.5",
        cols: 120,
        rows: 30
      })
    ).toThrow();
  });

  it("rejects launchProviderSession with non-integer cols", () => {
    expect(() =>
      launchProviderSessionInputSchema.parse({
        workspaceId: "ws-1",
        provider: "claude",
        prompt: "ok",
        modelLabel: "claude-3.5",
        cols: 12.5,
        rows: 30
      })
    ).toThrow();
  });

  it("rejects launchProviderSession with an unknown provider", () => {
    expect(() =>
      launchProviderSessionInputSchema.parse({
        workspaceId: "ws-1",
        provider: "gemini",
        prompt: "ok",
        modelLabel: "x",
        cols: 80,
        rows: 24
      })
    ).toThrow();
  });

  it("rejects createWorkspace with a baseRef starting with '-'", () => {
    expect(() =>
      createWorkspaceInputSchema.parse({
        projectId: "p-1",
        taskLabel: "fix",
        baseRef: "--upload-pack=evil"
      })
    ).toThrow();
  });

  it("rejects loadDiff with an absolute filePath", () => {
    expect(() => loadDiffInputSchema.parse(["ws-1", "/etc/passwd"])).toThrow();
  });

  it("rejects loadDiff with parent traversal in filePath", () => {
    expect(() => loadDiffInputSchema.parse(["ws-1", "src/../../secret"])).toThrow();
  });

  it("rejects loadDiff with filePath starting with '-'", () => {
    expect(() => loadDiffInputSchema.parse(["ws-1", "-rf"])).toThrow();
  });

  it("rejects prepareCommit with absolute paths in selectedFiles", () => {
    expect(() =>
      prepareCommitInputSchema.parse({
        workspaceId: "ws-1",
        selectedFiles: ["/etc/passwd"],
        message: "msg"
      })
    ).toThrow();
  });

  it("rejects resolveApproval with an unknown status", () => {
    expect(() => resolveApprovalInputSchema.parse({ approvalId: "a-1", status: "maybe" })).toThrow();
  });
});
