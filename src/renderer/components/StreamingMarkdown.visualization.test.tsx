import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { VISUALIZATION_START } from "../lib/visualizationReference.js";

const viewer = vi.hoisted(() => vi.fn());
vi.mock("./HtmlVisualization.js", () => ({
  HtmlVisualization: (props: unknown) => {
    viewer(props);
    return <div role="figure" aria-label="Visualization" />;
  }
}));

const workspace = { id: "workspace-1", path: "/tmp/project" } as Parameters<typeof StreamingMarkdown>[0]["workspace"];
const marker = `${VISUALIZATION_START}{"path":"/tmp/my_[chart].html","mode":"wide","title":"Trends"}\uE201`;
afterEach(() => { cleanup(); viewer.mockClear(); });

describe("visualizations in Markdown", () => {
  it("renders an inline viewer between ordinary prose", async () => {
    render(<StreamingMarkdown text={`Before.\n\n${marker}\n\nAfter.`} streaming={false} workspace={workspace} />);
    await screen.findByRole("figure", { name: "Visualization" });
    expect(viewer).toHaveBeenCalledWith({ workspaceId: "workspace-1", path: "/tmp/my_[chart].html", mode: "wide", title: "Trends" });
    expect(screen.getByText("Before.")).toBeInTheDocument();
    expect(screen.getByText("After.")).toBeInTheDocument();
  });

  it("keeps documented markers inside code as literal text", () => {
    render(<StreamingMarkdown text={`\`\`\`text\n${marker}\n\`\`\``} streaming={false} workspace={workspace} />);
    expect(screen.getByText(marker)).toBeInTheDocument();
    expect(viewer).not.toHaveBeenCalled();
  });

  it("renders complete streamed references without healing punctuation in the path", async () => {
    // Warm the splitter as a previous answer does, then start a live block.
    const first = render(<StreamingMarkdown text="Previous answer." streaming={false} />);
    await act(async () => { await import("../lib/markdownBlocks.js"); });
    first.unmount();
    render(<StreamingMarkdown text={marker} streaming paced={false} workspace={workspace} />);
    await screen.findByRole("figure", { name: "Visualization" });
    expect(viewer).toHaveBeenCalledWith(expect.objectContaining({ path: "/tmp/my_[chart].html" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows pending streamed references and rejects incomplete finished ones", () => {
    const text = `${VISUALIZATION_START}{"path":"/tmp/chart.html"`;
    const { rerender } = render(<StreamingMarkdown text={text} streaming paced={false} workspace={workspace} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading visualization reference");
    rerender(<StreamingMarkdown text={text} streaming={false} paced={false} workspace={workspace} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Incomplete visualization reference");
    expect(viewer).not.toHaveBeenCalled();
  });

  it("rejects invalid references without loading a file", () => {
    render(<StreamingMarkdown text={`${VISUALIZATION_START}{"path":"/tmp/secrets.txt"}\uE201`} streaming={false} workspace={workspace} />);
    expect(screen.getByRole("alert")).toHaveTextContent("absolute HTML file");
    expect(viewer).not.toHaveBeenCalled();
  });
});
