import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, WindowSnapshotStatus } from "../../../shared/types.js";
import { resetToastForTests, toastSnapshot } from "../../state/toast.js";
import { WindowSnapshotSettings } from "./WindowSnapshotSettings.js";

const remote = vi.hoisted(() => ({ active: false }));
vi.mock("../../lib/tauriBridge.js", () => ({ isRemoteBridge: () => remote.active }));

const base: WindowSnapshotStatus = {
  supported: true,
  permission: "granted",
  enabled: false,
  chord: "CommandOrControl+Alt+Shift+S",
  defaultChord: "CommandOrControl+Alt+Shift+S",
  registered: false,
  registrationError: null
};

const api = {
  status: vi.fn(),
  configure: vi.fn(),
  requestPermission: vi.fn()
};

beforeEach(() => {
  remote.active = false;
  resetToastForTests();
  for (const fn of Object.values(api)) fn.mockReset();
  api.status.mockResolvedValue(base);
  window.argmax = { windowSnapshot: api } as unknown as ArgmaxApi;
});

afterEach(() => {
  cleanup();
  delete (window as { argmax?: ArgmaxApi }).argmax;
});

describe("WindowSnapshotSettings", () => {
  it("turns the chord on through the host and shows what it returns", async () => {
    api.configure.mockResolvedValue({ ...base, enabled: true, registered: true });
    render(<WindowSnapshotSettings />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "Window snapshot shortcut" }));

    await waitFor(() =>
      expect(api.configure).toHaveBeenCalledWith({ enabled: true, chord: base.chord })
    );
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Window snapshot shortcut" })).toBeChecked()
    );
  });

  it("records a new chord and sends it", async () => {
    api.configure.mockResolvedValue({ ...base, chord: "Command+Alt+K" });
    render(<WindowSnapshotSettings />);

    fireEvent.click(await screen.findByRole("button", { name: /change shortcut/i }));
    fireEvent.keyDown(window, { code: "KeyK", metaKey: true, altKey: true });

    await waitFor(() =>
      expect(api.configure).toHaveBeenCalledWith({ enabled: false, chord: "Command+Alt+K" })
    );
  });

  it("refuses a key with no modifier before asking the host", async () => {
    render(<WindowSnapshotSettings />);

    fireEvent.click(await screen.findByRole("button", { name: /change shortcut/i }));
    fireEvent.keyDown(window, { code: "KeyK" });

    expect(api.configure).not.toHaveBeenCalled();
    expect(toastSnapshot()?.kind).toBe("error");
  });

  it("shows a registration error and keeps the old one on screen", async () => {
    api.configure.mockRejectedValue(new Error("Unable to register hotkey: was rejected by the OS"));
    api.status.mockResolvedValue({ ...base, enabled: true, registered: true });
    render(<WindowSnapshotSettings />);

    fireEvent.click(await screen.findByRole("button", { name: /change shortcut/i }));
    act(() => {
      fireEvent.keyDown(window, { code: "KeyK", metaKey: true });
    });

    await waitFor(() => expect(toastSnapshot()).toMatchObject({ kind: "error" }));
    expect(toastSnapshot()?.message).toContain("was rejected by the OS");
    expect(screen.getByRole("button", { name: /change shortcut, now/i })).toHaveTextContent("⌥⇧⌘S");
  });

  it("offers Screen Recording access when it is not granted", async () => {
    api.status.mockResolvedValue({ ...base, permission: "denied" });
    api.requestPermission.mockResolvedValue({ ...base, permission: "granted" });
    render(<WindowSnapshotSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Allow Screen Recording" }));

    await waitFor(() => expect(api.requestPermission).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Allowed")).toBeInTheDocument();
  });

  it("says a registration failure out loud while the chord is enabled", async () => {
    api.status.mockResolvedValue({ ...base, enabled: true, registrationError: "was rejected by the OS" });
    render(<WindowSnapshotSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("was rejected by the OS");
  });

  it("renders nothing and asks the host nothing over the remote bridge", async () => {
    remote.active = true;
    const { container } = render(<WindowSnapshotSettings />);
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
    expect(api.status).not.toHaveBeenCalled();
    expect(toastSnapshot()).toBeNull();
  });

  it("says plainly that it is macOS only elsewhere", async () => {
    api.status.mockResolvedValue({ ...base, supported: false, permission: "unsupported" });
    render(<WindowSnapshotSettings />);
    expect(await screen.findByText(/only available on macOS/i)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});
