import { beforeEach, describe, expect, it } from "vitest";
import {
  commitChatCycle,
  jumpToAdjacentChat,
  noteChatVisited,
  resetChatCycle,
  stepChatCycle
} from "./chatCycle.js";

const VISIBLE = ["workspace-1", "workspace-2", "workspace-3", "workspace-4"];

/** One ⌘§ press and release, the way the hook drives it. */
function tap(step: 1 | -1, currentId: string | null, visible: readonly string[] = VISIBLE): string | null {
  const landed = stepChatCycle(step, visible, currentId);
  commitChatCycle();
  if (landed) noteChatVisited(landed);
  return landed;
}

describe("chatCycle", () => {
  beforeEach(resetChatCycle);

  it("opens the most recently used chat from the launcher, and the least with Shift", () => {
    expect(stepChatCycle(1, VISIBLE, null)).toBe("workspace-1");
    commitChatCycle();
    resetChatCycle();
    expect(stepChatCycle(-1, VISIBLE, null)).toBe("workspace-4");
  });

  it("toggles between the two most recently used chats, like Cmd+Tab", () => {
    noteChatVisited("workspace-4");
    noteChatVisited("workspace-2");

    // From 2, one tap lands on 4 — where we came from, not the next row down.
    expect(tap(1, "workspace-2")).toBe("workspace-4");
    // And the next tap comes straight back, because landing on 4 pushed 2 to
    // position 1. This is the pair the chord is for.
    expect(tap(1, "workspace-4")).toBe("workspace-2");
    expect(tap(1, "workspace-2")).toBe("workspace-4");
  });

  it("walks further down the stack while Cmd is held, then commits only where it lands", () => {
    noteChatVisited("workspace-1");
    noteChatVisited("workspace-4");
    noteChatVisited("workspace-3");
    noteChatVisited("workspace-2");

    // Held: the order stays frozen at [2, 3, 4, 1], so each press moves on
    // instead of rocking between two neighbours.
    expect(stepChatCycle(1, VISIBLE, "workspace-2")).toBe("workspace-3");
    expect(stepChatCycle(1, VISIBLE, "workspace-2")).toBe("workspace-4");
    expect(stepChatCycle(1, VISIBLE, "workspace-2")).toBe("workspace-1");
    // Shift steps back up the same frozen order.
    expect(stepChatCycle(-1, VISIBLE, "workspace-2")).toBe("workspace-4");
    commitChatCycle();
    noteChatVisited("workspace-4");

    // Only workspace-4 was promoted; the chats stepped past on the way keep
    // their old places, so the toggle pair is now 4 and 2.
    expect(tap(1, "workspace-4")).toBe("workspace-2");
  });

  it("drops chats that leave the sidebar mid-hold", () => {
    noteChatVisited("workspace-3");
    noteChatVisited("workspace-1");

    expect(stepChatCycle(1, VISIBLE, "workspace-1")).toBe("workspace-3");
    // workspace-3 is archived while Cmd is still down.
    const remaining = ["workspace-1", "workspace-2", "workspace-4"];
    expect(stepChatCycle(1, remaining, "workspace-1")).toBe("workspace-2");
  });

  it("ends the hold when a chat is opened by some other route", () => {
    noteChatVisited("workspace-1");
    expect(stepChatCycle(1, VISIBLE, "workspace-1")).toBe("workspace-2");

    // The user hits Cmd+3 mid-hold. Releasing Cmd must not drag them back to
    // workspace-2.
    noteChatVisited("workspace-3");
    commitChatCycle();
    expect(tap(1, "workspace-3")).toBe("workspace-1");
  });

  it("treats each native-menu step as its own press and release", () => {
    noteChatVisited("workspace-2");
    noteChatVisited("workspace-1");

    expect(jumpToAdjacentChat(1, VISIBLE, "workspace-1")).toBe("workspace-2");
    noteChatVisited("workspace-2");
    expect(jumpToAdjacentChat(1, VISIBLE, "workspace-2")).toBe("workspace-1");
  });

  it("has nothing to cycle through with an empty sidebar", () => {
    expect(stepChatCycle(1, [], null)).toBeNull();
    expect(jumpToAdjacentChat(-1, [], null)).toBeNull();
  });
});
