import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForkLineage, ForkMergePreview } from "../../shared/types.js";
import { dismissToast } from "../state/toast.js";
import { ForkBar } from "./ForkBar.js";

const lineage: ForkLineage = {
  forkId: "fork-1",
  sourceSessionId: "source-1",
  boundaryEventId: "u2",
  workspace: "shared",
  lastMergedThroughEventId: null
};

function preview(overrides: Partial<ForkMergePreview> = {}): ForkMergePreview {
  return {
    forkId: "fork-1",
    childSessionId: "child-1",
    sourceSessionId: "source-1",
    childLabel: "Try the other parser",
    sourceLabel: "Parser rewrite",
    boundaryExcerpt: "ask 2",
    throughEventId: "evt-9",
    newMessageCount: 2,
    shownMessageCount: 2,
    truncated: false,
    text: "Findings from the forked chat\n\nUser: explore\nAssistant: found it",
    nothingNew: false,
    childActive: false,
    sourceBusy: false,
    unconfirmedMergeId: null,
    lastMergedThroughEventId: null,
    ...overrides
  };
}

function stubSession(overrides: Record<string, unknown>): void {
  window.argmax = {
    ...window.argmax,
    session: {
      ...window.argmax?.session,
      forkLineage: vi.fn().mockResolvedValue(null),
      forkMergePreview: vi.fn().mockResolvedValue(preview()),
      forkMerge: vi.fn().mockResolvedValue({
        merged: true,
        queued: false,
        mergeId: "merge-1",
        throughEventId: "evt-9"
      }),
      ...overrides
    }
  } as typeof window.argmax;
}

describe("ForkBar", () => {
  beforeEach(() => dismissToast());
  afterEach(() => cleanup());

  it("renders nothing for a chat that was not forked", async () => {
    stubSession({});
    const { container } = render(<ForkBar sessionId="child-1" />);
    await waitFor(() => expect(window.argmax!.session.forkLineage).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the source chat", async () => {
    stubSession({ forkLineage: vi.fn().mockResolvedValue(lineage) });
    const onOpenSession = vi.fn();
    render(<ForkBar sessionId="child-1" onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open source" }));
    expect(onOpenSession).toHaveBeenCalledWith("source-1");
  });

  it("previews what the source receives and sends exactly the previewed position", async () => {
    stubSession({ forkLineage: vi.fn().mockResolvedValue(lineage) });
    render(<ForkBar sessionId="child-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Bring findings back" }));

    const dialog = await screen.findByRole("dialog", { name: "Bring findings back" });
    expect(await screen.findByText(/2 new messages from this fork go to Parser rewrite/)).toBeVisible();
    expect(screen.getByLabelText("Message the source will receive")).toHaveTextContent("Assistant: found it");

    fireEvent.click(screen.getByRole("button", { name: "Send to source" }));
    await waitFor(() =>
      expect(window.argmax!.session.forkMerge).toHaveBeenCalledWith({
        sessionId: "child-1",
        throughEventId: "evt-9"
      })
    );
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("says the message will queue when the source is mid-turn", async () => {
    stubSession({
      forkLineage: vi.fn().mockResolvedValue(lineage),
      forkMergePreview: vi.fn().mockResolvedValue(preview({ sourceBusy: true }))
    });
    render(<ForkBar sessionId="child-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Bring findings back" }));
    expect(await screen.findByText(/waits in its queue until that turn ends/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Queue for source" })).toBeEnabled();
  });

  it("offers nothing to send once every finding has been brought back", async () => {
    stubSession({
      forkLineage: vi.fn().mockResolvedValue(lineage),
      forkMergePreview: vi.fn().mockResolvedValue(preview({ nothingNew: true, text: "" }))
    });
    render(<ForkBar sessionId="child-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Bring findings back" }));
    expect(await screen.findByText(/Nothing new to bring back to Parser rewrite\./)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Send to source" })).toBeNull();
    expect(window.argmax!.session.forkMerge).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and surfaces a refused send", async () => {
    stubSession({
      forkLineage: vi.fn().mockResolvedValue(lineage),
      forkMerge: vi.fn().mockRejectedValue(new Error("The source chat is archived."))
    });
    render(<ForkBar sessionId="child-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Bring findings back" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send to source" }));
    await waitFor(() => expect(window.argmax!.session.forkMerge).toHaveBeenCalled());
    expect(screen.getByRole("dialog", { name: "Bring findings back" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send to source" })).toBeEnabled();
  });
});
