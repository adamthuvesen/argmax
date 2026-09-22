import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { primaryProject, setupAppTestMocks } from "../../test/appTestHarness.js";
import type { ModelPickerSelection } from "../lib/models.js";
import { LaunchSurface } from "./LaunchSurface.js";

function renderLauncher(model: ModelPickerSelection = { provider: "claude", modelId: "claude-fable-5-1", label: "Fable 5.1", reasoningEffort: "medium" }) {
  const project = primaryProject();
  const launchLocal = vi.fn().mockResolvedValue(undefined);
  render(<LaunchSurface
    model={model}
    onAddProject={vi.fn()}
    onBranchSwitch={vi.fn()}
    onLaunchTask={launchLocal}
    onModelChange={vi.fn()}
    onSelectProject={vi.fn()}
    project={project}
    projects={[project]}
  />);
  return { project, launchLocal };
}

describe("cloud launch from the composer", () => {
  beforeEach(() => {
    setupAppTestMocks();
    vi.spyOn(window.argmax!.cloud, "prepare").mockResolvedValue({
      provider: "claude",
      repository: "adamthuvesen/commute-cli", branch: "main", commit: "1234567890abcdef",
      brief: "", environmentId: "env_default", environmentDescription: "Default",
      environments: [{ id: "env_default", name: "Default" }]
    });
    vi.spyOn(window.argmax!.cloud, "launch").mockResolvedValue({ url: "https://claude.ai/code/session_test" });
  });
  afterEach(cleanup);

  it.each([
    [{ provider: "claude", modelId: "claude-fable-5-1", label: "Fable 5.1", reasoningEffort: "medium" }, "Claude Cloud"],
    [{ provider: "codex", modelId: "gpt-6-astra", label: "GPT-6 Astra", reasoningEffort: "medium" }, "Codex Cloud"],
    [{ provider: "cursor", modelId: "composer-2.5", label: "Composer 2.5 (Cursor)", reasoningEffort: "medium" }, "Cursor Cloud"]
  ] as const)("routes the selected $0.provider provider to its hosted agent", async (selectedModel, hostedName) => {
    vi.mocked(window.argmax!.cloud.prepare).mockResolvedValue({
      provider: selectedModel.provider,
      repository: "adamthuvesen/commute-cli",
      branch: "main",
      commit: "1234567890abcdef",
      brief: "",
      environmentId: "env_default",
      environmentDescription: "Default",
      environments: [{ id: "env_default", name: "Default" }]
    });
    const { project, launchLocal } = renderLauncher(selectedModel);
    fireEvent.change(await screen.findByLabelText("Task prompt"), { target: { value: "Inspect README" } });
    fireEvent.click(screen.getByRole("button", { name: "Run location: Local" }));

    expect(screen.getByText(hostedName)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review cloud task" }));
    await screen.findByText("Inspect README");
    expect(screen.queryByRole("textbox", { name: "Task brief" })).not.toBeInTheDocument();
    expect(window.argmax!.cloud.prepare).toHaveBeenCalledWith({
      projectId: project.id,
      provider: selectedModel.provider
    });
    fireEvent.click(screen.getByRole("button", { name: "Send task" }));
    expect(await screen.findByRole("link", { name: `Open in ${hostedName}` })).toBeInTheDocument();
    expect(window.argmax!.cloud.launch).toHaveBeenCalledWith(expect.objectContaining({
      projectId: project.id,
      provider: selectedModel.provider
    }));
    expect(launchLocal).not.toHaveBeenCalled();
  });

  it("keeps unsupported providers local and explains why", () => {
    renderLauncher({ provider: "opencode", modelId: "openai/gpt-5.5", label: "GPT-5.5", reasoningEffort: "medium" });
    fireEvent.click(screen.getByRole("button", { name: "Run location: Local" }));
    expect(screen.getByRole("alert")).toHaveTextContent("OpenCode can’t run cloud tasks");
    expect(screen.getByRole("button", { name: "Run location: Local" })).toBeInTheDocument();
    expect(window.argmax!.cloud.prepare).not.toHaveBeenCalled();
  });

  it("defaults to local and restores local controls without losing the prompt", async () => {
    renderLauncher();
    fireEvent.change(await screen.findByLabelText("Task prompt"), { target: { value: "Inspect README" } });
    fireEvent.click(screen.getByRole("button", { name: "Run location: Local" }));
    expect(screen.queryByRole("button", { name: "Switch model" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Worktree" })).not.toBeInTheDocument();
    expect(screen.getByText("Claude Cloud")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run location: Cloud" }));
    expect(screen.getByRole("button", { name: "Switch model" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Worktree" })).toBeInTheDocument();
    expect(screen.getByLabelText("Task prompt")).toHaveValue("Inspect README");
  });

  it("reviews and launches the project brief without starting a local agent", async () => {
    const { project, launchLocal } = renderLauncher();
    fireEvent.change(await screen.findByLabelText("Task prompt"), { target: { value: "Inspect README" } });
    fireEvent.click(screen.getByRole("button", { name: "Run location: Local" }));
    fireEvent.click(screen.getByRole("button", { name: "Review cloud task" }));
    expect(await screen.findByText("Inspect README")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Task brief" })).not.toBeInTheDocument();
    expect(window.argmax!.cloud.prepare).toHaveBeenCalledWith({ projectId: project.id, provider: "claude" });
    expect(window.argmax!.cloud.launch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send task" }));
    expect(await screen.findByRole("link", { name: "Open in Claude Cloud" })).toBeInTheDocument();
    expect(window.argmax!.cloud.launch).toHaveBeenCalledWith(expect.objectContaining({
      projectId: project.id,
      provider: "claude",
      brief: "Inspect README"
    }));
    expect(launchLocal).not.toHaveBeenCalled();
    expect(screen.queryByText("The link is saved in this chat.")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Task prompt")).toHaveValue(""));
  });

  it("keeps the draft when cloud review is cancelled", async () => {
    const { launchLocal } = renderLauncher();
    fireEvent.change(await screen.findByLabelText("Task prompt"), { target: { value: "Keep my draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Run location: Local" }));
    fireEvent.click(screen.getByRole("button", { name: "Review cloud task" }));
    await screen.findByText("Keep my draft");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Task prompt")).toHaveValue("Keep my draft");
    expect(launchLocal).not.toHaveBeenCalled();
    expect(window.argmax!.cloud.launch).not.toHaveBeenCalled();
  });

  it("blocks pasted files and local goals before cloud preparation", async () => {
    renderLauncher();
    const prompt = await screen.findByLabelText("Task prompt");
    fireEvent.click(screen.getByRole("button", { name: "Run location: Local" }));
    fireEvent.paste(prompt, { clipboardData: { files: [new File(["image"], "image.png", { type: "image/png" })] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Cloud tasks support text only");
    fireEvent.change(prompt, { target: { value: "/goal fix everything" } });
    fireEvent.click(screen.getByRole("button", { name: "Review cloud task" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Goals run locally");
    expect(window.argmax!.cloud.prepare).not.toHaveBeenCalled();
    expect(prompt).toHaveValue("/goal fix everything");
  });

});
