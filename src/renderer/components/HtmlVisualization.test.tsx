import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setupAppTestMocks } from "../../test/appTestHarness.js";
import type { ArgmaxApi, VisualizationRead } from "../../shared/types.js";
import { HtmlVisualization } from "./HtmlVisualization.js";
import { clearDraft, readDraft } from "../lib/composerDrafts.js";

const artifact = { id: "artifact-1", sessionId: "session-1", title: "Counter", summary: "An interactive counter", format: "html" as const, mode: null, runtimeVersion: 1, externalDependencies: [] };
const value = (): VisualizationRead => ({ artifact, source: "<p>Counter source</p>", document: '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src none"><p>Counter</p>', state: { modelContent: null, privateContent: null }, controlValues: {} });
const read = vi.fn<ArgmaxApi["visualization"]["read"]>();
const ingest = vi.fn<ArgmaxApi["visualization"]["import"]>();
const saveState = vi.fn<ArgmaxApi["visualization"]["setState"]>();
const saveControls = vi.fn<ArgmaxApi["visualization"]["setControls"]>();

beforeEach(() => {
  setupAppTestMocks();
  if (window.argmax) { window.argmax.visualization.read = read; window.argmax.visualization.import = ingest; window.argmax.visualization.setState = saveState; window.argmax.visualization.setControls = saveControls; }
  read.mockReset().mockResolvedValue(value());
  ingest.mockReset().mockResolvedValue(artifact);
  saveState.mockReset().mockImplementation(input => Promise.resolve(input.state));
  saveControls.mockReset().mockImplementation(input => Promise.resolve(input.controlValues));
  clearDraft("session-1");
});
afterEach(() => cleanup());

function post(frame: HTMLIFrameElement, data: Record<string, unknown>, source = frame.contentWindow): void {
  fireEvent(window, new MessageEvent("message", { source, data: { instanceId: artifact.id, ...data } }));
}

describe("durable visualization host", () => {
  it("reads the owning artifact and confines scripts to an opaque iframe", async () => {
    render(<HtmlVisualization sessionId="session-1" artifactId="artifact-1" />);
    const frame = await screen.findByTitle("Counter");
    expect(read).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-1", artifactId: "artifact-1" });
    expect(ingest).not.toHaveBeenCalled();
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame).toHaveAttribute("srcdoc", expect.stringContaining("Content-Security-Policy"));
  });
  it("imports a historical marker then reads its saved snapshot", async () => {
    render(<HtmlVisualization sessionId="session-1" path="/checkout/chart.html" title="Counter" mode="wide" />);
    await screen.findByTitle("Counter");
    expect(ingest).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-1", path: "/checkout/chart.html", title: "Counter", summary: null, mode: "wide", sourceEventId: null });
    expect(read).toHaveBeenCalledWith({ sessionId: "session-1", artifactId: "artifact-1" });
  });
  it("shows unavailable artifacts and retries", async () => {
    read.mockRejectedValueOnce(new Error("Artifact is unavailable"));
    render(<HtmlVisualization sessionId="session-1" artifactId="artifact-1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Artifact is unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTitle("Counter");
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("validates frame identity, limits height, and preserves the frame while expanding", async () => {
    render(<HtmlVisualization sessionId="session-1" artifactId="artifact-1" />);
    const frame = await screen.findByTitle<HTMLIFrameElement>("Counter");
    post(frame, { type: "argmax:visualization-height", height: 200 }, window);
    post(frame, { type: "argmax:visualization-height", instanceId: "another-artifact", height: 200 });
    expect(frame.style.height).toBe("480px");
    post(frame, { type: "argmax:visualization-height", height: 200 });
    expect(frame.style.height).toBe("200px");
    fireEvent.click(screen.getByRole("button", { name: "Expand visualization" }));
    expect(screen.getByTitle("Counter")).toBe(frame);
    expect(frame.style.height).toBe("900px");
    post(frame, { type: "argmax:visualization-height", height: 999999 });
    expect(frame.style.height).toBe("2000px");
    fireEvent.click(screen.getByRole("button", { name: "View visualization source" }));
    expect(screen.getByLabelText("Visualization source")).toHaveTextContent("Counter source");
  });
  it("persists state in order and rejects oversized or foreign snapshots", async () => {
    render(<HtmlVisualization sessionId="session-1" artifactId="artifact-1" />);
    const frame = await screen.findByTitle<HTMLIFrameElement>("Counter");
    post(frame, { type: "argmax:visualization-state", requestId: "first", state: { modelContent: { selected: 1 }, privateContent: null } });
    post(frame, { type: "argmax:visualization-state", requestId: "second", state: { modelContent: { selected: 2 }, privateContent: null } });
    await waitFor(() => expect(saveState).toHaveBeenCalledTimes(2));
    expect(saveState.mock.calls[1][0]).toEqual({ sessionId: "session-1", artifactId: "artifact-1", state: { modelContent: { selected: 2 }, privateContent: null } });
    post(frame, { type: "argmax:visualization-state", requestId: "oversized", state: { privateContent: "x".repeat(17000) } });
    post(frame, { type: "argmax:visualization-state", requestId: "foreign", state: {} }, window);
    await act(async () => {});
    expect(saveState).toHaveBeenCalledTimes(2);
  });
  it("renders image artifacts without a script host", async () => {
    read.mockResolvedValue({ ...value(), artifact: { ...artifact, format: "image" }, source: "data:image/png;base64,AA==" });
    render(<HtmlVisualization sessionId="session-1" artifactId="artifact-1" />);
    expect(await screen.findByRole("img", { name: artifact.summary })).toHaveAttribute("src", "data:image/png;base64,AA==");
    expect(screen.queryByTitle("Counter")).toBeNull();
  });
  it("requires the host action before preparing a widget follow-up", async () => {
    render(<HtmlVisualization sessionId="session-1" artifactId="artifact-1" />);
    const frame = await screen.findByTitle<HTMLIFrameElement>("Counter");
    post(frame, { type: "argmax:visualization-follow-up", requestId: "ask", prompt: "Explain selection" });
    expect(readDraft("session-1").text).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Prepare follow-up" }));
    expect(readDraft("session-1").text).toBe("Explain selection");
  });
  it("persists host edits immediately and keeps original preview temporary", async () => {
    render(<HtmlVisualization sessionId="session-1" artifactId="artifact-1" />);
    const frame = await screen.findByTitle<HTMLIFrameElement>("Counter");
    const groups = [{ id: "design", label: "Design", controls: [{ id: "radius", kind: "slider", label: "Radius", value: 10, min: 0, max: 30 }] }];
    post(frame, { type: "argmax:visualization-controls", groups });
    fireEvent.click(screen.getByRole("button", { name: "Design controls" }));
    fireEvent.change(screen.getByRole("slider", { name: "Radius" }), { target: { value: "22" } });
    await waitFor(() => expect(saveControls).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-1", artifactId: "artifact-1", controlValues: { radius: 22 } }));
    fireEvent.click(screen.getByRole("button", { name: "Preview original" }));
    post(frame, { type: "argmax:visualization-controls", groups });
    await act(async () => {});
    expect(saveControls).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Reset Design" }));
    await waitFor(() => expect(saveControls).toHaveBeenCalledTimes(2));
    expect(saveControls.mock.calls[1][0].controlValues).toEqual({});
  });
  it("waits for pending state writes before exporting", async () => {
    let complete: (() => void) | undefined;
    saveState.mockImplementation(input => new Promise(resolve => { complete = () => resolve(input.state); }));
    const exportArtifact = vi.fn<ArgmaxApi["visualization"]["export"]>().mockRejectedValue(new Error("Download fixture finished"));
    if (window.argmax) window.argmax.visualization.export = exportArtifact;
    render(<HtmlVisualization sessionId="session-1" artifactId="artifact-1" />);
    const frame = await screen.findByTitle<HTMLIFrameElement>("Counter");
    post(frame, { type: "argmax:visualization-state", requestId: "save", state: { modelContent: { selected: 4 }, privateContent: null } });
    await waitFor(() => expect(saveState).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Download visualization" }));
    expect(exportArtifact).not.toHaveBeenCalled();
    complete?.();
    await waitFor(() => expect(exportArtifact).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-1", artifactId: "artifact-1" }));
  });
});
