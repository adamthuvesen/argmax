import { describe, expect, it } from "vitest";
import { shortenPathsInText } from "./pathDisplay.js";

describe("shortenPathsInText", () => {
  it("collapses the home prefix to ~", () => {
    expect(shortenPathsInText("/Users/user/dev/repo")).toBe("~/dev/repo");
    expect(shortenPathsInText("/home/user/dev/repo")).toBe("~/dev/repo");
  });

  it("middle-elides long paths so the tail survives", () => {
    const out = shortenPathsInText(
      "ls -la /Users/user/dev/example-app-repo/src/example_app_repo/commands"
    );
    expect(out).toBe("ls -la ~/…/example_app_repo/commands");
  });

  it("keeps the differing tail distinct across sibling paths", () => {
    const base = "/Users/user/dev/example-app-repo/src/example_app_repo";
    const a = shortenPathsInText(`${base}/commands`);
    const b = shortenPathsInText(`${base}/patch`);
    expect(a).not.toBe(b);
    expect(a.endsWith("example_app_repo/commands")).toBe(true);
    expect(b.endsWith("example_app_repo/patch")).toBe(true);
  });

  it("leaves short paths and non-path tokens untouched", () => {
    expect(shortenPathsInText("find ~/dev/example-app-repo -type f")).toBe(
      "find ~/dev/example-app-repo -type f"
    );
    expect(shortenPathsInText('rg --files -g "*.py"')).toBe('rg --files -g "*.py"');
  });

  it("preserves surrounding quotes on a path token", () => {
    expect(
      shortenPathsInText("read '/Users/user/dev/example-app-repo/src/pkg/verification'")
    ).toBe("read '~/…/pkg/verification'");
  });
});
