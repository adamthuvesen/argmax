import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, ProjectSource } from "../../../shared/types.js";
import { ProjectSourcesPanel } from "./ProjectSourcesPanel.js";

afterEach(() => {
  cleanup();
  delete (window as unknown as { argmax?: ArgmaxApi }).argmax;
});

function projectSource(overrides: Partial<ProjectSource> = {}): ProjectSource {
  const timestamp = "2026-09-12T12:00:00.000Z";
  return {
    id: "source-1",
    projectId: "project-1",
    title: "README",
    kind: "file",
    location: "README.md",
    guidance: "Use for onboarding context",
    addedBy: "user",
    addedBySessionId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function installSourcesStub(sources: Partial<NonNullable<ArgmaxApi["sources"]>>): void {
  (window as unknown as { argmax: ArgmaxApi }).argmax = {
    sources
  } as unknown as ArgmaxApi;
}

describe("ProjectSourcesPanel", () => {
  it("adds, edits, and removes a reference with projectId and payload", async () => {
    const created = projectSource();
    const updated = projectSource({
      title: "Architecture notes",
      location: "docs/architecture.md",
      guidance: "Prefer this for system design questions"
    });

    const list = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([created])
      .mockResolvedValueOnce([updated])
      .mockResolvedValueOnce([]);
    const add = vi.fn().mockResolvedValue(created);
    const update = vi.fn().mockResolvedValue(updated);
    const deleteSource = vi.fn().mockResolvedValue(undefined);
    installSourcesStub({ list, add, update, delete: deleteSource });

    render(<ProjectSourcesPanel projectId="project-1" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Add source" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "README" } });
    fireEvent.change(screen.getByLabelText("Repository path or URL"), {
      target: { value: "README.md" }
    });
    fireEvent.change(screen.getByLabelText("When to consult"), {
      target: { value: "Use for onboarding context" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save source" }));

    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(add).toHaveBeenCalledWith({
      projectId: "project-1",
      source: { title: "README", location: "README.md", guidance: "Use for onboarding context" }
    });

    await waitFor(() => expect(screen.getByText("README")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Edit source: README" }));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Architecture notes" }
    });
    fireEvent.change(screen.getByLabelText("Repository path or URL"), {
      target: { value: "docs/architecture.md" }
    });
    fireEvent.change(screen.getByLabelText("When to consult"), {
      target: { value: "Prefer this for system design questions" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save source" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith({
      projectId: "project-1",
      id: "source-1",
      source: { title: "Architecture notes", location: "docs/architecture.md", guidance: "Prefer this for system design questions" }
    });

    await waitFor(() => expect(screen.getByText("Architecture notes")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Remove source: Architecture notes" }));

    await waitFor(() => expect(deleteSource).toHaveBeenCalledTimes(1));
    expect(deleteSource).toHaveBeenCalledWith({
      projectId: "project-1",
      id: "source-1"
    });
  });

  it("shows a list failure", async () => {
    const list = vi.fn().mockRejectedValue(new Error("SOURCES_LIST_FAILED"));
    installSourcesStub({ list });

    render(<ProjectSourcesPanel projectId="project-1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("SOURCES_LIST_FAILED");
  });

  it("does not apply a stale list result after switching projects", async () => {
    let resolveP1: (value: ProjectSource[]) => void = () => undefined;
    const p1List = new Promise<ProjectSource[]>((resolve) => {
      resolveP1 = resolve;
    });

    const list = vi.fn().mockImplementation(({ projectId }: { projectId: string }) => {
      if (projectId === "p1") {
        return p1List;
      }
      if (projectId === "p2") {
        return Promise.resolve([
          projectSource({
            id: "source-p2",
            projectId: "p2",
            title: "P2 reference",
            location: "README.md"
          })
        ]);
      }
      return Promise.resolve([]);
    });
    installSourcesStub({ list });

    const { rerender } = render(<ProjectSourcesPanel key="p1" projectId="p1" />);

    rerender(<ProjectSourcesPanel key="p2" projectId="p2" />);

    await waitFor(() => expect(screen.getByText("P2 reference")).toBeInTheDocument());

    resolveP1([
      projectSource({
        id: "source-p1",
        projectId: "p1",
        title: "P1 stale reference",
        location: "README.md"
      })
    ]);

    await waitFor(() => {
      expect(list).toHaveBeenCalledWith({ projectId: "p2" });
    });
    expect(screen.queryByText("P1 stale reference")).not.toBeInTheDocument();
    expect(screen.getByText("P2 reference")).toBeInTheDocument();
  });
});
