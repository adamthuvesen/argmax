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

    const row = await screen.findByText("Claude Code");
    const li = row.closest("li");
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
});
