import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LINK_TARGET_KEY } from "../lib/linkTarget.js";
import { getBrowserRequest, subscribeBrowserRequest } from "../lib/browserPanel.js";
import { SessionConversationUserMessage } from "./SessionConversationTurn.js";

// Installing the real bridge at import time would arm a WebSocket; the flag is
// all the link needs from it.
const remote = vi.hoisted(() => ({ bridge: false }));
vi.mock("../lib/tauriBridge.js", () => ({
  isRemoteBridge: () => remote.bridge
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  remote.bridge = false;
  window.localStorage.removeItem(LINK_TARGET_KEY);
  delete (window as { argmax?: unknown }).argmax;
});

function renderMessage(message: string): void {
  render(
    <SessionConversationUserMessage
      event={{ id: "evt-1", message, createdAt: 0 } as never}
      attachments={[]}
    />
  );
}

describe("<SessionConversationUserMessage />", () => {
  it("renders a pasted URL as a link and leaves the rest as typed", () => {
    renderMessage("Can we check https://github.com/mentimeter/revops-backoffice/pull/458 today");

    const link = screen.getByRole("link", {
      name: "https://github.com/mentimeter/revops-backoffice/pull/458"
    });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/mentimeter/revops-backoffice/pull/458"
    );
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("article")).toHaveTextContent(
      "Can we check https://github.com/mentimeter/revops-backoffice/pull/458 today"
    );
  });

  it("opens a link in the system browser on a plain click", () => {
    const openPath = vi.fn(() => Promise.resolve({ ok: true as const }));
    (window as { argmax?: unknown }).argmax = { system: { openPath } };

    renderMessage("see https://menti.com/docs");
    fireEvent.click(screen.getByRole("link", { name: "https://menti.com/docs" }));

    expect(openPath).toHaveBeenCalledWith({ path: "https://menti.com/docs" });
  });

  it("opens a link in the browser pane on ⌘-click", () => {
    const requested: string[] = [];
    const stop = subscribeBrowserRequest(() => {
      const request = getBrowserRequest();
      if (request) requested.push(request.url);
    });

    renderMessage("see https://menti.com/docs");
    fireEvent.click(screen.getByRole("link", { name: "https://menti.com/docs" }), {
      metaKey: true
    });

    expect(requested).toEqual(["https://menti.com/docs"]);
    stop();
  });

  it("does not read a URL path as a skill invocation", () => {
    const { container } = render(
      <SessionConversationUserMessage
        event={{ id: "evt-2", message: "https://menti.com/plan and /eli5", createdAt: 0 } as never}
        attachments={[]}
      />
    );

    expect(container.querySelectorAll(".user-skill-token")).toHaveLength(1);
    expect(container.querySelector(".user-skill-token")?.textContent).toBe("/eli5");
  });

  it("leaves a message with no URL as plain text", () => {
    renderMessage("just a prompt about src/lib/foo.ts");

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("article")).toHaveTextContent("just a prompt about src/lib/foo.ts");
  });
});

/** A `user.message` another session's agent wrote, as Rust stores it. */
function originEvent(origin: unknown): never {
  return {
    id: "evt-origin",
    message: "Picker is fixed, over to you.",
    createdAt: 0,
    payload: { source: "composer", agentMode: "auto", origin }
  } as never;
}

describe("<SessionConversationUserMessage /> — from another chat", () => {
  it("heads the bubble with the sending chat and opens it", () => {
    const onOpenSession = vi.fn();
    render(
      <SessionConversationUserMessage
        event={originEvent({ sessionId: "session-9", label: "Fix the model picker", kind: "message" })}
        attachments={[]}
        onOpenSession={onOpenSession}
      />
    );

    expect(screen.getByRole("article", { name: "Message from another chat" })).toHaveTextContent(
      "From Fix the model picker"
    );

    fireEvent.click(screen.getByRole("button", { name: "Open chat: Fix the model picker" }));
    expect(onOpenSession).toHaveBeenCalledWith("session-9");
  });

  it("names the sending chat without an opener when the host cannot focus one", () => {
    render(
      <SessionConversationUserMessage
        event={originEvent({ sessionId: "session-9", label: "Fix the model picker", kind: "completion" })}
        attachments={[]}
      />
    );

    expect(screen.getByRole("article", { name: "Message from another chat" })).toHaveTextContent(
      "From Fix the model picker"
    );
    expect(screen.queryByRole("button", { name: /^Open chat:/ })).toBeNull();
  });

  it("falls back to the plain bubble when the origin block is malformed", () => {
    render(
      <SessionConversationUserMessage
        event={originEvent({ sessionId: "session-9", label: "   " })}
        attachments={[]}
      />
    );

    expect(screen.queryByRole("article", { name: "Message from another chat" })).toBeNull();
    expect(screen.getByRole("article")).toHaveTextContent("Picker is fixed, over to you.");
  });

  it("renders an ordinary user message with no origin as the plain bubble", () => {
    renderMessage("do the thing");

    expect(screen.queryByRole("article", { name: "Message from another chat" })).toBeNull();
    expect(screen.getByRole("article")).toHaveTextContent("do the thing");
  });
});
