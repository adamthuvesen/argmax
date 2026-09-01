import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as MermaidRuntime from "../lib/mermaidRuntime.js";
import { StreamingCodeContext } from "./streamingCodeContext.js";

const renderMermaidDiagram = vi.hoisted(() =>
  vi.fn((source: string) => {
    if (source.includes("not-a-diagram")) {
      return Promise.reject(new Error("Parse error on line 1: expecting a diagram type"));
    }
    return Promise.resolve({ svg: `<svg data-testid="mermaid-svg"><title>flow</title></svg>` });
  })
);

vi.mock("../lib/mermaidRuntime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof MermaidRuntime>();
  return {
    ...actual,
    renderMermaidDiagram
  };
});

import { nativeSvgWidth } from "../lib/mermaidRuntime.js";
import { MermaidDiagram } from "./MermaidDiagram.js";

describe("MermaidDiagram", () => {
  beforeEach(() => {
    renderMermaidDiagram.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the SVG mermaid returns and copies the source", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });

    const source = "flowchart LR\n  A --> B";
    render(<MermaidDiagram source={source} />);

    await waitFor(() => {
      expect(screen.getByTestId("mermaid-svg")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Diagram")).toHaveAttribute("data-state", "ready");
    expect(renderMermaidDiagram).toHaveBeenCalledWith(source);

    fireEvent.click(screen.getByRole("button", { name: "Copy diagram source" }));
    expect(writeText).toHaveBeenCalledWith(source);
  });

  it("toggles the mermaid source without leaving the diagram", async () => {
    render(<MermaidDiagram source={"flowchart LR\n  A --> B"} />);
    await waitFor(() => {
      expect(screen.getByTestId("mermaid-svg")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Show diagram source" }));
    expect(screen.getByText(/flowchart LR/)).toBeInTheDocument();
    expect(screen.queryByTestId("mermaid-svg")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show diagram" }));
    expect(screen.getByTestId("mermaid-svg")).toBeInTheDocument();
  });

  it("opens a full-size diagram dialog from the toolbar", async () => {
    render(<MermaidDiagram source={"flowchart LR\n  A --> B"} />);
    await waitFor(() => {
      expect(screen.getByTestId("mermaid-svg")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "View full diagram" }));
    const dialog = screen.getByRole("dialog", { name: "Full diagram" });
    expect(dialog).toBeInTheDocument();
    expect(dialog.querySelector("[data-testid='mermaid-svg']")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Full diagram" })).not.toBeInTheDocument();
  });

  it("reads mermaid's native pixel width from the SVG", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "1440px");
    expect(nativeSvgWidth(svg)).toBe(1440);
  });

  it("shows a pending status while a live fence is still being drawn", () => {
    render(
      <StreamingCodeContext.Provider value={true}>
        <MermaidDiagram source={"flowchart LR\n  A --> B"} />
      </StreamingCodeContext.Provider>
    );
    expect(screen.getByRole("status")).toHaveTextContent("Drawing diagram");
    expect(renderMermaidDiagram).not.toHaveBeenCalled();
  });

  it("falls back to the source and an error when a finished fence cannot be drawn", async () => {
    render(<MermaidDiagram source={"not-a-diagram"} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Parse error on line 1");
    });
    expect(screen.getByLabelText("Diagram")).toHaveAttribute("data-state", "error");
    expect(screen.getByText("not-a-diagram")).toBeInTheDocument();
    expect(screen.queryByTestId("mermaid-svg")).not.toBeInTheDocument();
  });
});
