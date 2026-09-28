import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectCheck } from "../../shared/types.js";
import { primaryProject, setupAppTestMocks } from "../../test/appTestHarness.js";
import { resetToastForTests, toastSnapshot } from "../state/toast.js";
import { NO_PROJECT_CHECK } from "../hooks/useProjectCheck.js";
import { LaunchSurface } from "./LaunchSurface.js";

const PROMPT = "Why is cmd+§ not working in argmax?";

function renderLauncher(check: ProjectCheck) {
  const current = primaryProject();
  const other = { ...current, id: "project-argmax", name: "argmax", repoPath: "/tmp/argmax" };
  vi.mocked(window.argmax!.projects.checkPrompt).mockResolvedValue(check);
  const launchLocal = vi.fn().mockResolvedValue({ sessionId: "session-new", workspaceId: "workspace-new" });
  render(
    <LaunchSurface
      autoRouting
      model={{ provider: "claude", modelId: "claude-fable-5-1", label: "Fable 5.1", reasoningEffort: "medium" }}
      onAddProject={vi.fn()}
      onBranchSwitch={vi.fn()}
      onLaunchTask={launchLocal}
      onModelChange={vi.fn()}
      onSelectProject={vi.fn()}
      project={current}
      projects={[current, other]}
    />
  );
  return { current, other, launchLocal };
}

async function submit(): Promise<void> {
  fireEvent.change(await screen.findByLabelText("Task prompt"), { target: { value: PROMPT } });
  fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
}

function checkWith(decision: "suggest" | "switch"): ProjectCheck {
  return {
    ...NO_PROJECT_CHECK,
    decision,
    checkId: "check-1",
    suggestedProjectId: "project-argmax",
    suggestedProbability: 0.98,
    currentProbability: 0.01,
    reasons: ["Mentions argmax", "Jev 98% sure"]
  };
}

describe("Project check in the launcher", () => {
  beforeEach(() => {
    setupAppTestMocks();
    vi.spyOn(window.argmax!.projects, "checkPrompt");
    vi.spyOn(window.argmax!.projects, "resolveCheck");
    resetToastForTests();
  });
  afterEach(cleanup);

  it("launches where it was aimed when the check has nothing to say", async () => {
    const { launchLocal } = renderLauncher(NO_PROJECT_CHECK);
    await submit();

    await waitFor(() => expect(launchLocal).toHaveBeenCalledOnce());
    expect(launchLocal.mock.calls[0]?.[6]).toBeUndefined();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks first, and Enter starts in the suggested project", async () => {
    const { launchLocal } = renderLauncher(checkWith("suggest"));
    await submit();

    const dialog = await screen.findByRole("dialog", { name: "Start in argmax?" });
    expect(launchLocal).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent("Mentions argmax");
    fireEvent.keyDown(screen.getByRole("radio", { name: /^argmax/ }), { key: "Enter" });

    await waitFor(() => expect(launchLocal).toHaveBeenCalledOnce());
    expect(launchLocal.mock.calls[0]?.[0]).toBe(PROMPT);
    expect(launchLocal.mock.calls[0]?.[6]).toBe("project-argmax");
    await waitFor(() => expect(window.argmax!.projects.resolveCheck).toHaveBeenCalledWith({
      checkId: "check-1",
      outcome: "accepted",
      sessionId: "session-new"
    }));
  });

  it("keeps the current project when the user picks it in the dialog", async () => {
    const { current, launchLocal } = renderLauncher(checkWith("suggest"));
    await submit();

    await screen.findByRole("dialog", { name: "Start in argmax?" });
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(`^${current.name}`) }));
    fireEvent.click(screen.getByRole("button", { name: `Start in ${current.name}` }));

    await waitFor(() => expect(launchLocal).toHaveBeenCalledOnce());
    expect(launchLocal.mock.calls[0]?.[6]).toBeUndefined();
    await waitFor(() => expect(window.argmax!.projects.resolveCheck).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "stayed" })
    ));
  });

  it("goes back to the composer with the draft on Back", async () => {
    const { launchLocal } = renderLauncher(checkWith("suggest"));
    await submit();

    await screen.findByRole("dialog", { name: "Start in argmax?" });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Task prompt")).toHaveValue(PROMPT);
    expect(launchLocal).not.toHaveBeenCalled();
    expect(window.argmax!.projects.resolveCheck).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "cancelled" })
    );
  });

  it("switches without asking and Undo relaunches where the launcher was aimed", async () => {
    const { current, launchLocal } = renderLauncher(checkWith("switch"));
    const terminate = vi.spyOn(window.argmax!.providers, "terminate");
    const archive = vi.spyOn(window.argmax!.workspaces, "archive");
    await submit();

    await waitFor(() => expect(launchLocal).toHaveBeenCalledOnce());
    expect(launchLocal.mock.calls[0]?.[6]).toBe("project-argmax");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const toast = toastSnapshot();
    expect(toast?.message).toBe(`Started in argmax instead of ${current.name}.`);

    act(() => toast?.action?.run());
    await waitFor(() => expect(launchLocal).toHaveBeenCalledTimes(2));
    expect(terminate).toHaveBeenCalledWith("session-new");
    expect(archive).toHaveBeenCalledWith({ workspaceId: "workspace-new", force: true });
    expect(launchLocal.mock.calls[1]?.[0]).toBe(PROMPT);
    expect(launchLocal.mock.calls[1]?.[6]).toBe(current.id);
    expect(window.argmax!.projects.resolveCheck).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "undone" })
    );
  });
});
