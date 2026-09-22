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

import { mermaidProseWidth, nativeSvgWidth } from "../lib/mermaidRuntime.js";
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

    const trigger = screen.getByRole("button", { name: "View full diagram" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Full diagram" });
    expect(dialog).toBeInTheDocument();
    expect(dialog.querySelector("[data-testid='mermaid-svg']")).toBeTruthy();
    const close = screen.getByRole("button", { name: "Close full diagram" });
    expect(close).toHaveFocus();

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(screen.getAllByRole("button", { name: "Copy diagram source" })[1]).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Full diagram" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("dismisses the full-size diagram from its backdrop", async () => {
    render(<MermaidDiagram source={"flowchart LR\n  A --> B"} />);
    await waitFor(() => {
      expect(screen.getByTestId("mermaid-svg")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "View full diagram" }));
    const overlay = document.querySelector(".mermaid-diagram-overlay");
    expect(overlay).toBeTruthy();
    fireEvent.mouseDown(overlay as HTMLElement);
    expect(screen.queryByRole("dialog", { name: "Full diagram" })).toBeNull();
  });

  it("reads mermaid's native pixel width from the SVG", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "1440px");
    expect(nativeSvgWidth(svg)).toBe(1440);
  });

  it("measures wide diagrams against the prose measure, not a wider chat column", () => {
    const column = document.createElement("div");
    column.style.setProperty("--markdown-prose-width", "780px");
    Object.defineProperty(column, "clientWidth", { configurable: true, value: 940 });
    document.body.append(column);

    expect(mermaidProseWidth(column)).toBe(780);

    column.remove();
  });

  it("marks a drawing that is wider than its column so CSS can break out", async () => {
    renderMermaidDiagram.mockResolvedValueOnce({
      svg: `<svg data-testid="mermaid-svg" width="1200"><title>flow</title></svg>`
    });
    render(<MermaidDiagram source={"flowchart LR\n  A --> B"} />);
    const figure = await screen.findByLabelText("Diagram");
    await waitFor(() => {
      expect(screen.getByTestId("mermaid-svg")).toBeInTheDocument();
      expect(figure).toHaveAttribute("data-wide", "true");
    });
  });

  it("sets a symmetric pixel breakout from the rendered session bounds", async () => {
    renderMermaidDiagram.mockResolvedValueOnce({
      svg: `<svg data-testid="mermaid-svg" width="1200"><title>flow</title></svg>`
    });
    const { container } = render(
      <div className="session-main-column">
        <div className="conversation-content">
          <div className="markdown">
            <MermaidDiagram source={"flowchart LR\n  A --> B"} />
          </div>
        </div>
      </div>
    );
    const session = container.querySelector<HTMLElement>(".session-main-column");
    const transcript = container.querySelector<HTMLElement>(".conversation-content");
    const column = container.querySelector<HTMLElement>(".markdown");
    expect(session).toBeTruthy();
    expect(transcript).toBeTruthy();
    expect(column).toBeTruthy();
    column?.style.setProperty("--markdown-prose-width", "780px");
    vi.spyOn(session as HTMLElement, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 1200
    } as DOMRect);
    vi.spyOn(transcript as HTMLElement, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 1200
    } as DOMRect);
    vi.spyOn(column as HTMLElement, "getBoundingClientRect").mockReturnValue({
      left: 130,
      right: 1070
    } as DOMRect);
    Object.defineProperty(column, "clientWidth", { configurable: true, value: 940 });

    const figure = await screen.findByLabelText("Diagram");
    await waitFor(() => {
      expect(figure).toHaveAttribute("data-wide", "true");
      expect(figure).toHaveStyle({ "--diagram-breakout": "130px" });
    });
  });

  it("breaks out to the clearance beside an open workspace card", async () => {
    renderMermaidDiagram.mockResolvedValueOnce({
      svg: `<svg data-testid="mermaid-svg" width="1200"><title>flow</title></svg>`
    });
    const { container } = render(
      <div className="session-main-column">
        <div className="workspace-card" style={{ display: "block" }} />
        <div className="conversation-content">
          <div className="chat-bubble assistant">
            <div className="markdown">
              <MermaidDiagram source={"flowchart LR\n  A --> B"} />
            </div>
          </div>
        </div>
      </div>
    );
    const session = container.querySelector<HTMLElement>(".session-main-column");
    const card = container.querySelector<HTMLElement>(".workspace-card");
    const transcript = container.querySelector<HTMLElement>(".conversation-content");
    const column = container.querySelector<HTMLElement>(".markdown");
    expect(session).toBeTruthy();
    expect(card).toBeTruthy();
    expect(transcript).toBeTruthy();
    expect(column).toBeTruthy();
    session?.style.setProperty("--workspace-card-clearance", "14px");
    column?.style.setProperty("--markdown-prose-width", "780px");
    vi.spyOn(session as HTMLElement, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 1117
    } as DOMRect);
    vi.spyOn(transcript as HTMLElement, "getBoundingClientRect").mockReturnValue({
      left: 10,
      right: 1107
    } as DOMRect);
    vi.spyOn(card as HTMLElement, "getBoundingClientRect").mockReturnValue({
      left: 841,
      right: 1097
    } as DOMRect);
    vi.spyOn(column as HTMLElement, "getBoundingClientRect").mockReturnValue({
      left: 38,
      right: 790
    } as DOMRect);
    Object.defineProperty(column, "clientWidth", { configurable: true, value: 752 });

    const figure = await screen.findByLabelText("Diagram");
    await waitFor(() => {
      expect(figure).toHaveAttribute("data-wide", "true");
      expect(figure).toHaveStyle({ "--diagram-breakout": "28px" });
    });
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
