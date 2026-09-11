import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ArgmaxApi,
  RemoteApnsStatus,
  RemotePushDevice,
  RemoteStatus
} from "../../../shared/types.js";
import { RemoteSettings } from "./RemoteSettings.js";

afterEach(() => {
  cleanup();
  delete (window as unknown as { argmax?: ArgmaxApi }).argmax;
});

function remoteStatus(overrides: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    enabled: true,
    serving: true,
    port: 8790,
    token: "a".repeat(32),
    ntfyTopic: null,
    localUrl: "http://127.0.0.1:8790/mobile.html",
    tailnetUrl: "http://mac.tailnet.ts.net:8790/mobile.html",
    tailscaleRunning: true,
    pairingUrl: `http://mac.tailnet.ts.net:8790/mobile.html#token=${"a".repeat(32)}`,
    qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    serveCommand: "tailscale serve --bg 8790",
    apns: apnsStatus(),
    ...overrides
  };
}

function apnsStatus(overrides: Partial<RemoteApnsStatus> = {}): RemoteApnsStatus {
  return {
    configured: false,
    keyPath: null,
    keyId: null,
    teamId: null,
    sandbox: false,
    devices: [],
    ...overrides
  };
}

function pushDevice(overrides: Partial<RemotePushDevice> = {}): RemotePushDevice {
  return {
    token: "a1b2c3d4e5f6a7b8",
    name: "Adam's iPhone",
    registeredAt: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

/** A fully wired APNs block: key saved, one phone paired. */
function pairedApns(): RemoteApnsStatus {
  return apnsStatus({
    configured: true,
    keyPath: "/Users/adam/Keys/AuthKey_ABC1234567.p8",
    keyId: "ABC1234567",
    teamId: "TEAM123456",
    devices: [pushDevice()]
  });
}

function installRemoteStub(overrides: {
  getStatus?: ReturnType<typeof vi.fn>;
  setConfig?: ReturnType<typeof vi.fn>;
  testNotification?: ReturnType<typeof vi.fn>;
  setApnsConfig?: ReturnType<typeof vi.fn>;
  unregisterPushDevice?: ReturnType<typeof vi.fn>;
  pushTest?: ReturnType<typeof vi.fn>;
}): void {
  (window as unknown as { argmax: ArgmaxApi }).argmax = {
    remote: {
      getStatus: overrides.getStatus ?? vi.fn().mockResolvedValue(remoteStatus()),
      setConfig: overrides.setConfig ?? vi.fn(),
      testNotification: overrides.testNotification ?? vi.fn(),
      setApnsConfig: overrides.setApnsConfig ?? vi.fn(),
      registerPushDevice: vi.fn(),
      unregisterPushDevice: overrides.unregisterPushDevice ?? vi.fn(),
      pushTest: overrides.pushTest ?? vi.fn()
    }
  } as unknown as ArgmaxApi;
}

describe("RemoteSettings", () => {
  it("shows the pairing QR and serve command when the bridge is enabled", async () => {
    installRemoteStub({});
    render(<RemoteSettings />);

    expect(await screen.findByRole("img", { name: "Pairing QR code" })).toBeInTheDocument();
    expect(screen.getByText("tailscale serve --bg 8790")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Enable phone remote" })).toBeChecked();
  });

  it("saves the toggle through remote:set-config and reflects the response", async () => {
    const setConfig = vi.fn().mockResolvedValue(remoteStatus({ enabled: false, serving: false }));
    installRemoteStub({
      getStatus: vi.fn().mockResolvedValue(remoteStatus()),
      setConfig
    });
    render(<RemoteSettings />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "Enable phone remote" }));

    await waitFor(() => {
      expect(setConfig).toHaveBeenCalledWith({ enabled: false, port: 8790, ntfyTopic: "" });
    });
    expect(screen.getByRole("checkbox", { name: "Enable phone remote" })).not.toBeChecked();
    expect(screen.queryByRole("img", { name: "Pairing QR code" })).not.toBeInTheDocument();
  });

  it("warns when the bridge is enabled but the server failed to start", async () => {
    installRemoteStub({ getStatus: vi.fn().mockResolvedValue(remoteStatus({ serving: false })) });
    render(<RemoteSettings />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The bridge is enabled but not running."
    );
  });

  it("sends a test notification once a topic is saved", async () => {
    const testNotification = vi.fn().mockResolvedValue({ ok: true });
    installRemoteStub({
      getStatus: vi
        .fn()
        .mockResolvedValue(remoteStatus({ ntfyTopic: "https://ntfy.sh/argmax-test" })),
      testNotification
    });
    render(<RemoteSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Send test notification" }));

    await waitFor(() => {
      expect(testNotification).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Test notification sent");
  });

  it("toggles with the saved port and topic, leaving unsaved edits to Save changes", async () => {
    const setConfig = vi.fn().mockResolvedValue(remoteStatus({ enabled: false, serving: false }));
    installRemoteStub({ setConfig });
    render(<RemoteSettings />);

    // Half-typed port, unsaved topic: neither may ride along on the switch.
    fireEvent.change(await screen.findByLabelText("Port"), { target: { value: "87" } });
    fireEvent.change(screen.getByLabelText("ntfy topic"), {
      target: { value: "https://ntfy.sh/not-saved-yet" }
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable phone remote" }));

    await waitFor(() => {
      expect(setConfig).toHaveBeenCalledWith({ enabled: false, port: 8790, ntfyTopic: "" });
    });
  });

  it("saves the APNs key fields and keeps the sandbox setting", async () => {
    const setApnsConfig = vi.fn().mockResolvedValue(remoteStatus({ apns: pairedApns() }));
    installRemoteStub({ setApnsConfig });
    render(<RemoteSettings />);

    fireEvent.change(await screen.findByLabelText("APNs key file"), {
      target: { value: "/Users/adam/Keys/AuthKey_ABC1234567.p8" }
    });
    fireEvent.change(screen.getByLabelText("Key ID"), { target: { value: "ABC1234567" } });
    fireEvent.change(screen.getByLabelText("Team ID"), { target: { value: "TEAM123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Save push key" }));

    await waitFor(() => {
      expect(setApnsConfig).toHaveBeenCalledWith({
        keyPath: "/Users/adam/Keys/AuthKey_ABC1234567.p8",
        keyId: "ABC1234567",
        teamId: "TEAM123456",
        sandbox: false
      });
    });
  });

  it("sends the sandbox toggle with the saved key fields, not half-typed ones", async () => {
    const setApnsConfig = vi.fn().mockResolvedValue(remoteStatus({ apns: pairedApns() }));
    installRemoteStub({
      getStatus: vi.fn().mockResolvedValue(remoteStatus({ apns: pairedApns() })),
      setApnsConfig
    });
    render(<RemoteSettings />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "Use the Apple sandbox host" }));

    await waitFor(() => {
      expect(setApnsConfig).toHaveBeenCalledWith({
        keyPath: "/Users/adam/Keys/AuthKey_ABC1234567.p8",
        keyId: "ABC1234567",
        teamId: "TEAM123456",
        sandbox: true
      });
    });
  });

  it("lists paired phones and removes one", async () => {
    const unregisterPushDevice = vi.fn().mockResolvedValue([]);
    installRemoteStub({
      getStatus: vi.fn().mockResolvedValue(remoteStatus({ apns: pairedApns() })),
      unregisterPushDevice
    });
    render(<RemoteSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove Adam's iPhone" }));

    await waitFor(() => {
      expect(unregisterPushDevice).toHaveBeenCalledWith({ token: "a1b2c3d4e5f6a7b8" });
    });
    expect(screen.queryByRole("button", { name: "Remove Adam's iPhone" })).not.toBeInTheDocument();
    expect(screen.getByText(/No phones paired yet/)).toBeInTheDocument();
  });

  it("sends a test push once a key and a phone are in place", async () => {
    const pushTest = vi
      .fn()
      .mockResolvedValue([
        { token: "a1b2c3d4e5f6a7b8", name: "Adam's iPhone", ok: true, error: null }
      ]);
    installRemoteStub({
      getStatus: vi.fn().mockResolvedValue(remoteStatus({ apns: pairedApns() })),
      pushTest
    });
    render(<RemoteSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Send test push" }));

    await waitFor(() => {
      expect(pushTest).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Test push sent to 1 device.");
  });

  it("names the phone Apple rejected instead of reporting a blanket failure", async () => {
    const pushTest = vi.fn().mockResolvedValue([
      { token: "a1b2c3d4e5f6a7b8", name: "Adam's iPhone", ok: true, error: null },
      { token: "ffff", name: "Old iPhone", ok: false, error: "APNs returned 410 (Unregistered)" }
    ]);
    installRemoteStub({
      getStatus: vi.fn().mockResolvedValue(
        remoteStatus({
          apns: { ...pairedApns(), devices: [pushDevice(), pushDevice({ token: "ffff", name: "Old iPhone" })] }
        })
      ),
      pushTest
    });
    render(<RemoteSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Send test push" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Old iPhone: APNs returned 410 (Unregistered)"
    );
  });

  it("blocks the test push until the key is saved and a phone is paired", async () => {
    installRemoteStub({});
    render(<RemoteSettings />);

    const button = await screen.findByRole("button", { name: "Send test push" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Set the key path, key id, and team id first");
  });

  it("rejects an out-of-range port before calling the backend", async () => {
    const setConfig = vi.fn();
    installRemoteStub({ setConfig });
    render(<RemoteSettings />);

    fireEvent.change(await screen.findByLabelText("Port"), { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(setConfig).not.toHaveBeenCalled();
    // Validation failures surface as alerts (data-status="error"), matching
    // the ProjectsSettings status convention.
    expect(screen.getByRole("alert")).toHaveTextContent("Port must be between 1024 and 65535.");
  });
});
