import { describe, expect, it } from "vitest";
import {
  addReviewTab, createReviewTabs, migrateReviewTabs, moveReviewTab, parseReviewTabs,
  openReviewTab, projectReviewLayout, removeReviewTab, reviewToolTab, selectReviewTab, splitReviewTab,
  type ReviewTab
} from "./reviewTabs.js";

const browser = (id: string): ReviewTab => ({ id: `browser:${id}`, kind: "browser", browserTabId: id });
const file = (path: string, sourceKey = "workspace:1"): ReviewTab => ({ id: `${sourceKey}:${path}`, kind: "file", path, sourceKey });

describe("review tabs", () => {
  it("persists a new-tab chooser and replaces it with the selected resource", () => {
    const chooser = openReviewTab(createReviewTabs(), reviewToolTab("new"));
    expect(parseReviewTabs(JSON.stringify(chooser))).toEqual(chooser);
    expect(projectReviewLayout(chooser).modes).toEqual(["new"]);
    const opened = openReviewTab(chooser, browser("chosen"));
    expect(opened.paneTabIds).toEqual(["browser:chosen"]);
    expect(opened.tabs.map((tab) => tab.id)).toEqual(["tool:changes", "browser:chosen"]);
    const splitChooser = splitReviewTab(openReviewTab(opened, reviewToolTab("new")), "tool:changes", "bottom");
    const replaced = openReviewTab(splitChooser, reviewToolTab("files"), 0);
    expect(replaced.paneTabIds).toEqual(["tool:files", "tool:changes"]);
    expect(replaced.tabs.some((tab) => tab.id === "tool:new")).toBe(false);
  });

  it("opens a side chat without persisting provider state", () => {
    const session: ReviewTab = { id: "side-chat:child-session", kind: "side-chat", sessionId: "child-session", workspaceId: "shared-checkout" };
    const opened = openReviewTab(createReviewTabs(), session);
    expect(opened.paneTabIds).toEqual([session.id]);
    expect(parseReviewTabs(JSON.stringify(opened))).toEqual(opened);
    expect(projectReviewLayout(opened).modes).toEqual(["side-chat"]);
    expect(openReviewTab(opened, session).tabs.filter((tab) => tab.kind === "side-chat")).toHaveLength(1);
  });

  it("keeps a Side chat form in the strip when another tab opens over it", () => {
    const form = openReviewTab(createReviewTabs(), reviewToolTab("side-chat"));
    const opened = openReviewTab(form, reviewToolTab("files"));
    expect(opened.paneTabIds).toEqual(["tool:files"]);
    expect(opened.tabs.map((tab) => tab.id)).toEqual(["tool:changes", "tool:side-chat", "tool:files"]);
  });

  it("round-trips order and two independent browser panes", () => {
    let state = addReviewTab(addReviewTab(createReviewTabs(), browser("a")), browser("b"));
    state = selectReviewTab(state, "browser:a");
    state = splitReviewTab(state, "browser:b", "bottom");
    state = moveReviewTab(state, "browser:b", 0);
    const restored = parseReviewTabs(JSON.stringify(state));
    expect(restored).toEqual(state);
    expect(projectReviewLayout(state).modes).toEqual(["browser", "browser"]);
    expect(state.tabs.map((tab) => tab.id)).toEqual(["browser:b", "tool:changes", "browser:a"]);
  });

  it("migrates a saved split without mutating tool identity", () => {
    const state = migrateReviewTabs(JSON.stringify({ modes: ["changes", "files"], activeIndex: 1, ratio: 0.67 }), (mode) => mode === "browser" || mode === "terminal" ? null : reviewToolTab(mode));
    expect(state?.paneTabIds).toEqual(["tool:changes", "tool:files"]);
    expect(state?.activeIndex).toBe(1);
    expect(state?.ratio).toBe(0.67);
  });

  it("promotes the neighboring tab on close and preserves the other visible pane", () => {
    let state = addReviewTab(addReviewTab(createReviewTabs(), browser("a")), browser("b"));
    state = selectReviewTab(state, "browser:a");
    expect(removeReviewTab(state, "browser:a").paneTabIds).toEqual(["browser:b"]);
    state = splitReviewTab(state, "browser:b", "bottom");
    expect(removeReviewTab(state, "browser:a").paneTabIds).toEqual(["browser:b"]);
    expect(removeReviewTab(state, "browser:a").tabs.map((tab) => tab.id)).toEqual(["tool:changes", "browser:b"]);
  });

  it("routes every file into the existing editor pane while retaining the browser", () => {
    let state = addReviewTab(addReviewTab(addReviewTab(createReviewTabs(), browser("a")), file("a.ts")), file("b.ts"));
    state = selectReviewTab(state, "browser:a");
    state = splitReviewTab(state, "workspace:1:a.ts", "bottom");
    state = selectReviewTab(state, "workspace:1:b.ts", 0);
    expect(state.paneTabIds).toEqual(["browser:a", "workspace:1:b.ts"]);
    state = splitReviewTab(state, "workspace:1:a.ts", "top");
    expect(state.paneTabIds).toEqual(["browser:a", "workspace:1:a.ts"]);
  });

  it("rejects corrupt references and duplicate resources in visible panes", () => {
    const state = createReviewTabs();
    expect(parseReviewTabs(JSON.stringify({ ...state, paneTabIds: ["missing"] }))).toBeNull();
    expect(parseReviewTabs(JSON.stringify({ ...state, tabs: [reviewToolTab("changes"), reviewToolTab("changes")] }))).toBeNull();
    expect(parseReviewTabs(JSON.stringify({ ...state, tabs: [file("a.ts"), file("b.ts")], paneTabIds: ["workspace:1:a.ts", "workspace:1:b.ts"] }))).toBeNull();
  });
});
