import { afterEach, describe, expect, it } from "vitest";
import { takeDeepLinkSessionId } from "./deepLink.js";

function visit(url: string): void {
  window.history.replaceState(null, "", url);
}

describe("takeDeepLinkSessionId", () => {
  afterEach(() => {
    visit("/mobile.html");
  });

  it("returns the session id and scrubs it from the address bar", () => {
    visit("/mobile.html?session=session-review-studio");

    expect(takeDeepLinkSessionId()).toBe("session-review-studio");
    expect(window.location.search).toBe("");
    // Consumed once: a reload after the scrub lands on the list.
    expect(takeDeepLinkSessionId()).toBeNull();
  });

  it("keeps other query params and the pairing hash", () => {
    visit("/mobile.html?session=session-1&demo=1#token=abc");

    expect(takeDeepLinkSessionId()).toBe("session-1");
    expect(window.location.search).toBe("?demo=1");
    expect(window.location.hash).toBe("#token=abc");
  });

  it("rejects an id outside the accepted shape but still scrubs it", () => {
    visit("/mobile.html?session=%3Cscript%3E");

    expect(takeDeepLinkSessionId()).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("returns null when no session is linked", () => {
    visit("/mobile.html?demo=1");

    expect(takeDeepLinkSessionId()).toBeNull();
    expect(window.location.search).toBe("?demo=1");
  });
});
