import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, SyncStatus } from "../../../shared/types.js";
import { SessionSyncSettings } from "./SessionSyncSettings.js";

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    config: { claude: false, codex: false, cursor: false, opencode: false, windowHours: 24 },
    supportedProviders: ["claude"],
    lastRunAt: null,
    importedCount: 0,
    lastError: null,
    ...overrides
  };
}

const syncStub = {
  getStatus: vi.fn(() => Promise.resolve(status())),
  setConfig: vi.fn(() => Promise.resolve(status())),
  runNow: vi.fn(() => Promise.resolve(status()))
};

beforeEach(() => {
  syncStub.getStatus.mockClear();
  syncStub.setConfig.mockClear();
  syncStub.getStatus.mockResolvedValue(status());
  syncStub.setConfig.mockResolvedValue(status());
  window.argmax = { sync: syncStub } as unknown as ArgmaxApi;
});

afterEach(() => {
  cleanup();
  delete (window as { argmax?: ArgmaxApi }).argmax;
});

describe("SessionSyncSettings", () => {
  it("turning a provider on saves it and reports what was imported", async () => {
    syncStub.setConfig.mockResolvedValue(
      status({
        config: { claude: true, codex: false, cursor: false, opencode: false, windowHours: 24 },
        importedCount: 3
      })
    );
    render(<SessionSyncSettings />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "Claude Code" }));

    await waitFor(() =>
      expect(syncStub.setConfig).toHaveBeenCalledWith(
        expect.objectContaining({ claude: true, windowHours: 24 })
      )
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Imported 3 sessions");
  });

  it("changing the window re-runs the sweep with the new range", async () => {
    render(<SessionSyncSettings />);
    fireEvent.click(await screen.findByRole("radio", { name: /Last 7 days/ }));
    await waitFor(() =>
      expect(syncStub.setConfig).toHaveBeenCalledWith(
        expect.objectContaining({ windowHours: 168 })
      )
    );
  });

  it("says what turning sync off removes, and confirms it afterwards", async () => {
    syncStub.getStatus.mockResolvedValue(
      status({
        config: { claude: true, codex: false, cursor: false, opencode: false, windowHours: 24 }
      })
    );
    render(<SessionSyncSettings />);

    // The warning is visible before the user acts, not only after.
    expect(
      await screen.findByText(/removes the synced sessions you haven't continued/i)
    ).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("checkbox", { name: "Claude Code" }));
    await waitFor(() =>
      expect(syncStub.setConfig).toHaveBeenCalledWith(expect.objectContaining({ claude: false }))
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Synced sessions you never continued were removed"
    );
  });

  it("does not offer providers whose transcripts Argmax cannot read", async () => {
    render(<SessionSyncSettings />);
    const codex = await screen.findByRole("checkbox", { name: "Codex" });
    fireEvent.click(codex);
    expect(syncStub.setConfig).not.toHaveBeenCalled();
    expect(screen.getAllByText(/can't read this agent's transcript format/i).length).toBeGreaterThan(
      0
    );
  });

  it("surfaces a failed sweep instead of claiming success", async () => {
    syncStub.setConfig.mockResolvedValue(status({ lastError: "permission denied" }));
    render(<SessionSyncSettings />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Claude Code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
  });
});
