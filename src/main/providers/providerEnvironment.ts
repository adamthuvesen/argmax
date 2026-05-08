import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const fallbackPathEntries = [
  join(homedir(), "bin"),
  join(homedir(), ".local", "bin"),
  join(homedir(), ".npm-global", "bin"),
  join(homedir(), ".bun", "bin"),
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin"
];

export function buildProviderEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
    PATH: providerPath(overrides.PATH ?? process.env.PATH)
  };
}

export function providerShell(): string {
  return process.env.SHELL && process.env.SHELL.startsWith("/") ? process.env.SHELL : "/bin/zsh";
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function providerPath(currentPath: string | undefined): string {
  const entries = [...(currentPath?.split(delimiter) ?? []), ...fallbackPathEntries].filter(Boolean);
  return Array.from(new Set(entries)).join(delimiter);
}
