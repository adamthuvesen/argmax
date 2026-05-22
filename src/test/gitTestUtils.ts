import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_GIT_USER = {
  email: "argmax@example.test",
  name: "Argmax Test"
} as const;

export type SeedGitRepoFile = {
  path: string;
  contents: string | Buffer;
};

export type SeedGitRepoOptions = {
  prefix?: string;
  initialBranch?: string;
  files?: readonly SeedGitRepoFile[];
  commitMessage?: string;
  /** Commit with no tree when true (requires user config). */
  emptyCommit?: boolean;
  /** Additional branch names to create after the initial commit. */
  branches?: readonly string[];
  user?: { email: string; name: string };
};

export function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

export function seedGitRepo(options: SeedGitRepoOptions = {}): string {
  const prefix = options.prefix ?? "argmax-git-";
  const initialBranch = options.initialBranch ?? "main";
  const user = options.user ?? DEFAULT_GIT_USER;
  const repoPath = realpathSync(mkdtempSync(join(tmpdir(), prefix)));

  runGit(repoPath, ["init", `--initial-branch=${initialBranch}`]);
  runGit(repoPath, ["config", "user.email", user.email]);
  runGit(repoPath, ["config", "user.name", user.name]);

  const files = options.files ?? [];
  for (const file of files) {
    const fullPath = join(repoPath, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.contents);
  }

  if (options.emptyCommit) {
    runGit(repoPath, ["commit", "--allow-empty", "-m", options.commitMessage ?? "test: seed repo"]);
  } else if (files.length > 0) {
    runGit(repoPath, ["add", ...files.map((file) => file.path)]);
    runGit(repoPath, ["commit", "-m", options.commitMessage ?? "test: seed repo"]);
  }

  for (const branch of options.branches ?? []) {
    if (branch === initialBranch) continue;
    runGit(repoPath, ["branch", branch]);
  }
  if ((options.branches?.length ?? 0) > 0) {
    runGit(repoPath, ["checkout", initialBranch]);
  }

  return repoPath;
}
