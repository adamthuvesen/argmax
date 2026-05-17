import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/highlighter.js", () => ({
  highlightLine: (content: string) => [{ content }],
  useHighlighterReady: () => true,
  langFromPath: (path: string | null | undefined) => (path?.endsWith(".ts") ? "typescript" : null)
}));

import { interpretFileChange } from "../lib/fileChange.js";
import { FileChangeCard } from "./FileChangeCard.js";

afterEach(() => {
  cleanup();
});

function changeFor(name: string, input: Record<string, unknown>) {
  const result = interpretFileChange(name, input);
  if (!result || result.length === 0) throw new Error("interpretFileChange returned no changes");
  const change = result[0];
  if (!change) throw new Error("missing change[0]");
  return change;
}

describe("FileChangeCard", () => {
  it("renders a create card with sage data-kind", () => {
    const change = changeFor("Write", { file_path: "/tmp/poem.md", content: "a\nb\nc" });
    const { container } = render(<FileChangeCard change={change} workspaceCwd={null} />);
    const card = container.querySelector(".file-change-card");
    expect(card).not.toBeNull();
    expect(card?.getAttribute("data-kind")).toBe("create");
    expect(card?.getAttribute("aria-label")).toBe("Created /tmp/poem.md");
    expect(screen.getByLabelText("Open /tmp/poem.md in editor")).toBeInTheDocument();
    expect(screen.getByText("Open in editor")).toBeInTheDocument();
  });

  it("displays workspace-relative path when cwd matches", () => {
    const change = changeFor("Write", {
      file_path: "/Users/me/proj/src/foo.ts",
      content: "x"
    });
    render(<FileChangeCard change={change} workspaceCwd="/Users/me/proj" />);
    expect(screen.getByText("src/foo.ts")).toBeInTheDocument();
    // Full path still in aria-label for screen readers.
    expect(screen.getByLabelText("Open /Users/me/proj/src/foo.ts in editor")).toBeInTheDocument();
  });

  it("renders an edit card with data-kind=edit", () => {
    const change = changeFor("Edit", {
      file_path: "/tmp/a.ts",
      old_string: "old1\nold2",
      new_string: "new1\nnew2\nnew3"
    });
    const { container } = render(<FileChangeCard change={change} workspaceCwd={null} />);
    const card = container.querySelector(".file-change-card");
    expect(card?.getAttribute("data-kind")).toBe("edit");
  });

  it("renders a delete card with no body diff", () => {
    const change = changeFor("deleteToolCall", { path: "/tmp/gone.md" });
    const { container } = render(<FileChangeCard change={change} workspaceCwd={null} />);
    const card = container.querySelector(".file-change-card");
    expect(card?.getAttribute("data-kind")).toBe("delete");
    expect(screen.getByText("File removed.")).toBeInTheDocument();
  });

  it("collapses bodies that exceed the threshold and toggles on click", () => {
    const big = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
    const change = changeFor("Write", { file_path: "/tmp/big.ts", content: big });
    const { container } = render(<FileChangeCard change={change} workspaceCwd={null} />);
    const body = container.querySelector(".file-change-card-body");
    expect(body?.getAttribute("data-collapsed")).toBe("true");
    const toggle = screen.getByRole("button", { name: /^Show all \d+ lines$/ });
    fireEvent.click(toggle);
    expect(container.querySelector(".file-change-card-body")?.getAttribute("data-collapsed")).toBe(
      "false"
    );
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();
  });

  it("hides line numbers for MultiEdit hunks", () => {
    const change = changeFor("MultiEdit", {
      file_path: "/tmp/a.ts",
      edits: [{ old_string: "a", new_string: "A" }]
    });
    const { container } = render(<FileChangeCard change={change} workspaceCwd={null} />);
    expect(
      container.querySelector(".file-change-card[data-no-line-numbers]")
    ).not.toBeNull();
  });

  it("renders a note when present", () => {
    const change = changeFor("Edit", {
      file_path: "/tmp/a.ts",
      old_string: "x",
      new_string: "y",
      replace_all: true
    });
    const { container } = render(<FileChangeCard change={change} workspaceCwd={null} />);
    expect(container.querySelector(".file-change-card-note")?.textContent).toMatch(/all matches/i);
  });
});
