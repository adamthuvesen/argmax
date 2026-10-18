import { describe, expect, it } from "vitest";
import type { SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { defaultDashboardSnapshot } from "../../test/fixtures/dashboardSnapshot.js";
import { buildSidebarChatTree } from "./sidebarChatTree.js";

const baseWorkspace = defaultDashboardSnapshot.workspaces[0];

const workspace = (id: string, overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  ...baseWorkspace, id, ...overrides
});
const session = (workspaceId: string, parentId?: string, overrides: Partial<SessionSummary> = {}): SessionSummary =>
  ({ ...defaultDashboardSnapshot.sessions[0], id: `session-${workspaceId}`, workspaceId, launchedBySessionId: parentId ? `session-${parentId}` : null, ...overrides });

describe("buildSidebarChatTree", () => {
  it("keeps descendants under their launcher across projects and sorts sibling chats by activity", () => {
    const rows = [
      workspace("parent"),
      workspace("older", { lastActivityAt: "2026-10-17T10:00:00Z" }),
      workspace("newer", { projectId: "other-project", lastActivityAt: "2026-10-18T10:00:00Z" }),
      workspace("grandchild")
    ];
    const tree = buildSidebarChatTree(rows,
      [session("parent"), session("older", "parent"), session("newer", "parent"), session("grandchild", "older")], new Set(), true);
    expect(tree.childrenByWorkspace.get("parent")?.map((row) => row.id)).toEqual(["newer", "older"]);
    expect(tree.childrenByWorkspace.get("older")?.map((row) => row.id)).toEqual(["grandchild"]);
    expect([...tree.parentByWorkspace]).toEqual([["older", "parent"], ["newer", "parent"], ["grandchild", "older"]]);
    expect([...tree.rootByWorkspace]).toEqual([["parent", "parent"], ["older", "parent"], ["newer", "parent"], ["grandchild", "parent"]]);
  });

  it("keeps pinned, detached, orphaned, and self-launched chats at the top level", () => {
    const rows = [workspace("parent"), workspace("pinned", { pinned: true }), workspace("detached"), workspace("orphan"), workspace("self")];
    const tree = buildSidebarChatTree(rows,
      [session("parent"), session("pinned", "parent"), session("detached", "parent"), session("orphan", "absent"), session("self", "self")],
      new Set(["detached"]), true);
    expect(tree.parentByWorkspace.size).toBe(0);
    expect(tree.childrenByWorkspace.size).toBe(0);
    for (const row of rows) expect(tree.rootByWorkspace.get(row.id)).toBe(row.id);
  });

  it("does not attach children to a parent workspace outside the eligible rows", () => {
    const tree = buildSidebarChatTree([workspace("child")],
      [session("parent"), session("child", "parent")], new Set(), true);
    expect(tree.parentByWorkspace.size).toBe(0);
    expect(tree.rootByWorkspace.get("child")).toBe("child");
  });

  it("leaves every cycle member at the top level and retains ordinary children of those roots", () => {
    const tree = buildSidebarChatTree([workspace("a"), workspace("b"), workspace("c"), workspace("child")],
      [session("a", "b"), session("b", "c"), session("c", "a"), session("child", "b")], new Set(), true);
    expect([...tree.parentByWorkspace]).toEqual([["child", "b"]]);
    expect([...tree.rootByWorkspace]).toEqual([["a", "a"], ["b", "b"], ["c", "c"], ["child", "b"]]);
  });

  it("uses the canonical child session when a workspace contains several sessions", () => {
    const tree = buildSidebarChatTree([workspace("parent-a"), workspace("parent-b"), workspace("child")], [
      session("parent-a"), session("parent-b"),
      session("child", "parent-a", { id: "child-old", lastActivityAt: "2026-10-17T10:00:00Z" }),
      session("child", "parent-b", { id: "child-new", lastActivityAt: "2026-10-18T10:00:00Z" })
    ], new Set(), true);
    expect(tree.parentByWorkspace.get("child")).toBe("parent-b");
    expect(tree.childrenByWorkspace.has("parent-a")).toBe(false);
  });

  it("can resolve the exact launcher session even when a newer session shares its workspace", () => {
    const tree = buildSidebarChatTree([workspace("parent"), workspace("child")], [
      session("parent", undefined, { lastActivityAt: "2026-10-17T10:00:00Z" }),
      session("parent", undefined, { id: "new-parent-session", lastActivityAt: "2026-10-18T10:00:00Z" }),
      session("child", "parent")
    ], new Set(), true);
    expect(tree.parentByWorkspace.get("child")).toBe("parent");
  });

  it("keeps all roots independent when nesting is disabled", () => {
    const tree = buildSidebarChatTree([workspace("parent"), workspace("child")],
      [session("parent"), session("child", "parent")], new Set(), false);
    expect(tree.parentByWorkspace.size).toBe(0);
    expect(tree.childrenByWorkspace.size).toBe(0);
    expect([...tree.rootByWorkspace]).toEqual([["parent", "parent"], ["child", "child"]]);
  });
});
