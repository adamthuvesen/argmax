import { Bot, FileText, Globe, Pencil, Search, Terminal, Wrench } from "lucide-react";
import type { JSX } from "react";
import { safeJsonParseRecord } from "../../shared/safeJson.js";
import type { TimelineEvent } from "../../shared/types.js";

export type ToolCall = {
  id: string;
  toolUseId: string;
  name: string;
  inputPreview: string;
  inputFull: Record<string, unknown>;
  output: string | null;
  status: "running" | "done" | "error";
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  // The `toolUseId` of the agent (Task) tool that spawned this call, when this
  // is a sub-agent's tool call. Lets the group bubble nest children under their
  // agent banner. Absent for top-level calls.
  parentToolUseId?: string | null;
};

export type ParallelPosition = "start" | "middle" | "end";

export type ToolCallGroup = {
  id: string;
  tools: ToolCall[];
  parallelPositions: Map<string, ParallelPosition>;
  parallelGroupId: Map<string, string>;
};

export type TurnToolItem =
  | { kind: "tool"; tool: ToolCall }
  | { kind: "tool-group"; group: ToolCallGroup };

export type ConversationItem =
  | { kind: "message"; event: TimelineEvent }
  | { kind: "tool"; tool: ToolCall }
  | { kind: "tool-group"; group: ToolCallGroup };

const PARALLEL_WINDOW_MS = 75;

export function buildToolCallGroup(tools: ToolCall[]): ToolCallGroup {
  const parallelPositions = new Map<string, ParallelPosition>();
  const parallelGroupId = new Map<string, string>();
  let cluster: ToolCall[] = [];
  const finalize = (): void => {
    if (cluster.length >= 2) {
      const first = cluster[0];
      const last = cluster[cluster.length - 1];
      if (!first || !last) {
        cluster = [];
        return;
      }
      const groupId = `pg-${first.id}`;
      parallelPositions.set(first.id, "start");
      parallelPositions.set(last.id, "end");
      parallelGroupId.set(first.id, groupId);
      parallelGroupId.set(last.id, groupId);
      for (let i = 1; i < cluster.length - 1; i++) {
        const mid = cluster[i];
        if (!mid) continue;
        parallelPositions.set(mid.id, "middle");
        parallelGroupId.set(mid.id, groupId);
      }
    }
    cluster = [];
  };
  for (const tool of tools) {
    const last = cluster[cluster.length - 1];
    if (!last) {
      cluster.push(tool);
      continue;
    }
    const gap = Date.parse(tool.createdAt) - Date.parse(last.createdAt);
    if (Number.isFinite(gap) && gap <= PARALLEL_WINDOW_MS) {
      cluster.push(tool);
    } else {
      finalize();
      cluster = [tool];
    }
  }
  finalize();
  const firstTool = tools[0];
  return {
    id: firstTool ? `tcg-${firstTool.id}` : "tcg-empty",
    tools,
    parallelPositions,
    parallelGroupId
  };
}

export type GroupRow = { tool: ToolCall; children: ToolCall[] };

// Split the flat tool list into a one-level tree: a sub-agent's calls (those
// carrying the spawning Task's toolUseId as parentToolUseId) nest under that
// Task. Everything else stays top-level. Order is preserved; children are
// pulled to sit directly beneath their parent so the group renders the agent's
// work as a nested thread, not an unattributed flat list.
export function buildGroupRows(tools: ToolCall[]): GroupRow[] {
  const byId = new Set(tools.map((t) => t.toolUseId));
  const childrenByParent = new Map<string, ToolCall[]>();
  const topLevel: ToolCall[] = [];
  for (const tool of tools) {
    const parent = tool.parentToolUseId;
    if (parent && parent !== tool.toolUseId && byId.has(parent)) {
      const arr = childrenByParent.get(parent) ?? [];
      arr.push(tool);
      childrenByParent.set(parent, arr);
    } else {
      topLevel.push(tool);
    }
  }
  return topLevel.map((tool) => ({
    tool,
    children: childrenByParent.get(tool.toolUseId) ?? []
  }));
}

type FineBucket = "read-files" | "read-lists" | "search" | "web" | "edit" | "bash" | "agent" | "other";

/**
 * The sub-agent / Task tool gets its own bucket so a parent agent spawning a
 * Task isn't lumped under "other" — instead it renders with the Agent label,
 * Bot icon, and a distinct CSS accent so the user can tell at a glance that
 * a different agent is doing the work.
 */
function isAgentTool(lower: string): boolean {
  // Claude's built-in tool is exactly "Task". Cursor spawns sub-agents via
  // `taskToolCall`; Codex coordinates them via `collab_tool_call`. Neither
  // streams the sub-agent's internal steps, but surfacing the launch as an
  // Agent (Bot icon + "Spawned N agents") still tells the user a different
  // agent did the work. Anchor literal matches so we don't sweep up
  // "TaskList" or "agent_id"-style names.
  return lower === "task" || lower === "agent" || lower === "subagent" ||
    lower === "tasktoolcall" || lower === "collab_tool_call" ||
    /(^|[_-])(sub-?agent|agent)$/.test(lower);
}

function getFineBucket(name: string): FineBucket {
  const lower = name.toLowerCase();
  if (isAgentTool(lower)) return "agent";
  if (/bash|shell|exec|terminal|cmd/.test(lower)) return "bash";
  if (/write|edit|create|patch|file[_-]?change/.test(lower)) return "edit";
  if (/search|grep|find|glob/.test(lower)) return "search";
  if (/web|browser|navigate|fetch|url|http/.test(lower)) return "web";
  // Distinguish directory listings ("list", "list_dir", "ls") from file reads
  // ("read", "view", "open", "cat") so the rolled-up headline can read
  // "Explored 1 file, 2 lists" like Codex.
  if (/^ls$|list[_-]?dir|^list$|list_files|list_directory/.test(lower)) return "read-lists";
  if (/read|view|open|cat/.test(lower)) return "read-files";
  if (/list/.test(lower)) return "read-lists";
  return "other";
}

const FINE_BUCKET_ORDER: FineBucket[] = [
  "agent",
  "read-files",
  "read-lists",
  "search",
  "web",
  "edit",
  "bash",
  "other"
];

// (verbForm, compactForm) per bucket. verbForm is used when the bucket is
// the sole bucket OR the first clause of a multi-bucket headline. compactForm
// is used for subsequent clauses — Codex-style "Explored 1 file, 2 lists,
// ran 1 command" emerges by mixing the two.
function clauseForBucket(bucket: FineBucket, n: number, first: boolean): string {
  const plural = (singular: string, pluralWord: string): string => (n === 1 ? singular : pluralWord);
  switch (bucket) {
    case "agent":
      return first ? `Spawned ${n} ${plural("agent", "agents")}` : `${n} ${plural("agent", "agents")}`;
    case "read-files":
      return first ? `Explored ${n} ${plural("file", "files")}` : `${n} ${plural("file", "files")}`;
    case "read-lists":
      return first ? `Listed ${n} ${plural("directory", "directories")}` : `${n} ${plural("list", "lists")}`;
    case "search":
      return first ? `Searched ${n} ${plural("time", "times")}` : `${n} ${plural("search", "searches")}`;
    case "web":
      return first ? `Fetched ${n} ${plural("URL", "URLs")}` : `${n} ${plural("URL", "URLs")}`;
    case "edit":
      return first ? `Edited ${n} ${plural("file", "files")}` : `${n} ${plural("edit", "edits")}`;
    case "bash":
      return first ? `Ran ${n} ${plural("command", "commands")}` : `ran ${n} ${plural("command", "commands")}`;
    case "other":
      return first ? `Used ${n} ${plural("tool", "tools")}` : `${n} ${plural("tool", "tools")}`;
  }
}

export function describeToolAction(tool: ToolCall): string {
  // Claude's Skill tool fires when the agent activates a skill. The skill's
  // full body streams separately (and is dropped upstream as noise), so the
  // row is the one durable marker — make it name the skill outright instead of
  // a bare "Skill".
  if (tool.name.toLowerCase() === "skill") {
    return tool.inputPreview ? `Activated skill ${tool.inputPreview}` : "Activated skill";
  }
  const bucket = getFineBucket(tool.name);
  const preview = tool.inputPreview;
  const basename = (path: string): string => {
    const trimmed = path.replace(/\/$/, "");
    return trimmed.includes("/") ? trimmed.split("/").pop() ?? trimmed : trimmed;
  };
  switch (bucket) {
    case "agent":
      // Sage "Agent" verb + the sub-agent's description (when the provider
      // gives one — Claude/Cursor do; Codex's collab call doesn't) make it
      // obvious a different agent is doing this work. No bland "task" filler.
      return preview ? `Agent ${preview}` : "Agent";
    case "bash":
      return preview ? `Ran ${preview}` : "Ran command";
    case "edit":
      return preview ? `Edited ${basename(preview)}` : "Edited file";
    case "read-files":
      return preview ? `Read ${basename(preview)}` : "Read file";
    case "read-lists":
      return preview ? `Listed files in ${basename(preview)}` : "Listed files";
    case "search":
      return preview ? `Searched for ${preview}` : "Searched";
    case "web":
      return preview ? `Fetched ${preview}` : "Fetched URL";
    case "other":
      return preview ? `${tool.name} ${preview}` : tool.name;
  }
}

// Extract a short, human-scannable token from a single tool call. For file
// tools that's the basename; for shell commands it's the first real binary
// word, peeking through `zsh -lc '…'` / `bash -c '…'` wrappers and stripping
// leading quotes so `'git status --short'` reads as `git`.
function previewTokenForTool(tool: ToolCall): string | null {
  const bucket = getFineBucket(tool.name);
  const raw = (tool.inputPreview ?? "").trim();
  if (!raw) return null;
  const basenameOf = (p: string): string => {
    const t = p.replace(/\/$/, "");
    return t.includes("/") ? t.split("/").pop() ?? t : t;
  };
  if (bucket === "bash") return extractBashCommandName(raw);
  if (bucket === "web") {
    // Strip scheme + host to a compact hostname hint.
    const match = raw.match(/^https?:\/\/([^/?#]+)/i);
    return match?.[1] ?? raw.slice(0, 28);
  }
  // read-files / read-lists / edit / search / agent / other — prefer the
  // basename of any path-looking input; otherwise keep the raw input clipped.
  const candidate = raw.includes("/") ? basenameOf(raw) : raw;
  const stripped = candidate.replace(/^['"`]|['"`]$/g, "").trim();
  if (!stripped) return null;
  // trimEnd so a mid-word slice never leaves a trailing space that reads as
  // "and , find" once the tokens are comma-joined.
  return stripped.slice(0, 28).trimEnd();
}

function extractBashCommandName(input: string): string | null {
  // Peel surrounding quotes and shell-wrapper prefixes so the inner command
  // surfaces. Handles `zsh -lc 'rg foo'`, `bash -c "git status"`, and the
  // common `sh -c <cmd>` shape. Falls back to the first whitespace-delimited
  // word for plain commands.
  let s = input.trim();
  s = s.replace(/^(?:zsh|bash|sh)\s+-l?c\s+/, "");
  s = s.replace(/^['"`]|['"`]$/g, "").trim();
  // After unwrapping, take the first meaningful word.
  const firstWord = s.split(/[\s|;&]/, 1)[0] ?? "";
  if (!firstWord) return null;
  // For `git status --short`, the user reads it as "git status" — surface a
  // two-word hint when the first word is a known multiverb command driver.
  if (firstWord === "git" || firstWord === "npm" || firstWord === "yarn" || firstWord === "pnpm") {
    const second = s.split(/[\s|;&]/)[1] ?? "";
    return second ? `${firstWord} ${second}`.slice(0, 28) : firstWord;
  }
  return firstWord.slice(0, 28);
}

export function summarizeToolGroup(tools: ToolCall[]): {
  headline: string;
  preview: string;
  currentAction: string | null;
  status: ToolCall["status"];
  hasErrors: boolean;
} {
  const counts = new Map<FineBucket, number>();
  for (const tool of tools) {
    const b = getFineBucket(tool.name);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const clauses: string[] = [];
  let first = true;
  for (const bucket of FINE_BUCKET_ORDER) {
    const n = counts.get(bucket);
    if (!n) continue;
    clauses.push(clauseForBucket(bucket, n, first));
    first = false;
  }
  const headline = clauses.length > 0 ? clauses.join(", ") : `${tools.length} tool calls`;

  // Build a scannable preview: filenames for read/edit/list/search tools,
  // distinct binary names for bash commands. Dedupes so a group running
  // `rg` three times shows "rg" once, not three slash-joined repetitions.
  // The prior shape joined raw shell text ("zsh -lc 'git status --short'…")
  // which was a wall, not a preview.
  // Agent (Task) tools are excluded from the token preview: their full
  // description already headlines the group as the "Agent …" banner row, and
  // splicing a sentence fragment in among filenames produced run-ons like
  // "Explore agent structure and , find, ls, …". The eyebrow stat line
  // ("Spawned 1 agent") carries the count; the preview stays scannable tokens.
  const previewable = tools.filter((tool) => getFineBucket(tool.name) !== "agent");
  const seen = new Set<string>();
  const previewParts: string[] = [];
  let truncated = false;
  for (let i = 0; i < previewable.length; i++) {
    const tool = previewable[i];
    if (!tool) continue;
    const token = previewTokenForTool(tool);
    if (!token) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    previewParts.push(token);
    if (previewParts.length === 3) {
      // Mark truncated if any later tool would have produced a new token.
      for (let j = i + 1; j < previewable.length; j++) {
        const next = previewable[j];
        if (!next) continue;
        const t = previewTokenForTool(next);
        if (t && !seen.has(t)) {
          truncated = true;
          break;
        }
      }
      break;
    }
  }
  const preview = previewParts.join(", ") + (truncated ? ", …" : "");

  let hasError = false;
  let allErrors = tools.length > 0;
  let latestRunning: ToolCall | null = null;
  for (const tool of tools) {
    if (tool.status === "error") {
      hasError = true;
    } else {
      allErrors = false;
      if (tool.status === "running") latestRunning = tool;
    }
  }
  const status: ToolCall["status"] = allErrors ? "error" : latestRunning ? "running" : "done";

  // While the group is still running, surface the most recent live tool's
  // action so the collapsed header shows what the agent is doing right now.
  const currentAction = latestRunning ? describeToolAction(latestRunning) : null;

  return { headline, preview, currentAction, status, hasErrors: hasError };
}

export function extractToolUseId(payload: Record<string, unknown>): string | null {
  if (typeof payload.id === "string" && payload.id) return payload.id;
  if (typeof payload.call_id === "string" && payload.call_id) return payload.call_id;
  return null;
}

/**
 * Correlate a `command.completed` event back to its `command.started` partner.
 * Each provider keys the correlation differently:
 *   - Claude: `tool_result.tool_use_id` → started `tool_use.id`
 *   - Codex:  `item.completed.id` matches started `item.id`
 *   - Cursor: `tool_call(completed).call_id` matches started `call_id`
 * Checked in that order so Claude's `tool_use_id` (which is *not* the
 * completion's own id) wins over a coincidentally-present `id` field.
 */
export function extractCompletionCorrelationId(payload: Record<string, unknown>): string | null {
  if (typeof payload.tool_use_id === "string" && payload.tool_use_id) return payload.tool_use_id;
  if (typeof payload.id === "string" && payload.id) return payload.id;
  if (typeof payload.call_id === "string" && payload.call_id) return payload.call_id;
  return null;
}

export function extractToolName(payload: Record<string, unknown>): string {
  if (typeof payload.name === "string" && payload.name) return payload.name;
  if (typeof payload.type === "string" && payload.type !== "command.started") return payload.type;
  return "tool";
}

export function extractToolInput(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)) {
    return payload.input as Record<string, unknown>;
  }
  if (typeof payload.arguments === "string") {
    return safeJsonParseRecord(payload.arguments, "toolCalls.arguments");
  }
  return {};
}

export function extractToolInputPreview(name: string, input: Record<string, unknown>): string {
  const lower = name.toLowerCase();
  if (lower === "skill") {
    // Claude's Skill tool input is `{ skill: "<name>" }`; surface that name so
    // the row reads "Activated skill <name>".
    const skill = input.skill ?? input.name ?? input.command;
    if (typeof skill === "string" && skill.trim().length > 0) return skill.slice(0, 72);
    return "";
  }
  if (isAgentTool(lower)) {
    // Claude's Task tool input is `{ description, prompt, subagent_type }`.
    // `description` is the human-friendly 3-5 word title; prefer it over the
    // long prompt body so the collapsed row stays scannable.
    const description = input.description;
    if (typeof description === "string" && description.trim().length > 0) {
      return description.slice(0, 72);
    }
    const subagentType = input.subagent_type ?? input.subagentType;
    if (typeof subagentType === "string" && subagentType.trim().length > 0) {
      return subagentType.slice(0, 72);
    }
    return "";
  }
  if (lower.includes("bash") || lower.includes("shell") || lower.includes("exec")) {
    const cmd = input.command ?? input.cmd;
    if (typeof cmd === "string") return cmd.split("\n")[0]?.slice(0, 72) ?? "";
  }
  if (/file[_-]?change/.test(lower)) {
    const preview = summarizeFileChanges(input.changes);
    if (preview) return preview;
  }
  const path = input.file_path ?? input.path ?? input.relative_path;
  if (typeof path === "string") return path;
  const query = input.query ?? input.pattern ?? input.search_term;
  if (typeof query === "string") return String(query).slice(0, 72);
  const url = input.url;
  if (typeof url === "string") return url.slice(0, 72);
  // Unknown shape: skip the Object.values[0] fallback — key iteration order
  // is insertion-order for strings but ascending-numeric-first for
  // integer-like keys, so the preview would vary unpredictably with the
  // input shape. Return empty rather than guess.
  return "";
}

function summarizeFileChanges(changes: unknown): string {
  if (!Array.isArray(changes)) return "";
  const paths = changes
    .map((change) => {
      if (!change || typeof change !== "object") return null;
      const value = (change as Record<string, unknown>).path;
      return typeof value === "string" && value.length > 0 ? value : null;
    })
    .filter((value): value is string => value !== null);
  if (paths.length === 0) return "";
  const [first] = paths;
  if (!first) return "";
  return paths.length === 1 ? first : `${first} +${paths.length - 1}`;
}

export function extractToolOutput(payload: Record<string, unknown>): string | null {
  if (typeof payload.content === "string") return payload.content;
  if (Array.isArray(payload.content)) {
    const text = payload.content
      .map((c: unknown) => (c && typeof c === "object" && "text" in c ? String((c as Record<string, unknown>).text) : ""))
      .filter(Boolean)
      .join("\n");
    return text || null;
  }
  if (typeof payload.output === "string") return payload.output;
  return null;
}

export function detectToolError(payload: Record<string, unknown>): boolean {
  if (payload.is_error === true) return true;
  if (payload.isError === true) return true;
  if (typeof payload.error === "string" && payload.error.length > 0) return true;
  if (payload.error && typeof payload.error === "object") return true;
  const status = payload.status;
  if (typeof status === "string" && /fail|error/i.test(status)) return true;
  return false;
}

export function extractToolError(payload: Record<string, unknown>): string | null {
  if (typeof payload.error === "string" && payload.error.length > 0) return payload.error;
  if (payload.error && typeof payload.error === "object") {
    const errObj = payload.error as Record<string, unknown>;
    if (typeof errObj.message === "string") return errObj.message;
  }
  if (payload.is_error === true || payload.isError === true) {
    const output = extractToolOutput(payload);
    if (output) return output;
  }
  return null;
}

export function extractOpenablePath(name: string, input: Record<string, unknown>): string | null {
  const lower = name.toLowerCase();
  if (!/read|view|cat|write|edit|patch|create|open/.test(lower)) return null;
  for (const key of ["file_path", "filepath", "path", "relative_path", "absolute_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function isBashLikeTool(name: string): boolean {
  const lower = name.toLowerCase();
  return /bash|shell|exec|terminal|cmd/.test(lower);
}

export function getToolIcon(name: string): JSX.Element {
  const lower = name.toLowerCase();
  if (isAgentTool(lower)) {
    return <Bot size={13} />;
  }
  if (lower.includes("bash") || lower.includes("shell") || lower.includes("terminal") || lower.includes("exec")) {
    return <Terminal size={13} />;
  }
  if (lower.includes("write") || lower.includes("edit") || lower.includes("create") || lower.includes("patch") || /file[_-]?change/.test(lower)) {
    return <Pencil size={13} />;
  }
  if (lower.includes("read") || lower.includes("view") || lower.includes("open") || lower.includes("cat") || lower.includes("list")) {
    return <FileText size={13} />;
  }
  if (lower.includes("search") || lower.includes("grep") || lower.includes("find") || lower.includes("glob")) {
    return <Search size={13} />;
  }
  if (lower.includes("web") || lower.includes("browser") || lower.includes("navigate") || lower.includes("fetch") || lower.includes("url") || lower.includes("http")) {
    return <Globe size={13} />;
  }
  return <Wrench size={13} />;
}

export type ToolTypeBucket = "bash" | "edit" | "read" | "search" | "web" | "agent" | "other";

export function getToolTypeBucket(name: string): ToolTypeBucket {
  const lower = name.toLowerCase();
  if (isAgentTool(lower)) return "agent";
  if (/bash|shell|exec|terminal|cmd/.test(lower)) return "bash";
  if (/write|edit|create|patch|file[_-]?change/.test(lower)) return "edit";
  if (/read|view|open|cat|list/.test(lower)) return "read";
  if (/search|grep|find|glob/.test(lower)) return "search";
  if (/web|browser|navigate|fetch|url|http/.test(lower)) return "web";
  return "other";
}

export function buildGroupIconBuckets(tools: ToolCall[]): ToolTypeBucket[] {
  const seen = new Map<ToolTypeBucket, number>();
  for (const tool of tools) {
    const b = getToolTypeBucket(tool.name);
    seen.set(b, (seen.get(b) ?? 0) + 1);
  }
  return [...seen.keys()].slice(0, 3);
}

export const BUCKET_ICON_NAME: Record<ToolTypeBucket, string> = {
  bash: "bash",
  edit: "write",
  read: "read_file",
  search: "search_files",
  web: "web_fetch",
  agent: "agent",
  other: "tool",
};
