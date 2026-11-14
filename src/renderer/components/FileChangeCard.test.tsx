import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/highlighter.js", () => ({
  requestHighlight: () => () => {},
  useHighlightThemeAppearance: () => "light",
  langFromPath: (path: string | null | undefined) => (path?.endsWith(".ts") ? "typescript" : null),
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
    render(<FileChangeCard change={change} workspaceCwd={null} />);
    const card = screen.getByRole("region", { name: "Created /tmp/poem.md" });
    expect(card).toHaveAttribute("data-kind", "create");
    expect(card).toHaveAttribute("aria-label", "Created /tmp/poem.md");
    expect(screen.getByLabelText("Open /tmp/poem.md")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
  });

  it("displays workspace-relative path when cwd matches", () => {
    const change = changeFor("Write", {
      file_path: "/Users/me/proj/src/foo.ts",
      content: "x",
    });
    render(<FileChangeCard change={change} workspaceCwd="/Users/me/proj" />);
    expect(screen.getByText("src/foo.ts")).toBeInTheDocument();
    // Full path still in aria-label for screen readers.
    expect(screen.getByLabelText("Open /Users/me/proj/src/foo.ts")).toBeInTheDocument();
  });

  it("opens the workspace-relative path in the review panel, not the absolute file_path", () => {
    // The review panel resolves/keys files by workspace-relative path; handing it
    // the agent's absolute file_path fails containment and nothing opens.
    const change = changeFor("Edit", {
      file_path: "/Users/me/proj/src/foo.ts",
      old_string: "a",
      new_string: "b",
    });
    const onOpenFile = vi.fn();
    render(
      <FileChangeCard change={change} workspaceCwd="/Users/me/proj" onOpenFile={onOpenFile} />,
    );
    fireEvent.click(screen.getByLabelText("Open /Users/me/proj/src/foo.ts"));
    expect(onOpenFile).toHaveBeenCalledWith("src/foo.ts");
  });

  it("renders a delete card with no body diff", () => {
    const change = changeFor("deleteToolCall", { path: "/tmp/gone.md" });
    render(<FileChangeCard change={change} workspaceCwd={null} />);
    expect(screen.getByRole("region")).toHaveAttribute("data-kind", "delete");
    expect(screen.getByText("File removed.")).toBeInTheDocument();
  });

  it("renders large diffs in a single scrollable body, no toggle", () => {
    const big = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
    const change = changeFor("Write", { file_path: "/tmp/big.ts", content: big });
    render(<FileChangeCard change={change} workspaceCwd={null} />);
    const body = screen.getByTestId("file-change-card-body");
    expect(body).not.toHaveAttribute("data-collapsed");
    for (let index = 0; index < 40; index += 1) {
      expect(within(body).getByText(`line${index}`)).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: /^Show all \d+ lines$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show less" })).toBeNull();
  });

  it("hides line numbers for MultiEdit hunks", () => {
    const change = changeFor("MultiEdit", {
      file_path: "/tmp/a.ts",
      edits: [{ old_string: "a", new_string: "A" }],
    });
    render(<FileChangeCard change={change} workspaceCwd={null} />);
    expect(screen.getByRole("region")).toHaveAttribute("data-no-line-numbers");
  });

  it("renders a note when present", () => {
    const change = changeFor("Edit", {
      file_path: "/tmp/a.ts",
      old_string: "x",
      new_string: "y",
      replace_all: true,
    });
    render(<FileChangeCard change={change} workspaceCwd={null} />);
    expect(screen.getByTestId("file-change-card-note")).toHaveTextContent(/all matches/i);
  });
});
