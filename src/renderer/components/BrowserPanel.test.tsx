import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, BrowserStateEvent } from "../../shared/types.js";
import { BrowserPanel } from "./BrowserPanel.js";

let stateListener: ((event: BrowserStateEvent) => void) | null = null;

const browserStub = {
  open: vi.fn(() => Promise.resolve({ ok: true as const })),
  navigate: vi.fn(() => Promise.resolve({ ok: true as const })),
  back: vi.fn(() => Promise.resolve({ ok: true as const })),
  forward: vi.fn(() => Promise.resolve({ ok: true as const })),
  reload: vi.fn(() => Promise.resolve({ ok: true as const })),
  setBounds: vi.fn(() => Promise.resolve({ ok: true as const })),
  close: vi.fn(() => Promise.resolve({ ok: true as const })),
  fillCredentials: vi.fn(() => Promise.resolve({ ok: true, itemTitle: "GitHub" })),
  onState: vi.fn((listener: (event: BrowserStateEvent) => void) => {
    stateListener = listener;
    return () => {
      stateListener = null;
    };
  })
};

beforeEach(() => {
  stateListener = null;
  for (const mock of Object.values(browserStub)) mock.mockClear();
  window.argmax = { browser: browserStub } as unknown as ArgmaxApi;
});

afterEach(() => {
  cleanup();
  delete (window as { argmax?: ArgmaxApi }).argmax;
});

describe("BrowserPanel", () => {
  it("opens the native webview for the requested URL", () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    expect(browserStub.open).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://github.com" })
    );
    expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue("https://github.com");
  });

  it("navigates on address submit after normalizing the input", () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    const address = screen.getByRole("textbox", { name: "Address" });
    fireEvent.change(address, { target: { value: "example.com" } });
    fireEvent.submit(address.closest("form") as HTMLFormElement);
    expect(browserStub.navigate).toHaveBeenCalledWith("https://example.com");
  });

  it("refuses non-web address input with a notice instead of navigating", () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    const address = screen.getByRole("textbox", { name: "Address" });
    fireEvent.change(address, { target: { value: "file:///etc/passwd" } });
    fireEvent.submit(address.closest("form") as HTMLFormElement);
    expect(browserStub.navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Enter a web address");
  });

  it("syncs the address bar from webview navigation events", () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    act(() => stateListener?.({ url: "https://github.com/argmax", title: "Argmax" }));
    expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue(
      "https://github.com/argmax"
    );
  });

  it("wires toolbar actions to the bridge and close to the parent", () => {
    const onClose = vi.fn();
    render(<BrowserPanel url="https://github.com" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: "Close browser" }));
    expect(browserStub.back).toHaveBeenCalled();
    expect(browserStub.reload).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("surfaces the 1Password fill result", async () => {
    render(<BrowserPanel url="https://github.com" onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Fill login from 1Password" }));
    expect(browserStub.fillCredentials).toHaveBeenCalled();
    expect(await screen.findByText("Filled from 1Password: GitHub")).toBeInTheDocument();
  });
});
