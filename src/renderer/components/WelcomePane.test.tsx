import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WelcomePane } from "./WelcomePane.js";
import type { ArgmaxApi, DiscoveredProvider } from "../../shared/types.js";

afterEach(() => {
  cleanup();
  delete (window as unknown as { argmax?: ArgmaxApi }).argmax;
});

function provider(overrides: Partial<DiscoveredProvider>): DiscoveredProvider {
  return {
    provider: "claude",
    displayName: "Claude Code",
    binaryName: "claude",
    installed: true,
    binaryPath: "/usr/local/bin/claude",
    version: "1.2.3",
    authenticated: true,
    setupGuidance: null,
    approvalSupport: "observable-only",
    ...overrides
  };
}

function installDiscoverStub(discover: ReturnType<typeof vi.fn>): void {
  (window as unknown as { argmax: ArgmaxApi }).argmax = {
    providers: { discover }
  } as unknown as ArgmaxApi;
}

describe("WelcomePane — provider discovery", () => {
  it("calls discover() with no force on mount, then force=true on Try again", async () => {
    const discover = vi.fn().mockResolvedValue([provider({})]);
    installDiscoverStub(discover);

    render(<WelcomePane onAddProject={vi.fn()} />);

    await waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    expect(discover).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: "Re-run provider discovery" }));
    await waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    expect(discover).toHaveBeenLastCalledWith(true);
  });

  it("shows login guidance for an installed-but-unauthenticated provider", async () => {
    const discover = vi.fn().mockResolvedValue([
      provider({
        authenticated: false,
        setupGuidance: "Claude Code is installed but not authenticated. Run `claude auth login` in your terminal, then refresh."
      })
    ]);
    installDiscoverStub(discover);

    render(<WelcomePane onAddProject={vi.fn()} />);

    const list = await screen.findByRole("list", { name: "Detected providers" });
    const li = within(list).getByText("Claude Code").closest("li");
    expect(li).toHaveAttribute("data-installed", "needs-login");
    expect(li && within(li).getByText(/not authenticated/i)).toBeInTheDocument();
  });

  it("enables Add Project once a provider is installed", async () => {
    const discover = vi.fn().mockResolvedValue([provider({})]);
    installDiscoverStub(discover);

    render(<WelcomePane onAddProject={vi.fn()} />);

    const cta = await screen.findByRole("button", { name: /Add Project/ });
    await waitFor(() => expect(cta).not.toBeDisabled());
  });

  it("keeps Add Project disabled when nothing is installed", async () => {
    const discover = vi.fn().mockResolvedValue([provider({ installed: false, authenticated: null })]);
    installDiscoverStub(discover);

    render(<WelcomePane onAddProject={vi.fn()} />);

    await screen.findByText("Claude Code");
    expect(screen.getByRole("button", { name: /Add Project/ })).toBeDisabled();
  });

  it("shows a copyable install command for a provider that is not installed", async () => {
    const discover = vi.fn().mockResolvedValue([
      provider({ installed: false, binaryPath: null, version: null, authenticated: null })
    ]);
    installDiscoverStub(discover);

    render(<WelcomePane onAddProject={vi.fn()} />);

    await screen.findByText("Claude Code");
    expect(screen.getByText("curl -fsSL https://claude.ai/install.sh | bash")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy Claude Code install command" })
    ).toBeInTheDocument();
  });

  it("shows a copyable login command for an installed-but-unauthenticated provider", async () => {
    const discover = vi.fn().mockResolvedValue([provider({ authenticated: false })]);
    installDiscoverStub(discover);

    render(<WelcomePane onAddProject={vi.fn()} />);

    await screen.findByText("Claude Code");
    expect(screen.getByText("claude auth login")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Claude Code login command" })).toBeInTheDocument();
  });

  it("re-probes discovery when the window regains focus while setup is incomplete", async () => {
    const discover = vi.fn().mockResolvedValue([provider({ authenticated: false })]);
    installDiscoverStub(discover);

    render(<WelcomePane onAddProject={vi.fn()} />);

    // Wait for the discovery result to render — the focus listener only
    // attaches once providers are known and setup is incomplete.
    await screen.findByText("Needs login");
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    expect(discover).toHaveBeenLastCalledWith(true);
  });

  it("does not re-probe on focus once every provider is ready", async () => {
    const discover = vi.fn().mockResolvedValue([provider({})]);
    installDiscoverStub(discover);

    render(<WelcomePane onAddProject={vi.fn()} />);

    await waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    fireEvent(window, new Event("focus"));
    // Give a queued refresh a chance to fire before asserting it didn't.
    await waitFor(() => expect(screen.getByText("Ready")).toBeInTheDocument());
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("lists per-provider MCP setup commands in the optional step", async () => {
    const discover = vi.fn().mockResolvedValue([provider({})]);
    installDiscoverStub(discover);

    render(<WelcomePane onAddProject={vi.fn()} />);

    await screen.findByText("Claude Code");
    expect(screen.getByText("claude mcp add <name> -- <command>")).toBeInTheDocument();
    expect(screen.getByText("codex mcp add <name> -- <command>")).toBeInTheDocument();
    expect(screen.getByText("opencode mcp add")).toBeInTheDocument();
  });
});
