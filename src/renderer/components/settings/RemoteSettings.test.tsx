import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, RemoteStatus } from "../../../shared/types.js";
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
    serveCommand: "tailscale serve --http=8790 --bg 8790",
    ...overrides
  };
}

function installRemoteStub(overrides: {
  getStatus?: ReturnType<typeof vi.fn>;
  setConfig?: ReturnType<typeof vi.fn>;
  testNotification?: ReturnType<typeof vi.fn>;
}): void {
  (window as unknown as { argmax: ArgmaxApi }).argmax = {
    remote: {
      getStatus: overrides.getStatus ?? vi.fn().mockResolvedValue(remoteStatus()),
      setConfig: overrides.setConfig ?? vi.fn(),
      testNotification: overrides.testNotification ?? vi.fn()
    }
  } as unknown as ArgmaxApi;
}

describe("RemoteSettings", () => {
  it("shows the pairing QR and serve command when the bridge is enabled", async () => {
    installRemoteStub({});
    render(<RemoteSettings />);

    expect(await screen.findByRole("img", { name: "Pairing QR code" })).toBeInTheDocument();
    expect(screen.getByText("tailscale serve --http=8790 --bg 8790")).toBeInTheDocument();
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
    expect(screen.getByRole("status")).toHaveTextContent("Test notification sent");
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
