import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoRoutingSettings } from "./AutoRoutingSettings.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function enterKey(value: string): void {
  fireEvent.change(screen.getByLabelText("Jev API key"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

describe("AutoRoutingSettings", () => {
  it("saves a key and reports the routing it turned on", async () => {
    const setRoutingKey = vi.fn().mockResolvedValue({ enabled: true, keyHint: "…abcd", projectCheck: "switch" });
    vi.stubGlobal("argmax", { settings: { setRoutingKey } });
    const onRoutingChange = vi.fn();
    render(<AutoRoutingSettings routing={{ enabled: false, projectCheck: "switch" }} onRoutingChange={onRoutingChange} />);

    expect(screen.getByLabelText("Jev API key")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    enterKey("  jev_live_abcd  ");

    await waitFor(() => expect(onRoutingChange).toHaveBeenCalledWith({ enabled: true, keyHint: "…abcd", projectCheck: "switch" }));
    expect(setRoutingKey).toHaveBeenCalledWith({ apiKey: "jev_live_abcd" });
  });

  it("shows a rejected key's message inline and stays off", async () => {
    const setRoutingKey = vi.fn().mockRejectedValue({
      code: "SERVICE",
      sub_code: "ROUTING_KEY_INVALID",
      message: "Jev rejected this API key."
    });
    vi.stubGlobal("argmax", { settings: { setRoutingKey } });
    const onRoutingChange = vi.fn();
    render(<AutoRoutingSettings routing={{ enabled: false, projectCheck: "switch" }} onRoutingChange={onRoutingChange} />);

    enterKey("jev_bad");

    expect(await screen.findByRole("alert")).toHaveTextContent("Jev rejected this API key.");
    expect(onRoutingChange).not.toHaveBeenCalled();
  });

  it("shows the saved key's hint and removes it", async () => {
    const clearRoutingKey = vi.fn().mockResolvedValue({ enabled: false, projectCheck: "switch" });
    vi.stubGlobal("argmax", { settings: { clearRoutingKey } });
    const onRoutingChange = vi.fn();
    render(
      <AutoRoutingSettings routing={{ enabled: true, keyHint: "…abcd", projectCheck: "switch" }} onRoutingChange={onRoutingChange} />
    );

    expect(screen.getByText("On · key …abcd")).toBeInTheDocument();
    expect(screen.queryByLabelText("Jev API key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));

    await waitFor(() => expect(onRoutingChange).toHaveBeenCalledWith({ enabled: false, projectCheck: "switch" }));
  });
});
