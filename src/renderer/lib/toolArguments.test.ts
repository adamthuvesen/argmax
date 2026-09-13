import { describe, expect, it } from "vitest";
import {
  displayToolInput,
  isAgentMessageToolName,
  isOpaqueCiphertext
} from "./toolArguments.js";

const CIPHERTEXT =
  "gAAAAABqpr4RdQiuoPbbS8PNeXuPtwfMGzgdXSHeWlWEyxGKhoB8JNw93a0oEyUkXVys9_wfawjMwX2QyWz8Ld6BwXbK_iZ0zfaCj5BZ5d038NLnbMX1rp3M00FqlwAaKycytD6E";

describe("opaque tool arguments", () => {
  it("recognizes a Fernet collab token and not ordinary prose", () => {
    expect(isOpaqueCiphertext(CIPHERTEXT)).toBe(true);
    expect(isOpaqueCiphertext("Please review the diff.")).toBe(false);
    expect(isOpaqueCiphertext("gAAAAA")).toBe(false);
  });

  it("drops Codex send_message ciphertext and thread ids", () => {
    expect(isAgentMessageToolName("send_message")).toBe(true);
    expect(
      displayToolInput("send_message", {
        message: CIPHERTEXT,
        receiver_thread_ids: ["thread-1"],
        sender_thread_id: "thread-parent"
      })
    ).toEqual({});
  });

  it("keeps a readable Claude SendMessage body and drops the agent id", () => {
    expect(isAgentMessageToolName("SendMessage")).toBe(true);
    expect(
      displayToolInput("SendMessage", {
        to: "a5c5b27a1557fa19e",
        message: "Please also check the iOS path."
      })
    ).toEqual({ message: "Please also check the iOS path." });
  });

  it("keeps Fernet-shaped data for unrelated tools", () => {
    expect(displayToolInput("Bash", { token: CIPHERTEXT })).toEqual({ token: CIPHERTEXT });
  });

  it("keeps an Argmax session_message body and its target chat", () => {
    expect(isAgentMessageToolName("mcp__argmax__session_message")).toBe(true);
    expect(
      displayToolInput("mcp__argmax__session_message", {
        session: "s-1",
        message: "The review is ready."
      })
    ).toEqual({ session: "s-1", message: "The review is ready." });
  });
});
