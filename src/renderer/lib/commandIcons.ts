import { serverIconFor } from "./serverIcons.js";
import { isBashLikeTool, unwrapBashCommand, type ToolCall } from "./toolCalls.js";

export interface CommandIconRule {
  commandPattern: string;
  server: string;
}

export function parseCommandIconRules(value: unknown): CommandIconRule[] {
  if (!Array.isArray(value)) throw new Error("argmax-icons.local.json must contain an array of command icon rules");
  return value.map((rule: unknown, index) => {
    if (
      typeof rule !== "object" || rule === null ||
      !("commandPattern" in rule) || typeof rule.commandPattern !== "string" || !rule.commandPattern.trim() ||
      !("server" in rule) || typeof rule.server !== "string" || !serverIconFor(rule.server) ||
      Object.keys(rule).some((key) => key !== "commandPattern" && key !== "server")
    ) throw new Error(`Invalid command icon rule ${index + 1} in argmax-icons.local.json: expected commandPattern and a known server`);
    try {
      new RegExp(rule.commandPattern);
    } catch {
      throw new Error(`Invalid commandPattern in argmax-icons.local.json rule ${index + 1}`);
    }
    return { commandPattern: rule.commandPattern, server: rule.server };
  });
}

// Shipped with every build: `gh` is the GitHub CLI everywhere, so a row that
// opens a PR or reads a check run carries the GitHub mark without local setup.
// Plain `git` stays unmarked — a remote is not necessarily GitHub.
export const DEFAULT_RULES: CommandIconRule[] = parseCommandIconRules([
  { commandPattern: "^(?:[\\w./-]*/)?gh(?=\\s|$)", server: "github" }
]);

// Optional build input: personal rules stay out of the public checkout.
const localFiles = import.meta.glob<unknown>("../../../argmax-icons.local.json", { eager: true, import: "default" });
const rules = [...parseCommandIconRules(Object.values(localFiles)[0] ?? []), ...DEFAULT_RULES];

/** Match the full shell input, before the row preview truncates long paths. */
export function commandIconServer(tool: ToolCall, matchers: CommandIconRule[] = rules): string | null {
  if (!isBashLikeTool(tool.name)) return null;
  const input = tool.inputFull;
  const command = [input?.command, input?.cmd, input?.shell_command, input?.script]
    .find((value): value is string => typeof value === "string") ?? tool.inputPreview;
  if (!command) return null;
  const unwrapped = unwrapBashCommand(command);
  return matchers.find((rule) => new RegExp(rule.commandPattern).test(unwrapped))?.server ?? null;
}
