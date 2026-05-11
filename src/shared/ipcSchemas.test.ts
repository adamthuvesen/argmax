// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createWorkspaceInputSchema,
  ipcSchemas,
  launchProviderSessionInputSchema,
  loadDiffInputSchema,
  prepareCommitInputSchema,
  providerSessionInputSchema,
  registerProjectInputSchema,
  resolveApprovalInputSchema
} from "./ipcSchemas.js";

describe("ipcSchemas", () => {
  it("exposes a schema for every payload-bearing IPC channel", () => {
    const channels = Object.keys(ipcSchemas);
    expect(channels).toContain("projects:register");
    expect(channels).toContain("projects:pick-folder");
    expect(channels).toContain("providers:launch");
    expect(channels).toContain("review:load-diff");
    expect(channels).toContain("dashboard:load");
    expect(channels).toContain("dashboard:list");
    expect(channels).toContain("session:eventsSince");
    expect(channels).toContain("workspace:status");
    expect(channels).toContain("approvals:pending");
  });

  // -------------------------- valid payloads --------------------------

  it("accepts a valid registerProject payload", () => {
    expect(registerProjectInputSchema.parse({ repoPath: "/Users/me/repo" })).toEqual({
      repoPath: "/Users/me/repo"
    });
  });

  it("accepts pickProjectFolder without input", () => {
    expect(ipcSchemas["projects:pick-folder"].parse(undefined)).toBeUndefined();
  });

  it("accepts a valid launchProviderSession payload", () => {
    const parsed = launchProviderSessionInputSchema.parse({
      workspaceId: "ws-1",
      provider: "claude",
      prompt: "build a thing",
      modelLabel: "Claude Haiku",
      modelId: "haiku",
      cols: 120,
      rows: 30
    });
    expect(parsed.provider).toBe("claude");
    expect(parsed.modelId).toBe("haiku");
    expect(parsed.cols).toBe(120);
  });

  it("accepts a valid launchProviderSession payload with reasoning effort", () => {
    const parsed = launchProviderSessionInputSchema.parse({
      workspaceId: "ws-1",
      provider: "codex",
      prompt: "build a thing",
      modelLabel: "GPT-5.3 Codex Spark Low",
      modelId: "gpt-5.3-codex-spark",
      reasoningEffort: "low",
      cols: 120,
      rows: 30
    });
    expect(parsed.reasoningEffort).toBe("low");
  });

  it("accepts a valid providerSession payload with a model switch", () => {
    const parsed = providerSessionInputSchema.parse({
      sessionId: "session-1",
      input: "continue",
      modelLabel: "GPT-5.5",
      modelId: "gpt-5.5",
      reasoningEffort: "high"
    });
    expect(parsed.modelId).toBe("gpt-5.5");
    expect(parsed.reasoningEffort).toBe("high");
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

  it("accepts a valid system:open-path payload and rejects leading '-'", () => {
    expect(ipcSchemas["system:open-path"].parse({ path: "/Users/me/file.ts" })).toEqual({
      path: "/Users/me/file.ts"
    });
    expect(
      ipcSchemas["system:open-path"].parse({ path: "src/index.ts", cwd: "/Users/me/repo" })
    ).toEqual({ path: "src/index.ts", cwd: "/Users/me/repo" });
    expect(() => ipcSchemas["system:open-path"].parse({ path: "-rf" })).toThrow();
    expect(() => ipcSchemas["system:open-path"].parse({ path: "" })).toThrow();
  });

  it("accepts focused dashboard read payloads", () => {
    expect(ipcSchemas["dashboard:list"].parse(undefined)).toBeUndefined();
    expect(ipcSchemas["approvals:pending"].parse(undefined)).toBeUndefined();
    expect(ipcSchemas["workspace:status"].parse(undefined)).toBeUndefined();
    expect(ipcSchemas["workspace:status"].parse({ workspaceIds: ["ws-1"] })).toEqual({ workspaceIds: ["ws-1"] });
    expect(
      ipcSchemas["session:eventsSince"].parse({
        sessionId: "session-1",
        eventCursor: 1,
        rawOutputCursor: 2
      })
    ).toEqual({ sessionId: "session-1", eventCursor: 1, rawOutputCursor: 2 });
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
        modelId: "claude-3.5",
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
        modelId: "claude-3.5",
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
        modelId: "claude-3.5",
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
        modelId: "x",
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

  it("rejects negative session event cursors", () => {
    expect(() =>
      ipcSchemas["session:eventsSince"].parse({
        sessionId: "session-1",
        eventCursor: -1
      })
    ).toThrow();
  });
});
