import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceSummary } from "../../shared/types.js";
import { MarkdownImage } from "./MarkdownImage.js";

// The component reads only the path and the id off the workspace.
const workspace = { id: "w1", path: "/repo" } as WorkspaceSummary;

describe("MarkdownImage", () => {
  afterEach(() => cleanup());

  // An image the agent drew reaches the user through Markdown, and until it
  // opened the lightbox it was the one image in the chat stuck at the
  // transcript's measure while a sent attachment could be viewed full size.
  it("opens the lightbox on click and closes it again", () => {
    render(<MarkdownImage src="docs/chart.png" alt="A chart" workspace={workspace} />);

    expect(screen.queryByRole("dialog", { name: "A chart" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "A chart — view larger" }));
    expect(screen.getByRole("dialog", { name: "A chart" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close image preview" }));
    expect(screen.queryByRole("dialog", { name: "A chart" })).toBeNull();
  });

  // The fallback is a link or a file chip, not an image, so there is nothing
  // to enlarge and no button to offer.
  it("gives a remote image a link rather than a lightbox", () => {
    render(<MarkdownImage src="https://example.com/chart.png" alt="A chart" workspace={workspace} />);

    expect(screen.queryByRole("button", { name: /view larger/ })).toBeNull();
    expect(screen.getByRole("link", { name: "example.com" })).toBeTruthy();
  });
});
