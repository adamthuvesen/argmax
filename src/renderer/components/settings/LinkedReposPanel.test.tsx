import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    summary: null,
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

describe("LinkedReposPanel", () => {
  it("lists linked repositories and their summaries without a path form", async () => {
    install({ list: vi.fn().mockResolvedValue([repo({ summary: "Shared API contracts and documentation." })]) });
    render(<LinkedReposPanel projectId="project-1" />);

    expect(await screen.findByText("/Users/dev/shared-docs")).toBeInTheDocument();
    expect(screen.getByText("Shared API contracts and documentation.")).toBeInTheDocument();
    expect(screen.getByText(/agents can read and edit/)).toBeInTheDocument();
    expect(screen.getByText(/never watches/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate summary for shared-docs" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("does not connect or summarize when the native picker is cancelled", async () => {
    const pickFolder = vi.fn().mockResolvedValue(null);
    const summarize = vi.fn();
    install({ pickFolder, summarize });
    render(<LinkedReposPanel projectId="project-1" />);

    await screen.findByText("No linked repositories yet.");
    fireEvent.click(screen.getByRole("button", { name: "Connect repository…" }));

    await waitFor(() => expect(pickFolder).toHaveBeenCalledWith({ projectId: "project-1" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect repository…" })).toBeEnabled());
    expect(summarize).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("No linked repositories yet.")).toBeInTheDocument();
  });

  it("shows a connected repository immediately and generates its summary automatically", async () => {
    const pendingSummary = deferred<LinkedRepo>();
    const summarize = vi.fn().mockReturnValue(pendingSummary.promise);
    install({ pickFolder: vi.fn().mockResolvedValue(repo()), summarize });
    render(<LinkedReposPanel projectId="project-1" />);

    await screen.findByText("No linked repositories yet.");
    fireEvent.click(screen.getByRole("button", { name: "Connect repository…" }));

    expect(await screen.findByText("/Users/dev/shared-docs")).toBeInTheDocument();
    expect(summarize).toHaveBeenCalledWith({ projectId: "project-1", id: "l1" });
    expect(screen.getByRole("status")).toHaveTextContent("Generating summary…");
    expect(screen.getByRole("checkbox", { name: "Enable linked repository shared-docs" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove linked repository shared-docs" })).toBeDisabled();

    await act(async () => {
      pendingSummary.resolve(repo({ summary: "Shared API contracts." }));
      await pendingSummary.promise;
    });
    expect(screen.getByText("Shared API contracts.")).toBeInTheDocument();
    expect(screen.queryByText("Generating summary…")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove linked repository shared-docs" })).toBeEnabled();
  });

  it("retains the connected repository when summarizing fails and allows a retry", async () => {
    const summarize = vi.fn()
      .mockRejectedValueOnce(new Error("Summary provider unavailable."))
      .mockResolvedValueOnce(repo({ summary: "Shared documentation." }));
    install({ pickFolder: vi.fn().mockResolvedValue(repo()), summarize });
    render(<LinkedReposPanel projectId="project-1" />);

    await screen.findByText("No linked repositories yet.");
    fireEvent.click(screen.getByRole("button", { name: "Connect repository…" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Repository connected. Summary unavailable. Summary provider unavailable."
    );
    expect(screen.getByText("/Users/dev/shared-docs")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry summary for shared-docs" }));

    expect(await screen.findByText("Shared documentation.")).toBeInTheDocument();
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("allows an existing repository without a summary to generate one", async () => {
    const summarize = vi.fn().mockResolvedValue(repo({ summary: "Shared documentation." }));
    install({ list: vi.fn().mockResolvedValue([repo()]), summarize });
    render(<LinkedReposPanel projectId="project-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Generate summary for shared-docs" }));
    expect(await screen.findByText("Shared documentation.")).toBeInTheDocument();
    expect(summarize).toHaveBeenCalledWith({ projectId: "project-1", id: "l1" });
  });

  it("shows the reason a selected repository was rejected", async () => {
    install({ pickFolder: vi.fn().mockRejectedValue({
      code: "INVALID_INPUT",
      issues: [{ path: ["path"], code: "LINKED_REPO_ROOT_DUPLICATE", message: "This repository is already connected." }]
    }) });
    render(<LinkedReposPanel projectId="project-1" />);

    await screen.findByText("No linked repositories yet.");
    fireEvent.click(screen.getByRole("button", { name: "Connect repository…" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This repository is already connected.");
  });

  it("keeps a late selection and its automatic summary scoped to the original project", async () => {
    const selection = deferred<LinkedRepo | null>();
    const summarize = vi.fn().mockResolvedValue(repo({ summary: "Old project summary." }));
    install({ pickFolder: vi.fn().mockReturnValue(selection.promise), summarize });
    const { rerender } = render(<LinkedReposPanel projectId="project-1" />);

    await screen.findByText("No linked repositories yet.");
    fireEvent.click(screen.getByRole("button", { name: "Connect repository…" }));
    rerender(<LinkedReposPanel projectId="project-2" />);
    await screen.findByText("No linked repositories yet.");
    await act(async () => {
      selection.resolve(repo());
      await selection.promise;
    });

    expect(screen.queryByText("shared-docs")).toBeNull();
    expect(summarize).toHaveBeenCalledWith({ projectId: "project-1", id: "l1" });
    expect(screen.queryByText("Old project summary.")).toBeNull();
    expect(screen.getByRole("button", { name: "Connect repository…" })).toBeEnabled();
  });

  it("ignores a summary result after switching projects", async () => {
    const pendingSummary = deferred<LinkedRepo>();
    install({
      list: vi.fn().mockImplementation(({ projectId }: { projectId: string }) =>
        Promise.resolve(projectId === "project-1" ? [repo()] : [])
      ),
      summarize: vi.fn().mockReturnValue(pendingSummary.promise)
    });
    const { rerender } = render(<LinkedReposPanel projectId="project-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Generate summary for shared-docs" }));
    rerender(<LinkedReposPanel projectId="project-2" />);
    await screen.findByText("No linked repositories yet.");
    await act(async () => {
      pendingSummary.resolve(repo({ summary: "Old project summary." }));
      await pendingSummary.promise;
    });

    expect(screen.queryByText("Old project summary.")).toBeNull();
    expect(screen.queryByText("shared-docs")).toBeNull();
  });

  it("reattaches a pending summary after unmount and remount without generating twice", async () => {
    const pendingSummary = deferred<LinkedRepo>();
    const summarize = vi.fn().mockReturnValue(pendingSummary.promise);
    install({ list: vi.fn().mockResolvedValue([repo()]), summarize });
    const firstPanel = render(<LinkedReposPanel projectId="project-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Generate summary for shared-docs" }));
    expect(summarize).toHaveBeenCalledTimes(1);
    firstPanel.unmount();
    render(<LinkedReposPanel projectId="project-1" />);

    expect(await screen.findByText("Generating summary…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate summary for shared-docs" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove linked repository shared-docs" })).toBeDisabled();
    expect(summarize).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingSummary.resolve(repo({ summary: "Shared API contracts." }));
      await pendingSummary.promise;
    });
    expect(screen.getByText("Shared API contracts.")).toBeInTheDocument();
    expect(screen.queryByText("Generating summary…")).toBeNull();
    expect(screen.getByRole("button", { name: "Regenerate summary for shared-docs" })).toBeEnabled();
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it.each([null, "Shared documentation."])("disables summary generation for disabled repositories with summary %s", async (summary) => {
    const summarize = vi.fn();
    install({ list: vi.fn().mockResolvedValue([repo({ enabled: false, summary })]), summarize });
    render(<LinkedReposPanel projectId="project-1" />);

    const label = summary ? "Regenerate summary for shared-docs" : "Generate summary for shared-docs";
    const button = await screen.findByRole("button", { name: label });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(summarize).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Enable linked repository shared-docs" })).toBeEnabled();
  });

  it("shows a pending summary failure after remount and starts a new request on retry", async () => {
    const pendingSummary = deferred<LinkedRepo>();
    const summarize = vi.fn().mockReturnValueOnce(pendingSummary.promise)
      .mockResolvedValueOnce(repo({ summary: "Shared documentation." }));
    install({ list: vi.fn().mockResolvedValue([repo()]), summarize });
    const firstPanel = render(<LinkedReposPanel projectId="project-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Generate summary for shared-docs" }));
    firstPanel.unmount();
    render(<LinkedReposPanel projectId="project-1" />);
    await screen.findByText("Generating summary…");
    await act(async () => {
      pendingSummary.reject(new Error("Provider unavailable."));
      await pendingSummary.promise.catch(() => undefined);
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Repository connected. Summary unavailable. Provider unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Retry summary for shared-docs" }));
    expect(await screen.findByText("Shared documentation.")).toBeInTheDocument();
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("switches a repository off and removes it", async () => {
    const setEnabled = vi.fn().mockResolvedValue(repo({ enabled: false }));
    const remove = vi.fn().mockResolvedValue(undefined);
    install({ list: vi.fn().mockResolvedValue([repo()]), setEnabled, remove });
    render(<LinkedReposPanel projectId="project-1" />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "Enable linked repository shared-docs" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Enable linked repository shared-docs" })).not.toBeChecked());
    expect(setEnabled).toHaveBeenCalledWith({ projectId: "project-1", id: "l1", enabled: false });

    fireEvent.click(screen.getByRole("button", { name: "Remove linked repository shared-docs" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ projectId: "project-1", id: "l1" }));
    await waitFor(() => expect(screen.queryByText("/Users/dev/shared-docs")).toBeNull());
  });
});
