import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { DashboardSnapshot } from "../shared/types.js";
import { ACCENT_STORAGE_KEY } from "./lib/accent.js";
import { CHAT_WIDTH_KEY } from "./lib/chatWidth.js";
import { FAST_MODE_KEY } from "./lib/uiPreferences.js";
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

async function openArgmaxMenu(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Argmax menu" }));
  return screen.findByRole("menu", { name: "Argmax menu" });
}

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

    fireEvent.keyDown(document, { key: ",", metaKey: true });
    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
  });

  it("shows a local identity menu instead of a Ready settings footer", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    const trigger = screen.getByRole("button", { name: "Argmax menu" });
    expect(trigger).toHaveTextContent("argmax@local");
    expect(trigger).not.toHaveTextContent("Local workspace");
    expect(within(trigger).queryByText(/ready/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();

    const menu = await openArgmaxMenu();
    expect(within(menu).getByRole("menuitem", { name: /Command Palette/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Settings/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Providers/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Diagnostics & Logs/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Keyboard Shortcuts/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /About Argmax/ })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Argmax menu" })).not.toBeInTheDocument());
  });

  it("opens command palette and keyboard shortcuts from the identity menu", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    let menu = await openArgmaxMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Command Palette/ }));
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument());

    menu = await openArgmaxMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Keyboard Shortcuts/ }));
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("deep-links providers, diagnostics, and about from the identity menu", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    let menu = await openArgmaxMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Providers/ }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Providers" })).toBeInTheDocument();

    menu = await openArgmaxMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Diagnostics & Logs/ }));
    expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeInTheDocument();

    menu = await openArgmaxMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /About Argmax/ }));
    expect(await screen.findByRole("heading", { name: "About" })).toBeInTheDocument();
    expect(screen.getByText("Claude Code · Codex · Cursor")).toBeInTheDocument();
  });

  it("resets the reused workspace scroller when opening settings", async () => {
    const { container } = render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    const scroller = container.querySelector(".work-scroll");
    expect(scroller).toBeInstanceOf(HTMLElement);
    (scroller as HTMLElement).scrollTop = 96;

    await openSettings();

    const settingsScroller = container.querySelector(".settings-scroll");
    expect(settingsScroller).toBe(scroller);
    expect((settingsScroller as HTMLElement).scrollTop).toBe(0);
  });

  it("resets settings scroll when the active Settings sidebar button is clicked again", async () => {
    const { container } = render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });
    await openSettings();

    const settingsScroller = container.querySelector(".settings-scroll");
    expect(settingsScroller).toBeInstanceOf(HTMLElement);
    (settingsScroller as HTMLElement).scrollTop = 96;

    await openSettings();

    expect((settingsScroller as HTMLElement).scrollTop).toBe(0);
  });

  it("toggles settings with Cmd+, including from the focused launcher prompt", async () => {
    render(<App />);

    const prompt = await screen.findByLabelText("Task prompt");
    prompt.focus();
    fireEvent.keyDown(prompt, { key: ",", metaKey: true });

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: ",", metaKey: true });
    expect(await screen.findByLabelText("Task prompt")).toBeInTheDocument();
  });

  it("settings Default model label is wired to the custom picker via htmlFor/id", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });
    await openSettings("Agents");
    await screen.findByRole("heading", { name: "Model defaults" });

    // getByLabelText only resolves the trigger when label.htmlFor matches the
    // picker button's id — i.e. the wiring is correct end-to-end.
    const trigger = screen.getByLabelText("Default model");
    expect(trigger.tagName).toBe("BUTTON");
    fireEvent.click(trigger);
    const listbox = await screen.findByRole("listbox", { name: "Default model" });
    expect(listbox).toBeInTheDocument();
    expect(listbox).not.toHaveTextContent("GPT-5.3");
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
      modelId: "gpt-5.5",
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

    window.localStorage.setItem("argmax.chat.cost.visible", "true");
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

    window.localStorage.setItem("argmax.chat.cost.visible", "true");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));
    expect(await screen.findByRole("region", { name: "Session cost summary" })).toBeInTheDocument();

    await openSettings();
    await screen.findByRole("heading", { name: "Appearance" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Show cost in agent chat" }));

    await waitFor(() =>
      expect(window.localStorage.getItem("argmax.chat.cost.visible")).toBe("false")
    );
    fireEvent.keyDown(document, { key: ",", metaKey: true });

    await screen.findByRole("button", { name: "Build dashboard" });
    expect(screen.queryByRole("region", { name: "Session cost summary" })).not.toBeInTheDocument();
  });

  it("disables the IDE chooser when the workspace has no path yet", async () => {
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

    const ideButton = await screen.findByRole("button", { name: "Choose IDE" });
    expect(ideButton).toBeDisabled();
    expect(ideButton).toHaveAttribute("title", "Worktree not ready yet");
  });

  it("auto-selects the only detected GUI IDE as the menu default when none is stored", async () => {
    listDetectedIdes.mockResolvedValue([
      { id: "windsurf", label: "Windsurf", appPath: "/Applications/Windsurf.app", hasCli: false },
      { id: "terminal", label: "Terminal", appPath: "/System/Applications/Utilities/Terminal.app", hasCli: false }
    ]);

    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    const chevron = await screen.findByRole("button", { name: "Choose IDE" });
    await waitFor(() => expect(chevron).not.toBeDisabled());
    fireEvent.click(chevron);

    const menu = await screen.findByRole("menu", { name: "Open this worktree in" });
    expect(within(menu).getByRole("menuitem", { name: "Windsurf" })).toHaveAttribute("aria-pressed", "true");
    expect(within(menu).getByRole("menuitem", { name: "Terminal" })).toHaveAttribute("aria-pressed", "false");
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

    const trigger = screen.getByRole("button", { name: "Default IDE" });
    expect(trigger.tagName).toBe("BUTTON");
    fireEvent.click(trigger);
    const listbox = await screen.findByRole("listbox", { name: "Default IDE" });
    fireEvent.click(within(listbox).getByRole("button", { name: "Cursor" }));

    await waitFor(() => expect(window.localStorage.getItem("argmax.defaultIde")).toBe("cursor"));

    fireEvent.click(trigger);
    fireEvent.click(within(await screen.findByRole("listbox", { name: "Default IDE" })).getByRole("button", {
      name: "Ask each time"
    }));

    await waitFor(() => expect(window.localStorage.getItem("argmax.defaultIde")).toBeNull());
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

    // Toggle Settings closed to get back to the launcher.
    fireEvent.keyDown(document, { key: ",", metaKey: true });

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

  it("settings Fast mode defaults off, persists, and propagates through the next launch", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings("Agents");
    await screen.findByRole("heading", { name: "Model defaults" });

    const toggle = screen.getByRole("checkbox", { name: "Fast mode for Claude and Codex" });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => expect(window.localStorage.getItem(FAST_MODE_KEY)).toBe("true"));

    fireEvent.keyDown(document, { key: ",", metaKey: true });
    fireEvent.change(await screen.findByLabelText("Task prompt"), {
      target: { value: "Launch quickly" }
    });
    fireEvent.click(screen.getByTitle("Start agent"));

    await waitFor(() =>
      expect(launchProvider).toHaveBeenCalledWith(expect.objectContaining({ fastMode: true }))
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
    expect(window.localStorage.getItem("argmax.font.size")).toBe("default");
    expect(document.documentElement.getAttribute("data-font-size")).toBe("default");
  });

  it("settings Appearance section switches the font size and persists it", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings();
    await screen.findByRole("heading", { name: "Appearance" });

    const fontSize = screen.getByRole("radiogroup", { name: "Font size" });
    expect(within(fontSize).getByRole("radio", { name: "Default" })).toBeChecked();

    fireEvent.click(within(fontSize).getByRole("radio", { name: "Large" }));
    await waitFor(() =>
      expect(window.localStorage.getItem("argmax.font.size")).toBe("large")
    );
    expect(document.documentElement.getAttribute("data-font-size")).toBe("large");

    fireEvent.click(within(fontSize).getByRole("radio", { name: "Small" }));
    await waitFor(() =>
      expect(window.localStorage.getItem("argmax.font.size")).toBe("small")
    );
    expect(document.documentElement.getAttribute("data-font-size")).toBe("small");
  });

  it("settings Appearance section renders the Accent picker and persists accent changes", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings();
    await screen.findByRole("heading", { name: "Appearance" });

    const accentPicker = screen.getByRole("radiogroup", { name: "Accent" });
    expect(within(accentPicker).getByRole("radio", { name: "Green" })).toHaveAttribute(
      "aria-checked",
      "true"
    );

    fireEvent.click(within(accentPicker).getByRole("radio", { name: "Orange" }));
    await waitFor(() =>
      expect(window.localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("orange")
    );
    expect(document.documentElement.getAttribute("data-accent")).toBe("orange");

    fireEvent.click(within(accentPicker).getByRole("radio", { name: "Blue" }));
    await waitFor(() =>
      expect(window.localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("blue")
    );
    expect(document.documentElement.getAttribute("data-accent")).toBe("blue");
  });

  it("settings Appearance section switches chat width and persists it", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings();
    await screen.findByRole("heading", { name: "Appearance" });

    const chatWidth = screen.getByRole("radiogroup", { name: "Chat width" });
    expect(within(chatWidth).getByRole("radio", { name: "Default" })).toBeChecked();
    expect(screen.getByRole("main")).toHaveAttribute("data-chat-width", "standard");

    fireEvent.click(within(chatWidth).getByRole("radio", { name: "Narrow" }));
    await waitFor(() =>
      expect(window.localStorage.getItem(CHAT_WIDTH_KEY)).toBe("narrow")
    );
    expect(screen.getByRole("main")).toHaveAttribute("data-chat-width", "narrow");

    fireEvent.click(within(chatWidth).getByRole("radio", { name: "Wide" }));
    await waitFor(() =>
      expect(window.localStorage.getItem(CHAT_WIDTH_KEY)).toBe("wide")
    );
    expect(screen.getByRole("main")).toHaveAttribute("data-chat-width", "wide");
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
