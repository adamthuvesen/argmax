import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpencodeGatewaySettings } from "./OpencodeGatewaySettings.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OpencodeGatewaySettings", () => {
  it("switches the gateway and shows that gateway's key field", async () => {
    const setOpencodeGateway = vi.fn().mockResolvedValue({ gateway: "vercel", openrouterKeyHint: "…or12" });
    vi.stubGlobal("argmax", {
      settings: {
        opencodeGateway: vi.fn().mockResolvedValue({ gateway: "openrouter", openrouterKeyHint: "…or12" }),
        setOpencodeGateway
      }
    });
    render(<OpencodeGatewaySettings />);

    expect(await screen.findByText("Saved in your Keychain · key …or12")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Vercel AI Gateway" }));

    await waitFor(() => expect(setOpencodeGateway).toHaveBeenCalledWith({ gateway: "vercel" }));
    expect(await screen.findByLabelText("Vercel AI Gateway API key")).toHaveAttribute("type", "password");
    expect(screen.getByRole("radio", { name: "Vercel AI Gateway" })).toBeChecked();
  });

  it("saves a trimmed key for the selected gateway", async () => {
    const setOpencodeGatewayKey = vi.fn().mockResolvedValue({ gateway: "vercel", vercelKeyHint: "…cdef" });
    vi.stubGlobal("argmax", {
      settings: {
        opencodeGateway: vi.fn().mockResolvedValue({ gateway: "vercel" }),
        setOpencodeGatewayKey
      }
    });
    render(<OpencodeGatewaySettings />);

    const input = await screen.findByLabelText("Vercel AI Gateway API key");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "  vck_0123456789abcdef  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(setOpencodeGatewayKey).toHaveBeenCalledWith({ gateway: "vercel", apiKey: "vck_0123456789abcdef" })
    );
    expect(await screen.findByText("Saved in your Keychain · key …cdef")).toBeInTheDocument();
  });

  it("shows a rejected key inline and keeps the field", async () => {
    vi.stubGlobal("argmax", {
      settings: {
        opencodeGateway: vi.fn().mockResolvedValue({ gateway: "openrouter" }),
        setOpencodeGatewayKey: vi.fn().mockRejectedValue({
          code: "SERVICE",
          sub_code: "OPENCODE_GATEWAY_KEY_REJECTED",
          message: "OpenRouter rejected that key, so it was not saved."
        })
      }
    });
    render(<OpencodeGatewaySettings />);

    fireEvent.change(await screen.findByLabelText("OpenRouter API key"), {
      target: { value: "sk-or-v1-0123456789abcdef" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("OpenRouter rejected that key, so it was not saved.");
    expect(screen.getByLabelText("OpenRouter API key")).toHaveAttribute("aria-invalid", "true");
  });

  it("removes the saved key", async () => {
    const clearOpencodeGatewayKey = vi.fn().mockResolvedValue({ gateway: "openrouter" });
    vi.stubGlobal("argmax", {
      settings: {
        opencodeGateway: vi.fn().mockResolvedValue({ gateway: "openrouter", openrouterKeyHint: "…or12" }),
        clearOpencodeGatewayKey
      }
    });
    render(<OpencodeGatewaySettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));

    await waitFor(() => expect(clearOpencodeGatewayKey).toHaveBeenCalledWith({ gateway: "openrouter" }));
    expect(await screen.findByLabelText("OpenRouter API key")).toBeInTheDocument();
  });
});
