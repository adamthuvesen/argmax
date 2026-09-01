import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnFileChange } from "../lib/turnFileChanges.js";
import { TurnChangesCard } from "./TurnChangesCard.js";

afterEach(() => {
  cleanup();
});

const CHANGES: TurnFileChange[] = [
  { path: "/repo/src/styles/tokens.css", kind: "edit", adds: 9, dels: 0, writes: 1 },
  { path: "/repo/src/components/CommandPalette.tsx", kind: "create", adds: 26, dels: 2, writes: 1 },
  { path: "/repo/docs/old.md", kind: "delete", adds: 0, dels: 0, writes: 1 }
];

describe("TurnChangesCard", () => {
  it("summarizes the turn in its header and shows the list by default", () => {
    render(<TurnChangesCard changes={CHANGES} workspaceCwd="/repo" />);
    const toggle = screen.getByLabelText("Hide 3 files changed");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(toggle).getByText("3 files changed")).toBeInTheDocument();
    expect(within(toggle).getByText("+35")).toBeInTheDocument();
    expect(within(toggle).getByText("−2")).toBeInTheDocument();
    expect(screen.getByLabelText("Edited src/styles/tokens.css")).toBeInTheDocument();
  });

  it("closes and reopens the list from the header", () => {
    render(<TurnChangesCard changes={CHANGES} workspaceCwd="/repo" />);
    fireEvent.click(screen.getByLabelText("Hide 3 files changed"));
    expect(screen.queryByLabelText("Edited src/styles/tokens.css")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Show 3 files changed"));
    expect(screen.getByLabelText("Edited src/styles/tokens.css")).toBeInTheDocument();
    expect(screen.getByLabelText("Created src/components/CommandPalette.tsx")).toBeInTheDocument();
    expect(screen.getByLabelText("Deleted docs/old.md")).toBeInTheDocument();
  });

  it("starts collapsed when the setting says so", () => {
    render(<TurnChangesCard changes={CHANGES} workspaceCwd="/repo" defaultExpanded={false} />);
    expect(screen.queryByLabelText("Edited src/styles/tokens.css")).not.toBeInTheDocument();
  });

  it("opens a row's diff by its workspace-relative path", () => {
    const onOpenDiff = vi.fn();
    render(<TurnChangesCard changes={CHANGES} workspaceCwd="/repo" onOpenDiff={onOpenDiff} />);
    fireEvent.click(screen.getByLabelText("Edited src/styles/tokens.css"));
    expect(onOpenDiff).toHaveBeenCalledWith("src/styles/tokens.css");
  });

  it("falls back to the file view on a host with no changes view", () => {
    const onOpenFile = vi.fn();
    render(<TurnChangesCard changes={CHANGES} workspaceCwd="/repo" onOpenFile={onOpenFile} />);
    fireEvent.click(screen.getByLabelText("Edited src/styles/tokens.css"));
    expect(onOpenFile).toHaveBeenCalledWith("src/styles/tokens.css");
  });

  it("prefers the diff over the file view when both are available", () => {
    const onOpenDiff = vi.fn();
    const onOpenFile = vi.fn();
    render(
      <TurnChangesCard
        changes={CHANGES}
        workspaceCwd="/repo"
        onOpenDiff={onOpenDiff}
        onOpenFile={onOpenFile}
      />
    );
    fireEvent.click(screen.getByLabelText("Edited src/styles/tokens.css"));
    expect(onOpenDiff).toHaveBeenCalledTimes(1);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("hands Review straight to the review panel", () => {
    const onOpenReview = vi.fn();
    render(<TurnChangesCard changes={CHANGES} workspaceCwd="/repo" onOpenReview={onOpenReview} />);
    fireEvent.click(screen.getByLabelText("Review changed files"));
    expect(onOpenReview).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when the turn wrote no files", () => {
    const { container } = render(<TurnChangesCard changes={[]} workspaceCwd="/repo" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the file name only, keeping the path in the row's accessible name", () => {
    render(<TurnChangesCard changes={CHANGES} workspaceCwd="/repo" />);
    const row = screen.getByLabelText("Edited src/styles/tokens.css");
    expect(row).toHaveTextContent("tokens.css");
    expect(row).not.toHaveTextContent("src/styles");
    expect(row).toHaveAttribute("title", "/repo/src/styles/tokens.css");
  });

  it("colors each row by file family", () => {
    const { container } = render(<TurnChangesCard changes={CHANGES} workspaceCwd="/repo" />);
    const families = [...container.querySelectorAll(".turn-changes-row")].map((row) =>
      row.getAttribute("data-family")
    );
    expect(families).toEqual(["style", "script", "doc"]);
  });
});
