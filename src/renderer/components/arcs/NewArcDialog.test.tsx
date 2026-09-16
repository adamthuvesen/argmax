import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArcCreateInput, ArcLaunchCoordinatorInput, ArcRecord, ProjectSummary } from "../../../shared/types.js";
import { overlaysSnapshot, resetOverlaysForTests } from "../../state/overlays.js";
import { resetToastForTests, toastSnapshot } from "../../state/toast.js";
import { NewArcDialog } from "./NewArcDialog.js";

const PROJECTS: ProjectSummary[] = [
  {
    id: "project-1",
    name: "Argmax",
    repoPath: "/tmp/argmax",
    currentBranch: "main",
    defaultBranch: "main",
    settings: {
      archiveOnMerge: false,
      worktreeLocation: "/tmp/worktrees",
      setupCommand: "",
      checkCommands: []
    },
    counts: { active: 0, blocked: 0, failed: 0, reviewReady: 0 },
    latestActivityAt: "2026-05-12T15:54:00.000Z"
  }
];

const ARC_RECORD: ArcRecord = {
  id: "arc-1",
  name: "Pricing rollout",
  brief: "",
  state: "active",
  homeProjectId: "project-1",
  coordinatorSessionId: null,
  dir: "/tmp/arcs/arc-1",
  createdAt: "2026-05-12T15:54:00.000Z",
  updatedAt: "2026-05-12T15:54:00.000Z"
};

function installArgmax(
  createMock: ReturnType<typeof vi.fn<(input: ArcCreateInput) => Promise<ArcRecord>>>,
  launchCoordinatorMock: ReturnType<typeof vi.fn<(input: ArcLaunchCoordinatorInput) => Promise<ArcRecord>>>
): void {
  Object.defineProperty(window, "argmax", {
    configurable: true,
    writable: true,
    value: {
      arcs: {
        create: createMock,
        launchCoordinator: launchCoordinatorMock
      }
    }
  });
}

describe("NewArcDialog", () => {
  let createMock: ReturnType<typeof vi.fn<(input: ArcCreateInput) => Promise<ArcRecord>>>;
  let launchCoordinatorMock: ReturnType<typeof vi.fn<(input: ArcLaunchCoordinatorInput) => Promise<ArcRecord>>>;

  beforeEach(() => {
    createMock = vi.fn<(input: ArcCreateInput) => Promise<ArcRecord>>();
    launchCoordinatorMock = vi.fn<(input: ArcLaunchCoordinatorInput) => Promise<ArcRecord>>();
    installArgmax(createMock, launchCoordinatorMock);
    resetOverlaysForTests();
    resetToastForTests();
  });

  afterEach(() => {
    cleanup();
    delete (window as { argmax?: unknown }).argmax;
    resetOverlaysForTests();
    resetToastForTests();
  });

  it("renders nothing when closed", () => {
    render(<NewArcDialog open={false} onClose={() => {}} projects={PROJECTS} />);
    expect(screen.queryByRole("dialog", { name: "New arc" })).not.toBeInTheDocument();
  });

  it("blocks submit until it has a name and either a brief or a folder", () => {
    render(<NewArcDialog open onClose={() => {}} projects={PROJECTS} />);
    const submit = screen.getByRole("button", { name: "Create arc" });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pricing rollout" } });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "/tmp/hq/missions/pricing" } });
    expect(submit).not.toBeDisabled();

    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Brief"), { target: { value: "Ship the new tiers." } });
    expect(submit).not.toBeDisabled();
  });

  it("creates the arc, launches its coordinator, and opens the Arc page", async () => {
    createMock.mockResolvedValue(ARC_RECORD);
    launchCoordinatorMock.mockResolvedValue({ ...ARC_RECORD, coordinatorSessionId: "session-coordinator" });
    const onClose = vi.fn();

    render(<NewArcDialog open onClose={onClose} projects={PROJECTS} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pricing rollout" } });
    fireEvent.change(screen.getByLabelText("Brief"), { target: { value: "Ship the new tiers." } });
    fireEvent.click(screen.getByRole("button", { name: "Create arc" }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith({
      name: "Pricing rollout",
      brief: "Ship the new tiers.",
      homeProjectId: "project-1",
      dir: null
    });

    await waitFor(() => expect(launchCoordinatorMock).toHaveBeenCalledTimes(1));
    expect(launchCoordinatorMock).toHaveBeenCalledWith(
      expect.objectContaining({ arcId: "arc-1", provider: "claude" })
    );

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(overlaysSnapshot().standalonePage).toBe("arc");
    expect(overlaysSnapshot().selectedArcId).toBe("arc-1");
  });

  it("shows the backend's ARC_DIR_INVALID message inline and keeps the dialog open", async () => {
    createMock.mockRejectedValue(new Error("ARC_DIR_INVALID: folder does not exist"));
    const onClose = vi.fn();

    render(<NewArcDialog open onClose={onClose} projects={PROJECTS} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pricing rollout" } });
    fireEvent.change(screen.getByLabelText("Brief"), { target: { value: "Ship the new tiers." } });
    fireEvent.click(screen.getByRole("button", { name: "Create arc" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("ARC_DIR_INVALID");
    expect(screen.getByRole("dialog", { name: "New arc" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(launchCoordinatorMock).not.toHaveBeenCalled();
  });

  it("still opens the page and toasts when the arc is created but the coordinator fails to launch", async () => {
    createMock.mockResolvedValue(ARC_RECORD);
    launchCoordinatorMock.mockRejectedValue(new Error("provider unavailable"));
    const onClose = vi.fn();

    render(<NewArcDialog open onClose={onClose} projects={PROJECTS} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pricing rollout" } });
    fireEvent.change(screen.getByLabelText("Brief"), { target: { value: "Ship the new tiers." } });
    fireEvent.click(screen.getByRole("button", { name: "Create arc" }));

    await waitFor(() => expect(launchCoordinatorMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(overlaysSnapshot().standalonePage).toBe("arc");
    expect(overlaysSnapshot().selectedArcId).toBe("arc-1");
    await waitFor(() => expect(toastSnapshot()?.kind).toBe("error"));
    expect(toastSnapshot()?.message).toContain("provider unavailable");
  });

  describe("starting from a chat", () => {
    const SOURCE = {
      sessionId: "session-chat",
      chatLabel: "Build the pricing page",
      projectName: "Argmax",
      isolated: true,
      adoptableCount: 2
    };

    function installPromote(
      draft: Promise<{ name: string | null; brief: string | null }>,
      promote = vi.fn(() => Promise.resolve(ARC_RECORD))
    ) {
      Object.defineProperty(window, "argmax", {
        configurable: true,
        writable: true,
        value: { arcs: { draftFromSession: vi.fn(() => draft), promote } }
      });
      return promote;
    }

    it("fills the draft, names what comes along, and promotes the chat", async () => {
      const promote = installPromote(
        Promise.resolve({ name: "Pricing rollout", brief: "Ship the new tiers." })
      );
      const onClose = vi.fn();
      render(<NewArcDialog open onClose={onClose} projects={PROJECTS} promote={SOURCE} />);

      const dialog = screen.getByRole("dialog", { name: "Start an arc from this chat" });
      expect(dialog).toHaveTextContent("Build the pricing page becomes the arc’s coordinator");
      expect(dialog).toHaveTextContent("The 2 chats it launched join the arc too.");
      expect(dialog).toHaveTextContent("This chat runs in its own worktree.");
      expect(screen.queryByLabelText("Coordinator model")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Home project" })).not.toBeInTheDocument();

      await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Pricing rollout"));
      expect(screen.getByLabelText("Brief")).toHaveValue("Ship the new tiers.");
      expect(screen.getByText("Drafted from this chat")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Start arc" }));
      await waitFor(() => expect(promote).toHaveBeenCalledTimes(1));
      expect(promote).toHaveBeenCalledWith({
        sessionId: "session-chat",
        name: "Pricing rollout",
        brief: "Ship the new tiers.",
        dir: null
      });
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    it("never overwrites a field the person typed into before the draft landed", async () => {
      let resolveDraft: (value: { name: string | null; brief: string | null }) => void = () => {};
      installPromote(
        new Promise((resolve) => {
          resolveDraft = resolve;
        })
      );
      render(<NewArcDialog open onClose={() => {}} projects={PROJECTS} promote={SOURCE} />);

      expect(screen.getByText("Drafting from this chat…")).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My own name" } });
      resolveDraft({ name: "Drafted name", brief: "Drafted brief." });

      await waitFor(() => expect(screen.getByLabelText("Brief")).toHaveValue("Drafted brief."));
      expect(screen.getByLabelText("Name")).toHaveValue("My own name");
    });

    it("says so when no draft could be made", async () => {
      installPromote(Promise.resolve({ name: null, brief: null }));
      render(<NewArcDialog open onClose={() => {}} projects={PROJECTS} promote={SOURCE} />);
      expect(await screen.findByText("Couldn’t draft one, so write it yourself")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Start arc" })).toBeDisabled();
    });
  });
});
