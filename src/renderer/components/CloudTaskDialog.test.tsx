import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudHandoffPreview } from "../../shared/types.js";
import { CloudTaskDialog } from "./CloudTaskDialog.js";

const preview: CloudHandoffPreview = {
  provider: "claude",
  repository: "adamthuvesen/private-sandbox",
  branch: "adam/cloud-smoke-test",
  commit: "1234567890abcdef",
  brief: "Check the README and report what it contains.",
  environmentId: "env-default",
  environmentDescription: "Default",
  environments: [{ id: "env-default", name: "Default" }]
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function installCloudApi(
  prepare: ReturnType<typeof vi.fn>,
  launch: ReturnType<typeof vi.fn>
): void {
  Object.defineProperty(window, "argmax", {
    configurable: true,
    writable: true,
    value: {
      cloud: { prepare, launch },
      system: { openPath: vi.fn().mockResolvedValue({ ok: true }) }
    }
  });
}

describe("CloudTaskDialog", () => {
  afterEach(() => {
    cleanup();
    delete (window as { argmax?: unknown }).argmax;
  });

  beforeEach(() => {
    localStorage.clear();
  });

  it("loads the handoff and lets preparation be dismissed", async () => {
    const pending = deferred<CloudHandoffPreview>();
    const prepare = vi.fn().mockReturnValue(pending.promise);
    installCloudApi(prepare, vi.fn());
    const onClose = vi.fn();

    render(<CloudTaskDialog open provider="claude" sessionId="session-1" onClose={onClose} />);

    const preparing = screen.getByRole("status", { name: "Preparing cloud task" });
    expect(preparing.querySelectorAll(".loading-block").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Close dialog" })).toBeEnabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    pending.resolve(preview);
    expect(await screen.findByText("Continue this chat in Claude Cloud.")).toBeInTheDocument();
    expect(screen.getByText(preview.brief)).toBeInTheDocument();
    // The preview renders one microtask before `preparing` clears, and only
    // then does focus move to the launch button.
    await waitFor(() => expect(screen.getByRole("button", { name: "Send task" })).toHaveFocus());
    expect(screen.getByText("adamthuvesen/private-sandbox")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getByTitle("env-default")).toHaveTextContent("Default");
    expect(prepare).toHaveBeenCalledWith({ sessionId: "session-1", provider: "claude" });
  });

  it("requires a choice when the provider has multiple cloud environments", async () => {
    const prepare = vi.fn().mockResolvedValue({
      ...preview,
      provider: "cursor" as const,
      environmentId: "",
      environmentDescription: "Choose an environment",
      environments: [
        { id: "env-personal", name: "Personal" },
        { id: "env-work", name: "Work" }
      ]
    });
    const launch = vi.fn().mockResolvedValue({ url: "https://cursor.com/agents/task-1" });
    installCloudApi(prepare, launch);

    render(
      <CloudTaskDialog
        open
        provider="cursor"
        projectId="project-1"
        initialBrief="Inspect README"
        onClose={vi.fn()}
      />
    );

    expect(await screen.findByRole("dialog", { name: "Send task to Cursor Cloud" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send task" })).toBeDisabled();
    const environmentPicker = screen.getByRole("button", { name: "Cloud environment" });
    fireEvent.click(environmentPicker);
    expect(screen.getByRole("listbox", { name: "Cloud environment" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Cloud environment" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Send task to Cursor Cloud" })).toBeInTheDocument();
    expect(environmentPicker).toHaveFocus();

    fireEvent.click(environmentPicker);
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(screen.getByRole("dialog", { name: "Send task to Cursor Cloud" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send task" }));

    expect(await screen.findByRole("link", { name: "Open in Cursor Cloud" })).toBeInTheDocument();
    expect(prepare).toHaveBeenCalledWith({ projectId: "project-1", provider: "cursor" });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      provider: "cursor",
      environmentId: "env-work"
    }));
  });

  it("keeps the task after a launch error and can retry", async () => {
    const launch = vi
      .fn()
      .mockRejectedValueOnce("Claude Cloud rejected the task")
      .mockResolvedValueOnce({ url: "https://claude.ai/code/task-1" });
    installCloudApi(vi.fn().mockResolvedValue(preview), launch);

    render(<CloudTaskDialog open provider="claude" sessionId="session-1" onClose={vi.fn()} />);
    await screen.findByText(preview.brief);
    fireEvent.click(screen.getByRole("button", { name: "Send task" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Claude Cloud rejected the task");
    expect(screen.getByText(preview.brief)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send task" }));
    expect(await screen.findByRole("link", { name: "Open in Claude Cloud" })).toHaveAttribute(
      "href",
      "https://claude.ai/code/task-1"
    );
    expect(screen.getByRole("link", { name: "Open in Claude Cloud" })).toHaveFocus();
    expect(screen.getByTitle("https://claude.ai/code/task-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(launch).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      provider: "claude",
      repository: preview.repository,
      branch: preview.branch,
      commit: preview.commit,
      brief: preview.brief,
      environmentId: "env-default"
    });
  });

  it("offers no resend when the provider may already have the task", async () => {
    const launch = vi.fn().mockRejectedValueOnce({
      sub_code: "CLOUD_LAUNCH_DELIVERY_UNKNOWN",
      message: "Claude Cloud may have created the task."
    });
    installCloudApi(vi.fn().mockResolvedValue(preview), launch);

    render(<CloudTaskDialog open provider="claude" sessionId="session-1" onClose={vi.fn()} />);
    await screen.findByText(preview.brief);
    fireEvent.click(screen.getByRole("button", { name: "Send task" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("may have created the task");
    expect(screen.getByRole("dialog", { name: "Task status unknown" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send task" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Check Claude Cloud" })).toHaveAttribute("href", "https://claude.ai/code");
    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toHaveFocus());
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("does not launch twice while the first request is pending", async () => {
    const pending = deferred<{ url: string }>();
    const launch = vi.fn().mockReturnValue(pending.promise);
    installCloudApi(vi.fn().mockResolvedValue(preview), launch);

    render(<CloudTaskDialog open provider="claude" sessionId="session-1" onClose={vi.fn()} />);
    const launchButton = await screen.findByRole("button", { name: "Send task" });
    launchButton.focus();
    fireEvent.click(launchButton);
    fireEvent.click(launchButton);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sending…" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(launchButton).toHaveFocus();
    fireEvent.keyDown(launchButton, { key: "Tab" });
    expect(launchButton).toHaveFocus();

    pending.resolve({ url: "https://claude.ai/code/task-2" });
    expect(await screen.findByRole("link", { name: "Open in Claude Cloud" })).toBeInTheDocument();
  });

  it("shows preparation errors and retries without closing", async () => {
    const prepare = vi
      .fn()
      .mockRejectedValueOnce({
        code: "SERVICE_ERROR",
        message: "Push the branch before launching"
      })
      .mockResolvedValueOnce(preview);
    installCloudApi(prepare, vi.fn());

    render(<CloudTaskDialog open provider="claude" sessionId="session-1" onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Push the branch before launching");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(preview.brief)).toBeInTheDocument();
  });

  it("keeps the successful link and warns if saving the chat note failed", async () => {
    installCloudApi(vi.fn().mockResolvedValue(preview), vi.fn().mockResolvedValue({
      url: "https://claude.ai/code/session_created",
      warning: "The task was launched, but its link could not be saved in this chat."
    }));
    render(<CloudTaskDialog open provider="claude" sessionId="session-1" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Send task" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("its link could not be saved");
    expect(screen.getByRole("link", { name: "Open in Claude Cloud" })).toHaveAttribute(
      "href", "https://claude.ai/code/session_created"
    );
    expect(screen.queryByRole("button", { name: "Send task" })).not.toBeInTheDocument();
  });

  it("ignores preparation from a dismissed dialog when it reopens", async () => {
    const stale = deferred<CloudHandoffPreview>();
    installCloudApi(vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValueOnce(preview), vi.fn());
    const { rerender } = render(<CloudTaskDialog open provider="claude" sessionId="session-1" onClose={vi.fn()} />);
    rerender(<CloudTaskDialog open={false} provider="claude" sessionId="session-1" onClose={vi.fn()} />);
    rerender(<CloudTaskDialog open provider="claude" sessionId="session-1" onClose={vi.fn()} />);
    expect(await screen.findByText(preview.brief)).toBeInTheDocument();
    stale.resolve({ ...preview, brief: "Stale context" });
    await waitFor(() => expect(screen.getByText(preview.brief)).toBeInTheDocument());
  });

  it("reports an unavailable bridge instead of waiting indefinitely", async () => {
    render(<CloudTaskDialog open provider="claude" sessionId="session-1" onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("available only in the Argmax desktop app");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "false");
  });

  it("opens the cloud task and dismisses the dialog", async () => {
    const openPath = vi.fn().mockResolvedValue({ ok: true });
    const onClose = vi.fn();
    installCloudApi(
      vi.fn().mockResolvedValue({ ...preview, provider: "cursor" }),
      vi.fn().mockResolvedValue({ url: "https://cursor.com/agents/task-1" })
    );
    Object.assign(window.argmax!.system, { openPath });

    render(
      <CloudTaskDialog
        open
        provider="cursor"
        sessionId="session-1"
        onClose={onClose}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: "Send task" }));
    fireEvent.click(await screen.findByRole("link", { name: "Open in Cursor Cloud" }));

    expect(openPath).toHaveBeenCalledWith({ path: "https://cursor.com/agents/task-1" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the current prompt once and includes inspectable chat context in the launch", async () => {
    const codexPreview: CloudHandoffPreview = {
      ...preview,
      provider: "codex",
      brief: "Conversation so far:\nThe previous turn established the failing parser behavior.\n\nNew user message:\nFix the parser"
    };
    const prepare = vi.fn().mockResolvedValue(codexPreview);
    const launch = vi.fn().mockResolvedValue({ url: "https://chatgpt.com/codex/tasks/task-1" });
    installCloudApi(prepare, launch);

    render(
      <CloudTaskDialog
        open
        provider="codex"
        sessionId="session-1"
        initialBrief="Fix the parser"
        onClose={vi.fn()}
      />
    );

    expect(await screen.findByText("Fix the parser")).toBeInTheDocument();
    expect(screen.getAllByText("Fix the parser")).toHaveLength(1);
    expect(prepare).toHaveBeenCalledWith({ sessionId: "session-1", provider: "codex", instruction: "Fix the parser" });
    fireEvent.click(screen.getByText("Includes context from this chat"));
    expect(screen.getByText(/The previous turn established the failing parser behavior/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send task" }));

    await screen.findByRole("link", { name: "Open in Codex Cloud" });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      brief: codexPreview.brief
    }));
  });

});
