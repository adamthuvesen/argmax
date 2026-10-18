import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, ProjectFolder } from "../../../shared/types.js";
import { ProjectFolderContext } from "./ProjectFolderContext.js";

const folder: ProjectFolder = {
  id: "linked-1", projectId: "project-1", name: "docs", rootPath: "/repos/docs",
  isPrimary: false, enabled: true, summary: null
};
function install(linkedRepos: Partial<ArgmaxApi["linkedRepos"]>): void {
  window.argmax = { linkedRepos } as unknown as ArgmaxApi;
}
afterEach(() => {
  cleanup();
  delete (window as unknown as { argmax?: ArgmaxApi }).argmax;
});

describe("ProjectFolderContext", () => {
  it("generates summaries in the folder editor and retains retry after failure", async () => {
    const summarize = vi.fn().mockRejectedValueOnce(new Error("Provider unavailable"))
      .mockResolvedValueOnce({ ...folder, summary: "Shared API contracts." });
    install({ summarize });
    render(<ProjectFolderContext folder={folder} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate summary for docs" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Provider unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry summary for docs" }));
    expect(await screen.findByText("Shared API contracts.")).toBeInTheDocument();
    expect(summarize).toHaveBeenCalledWith({ projectId: "project-1", id: "linked-1" });
  });

  it("reattaches a pending summary after remount without generating twice", async () => {
    let resolve!: (result: { summary: string }) => void;
    const pending = new Promise<{ summary: string }>((settle) => { resolve = settle; });
    const summarize = vi.fn().mockReturnValue(pending);
    install({ summarize });
    const first = render(<ProjectFolderContext folder={folder} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate summary for docs" }));
    first.unmount();
    render(<ProjectFolderContext folder={folder} />);
    expect(await screen.findByText("Generating summary…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate summary for docs" })).toBeDisabled();
    await act(async () => { resolve({ summary: "Shared contracts." }); await pending; });
    expect(screen.getByText("Shared contracts.")).toBeInTheDocument();
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("toggles agent context and disables generation for disabled folders", async () => {
    const setEnabled = vi.fn().mockResolvedValue({ ...folder, enabled: false });
    const summarize = vi.fn();
    install({ setEnabled, summarize });
    render(<ProjectFolderContext folder={folder} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Include docs in agent context" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Include docs in agent context" })).not.toBeChecked());
    expect(setEnabled).toHaveBeenCalledWith({ projectId: "project-1", id: "linked-1", enabled: false });
    expect(screen.getByRole("button", { name: "Generate summary for docs" })).toBeDisabled();
    expect(summarize).not.toHaveBeenCalled();
  });
});
