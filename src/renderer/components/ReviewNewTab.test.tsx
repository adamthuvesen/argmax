import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewNewTab } from "./ReviewNewTab.js";

describe("ReviewNewTab", () => {
  it("opens a selected tool and resolves an address without suggested content", () => {
    const onOpen = vi.fn();
    const onBrowse = vi.fn();
    render(<ReviewNewTab onOpen={onOpen} onBrowse={onBrowse} hasAgents hasTerminal hasSideChat hasBrowser artifactsEnabled />);
    fireEvent.click(screen.getByRole("button", { name: "Side chat" }));
    expect(onOpen).toHaveBeenCalledWith("side-chat");
    fireEvent.change(screen.getByRole("textbox", { name: "Search or enter a URL" }), { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Open address" }));
    expect(onBrowse).toHaveBeenCalledWith("https://example.com");
    expect(screen.queryByText("Suggested")).not.toBeInTheDocument();
  });

  it("omits unavailable resources", () => {
    render(<ReviewNewTab onOpen={vi.fn()} onBrowse={vi.fn()} hasAgents={false} hasTerminal={false} hasSideChat={false} hasBrowser={false} artifactsEnabled />);
    expect(screen.getByRole("button", { name: "Files" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Side chat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Claude artifacts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
