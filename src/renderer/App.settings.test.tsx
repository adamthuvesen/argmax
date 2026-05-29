import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { DashboardSnapshot } from "../shared/types.js";
import {
  dashboardDeltaListener,
  launchProvider,
  listDetectedIdes,
  missingSession,
  mockDashboardSnapshot,
  openInIde,
  openSettings,
  sessionCostSummary,
  setupAppTestMocks,
  snapshot
} from "../test/appTestHarness.js";

describe("App settings", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    setupAppTestMocks();
  });

  it("opens the settings page from the sidebar and lets the user close it", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings();

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Local profile" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Launch defaults" })).toBeInTheDocument();
    // The launcher prompt is hidden while the settings panel is showing.
    expect(screen.queryByLabelText("Task prompt")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
  });

  it("settings Default model label is wired to the select via htmlFor/id", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });
    await openSettings("Agents");
    await screen.findByRole("heading", { name: "Model defaults" });

    // getByLabelText only resolves the SELECT element when label.htmlFor
    // matches the select's id — i.e. the wiring is correct end-to-end.
    const select = screen.getByLabelText("Default model");
    expect(select.tagName).toBe("SELECT");
  });

  it("settings Thinking blocks default persists to localStorage", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });
    await openSettings("Agents");

    const group = await screen.findByRole("radiogroup", { name: "Thinking blocks" });
    fireEvent.click(within(group).getByRole("radio", { name: "Show expanded" }));

    await waitFor(() =>
      expect(window.localStorage.getItem("argmax.thinking.expanded")).toBe("true")
    );
  });

  it("hides sidebar session tokens by default and shows them when enabled in Settings", async () => {
    sessionCostSummary.mockResolvedValue({
      sessionId: "session-1",
      modelId: "gpt-5.3-codex",
      tokens: { input: 12_300, output: 4_500, cacheRead: 50_000, cacheWrite: 0 },
      costUsd: 0.012
    });

    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    // Push a delta carrying token counts so the workspace-token map populates.
    act(() => {
      dashboardDeltaListener?.({
        sessions: [
          {
            ...((snapshot.sessions[0] ?? missingSession())),
            costUsd: 0.012,
            tokens: { input: 12_300, output: 4_500, cacheRead: 50_000, cacheWrite: 0 }
          }
        ]
      });
    });

    expect(screen.queryByLabelText(/Tokens: 16\.8k/)).not.toBeInTheDocument();

    await openSettings();
    await screen.findByRole("heading", { name: "Appearance" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Show session tokens in sidebar" }));

    await waitFor(() =>
      expect(window.localStorage.getItem("argmax.sidebar.tokens.visible")).toBe("true")
    );
    // 12.3k + 4.5k = 16.8k displayed; cache reads stay in the tooltip only.
    const cell = await screen.findByLabelText(/Tokens: 16\.8k/);
    expect(cell).toHaveTextContent("16.8k");
    expect(cell.getAttribute("title")).toContain("50k cached");
  });

  it("renders the CostPanel rows and totals on session detail", async () => {
    const costed: DashboardSnapshot = {
      ...snapshot,
      sessions: snapshot.sessions.map((session) =>
        session.id === "session-1"
          ? {
              ...session,
              costUsd: 4.32,
              tokens: { input: 1200, output: 340, cacheRead: 100, cacheWrite: 0 }
            }
          : session
      )
    };
    mockDashboardSnapshot(costed);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    const panel = await screen.findByRole("region", { name: "Session cost summary" });
    expect(panel).toBeInTheDocument();

    await waitFor(() => {
      expect(within(panel).getByLabelText(/Total cost:/)).toHaveTextContent("$4.32");
    });

    fireEvent.click(within(panel).getByRole("button", { name: "Toggle cost breakdown" }));

    const inputRow = within(panel).getByRole("row", { name: "Input usage" });
    expect(within(inputRow).getByTitle("Input tokens: 1,200")).toBeInTheDocument();

    const outputRow = within(panel).getByRole("row", { name: "Output usage" });
    expect(within(outputRow).getByTitle("Output tokens: 340")).toBeInTheDocument();

    expect(within(panel).getByRole("row", { name: "Cache read usage" })).toBeInTheDocument();
    expect(within(panel).getByRole("row", { name: "Cache write usage" })).toBeInTheDocument();

    // Cost is projected from session.costUsd on the dashboard delta. The
    // panel must not fire a separate session:costSummary IPC.
    expect(sessionCostSummary).not.toHaveBeenCalled();
  });

  it("hides the chat cost card when disabled in Settings", async () => {
    const costed: DashboardSnapshot = {
      ...snapshot,
      sessions: snapshot.sessions.map((session) =>
        session.id === "session-1"
          ? {
              ...session,
              costUsd: 4.32,
              tokens: { input: 1200, output: 340, cacheRead: 100, cacheWrite: 0 }
            }
          : session
      )
    };
    mockDashboardSnapshot(costed);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("region", { name: "Session cost summary" })).toBeInTheDocument();

    await openSettings();
    await screen.findByRole("heading", { name: "Appearance" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Show cost in agent chat" }));

    await waitFor(() =>
      expect(window.localStorage.getItem("argmax.chat.cost.visible")).toBe("false")
    );
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));

    await screen.findByRole("button", { name: "Build dashboard" });
    expect(screen.queryByRole("region", { name: "Session cost summary" })).not.toBeInTheDocument();
  });

  it("disables the Open in IDE button when the workspace has no path yet", async () => {
    listDetectedIdes.mockResolvedValue([
      { id: "vscode", label: "VS Code", appPath: "/Applications/Visual Studio Code.app", hasCli: true }
    ]);
    const pathless: DashboardSnapshot = {
      ...snapshot,
      workspaces: snapshot.workspaces.map((workspace) => ({ ...workspace, path: "" }))
    };
    mockDashboardSnapshot(pathless);

    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    const ideButton = await screen.findByRole("button", { name: "Open in IDE" });
    expect(ideButton).toBeDisabled();
    expect(ideButton).toHaveAttribute("title", "Worktree not ready yet");
  });

  it("opens the default IDE when one is configured", async () => {
    window.localStorage.setItem("argmax.defaultIde", "vscode");

    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    const ideButton = await screen.findByRole("button", { name: "Open in IDE" });
    await waitFor(() => expect(ideButton).not.toBeDisabled());
    fireEvent.click(ideButton);

    await waitFor(() => expect(openInIde).toHaveBeenCalledTimes(1));
    expect(openInIde).toHaveBeenCalledWith({ workspaceId: "workspace-1", ide: "vscode" });
  });

  it("auto-selects the only detected GUI IDE when no default is stored", async () => {
    listDetectedIdes.mockResolvedValue([
      { id: "windsurf", label: "Windsurf", appPath: "/Applications/Windsurf.app", hasCli: false },
      { id: "terminal", label: "Terminal", appPath: "/System/Applications/Utilities/Terminal.app", hasCli: false }
    ]);

    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    const ideButton = await screen.findByRole("button", { name: "Open in IDE" });
    await waitFor(() => expect(ideButton.getAttribute("title")).toContain("Windsurf"));
    fireEvent.click(ideButton);

    await waitFor(() => expect(openInIde).toHaveBeenCalledTimes(1));
    expect(openInIde).toHaveBeenCalledWith({ workspaceId: "workspace-1", ide: "windsurf" });
  });

  it("lists every detected IDE in the chevron menu", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    const chevron = await screen.findByRole("button", { name: "Choose IDE" });
    await waitFor(() => expect(chevron).not.toBeDisabled());
    fireEvent.click(chevron);

    const menu = await screen.findByRole("menu", { name: "Open this worktree in" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.textContent)).toEqual(["VS Code", "Cursor", "Terminal"]);
  });

  it("opens the chosen IDE from the chevron menu without changing the default", async () => {
    window.localStorage.setItem("argmax.defaultIde", "vscode");

    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    const chevron = await screen.findByRole("button", { name: "Choose IDE" });
    await waitFor(() => expect(chevron).not.toBeDisabled());
    fireEvent.click(chevron);
    const menu = await screen.findByRole("menu", { name: "Open this worktree in" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Cursor" }));

    await waitFor(() => expect(openInIde).toHaveBeenCalledTimes(1));
    expect(openInIde).toHaveBeenCalledWith({ workspaceId: "workspace-1", ide: "cursor" });
    expect(window.localStorage.getItem("argmax.defaultIde")).toBe("vscode");
  });

  it("settings Tools section writes the chosen default IDE to localStorage", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings("Integrations");
    await screen.findByRole("heading", { name: "Default IDE" });

    const select = screen.getByRole("combobox", { name: "Default IDE" });
    fireEvent.change(select, { target: { value: "cursor" } });

    await waitFor(() => expect(window.localStorage.getItem("argmax.defaultIde")).toBe("cursor"));
  });

  it("settings Permissions section persists the chosen mode and propagates it through the next launch", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings("Agents");
    await screen.findByRole("heading", { name: "Permissions" });

    fireEvent.click(screen.getByRole("radio", { name: "Ask each time" }));
    await waitFor(() =>
      expect(window.localStorage.getItem("argmax.permissionMode")).toBe("ask-each-time")
    );

    // Close Settings to get back to the launcher.
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));

    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Gate this run" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() =>
      expect(launchProvider).toHaveBeenCalledWith(
        expect.objectContaining({ permissionMode: "ask-each-time" })
      )
    );
  });

  it("settings Appearance section switches the font family and persists it", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings();
    await screen.findByRole("heading", { name: "Appearance" });

    fireEvent.click(screen.getByRole("button", { name: "Font family" }));
    fireEvent.click(screen.getByRole("button", { name: "JetBrains Mono" }));

    await waitFor(() =>
      expect(window.localStorage.getItem("argmax.font.family")).toBe("jetbrains-mono")
    );
    expect(document.documentElement.getAttribute("data-font")).toBe("jetbrains-mono");
  });

  it("settings Appearance section wires the macOS-native options through to the document attribute", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings();
    await screen.findByRole("heading", { name: "Appearance" });

    for (const [label, id] of [
      ["System Mono", "system-mono"],
      ["Menlo", "menlo"],
      ["Monaco", "monaco"],
      ["Lilex", "lilex"]
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: "Font family" }));
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() =>
        expect(document.documentElement.getAttribute("data-font")).toBe(id)
      );
      expect(window.localStorage.getItem("argmax.font.family")).toBe(id);
    }
  });
});
