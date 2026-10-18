import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi } from "../../shared/types.js";
import { resetToastForTests, toastSnapshot } from "../state/toast.js";
import { NewProjectDialog } from "./NewProjectDialog.js";

function install(paths: (string | null)[]): ReturnType<typeof vi.fn> {
  const pickDirectory = vi.fn();
  for (const path of paths) pickDirectory.mockResolvedValueOnce({ cancelled: path === null, path });
  window.argmax = { projects: { pickDirectory } } as unknown as ArgmaxApi;
  return pickDirectory;
}

afterEach(() => {
  cleanup();
  resetToastForTests();
  delete (window as unknown as { argmax?: ArgmaxApi }).argmax;
});

describe("NewProjectDialog", () => {
  it("collects a named project, defaults the first folder to primary, and changes primary before creation", async () => {
    install(["/repos/app", "/repos/dbt", "/repos/dbt"]);
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<NewProjectDialog onCreate={onCreate} onClose={vi.fn()} />);
    expect(screen.getByLabelText("Project name")).toHaveFocus();
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "  AI Analytics  " } });
    const submit = screen.getByRole("button", { name: "Create project" });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
    expect(await screen.findByText("app")).toBeInTheDocument();
    expect(screen.getAllByRole("radio", { checked: true })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
    expect(await screen.findByText("dbt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add folder" })).toBeEnabled());
    expect(within(screen.getByRole("list", { name: "Project folders" })).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("radio", { name: "Make dbt primary" }));
    fireEvent.click(submit);
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({
      name: "AI Analytics", folders: ["/repos/app", "/repos/dbt"], primaryPath: "/repos/dbt"
    }));
  });

  it("cancels the draft without creating a project or retaining a cancelled directory selection", async () => {
    const picker = install([null, "/repos/app"]);
    const onCreate = vi.fn();
    const onClose = vi.fn();
    render(<NewProjectDialog onCreate={onCreate} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
    await waitFor(() => expect(picker).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add folder" })).toBeEnabled());
    expect(screen.queryByRole("list")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
    await screen.findByText("app");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("promotes the remaining folder after removing primary and disables submission without folders", async () => {
    install(["/repos/app", "/repos/dbt"]);
    render(<NewProjectDialog onCreate={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "AI" } });
    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
    await screen.findByText("app");
    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
    await screen.findByText("dbt");
    fireEvent.click(screen.getByRole("button", { name: "Remove folder app" }));
    expect(screen.getByRole("radio", { name: "Make dbt primary" })).toBeChecked();
    expect(screen.getAllByRole("radio", { checked: true })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove folder dbt" }));
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
  });

  it("keeps the draft after a backend failure and prevents dismissal during creation", async () => {
    install(["/repos/app"]);
    let reject!: (reason: Error) => void;
    const onCreate = vi.fn().mockReturnValue(new Promise<void>((_, fail) => { reject = fail; }));
    const onClose = vi.fn();
    render(<NewProjectDialog onCreate={onCreate} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "AI" } });
    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
    await screen.findByText("app");
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    act(() => { reject(new Error("Primary folder must be a Git repository.")); });
    await waitFor(() => expect(toastSnapshot()?.message).toContain("Git repository"));
    expect(screen.getByLabelText("Project name")).toHaveValue("AI");
    expect(screen.getByRole("button", { name: "Create project" })).toBeEnabled();
  });
});
