import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeMcpSettings } from "./ClaudeMcpSettings.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ownServers = [
  { name: "trace", enabled: true },
  { name: "engram", enabled: true },
  { name: "off", enabled: false },
];

function stubSettings(overrides: Record<string, unknown> = {}) {
  const settings = {
    claudeMcp: vi.fn().mockResolvedValue({ preset: "everything", customServers: [], ownServers }),
    claudeMcpProbe: vi
      .fn()
      .mockResolvedValue({ connectors: 18, pluginServers: 24, pluginServersAtConnectorUrls: 4 }),
    setClaudeMcp: vi.fn(),
    ...overrides,
  };
  vi.stubGlobal("argmax", { settings });
  return settings;
}

/** The radio's name is its whole row: label, description, and count. */
function presetRadio(label: string): HTMLElement {
  return screen.getByRole("radio", { name: new RegExp(`^${label}`) });
}

describe("ClaudeMcpSettings", () => {
  it("counts the servers each preset starts from the real config and the probe", async () => {
    stubSettings();
    render(<ClaudeMcpSettings />);

    const group = await screen.findByRole("radiogroup", { name: "MCP at turn start" });
    expect(within(group).getByRole("radio", { name: /^Everything/ })).toBeChecked();
    // argmax + 2 enabled own servers + 18 connectors + 24 plugin servers − 4 duplicates.
    await waitFor(() => expect(presetRadio("Everything")).toHaveAccessibleName(/41 servers/));
    expect(presetRadio("Without claude.ai connectors")).toHaveAccessibleName(/27 servers/);
    expect(presetRadio("Your servers only")).toHaveAccessibleName(/3 servers/);
    expect(presetRadio("Argmax tools only")).toHaveAccessibleName(/1 server/);
    expect(screen.getByText(/leave plugin servers and claude.ai connectors off/)).toBeVisible();
  });

  it("saves a preset and keeps the Custom subset with it", async () => {
    const settings = stubSettings({
      claudeMcp: vi
        .fn()
        .mockResolvedValue({ preset: "everything", customServers: ["trace"], ownServers }),
      setClaudeMcp: vi.fn().mockResolvedValue({
        preset: "argmax-only",
        customServers: ["trace"],
        ownServers,
      }),
    });
    render(<ClaudeMcpSettings />);

    fireEvent.click(await screen.findByRole("radio", { name: /^Argmax tools only/ }));

    await waitFor(() =>
      expect(settings.setClaudeMcp).toHaveBeenCalledWith({
        preset: "argmax-only",
        customServers: ["trace"],
      }),
    );
    expect(screen.getByRole("radio", { name: /^Argmax tools only/ })).toBeChecked();
    expect(screen.queryByRole("group", { name: "Custom servers" })).not.toBeInTheDocument();
  });

  it("toggles Custom servers and flags a saved name the config no longer has", async () => {
    const settings = stubSettings({
      claudeMcp: vi
        .fn()
        .mockResolvedValue({ preset: "custom", customServers: ["removed"], ownServers }),
      setClaudeMcp: vi.fn().mockResolvedValue({
        preset: "custom",
        customServers: ["removed", "trace"],
        ownServers,
      }),
    });
    render(<ClaudeMcpSettings />);

    const servers = await screen.findByRole("group", { name: "Custom servers" });
    expect(within(servers).getByText(/Not in your Claude config/)).toBeVisible();
    expect(within(servers).getByRole("checkbox", { name: "Start off" })).toBeDisabled();
    expect(presetRadio("Custom")).toHaveAccessibleName(/1 server/);

    fireEvent.click(within(servers).getByRole("checkbox", { name: "Start trace" }));

    await waitFor(() =>
      expect(settings.setClaudeMcp).toHaveBeenCalledWith({
        preset: "custom",
        customServers: ["removed", "trace"],
      }),
    );
    expect(await within(servers).findByRole("checkbox", { name: "Start trace" })).toBeChecked();
    expect(presetRadio("Custom")).toHaveAccessibleName(/2 servers/);
  });

  it("restores the saved preset and reports a failed save", async () => {
    stubSettings({
      setClaudeMcp: vi.fn().mockRejectedValue(new Error("database is locked")),
    });
    render(<ClaudeMcpSettings />);

    fireEvent.click(await screen.findByRole("radio", { name: /^Your servers only/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("database is locked");
    expect(screen.getByRole("radio", { name: /^Everything/ })).toBeChecked();
  });

  it("says when the probe could not count connectors and plugin servers", async () => {
    stubSettings({ claudeMcpProbe: vi.fn().mockResolvedValue(null) });
    render(<ClaudeMcpSettings />);

    await waitFor(() =>
      expect(presetRadio("Everything")).toHaveAccessibleName(/Count unknown/),
    );
    expect(presetRadio("Your servers only")).toHaveAccessibleName(/3 servers/);
  });
});
