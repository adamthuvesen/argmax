// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createWorkspaceInputSchema,
  gitCommitInputSchema,
  ipcSchemas,
  launchProviderSessionInputSchema,
  loadDiffInputSchema,
  providerSessionInputSchema,
  registerProjectInputSchema,
  resolveApprovalInputSchema,
  switchBranchInputSchema
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
    expect(channels).toContain("session:costSummary");
    expect(channels).toContain("workspace:status");
    expect(channels).toContain("approvals:pending");
    expect(channels).toContain("mcp:auth:start");
    expect(channels).toContain("mcp:auth:write");
    expect(channels).toContain("mcp:auth:resize");
    expect(channels).toContain("mcp:auth:terminate");
  });

  it("validates mcp:auth:* payloads (cols/rows bounded, sessionId non-empty)", () => {
    expect(ipcSchemas["mcp:auth:start"].parse({ cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 });
    expect(() => ipcSchemas["mcp:auth:start"].parse({ cols: 10, rows: 24 })).toThrow();
    expect(() => ipcSchemas["mcp:auth:start"].parse({ cols: 80.5, rows: 24 })).toThrow();

    expect(
      ipcSchemas["mcp:auth:write"].parse({ sessionId: "s-1", data: "hi" })
    ).toEqual({ sessionId: "s-1", data: "hi" });
    expect(() => ipcSchemas["mcp:auth:write"].parse({ sessionId: "", data: "x" })).toThrow();

    expect(
      ipcSchemas["mcp:auth:resize"].parse({ sessionId: "s-1", cols: 120, rows: 40 })
    ).toEqual({ sessionId: "s-1", cols: 120, rows: 40 });

    expect(ipcSchemas["mcp:auth:terminate"].parse("s-1")).toBe("s-1");
    expect(() => ipcSchemas["mcp:auth:terminate"].parse("")).toThrow();
  });

  it("rejects session:costSummary with an empty or non-string sessionId", () => {
    expect(() => ipcSchemas["session:costSummary"].parse({ sessionId: "" })).toThrow();
    expect(() => ipcSchemas["session:costSummary"].parse({ sessionId: 42 })).toThrow();
    expect(() => ipcSchemas["session:costSummary"].parse({})).toThrow();
    expect(ipcSchemas["session:costSummary"].parse({ sessionId: "session-1" })).toEqual({
      sessionId: "session-1"
    });
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

  it("accepts a valid workspaces:openInIde payload with a known ide", () => {
    expect(ipcSchemas["workspaces:openInIde"].parse({ workspaceId: "ws-1", ide: "vscode" })).toEqual({
      workspaceId: "ws-1",
      ide: "vscode"
    });
    expect(ipcSchemas["workspaces:openInIde"].parse({ workspaceId: "ws-1", ide: "default" })).toEqual({
      workspaceId: "ws-1",
      ide: "default"
    });
  });

  it("rejects workspaces:openInIde with an unknown ide value", () => {
    expect(() =>
      ipcSchemas["workspaces:openInIde"].parse({ workspaceId: "ws-1", ide: "atom" })
    ).toThrow();
  });

  it("rejects workspaces:openInIde with a missing workspaceId", () => {
    expect(() => ipcSchemas["workspaces:openInIde"].parse({ ide: "vscode" })).toThrow();
    expect(() => ipcSchemas["workspaces:openInIde"].parse({ workspaceId: "", ide: "vscode" })).toThrow();
  });

  it("accepts system:listDetectedIdes with no payload", () => {
    expect(ipcSchemas["system:listDetectedIdes"].parse(undefined)).toBeUndefined();
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

  it("accepts launchProviderSession with a prompt containing newlines", () => {
    expect(
      launchProviderSessionInputSchema.parse({
        workspaceId: "ws-1",
        provider: "claude",
        prompt: "line1\nline2",
        modelLabel: "claude-3.5",
        modelId: "claude-3.5",
        cols: 120,
        rows: 30
      })
    ).toMatchObject({ prompt: "line1\nline2" });
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

  it("rejects registerProject when repoPath is not absolute or contains null bytes", () => {
    expect(() => registerProjectInputSchema.parse({ repoPath: "relative/path" })).toThrow();
    expect(() => registerProjectInputSchema.parse({ repoPath: "/tmp/with null" })).toThrow();
    expect(registerProjectInputSchema.parse({ repoPath: "/tmp/argmax" })).toEqual({ repoPath: "/tmp/argmax" });
  });

  it("rejects switchBranch when the branch name starts with '-' (argv-injection guard)", () => {
    expect(() => switchBranchInputSchema.parse({ projectId: "p-1", branch: "--orphan" })).toThrow();
    expect(() => switchBranchInputSchema.parse({ projectId: "p-1", branch: "-q" })).toThrow();
    expect(switchBranchInputSchema.parse({ projectId: "p-1", branch: "feature/foo" })).toEqual({
      projectId: "p-1",
      branch: "feature/foo"
    });
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

  it("accepts gitCommit with omitted selectedFiles (whole-worktree mode)", () => {
    expect(gitCommitInputSchema.parse({ workspaceId: "ws-1", message: "msg" })).toEqual({
      workspaceId: "ws-1",
      message: "msg"
    });
  });

  it("accepts gitCommit with a list of relative selectedFiles", () => {
    expect(
      gitCommitInputSchema.parse({
        workspaceId: "ws-1",
        message: "msg",
        selectedFiles: ["src/a.ts", "src/b.ts"]
      })
    ).toEqual({
      workspaceId: "ws-1",
      message: "msg",
      selectedFiles: ["src/a.ts", "src/b.ts"]
    });
  });

  it("rejects gitCommit with absolute paths in selectedFiles", () => {
    expect(() =>
      gitCommitInputSchema.parse({
        workspaceId: "ws-1",
        message: "msg",
        selectedFiles: ["/etc/passwd"]
      })
    ).toThrow();
  });

  it("rejects gitCommit with selectedFiles entries containing parent traversal", () => {
    expect(() =>
      gitCommitInputSchema.parse({
        workspaceId: "ws-1",
        message: "msg",
        selectedFiles: ["src/../secret"]
      })
    ).toThrow();
  });

  it("rejects gitCommit with selectedFiles entries starting with '-'", () => {
    expect(() =>
      gitCommitInputSchema.parse({
        workspaceId: "ws-1",
        message: "msg",
        selectedFiles: ["-rf"]
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
