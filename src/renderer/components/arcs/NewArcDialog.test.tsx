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

  it("blocks submit while the name is blank", () => {
    render(<NewArcDialog open onClose={() => {}} projects={PROJECTS} />);
    expect(screen.getByRole("button", { name: "Create arc" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pricing rollout" } });
    expect(screen.getByRole("button", { name: "Create arc" })).not.toBeDisabled();
  });

  it("creates the arc, launches its coordinator, and opens the Arc page", async () => {
    createMock.mockResolvedValue(ARC_RECORD);
    launchCoordinatorMock.mockResolvedValue({ ...ARC_RECORD, coordinatorSessionId: "session-coordinator" });
    const onClose = vi.fn();

    render(<NewArcDialog open onClose={onClose} projects={PROJECTS} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pricing rollout" } });
    fireEvent.click(screen.getByRole("button", { name: "Create arc" }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith({
      name: "Pricing rollout",
      brief: "",
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
    fireEvent.click(screen.getByRole("button", { name: "Create arc" }));

    await waitFor(() => expect(launchCoordinatorMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(overlaysSnapshot().standalonePage).toBe("arc");
    expect(overlaysSnapshot().selectedArcId).toBe("arc-1");
    await waitFor(() => expect(toastSnapshot()?.kind).toBe("error"));
    expect(toastSnapshot()?.message).toContain("provider unavailable");
  });
});
