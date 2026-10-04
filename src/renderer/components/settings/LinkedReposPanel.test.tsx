import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, LinkedRepo } from "../../../shared/types.js";
import { LinkedReposPanel } from "./LinkedReposPanel.js";

afterEach(() => {
  cleanup();
  delete (window as unknown as { argmax?: ArgmaxApi }).argmax;
});

function repo(overrides: Partial<LinkedRepo> = {}): LinkedRepo {
  return {
    id: "l1",
    projectId: "project-1",
    name: "shared-docs",
    rootPath: "/Users/dev/shared-docs",
    enabled: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides
  };
}

function install(linkedRepos: Partial<ArgmaxApi["linkedRepos"]>): void {
  (window as unknown as { argmax: ArgmaxApi }).argmax = {
    linkedRepos: { list: vi.fn().mockResolvedValue([]), ...linkedRepos }
  } as unknown as ArgmaxApi;
}

describe("LinkedReposPanel", () => {
  it("lists linked repositories with their canonical roots and allows reading and editing", async () => {
    install({ list: vi.fn().mockResolvedValue([repo()]) });
    render(<LinkedReposPanel projectId="project-1" />);

    expect(await screen.findByText("/Users/dev/shared-docs")).toBeInTheDocument();
    expect(screen.getByText("shared-docs")).toBeInTheDocument();
    expect(screen.getByText(/agents can read and edit/)).toBeInTheDocument();
    expect(screen.getByText(/never watches/)).toBeInTheDocument();
  });

  it("links a repository, sending a null name when none was typed", async () => {
    const add = vi.fn().mockResolvedValue(repo({ id: "l2", name: "api", rootPath: "/Users/dev/api" }));
    install({ add });
    render(<LinkedReposPanel projectId="project-1" />);

    await screen.findByText("No linked repositories yet.");
    fireEvent.change(screen.getByLabelText("Absolute path"), { target: { value: "  /Users/dev/api " } });
    fireEvent.click(screen.getByRole("button", { name: "Link repository" }));

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith({
        projectId: "project-1",
        repo: { name: null, path: "/Users/dev/api" }
      })
    );
    expect(await screen.findByText("/Users/dev/api")).toBeInTheDocument();
  });

  it("shows the reason a path was rejected beside the form", async () => {
    const add = vi.fn().mockRejectedValue({
      code: "INVALID_INPUT",
      issues: [{ path: ["path"], code: "LINKED_REPO_PATH_RELATIVE", message: "A linked repository path must be absolute." }]
    });
    install({ add });
    render(<LinkedReposPanel projectId="project-1" />);

    await screen.findByText("No linked repositories yet.");
    fireEvent.change(screen.getByLabelText("Absolute path"), { target: { value: "relative/dir" } });
    fireEvent.click(screen.getByRole("button", { name: "Link repository" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("A linked repository path must be absolute.");
  });

  it("switches a repository off and removes it", async () => {
    const setEnabled = vi.fn().mockResolvedValue(repo({ enabled: false }));
    const remove = vi.fn().mockResolvedValue(undefined);
    install({ list: vi.fn().mockResolvedValue([repo()]), setEnabled, remove });
    render(<LinkedReposPanel projectId="project-1" />);

    const toggle = await screen.findByRole("checkbox", { name: "Enable linked repository shared-docs" });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(setEnabled).toHaveBeenCalledWith({ projectId: "project-1", id: "l1", enabled: false })
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove linked repository shared-docs" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ projectId: "project-1", id: "l1" }));
    await waitFor(() => expect(screen.queryByText("/Users/dev/shared-docs")).toBeNull());
  });
});
