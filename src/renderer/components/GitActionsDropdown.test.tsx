import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi, GhPrRecord, SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { GitActionsDropdown } from "./GitActionsDropdown.js";

const sessionStub: SessionSummary = {
  id: "session-1",
  workspaceId: "ws-1",
  provider: "codex",
  modelLabel: "label",
  modelId: "model",
  permissionMode: "auto-approve",
  providerConversationId: null,
  prompt: "p",
  state: "running",
  attention: "normal",
  startedAt: "2026-05-14T00:00:00Z",
  completedAt: null,
  lastActivityAt: "2026-05-14T00:00:00Z",
  preferred: true
};

const workspaceStub: WorkspaceSummary = {
  id: "ws-1",
  projectId: "p-1",
  taskLabel: "task",
  branch: "feature/x",
  baseRef: "main",
  path: "/tmp/wt",
  state: "running",
  sharedWorkspace: false,
  dirty: true,
  changedFiles: 2,
  lastActivityAt: "2026-05-14T00:00:00Z",
  pinned: false
};

const prStub: GhPrRecord = {
  sessionId: "session-1",
  prNumber: 42,
  headSha: "abc123",
  lastSeenCheckState: "success",
  updatedAt: "2026-05-14T00:00:00Z"
};

interface GitApiStubs {
  commit?: ArgmaxApi["git"]["commit"];
  push?: ArgmaxApi["git"]["push"];
  createBranch?: ArgmaxApi["git"]["createBranch"];
  viewOrCreatePr?: ArgmaxApi["git"]["viewOrCreatePr"];
}

function installArgmax(stubs: GitApiStubs = {}): void {
  const api = {
    git: {
      commit: stubs.commit ?? vi.fn(),
      push: stubs.push ?? vi.fn(),
      createBranch: stubs.createBranch ?? vi.fn(),
      viewOrCreatePr: stubs.viewOrCreatePr ?? vi.fn()
    }
  } as unknown as ArgmaxApi;
  // Cast through unknown — we only stub the slice the dropdown reads.
  (window as unknown as { argmax: ArgmaxApi }).argmax = api;
}

beforeEach(() => {
  installArgmax();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { argmax?: ArgmaxApi }).argmax;
});

describe("GitActionsDropdown", () => {
  it("opens the menu and shows all four actions", () => {
    render(<GitActionsDropdown prs={[]} session={sessionStub} workspace={workspaceStub} />);
    fireEvent.click(screen.getByLabelText("Git actions"));
    const menu = screen.getByRole("menu", { name: "Git actions" });
    expect(menu).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Commit/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Push/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Create pull request/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Create branch/i })).toBeTruthy();
  });

  it("flips the View PR label based on whether prs is populated", () => {
    const { rerender } = render(
      <GitActionsDropdown prs={[]} session={sessionStub} workspace={workspaceStub} />
    );
    fireEvent.click(screen.getByLabelText("Git actions"));
    expect(screen.getByRole("menuitem", { name: /Create pull request/i })).toBeTruthy();

    rerender(<GitActionsDropdown prs={[prStub]} session={sessionStub} workspace={workspaceStub} />);
    expect(screen.getByRole("menuitem", { name: /View pull request/i })).toBeTruthy();
  });

  it("disables the trigger when there is no workspace", () => {
    render(<GitActionsDropdown prs={[]} session={sessionStub} workspace={null} />);
    expect(screen.getByLabelText<HTMLButtonElement>("Git actions").disabled).toBe(true);
  });

  it("keeps Commit enabled even when the worktree is clean (git itself surfaces the failure)", () => {
    render(
      <GitActionsDropdown
        prs={[]}
        session={sessionStub}
        workspace={{ ...workspaceStub, dirty: false }}
      />
    );
    fireEvent.click(screen.getByLabelText("Git actions"));
    const commit = screen.getByRole<HTMLButtonElement>("menuitem", { name: /Commit/i });
    expect(commit.disabled).toBe(false);
    expect(commit.title).toMatch(/clean/i);
  });

  it("commits the typed message via window.argmax.git.commit", async () => {
    const commit = vi.fn().mockResolvedValue({ commitSha: "deadbeefcafe", branch: "feature/x" });
    installArgmax({ commit });

    render(<GitActionsDropdown prs={[]} session={sessionStub} workspace={workspaceStub} />);
    fireEvent.click(screen.getByLabelText("Git actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Commit/i }));

    const textarea = screen.getByLabelText<HTMLTextAreaElement>("Commit message");
    fireEvent.change(textarea, { target: { value: "wip: dropdown" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    await waitFor(() => {
      expect(commit).toHaveBeenCalledWith({ workspaceId: "ws-1", message: "wip: dropdown" });
    });
    const message = await screen.findByText(/deadbee/);
    const feedback = message.closest(".git-actions-feedback");
    expect(feedback?.className).toContain("git-actions-feedback--success");
    expect(feedback?.getAttribute("role")).toBe("status");
  });

  it("rejects branch names with illegal characters before invoking IPC", async () => {
    const createBranch = vi.fn();
    installArgmax({ createBranch });

    render(<GitActionsDropdown prs={[]} session={sessionStub} workspace={workspaceStub} />);
    fireEvent.click(screen.getByLabelText("Git actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Create branch/i }));

    const input = screen.getByLabelText<HTMLInputElement>("Branch name");
    fireEvent.change(input, { target: { value: "bad name!" } });
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/letters, digits/i);
    });
    expect(screen.getByRole("alert").className).toContain("git-actions-feedback--error");
    expect(createBranch).not.toHaveBeenCalled();
  });

  it("calls viewOrCreatePr and refreshes prs on success", async () => {
    const viewOrCreatePr = vi
      .fn()
      .mockResolvedValue({ action: "created", url: "https://github.com/a/b/pull/9", prNumber: 9 });
    const onPrsRefresh = vi.fn();
    installArgmax({ viewOrCreatePr });

    render(
      <GitActionsDropdown
        prs={[]}
        session={sessionStub}
        workspace={workspaceStub}
        onPrsRefresh={onPrsRefresh}
      />
    );
    fireEvent.click(screen.getByLabelText("Git actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Create pull request/i }));

    await waitFor(() => {
      expect(viewOrCreatePr).toHaveBeenCalledWith({ sessionId: "session-1" });
    });
    expect(onPrsRefresh).toHaveBeenCalled();
  });

  it("renders push success feedback on the menu after a successful push", async () => {
    const push = vi
      .fn()
      .mockResolvedValue({ branch: "feature/x", upstreamSet: true });
    installArgmax({ push });

    render(<GitActionsDropdown prs={[]} session={sessionStub} workspace={workspaceStub} />);
    fireEvent.click(screen.getByLabelText("Git actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Push/i }));

    const message = await screen.findByText(/Set upstream and pushed feature\/x/);
    const feedback = message.closest(".git-actions-feedback");
    expect(feedback?.className).toContain("git-actions-feedback--success");
    expect(feedback?.getAttribute("role")).toBe("status");
  });

  it("renders push error feedback when the IPC call rejects", async () => {
    const push = vi.fn().mockRejectedValue(new Error("git failed: remote rejected"));
    installArgmax({ push });

    render(<GitActionsDropdown prs={[]} session={sessionStub} workspace={workspaceStub} />);
    fireEvent.click(screen.getByLabelText("Git actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Push/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/remote rejected/);
    expect(alert.className).toContain("git-actions-feedback--error");
  });
});
