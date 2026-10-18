import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { baseSession } from "../../test/sessionConversationTestHarness.js";
import { ReviewSideChat, type ReviewSideChatContext, type ReviewSideChatSession } from "./ReviewSideChat.js";
import type { MultitaskPanel } from "./MultitaskPanel.js";

const chat = vi.hoisted(() => vi.fn());
vi.mock("./MultitaskPanel.js", () => ({
  MultitaskPanel: (props: ComponentProps<typeof MultitaskPanel>) => {
    chat(props);
    return <div>Transcript for {props.session.id}</div>;
  }
}));

function contextStub(): ReviewSideChatContext {
  return {
    launch: vi.fn().mockResolvedValue({ sessionId: "child", workspaceId: "scratch" }),
    sessionsById: new Map(),
    workspacesById: new Map(),
    onCancelQueuedMessage: vi.fn(),
    onClearSession: vi.fn(),
    onSendQueuedMessageNow: vi.fn(),
    onSendSessionInput: vi.fn().mockResolvedValue({ ok: true, queued: false }),
    onTerminateSession: vi.fn()
  };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("ReviewSideChat", () => {
  it("launches only on submit and ignores repeated submissions during launch", async () => {
    const context = contextStub();
    let finish!: (session: ReviewSideChatSession) => void;
    context.launch = vi.fn(() => new Promise<ReviewSideChatSession>((resolve) => { finish = resolve; }));
    const onLaunched = vi.fn();
    render(<ReviewSideChat context={context} onLaunched={onLaunched} />);
    expect(context.launch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start side chat" })).toBeDisabled();
    const message = screen.getByRole("textbox", { name: "Side chat message" });
    fireEvent.change(message, { target: { value: "  Explain this approach  " } });
    const form = message.closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(context.launch).toHaveBeenCalledExactlyOnceWith("Explain this approach");
    expect(screen.getByText("Starting chat…")).toBeVisible();
    await act(async () => {
      finish({ sessionId: "child", workspaceId: "scratch" });
      await Promise.resolve();
    });
    expect(onLaunched).toHaveBeenCalledExactlyOnceWith({ sessionId: "child", workspaceId: "scratch" });
  });

  it("retains the draft and exposes a failed launch for retry", async () => {
    const context = contextStub();
    context.launch = vi.fn().mockRejectedValue(new Error("Provider unavailable"));
    const onLaunched = vi.fn();
    render(<ReviewSideChat context={context} onLaunched={onLaunched} />);
    const message = screen.getByRole("textbox", { name: "Side chat message" });
    fireEvent.change(message, { target: { value: "Explain this approach" } });
    fireEvent.click(screen.getByRole("button", { name: "Start side chat" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Provider unavailable");
    expect(message).toHaveValue("Explain this approach");
    expect(screen.getByRole("button", { name: "Start side chat" })).toBeEnabled();
    expect(onLaunched).not.toHaveBeenCalled();
  });

  it("restores the same real chat and forwards live session state and commands", () => {
    const context = contextStub();
    const session = baseSession({ id: "child", workspaceId: "scratch", state: "running" });
    context.sessionsById = new Map([[session.id, session]]);
    const onLaunched = vi.fn();
    const { rerender } = render(
      <ReviewSideChat context={context} sessionId="child" workspaceId="scratch" isFocused={false} onLaunched={onLaunched} />
    );
    expect(screen.getByText("Transcript for child")).toBeVisible();
    expect(context.launch).not.toHaveBeenCalled();
    expect(chat).toHaveBeenLastCalledWith(expect.objectContaining({
      session,
      isFocused: false,
      onSendSessionInput: context.onSendSessionInput,
      onTerminateSession: context.onTerminateSession
    }));
    const updated = { ...session, state: "complete" as const };
    rerender(<ReviewSideChat context={{ ...context, sessionsById: new Map([[session.id, updated]]) }} sessionId="child" workspaceId="scratch" onLaunched={onLaunched} />);
    expect(chat).toHaveBeenLastCalledWith(expect.objectContaining({ session: updated }));
    expect(context.launch).not.toHaveBeenCalled();
  });
});
