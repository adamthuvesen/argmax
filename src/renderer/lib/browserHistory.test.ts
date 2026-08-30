// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  BROWSER_HISTORY_KEY,
  recordBrowserVisit,
  suggestBrowserHistory
} from "./browserHistory.js";

afterEach(() => {
  window.localStorage.removeItem(BROWSER_HISTORY_KEY);
});

describe("browser history", () => {
  it("records visits newest-first and dedupes by URL, keeping the title", () => {
    recordBrowserVisit("https://github.com", "GitHub");
    recordBrowserVisit("https://example.com", "Example");
    recordBrowserVisit("https://github.com", null);

    const suggestions = suggestBrowserHistory("");
    expect(suggestions.map((entry) => entry.url)).toEqual([
      "https://github.com",
      "https://example.com"
    ]);
    // A later visit without a title keeps the one already learned.
    expect(suggestions[0]?.title).toBe("GitHub");
  });

  it("matches on URL and title, case-insensitively", () => {
    recordBrowserVisit("https://github.com/argmax", "Argmax repo");
    recordBrowserVisit("https://example.com", "Example");

    expect(suggestBrowserHistory("ARGMAX").map((entry) => entry.url)).toEqual([
      "https://github.com/argmax"
    ]);
    expect(suggestBrowserHistory("example.com").map((entry) => entry.url)).toEqual([
      "https://example.com"
    ]);
    expect(suggestBrowserHistory("nothing")).toEqual([]);
  });

  it("ignores non-web URLs and survives corrupt storage", () => {
    recordBrowserVisit("about:blank", null);
    expect(suggestBrowserHistory("")).toEqual([]);

    window.localStorage.setItem(BROWSER_HISTORY_KEY, "not json");
    expect(suggestBrowserHistory("")).toEqual([]);
    recordBrowserVisit("https://github.com", "GitHub");
    expect(suggestBrowserHistory("")).toHaveLength(1);
  });
});
