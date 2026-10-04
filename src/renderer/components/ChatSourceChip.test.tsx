import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatReferenceLink } from "../lib/composerContext.js";
import {
  publishChatDirectory,
  registerChatOpener,
  resetChatDirectoryForTests
} from "../state/chatDirectory.js";
import { ChatSourceChip } from "./ChatSourceChip.js";
import { SessionConversationUserMessage } from "./SessionConversationTurn.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";

afterEach(() => {
  cleanup();
  resetChatDirectoryForTests();
});

const known = {
  sessionId: "s1",
  workspaceId: "w1",
  title: "Billing rewrite",
  projectName: "Argmax",
  lastActivityAt: "2026-10-01T00:00:00Z"
};

describe("ChatSourceChip", () => {
  it("opens the chat it names, under the chat's current title", () => {
    const open = vi.fn();
    registerChatOpener(open);
    publishChatDirectory([{ ...known, title: "Billing v2" }]);
    render(<ChatSourceChip sessionId="s1" title="Billing rewrite" />);

    fireEvent.click(screen.getByRole("button", { name: "Open chat: Billing v2" }));

    expect(open).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w1" }));
  });

  it("keeps a missing chat visible with its title and offers nothing to open", () => {
    render(<ChatSourceChip sessionId="gone" title="Billing rewrite" />);

    expect(screen.getByText("Billing rewrite (unavailable)")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("draws the chat when it arrives in the directory later", () => {
    render(<ChatSourceChip sessionId="s1" title="Billing rewrite" />);
    expect(screen.queryByRole("button")).toBeNull();

    act(() => publishChatDirectory([known]));

    expect(screen.getByRole("button", { name: "Open chat: Billing rewrite" })).toBeInTheDocument();
  });
});

describe("chat references in the transcript", () => {
  it("draws a reference in a sent prompt as a chip, and keeps the sent text for copy", () => {
    publishChatDirectory([known]);
    const message = `see ${chatReferenceLink({ sessionId: "s1", title: "Billing rewrite" })} for context`;
    render(
      <SessionConversationUserMessage
        event={{ id: "e1", type: "user.message", message, payload: {}, createdAt: "2026-10-01T00:00:00Z" } as never}
        attachments={[]}
      />
    );

    expect(screen.getByRole("button", { name: "Open chat: Billing rewrite" })).toBeInTheDocument();
    expect(screen.queryByText(/argmax:\/\/chat/)).toBeNull();
    expect(screen.getByText(/for context/)).toBeInTheDocument();
  });

  it("draws a chat an answer cites as a chip too", () => {
    publishChatDirectory([known]);
    render(<StreamingMarkdown streaming={false} text="Per [Billing rewrite](argmax://chat/s1?v=1) the fix landed." />);

    expect(screen.getByRole("button", { name: "Open chat: Billing rewrite" })).toBeInTheDocument();
  });
});
