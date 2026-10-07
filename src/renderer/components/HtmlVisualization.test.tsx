import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setupAppTestMocks } from "../../test/appTestHarness.js";
import type { ArgmaxApi, WorkspaceFilePreview } from "../../shared/types.js";
import { HtmlVisualization } from "./HtmlVisualization.js";

const path = "/test/checkout/chart.html";
const readVisualization = vi.fn<ArgmaxApi["workspace"]["readVisualization"]>();
const textFile = (content = '<button id="increment">Increase</button>'): WorkspaceFilePreview => ({ kind: "text", content, size: content.length, mtimeMs: 1 });

beforeEach(() => {
  setupAppTestMocks();
  if (window.argmax) window.argmax.workspace.readVisualization = readVisualization;
  readVisualization.mockReset().mockResolvedValue(textFile());
});
afterEach(() => cleanup());

describe("HtmlVisualization", () => {
  it("shows loading until the file arrives and confines execution to the iframe", async () => {
    let resolveFile: ((file: WorkspaceFilePreview) => void) | undefined;
    readVisualization.mockImplementation(() => new Promise((resolve) => { resolveFile = resolve; }));
    render(<HtmlVisualization workspaceId="workspace-1" path={path} title="Counter" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading visualization");
    expect(readVisualization).toHaveBeenCalledExactlyOnceWith({ kind: "workspace", id: "workspace-1" }, path);
    await act(() => Promise.resolve(resolveFile?.(textFile())));
    const frame = screen.getByTitle("Counter");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame).toHaveAttribute("srcdoc", expect.stringContaining("Content-Security-Policy"));
    expect(screen.queryByRole("button", { name: "Increase" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("displays read failures and retries the same file", async () => {
    readVisualization.mockRejectedValueOnce(new Error("File does not exist"));
    render(<HtmlVisualization workspaceId="workspace-1" path={path} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("File does not exist");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTitle("Visualization");
    expect(readVisualization).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ kind: "text", content: "Chart", size: 1_000_001, mtimeMs: 1 }, "1 MB"],
    [{ kind: "text", content: "あ".repeat(333_334), size: 10, mtimeMs: 1 }, "1 MB"],
    [{ kind: "skipped", reason: "binary" }, "HTML text file"],
    [{ kind: "skipped", reason: "too-large" }, "1 MB"],
    [{ kind: "skipped", reason: "not-a-file" }, "unavailable"]
  ] satisfies [WorkspaceFilePreview, string][])("rejects unusable files %#", async (file, message) => {
    readVisualization.mockResolvedValue(file);
    render(<HtmlVisualization workspaceId="workspace-1" path={path} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByTitle("Visualization")).not.toBeInTheDocument();
  });

  it("accepts resize messages only from this iframe and bounds reported heights", async () => {
    render(<HtmlVisualization workspaceId="workspace-1" path={path} />);
    const frame = await screen.findByTitle<HTMLIFrameElement>("Visualization");
    const send = (source: Window | null, height: unknown): void => {
      fireEvent(window, new MessageEvent("message", { source, data: { type: "argmax:visualization-height", height } }));
    };
    send(window, 200);
    expect(frame.style.height).toBe("480px");
    send(frame.contentWindow, 200);
    expect(frame.style.height).toBe("200px");
    send(frame.contentWindow, -100);
    expect(frame.style.height).toBe("120px");
    send(frame.contentWindow, "350");
    send(frame.contentWindow, Infinity);
    expect(frame.style.height).toBe("120px");
    send(frame.contentWindow, 10_000);
    fireEvent.click(screen.getByRole("button", { name: "Expand visualization" }));
    expect(frame.style.height).toBe("1200px");
  });

  it("expands and collapses the existing iframe without resetting its document", async () => {
    render(<HtmlVisualization workspaceId="workspace-1" path={path} mode="wide" />);
    const frame = await screen.findByTitle("Visualization");
    const source = frame.getAttribute("srcdoc");
    fireEvent.click(screen.getByRole("button", { name: "Expand visualization" }));
    expect(screen.getByTitle("Visualization")).toBe(frame);
    expect(frame).toHaveStyle({ height: "900px" });
    fireEvent.click(screen.getByRole("button", { name: "Collapse visualization" }));
    expect(screen.getByTitle("Visualization")).toBe(frame);
    expect(frame.getAttribute("srcdoc")).toBe(source);
    expect(readVisualization).toHaveBeenCalledTimes(1);
  });

  it("ignores a file read that completes after the path changes", async () => {
    let resolveOld: ((file: WorkspaceFilePreview) => void) | undefined;
    readVisualization.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const { rerender } = render(<HtmlVisualization workspaceId="workspace-1" path={path} />);
    rerender(<HtmlVisualization workspaceId="workspace-1" path="/test/checkout/new.html" />);
    const frame = await screen.findByTitle("Visualization");
    await act(() => Promise.resolve(resolveOld?.(textFile("Old file"))));
    await waitFor(() => expect(frame.getAttribute("srcdoc")).not.toContain("Old file"));
  });

});
