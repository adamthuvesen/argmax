import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { DashboardSnapshot } from "../shared/types.js";
import { ACCENT_STORAGE_KEY } from "./lib/accent.js";
import { CHAT_WIDTH_KEY } from "./lib/chatWidth.js";
import { FAST_MODE_KEY, RANDOM_SESSION_ICON_KEY } from "./lib/uiPreferences.js";
import { APP_VERSION_LABEL } from "../shared/appVersion.js";
import {
  launchProvider,
  listDetectedIdes,
  mockDashboardSnapshot,
  openInIde,
  providersDiscover,
  openSettings,
  sessionCostSummary,
  setupAppTestMocks,
  snapshot
} from "../test/appTestHarness.js";

async function openArgmaxMenu(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Argmax menu" }));
  return screen.findByRole("menu", { name: "Argmax menu" });
}

// The IDE chooser lives in the session row's right-click menu; discovery is
// async, so wait for the item to come out of its "no IDEs yet" disabled state.
async function openIdeMenu(): Promise<HTMLElement> {
  fireEvent.contextMenu(screen.getByRole("button", { name: "Build dashboard" }));
  const ideItem = await screen.findByRole("menuitem", { name: "Open in IDE" });
  await waitFor(() => expect(ideItem).not.toBeDisabled());
  fireEvent.click(ideItem);
  return ideItem;
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
    expect(trigger).toHaveTextContent("Argmax");
    expect(trigger).toHaveTextContent(APP_VERSION_LABEL);
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
    expect(screen.getByText("Claude Code · Codex · Cursor · OpenCode")).toBeInTheDocument();
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

  it("settings Single line tool-call display persists and disables the groups row", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });
    await openSettings("Agents");

    const group = await screen.findByRole("radiogroup", { name: "Tool calls in chat" });
    fireEvent.click(within(group).getByRole("radio", { name: "Single line" }));

    await waitFor(() =>
      expect(window.localStorage.getItem("argmax.toolCalls.display")).toBe("single-line")
    );

    const groupsGroup = screen.getByRole("radiogroup", { name: "Tool call groups" });
    expect(within(groupsGroup).getByRole("radio", { name: "Show expanded" })).toBeDisabled();
  });

  it("disables the composer pixel field by default and persists turning it on", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings();
    await screen.findByRole("heading", { name: "Appearance" });

    const toggle = screen.getByRole("checkbox", { name: "Pixel field in composer" });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(window.localStorage.getItem("argmax.composer.pixelField.enabled")).toBe("true")
    );
  });

  it("disables random session icons by default and persists turning them on", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings();
    await screen.findByRole("heading", { name: "Launch defaults" });

    const toggle = screen.getByRole("checkbox", { name: "Random icon for new sessions" });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(window.localStorage.getItem(RANDOM_SESSION_ICON_KEY)).toBe("true")
    );
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

    fireEvent.contextMenu(screen.getByRole("button", { name: "Build dashboard" }));
    const ideItem = await screen.findByRole("menuitem", { name: "Open in IDE" });
    expect(ideItem).toBeDisabled();
    expect(ideItem).toHaveAttribute("title", "Worktree not ready yet");
  });

  it("auto-selects the only detected GUI IDE as the menu default when none is stored", async () => {
    listDetectedIdes.mockResolvedValue([
      { id: "windsurf", label: "Windsurf", appPath: "/Applications/Windsurf.app", hasCli: false },
      { id: "terminal", label: "Terminal", appPath: "/System/Applications/Utilities/Terminal.app", hasCli: false }
    ]);

    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    const ideItem = await openIdeMenu();
    expect(ideItem).not.toBeDisabled();

    const menu = await screen.findByRole("menu", { name: "Open this worktree in" });
    expect(within(menu).getByRole("menuitem", { name: "Windsurf" })).toHaveAttribute("aria-pressed", "true");
    expect(within(menu).getByRole("menuitem", { name: "Terminal" })).toHaveAttribute("aria-pressed", "false");
  });

  it("lists every detected IDE in the right-click menu", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openIdeMenu();

    const menu = await screen.findByRole("menu", { name: "Open this worktree in" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.textContent)).toEqual(["VS Code", "Cursor", "Terminal"]);
  });

  it("opens the chosen IDE from the right-click menu without changing the default", async () => {
    window.localStorage.setItem("argmax.defaultIde", "vscode");

    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openIdeMenu();
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
    // Opens upward so the menu does not cover the MCP servers section below it.
    expect(listbox).toHaveAttribute("data-placement", "above");
    fireEvent.click(within(listbox).getByRole("button", { name: "Cursor" }));

    await waitFor(() => expect(window.localStorage.getItem("argmax.defaultIde")).toBe("cursor"));

    fireEvent.click(trigger);
    fireEvent.click(within(await screen.findByRole("listbox", { name: "Default IDE" })).getByRole("button", {
      name: "Ask each time"
    }));

    // "Ask each time" persists the explicit "none" sentinel — a missing key now
    // means the factory default (Cursor), so removal would silently re-pin it.
    await waitFor(() => expect(window.localStorage.getItem("argmax.defaultIde")).toBe("none"));
  });

  it("settings Permissions section persists the chosen mode and propagates it through the next launch", async () => {
    providersDiscover.mockResolvedValue([
      {
        provider: "claude",
        displayName: "Claude Code",
        binaryName: "claude",
        installed: true,
        binaryPath: "/usr/local/bin/claude",
        version: "1.2.3",
        authenticated: true,
        setupGuidance: null,
        approvalSupport: "respondable"
      }
    ]);
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
    expect(window.localStorage.getItem("argmax.font.scale")).toBe("6");
    expect(document.documentElement.getAttribute("data-font-size")).toBe("6");
  });

  it("settings Appearance section switches the app font size and persists it", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings();
    await screen.findByRole("heading", { name: "Appearance" });

    const fontSize = screen.getByRole("slider", { name: "App font size" });
    expect(fontSize).toHaveValue("6");

    // The slider reaches past the old 1–5 scale at both ends.
    fireEvent.change(fontSize, { target: { value: "10" } });
    await waitFor(() => expect(window.localStorage.getItem("argmax.font.scale")).toBe("10"));
    expect(document.documentElement.getAttribute("data-font-size")).toBe("10");

    fireEvent.change(fontSize, { target: { value: "1" } });
    await waitFor(() => expect(window.localStorage.getItem("argmax.font.scale")).toBe("1"));
    expect(document.documentElement.getAttribute("data-font-size")).toBe("1");
  });

  it("settings Appearance section sizes agent windows independently of app chrome", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings();
    await screen.findByRole("heading", { name: "Appearance" });

    const appFontSize = screen.getByRole("slider", { name: "App font size" });
    const chatFontSize = screen.getByRole("slider", { name: "Agent window font size" });
    expect(chatFontSize).toHaveValue("6");

    fireEvent.change(chatFontSize, { target: { value: "7" } });
    await waitFor(() => expect(window.localStorage.getItem("argmax.font.scale.chat")).toBe("7"));
    // App chrome must not follow the agent-window size.
    expect(window.localStorage.getItem("argmax.font.scale")).toBe("6");
    expect(document.documentElement.getAttribute("data-font-size")).toBe("6");
    expect(appFontSize).toHaveValue("6");

    fireEvent.change(appFontSize, { target: { value: "5" } });
    await waitFor(() => expect(document.documentElement.getAttribute("data-font-size")).toBe("5"));
    expect(window.localStorage.getItem("argmax.font.scale.chat")).toBe("7");
    expect(chatFontSize).toHaveValue("7");
  });

  it("carries the agent-window size on the session grid, not on app chrome", async () => {
    window.localStorage.setItem("argmax.font.scale.chat", "5");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Build dashboard" }));

    const grid = await screen.findByRole("group", { name: "Session panes" });
    expect(grid).toHaveAttribute("data-font-size", "5");
    expect(document.documentElement.getAttribute("data-font-size")).toBe("6");
  });

  it("settings Appearance section switches chat width and persists it", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await openSettings();
    await screen.findByRole("heading", { name: "Appearance" });

    const chatWidth = screen.getByRole("radiogroup", { name: "Chat width" });
    expect(within(chatWidth).getByRole("radio", { name: "3" })).toBeChecked();
    expect(screen.getByRole("main")).toHaveAttribute("data-chat-width", "3");

    fireEvent.click(within(chatWidth).getByRole("radio", { name: "1" }));
    await waitFor(() => expect(window.localStorage.getItem(CHAT_WIDTH_KEY)).toBe("1"));
    expect(screen.getByRole("main")).toHaveAttribute("data-chat-width", "1");

    fireEvent.click(within(chatWidth).getByRole("radio", { name: "5" }));
    await waitFor(() => expect(window.localStorage.getItem(CHAT_WIDTH_KEY)).toBe("5"));
    expect(screen.getByRole("main")).toHaveAttribute("data-chat-width", "5");
  });

  it("migrates sizes stored by the old three-way settings", async () => {
    // Small/Default/Large sat one step either side of the default: levels 5, 6
    // and 7 on the font scale, 2, 3 and 4 on the chat-width scale.
    window.localStorage.setItem("argmax.font.size", "large");
    window.localStorage.setItem("argmax.font.size.chat", "small");
    window.localStorage.setItem(CHAT_WIDTH_KEY, "wide");
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    await waitFor(() =>
      expect(document.documentElement.getAttribute("data-font-size")).toBe("7")
    );
    expect(screen.getByRole("main")).toHaveAttribute("data-chat-width", "4");
    // The level is written back under the new key, so the legacy value
    // converts on first run.
    await waitFor(() => expect(window.localStorage.getItem("argmax.font.scale")).toBe("7"));
    expect(window.localStorage.getItem("argmax.font.scale.chat")).toBe("5");
    expect(window.localStorage.getItem(CHAT_WIDTH_KEY)).toBe("4");
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


  it("migrates a stored 1–5 level onto the 1–10 scale", async () => {
    window.localStorage.setItem("argmax.font.size", "4");
    render(<App />);
    await screen.findByRole("button", { name: "Build dashboard" });

    // Old level 4 (one step up) becomes new level 7 and persists under the new key.
    expect(document.documentElement.getAttribute("data-font-size")).toBe("7");
    await waitFor(() => expect(window.localStorage.getItem("argmax.font.scale")).toBe("7"));
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
