import { describe, expect, it, vi } from "vitest";
import type { ArgmaxApi } from "../../shared/types.js";
import { resolveOpenablePath } from "./openableFile.js";

function apiWithFiles(files: string[], changed: string[] = []): ArgmaxApi {
  return {
    workspace: {
      statFile: vi.fn().mockRejectedValue(new Error("outside workspace")),
      listFiles: vi.fn().mockResolvedValue(files.map((path) => ({ path })))
    },
    review: {
      listChangedFiles: vi.fn().mockResolvedValue(changed.map((path) => ({ path })))
    }
  } as unknown as ArgmaxApi;
}

describe("resolveOpenablePath", () => {
  it("maps an absolute path from another checkout by its workspace-relative suffix", async () => {
    const api = apiWithFiles(["src/renderer/App.tsx", "README.md"]);

    await expect(
      resolveOpenablePath(api, "workspace-1", "/Users/me/other-checkout/src/renderer/App.tsx")
    ).resolves.toBe("src/renderer/App.tsx");
  });

  it("resolves a unique bare filename but not an ambiguous one", async () => {
    await expect(
      resolveOpenablePath(apiWithFiles(["docs/README.md"]), "workspace-1", "README.md")
    ).resolves.toBe("docs/README.md");
    await expect(
      resolveOpenablePath(
        apiWithFiles(["docs/README.md", "fixtures/README.md"]),
        "workspace-1",
        "README.md"
      )
    ).resolves.toBeNull();
  });

  it("breaks a basename tie with the one changed match", async () => {
    const files = ["apps/a/instructions.md", "apps/b/instructions.md", "apps/c/instructions.md"];
    await expect(
      resolveOpenablePath(apiWithFiles(files, ["apps/b/instructions.md", "apps/b/agent.ts"]), "workspace-1", "instructions.md")
    ).resolves.toBe("apps/b/instructions.md");
    await expect(
      resolveOpenablePath(apiWithFiles(files, ["apps/a/instructions.md", "apps/c/instructions.md"]), "workspace-1", "instructions.md")
    ).resolves.toBeNull();
  });
});

