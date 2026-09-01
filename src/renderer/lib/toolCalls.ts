import { safeJsonParse, safeJsonParseRecord } from "../../shared/safeJson.js";
import type { TimelineEvent } from "../../shared/types.js";
import {
  interpretFileChange,
  summarizeFileChanges,
  type ChangeCounts
} from "./fileChange.js";

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
  | { kind: "tool"; tool: ToolCall; children?: ToolCall[] }
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
 * Task isn't lumped under "other" — instead it renders as "Started agent",
 * with the Bot icon and a distinct CSS accent so the user can tell at a
 * glance that a different agent is doing the work.
 */
export function isAgentToolName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "close_agent" || lower === "close-agent" || lower === "send_message_to_thread") {
    return false;
  }
  // Claude's built-in tool is exactly "Task". Cursor spawns sub-agents via
  // `taskToolCall`; Codex coordinates them via `collab_tool_call`. Neither
  // streams the sub-agent's internal steps, but surfacing the launch as an
  // Agent (Bot icon + "Started an agent") still tells the user a different
  // agent did the work. Anchor literal matches so we don't sweep up
  // "TaskList" or "agent_id"-style names.
  return lower === "task" || lower === "agent" || lower === "subagent" ||
    lower === "tasktoolcall" || lower === "collab_tool_call" || lower === "spawn_agent" ||
    /(^|[_-])(sub-?agent|agent)$/.test(lower);
}

/**
 * MCP servers namespace their tools on the wire, and the namespace carries
 * words the bucket matchers key on: `mcp__claude_ai_Notion__notion-fetch`
 * matched `fetch` and rendered as "Fetched URL", naming neither Notion nor the
 * page it read. These are two literal protocol shapes rather than a guess —
 * Claude and Cursor prefix with `mcp__`, OpenCode repeats the server, and the
 * backreference is what keeps ordinary snake_case names out.
 */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const match =
    /^mcp__(.+?)__(.+)$/.exec(name) ??
    /^([a-z0-9-]+)_\1-(.+)$/.exec(name) ??
    /^([a-z][a-z0-9-]*)\.(.+)$/.exec(name);
  if (!match) return null;
  const [, namespace, toolSegment] = match;
  if (!namespace || !toolSegment) return null;
  // `claude_ai_Notion` names the client before the server; the user connected
  // to the last segment.
  // Claude's hosted namespace adds a client prefix. Other underscores belong
  // to the server (`browser_use`) and must survive.
  let server = namespace.startsWith("claude_ai_")
    ? namespace.slice("claude_ai_".length)
    : namespace;
  if (server.startsWith("plugin-")) {
    const parts = server.slice("plugin-".length).split("-").filter(Boolean);
    const half = parts.length / 2;
    server =
      Number.isInteger(half) &&
      parts.slice(0, half).join("-") === parts.slice(half).join("-")
        ? parts.slice(0, half).join(" ")
        : parts.at(-1) ?? server;
  } else {
    server = server.replace(/[-_]/g, " ");
  }
  const words = toolSegment.split(/[-_]+/).filter(Boolean);
  if (words[0]?.toLowerCase() === server.toLowerCase()) words.shift();
  if (words.length === 0) return null;
  return { server, tool: words.join(" ") };
}

/** "Notion fetch" for `mcp__claude_ai_Notion__notion-fetch`, else null. */
export function mcpToolLabel(name: string): string | null {
  const parsed = parseMcpToolName(name);
  if (!parsed) return null;
  return `${parsed.server.charAt(0).toUpperCase()}${parsed.server.slice(1)} ${parsed.tool}`;
}

const HIDDEN_TOOL_NAMES = new Set([
  // Provider-side discovery before the actual MCP call. The subsequent call
  // names the external action; showing both is protocol leakage.
  "getmcptoolstoolcall",
  "toolsearch",
  // Internal task-list bookkeeping. It changes no project file and creates no
  // agent; the resulting plan is already visible through useful work.
  "taskcreate",
  "taskupdate",
  "todowrite"
]);

export function isHiddenToolName(name: string): boolean {
  return HIDDEN_TOOL_NAMES.has(name.toLowerCase());
}

function humanizeToolName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[._-]+|\s+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.length === 0) return "Used tool";
  const first = words[0] ?? "";
  words[0] = `${first.charAt(0).toUpperCase()}${first.slice(1)}`;
  return words.join(" ");
}

function getFineBucket(name: string): FineBucket {
  const lower = name.toLowerCase();
  // Before the agent check too: an MCP tool ending in `-agent` is not a
  // subagent launch and must not open an activity pane.
  if (parseMcpToolName(name)) return "other";
  if (isAgentToolName(name)) return "agent";
  if (/bash|shell|exec|terminal|cmd/.test(lower)) return "bash";
  // `replace` catches Grok Build's `search_replace`, its primary edit tool —
  // without it the `search` matcher below claims it and edits read as searches.
  if (/write|edit|create|patch|replace|file[_-]?change/.test(lower)) return "edit";
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
  const nNoun = (singular: string, pluralWord: string): string =>
    `${n} ${n === 1 ? singular : pluralWord}`;
  switch (bucket) {
    case "agent":
      if (first) return n === 1 ? "Started an agent" : `Started ${n} agents`;
      return nNoun("agent", "agents");
    case "read-files":
      return first ? `Explored ${nNoun("file", "files")}` : nNoun("file", "files");
    case "read-lists":
      return first ? `Listed ${nNoun("directory", "directories")}` : nNoun("list", "lists");
    case "search":
      if (first) return n === 1 ? "Searched once" : `Searched ${n} times`;
      return nNoun("search", "searches");
    case "web":
      return first ? `Fetched ${nNoun("URL", "URLs")}` : nNoun("URL", "URLs");
    case "edit":
      return first ? `Edited ${nNoun("file", "files")}` : nNoun("edit", "edits");
    case "bash":
      return first ? `Ran ${nNoun("command", "commands")}` : `ran ${nNoun("command", "commands")}`;
    case "other":
      return first ? `Used ${nNoun("tool", "tools")}` : nNoun("tool", "tools");
  }
}

/**
 * Split an activity label into its leading verb and the rest ("Edited" +
 * "userBubbleTint.ts", "Explored" + "2 files, ran 1 command"). Rows and group
 * headlines share one visual grammar — bright verb, dim remainder — so they
 * share one splitter.
 */
export function splitLeadingVerb(label: string): { verb: string; rest: string } {
  const space = label.indexOf(" ");
  if (space === -1) return { verb: label, rest: "" };
  return { verb: label.slice(0, space), rest: label.slice(space + 1) };
}

/**
 * Sum the line stat across a run of tool calls, for the `+N −N` a collapsed
 * group headline shows. Reads the same per-tool input the expanded rows read,
 * so the headline can never disagree with the rows underneath it.
 */
export function summarizeToolChangeCounts(tools: ToolCall[]): ChangeCounts | null {
  let adds = 0;
  let dels = 0;
  let files = 0;
  for (const tool of tools) {
    const changes = interpretFileChange(tool.name, tool.inputFull);
    if (!changes) continue;
    const counts = summarizeFileChanges(changes);
    adds += counts.adds;
    dels += counts.dels;
    files += counts.files;
  }
  if (adds === 0 && dels === 0) return null;
  return { adds, dels, files };
}

export function describeToolAction(tool: ToolCall): string {
  // Claude's Skill tool fires when the agent activates a skill. The skill's
  // full body streams separately (and is dropped upstream as noise), so the
  // row is the one durable marker — make it name the skill outright instead of
  // a bare "Skill".
  if (tool.name.toLowerCase() === "skill") {
    return tool.inputPreview ? `Activated skill ${tool.inputPreview}` : "Activated skill";
  }
  const mcpLabel = mcpToolLabel(tool.name);
  if (mcpLabel) return tool.inputPreview ? `${mcpLabel} ${tool.inputPreview}` : mcpLabel;
  const bucket = getFineBucket(tool.name);
  const preview = tool.inputPreview;
  const basename = (path: string): string => {
    const trimmed = path.replace(/\/$/, "");
    return trimmed.includes("/") ? trimmed.split("/").pop() ?? trimmed : trimmed;
  };
  switch (bucket) {
    case "agent":
      // Make agent delegation read like an action in the transcript. "Agent X"
      // looked like a label; "Started agent X" tells the user work was handed
      // to another agent without turning the row into a banner.
      return preview ? `Started agent ${preview}` : "Started agent";
    case "bash":
      return preview ? `Ran ${displayBashCommand(preview)}` : "Ran command";
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
      return preview ? `${humanizeToolName(tool.name)} ${preview}` : humanizeToolName(tool.name);
  }
}

// Extract a short, human-scannable token from a single tool call. For file
// tools that's the basename; for shell commands it's the first real binary
// word, peeking through `zsh -lc '…'` / `bash -c '…'` wrappers and stripping
// leading quotes so `'git status --short'` reads as `git`.

/** Full command text for the expanded detail. Rows use `displayBashCommand`. */
export function unwrapBashCommand(input: string): string {
  let s = stripOuterQuotes(input.trim());
  for (let i = 0; i < 2; i++) {
    const match = /^(?:[\w./-]+\/)?(?:zsh|bash|sh)\s+-l?c\s+(?<inner>[\s\S]+)$/i.exec(s);
    if (!match?.groups?.inner) break;
    const inner = stripOuterQuotes(match.groups.inner.trim());
    if (!inner || inner === s) break;
    s = inner;
  }
  return s;
}

/** One-line preview for the row label. Truncates; the detail shows the rest. */
export function displayBashCommand(input: string): string {
  return unwrapBashCommand(input).slice(0, 72);
}

function stripOuterQuotes(input: string): string {
  const first = input[0];
  const last = input[input.length - 1];
  if ((first === "'" || first === "\"" || first === "`") && first === last) {
    return input.slice(1, -1).trim();
  }
  return input;
}

export function summarizeToolGroup(tools: ToolCall[]): {
  headline: string;
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

  return { headline, currentAction, status, hasErrors: hasError };
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

/**
 * The provider process run an event came out of, stamped onto every payload by
 * the flush queue. Provider-native tool ids (`call_1`, `item_2`) are only
 * unique within one run, so this is what keeps a second run's reused id from
 * being read as the first run's tool. Historical rows predate the stamp and
 * return null.
 */
export function extractProviderInvocationId(payload: Record<string, unknown>): string | null {
  const value = payload.providerInvocationId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function extractToolName(payload: Record<string, unknown>): string {
  const payloadName = typeof payload.name === "string" ? payload.name : null;
  const input = inputRecord(payload.input, "toolCalls.name.input");

  // Cursor ACP emits the wrapper kind as the name and keeps the real tool in
  // the input. Resolve that identity before classification so `other` + task
  // becomes an agent launch, and MCP calls name the server they actually used.
  const embeddedName = input._toolName;
  if (
    payloadName?.toLowerCase() === "other" &&
    typeof embeddedName === "string" &&
    embeddedName.length > 0
  ) {
    return embeddedName;
  }

  const lower = payloadName?.toLowerCase();
  if (lower === "mcptoolcall" || lower === "getmcptoolstoolcall") {
    const server = input.serverIdentifier ?? input.providerIdentifier ?? input.server;
    const tool = input.toolName;
    if (typeof server === "string" && server.length > 0 && typeof tool === "string" && tool.length > 0) {
      return `mcp__${server}__${tool}`;
    }
  }

  // Codex normalizes the event name to `item.tool`, but preserves `server` and
  // `tool` at the payload root. Recover the pair regardless of the wrapper
  // name (`mcp_tool_call` may already be gone by this point).
  const codexServer = payload.server;
  const codexTool = payload.tool;
  if (
    typeof codexServer === "string" &&
    codexServer.length > 0 &&
    typeof codexTool === "string" &&
    codexTool.length > 0
  ) {
    if (codexTool.includes(".")) return codexTool;
    return `mcp__${codexServer}__${codexTool}`;
  }

  if (payloadName) return payloadName;
  if (typeof payload.type === "string" && payload.type !== "command.started") return payload.type;
  return "tool";
}

function inputRecord(value: unknown, context: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    return safeJsonParseRecord(value, context);
  }
  return {};
}

export function extractToolInput(payload: Record<string, unknown>): Record<string, unknown> {
  const args = {
    ...inputRecord(payload.parameters, "toolCalls.parameters"),
    ...inputRecord(payload.arguments, "toolCalls.arguments"),
    ...inputRecord(payload.args, "toolCalls.args")
  };
  const input = inputRecord(payload.input, "toolCalls.input");
  return { ...args, ...input };
}

export function cleanToolInput(
  name: string,
  input: Record<string, unknown>,
  providerName?: string | null
): Record<string, unknown> {
  if (!parseMcpToolName(name) || providerName?.toLowerCase() !== "mcptoolcall") return input;
  const args = inputRecord(input.args, "toolCalls.mcp.args");
  return args;
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
  if (isAgentToolName(name)) {
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
    const prompt = input.prompt;
    if (typeof prompt === "string" && prompt.trim().length > 0) {
      return prompt.slice(0, 72);
    }
    return "";
  }
  if (lower.includes("bash") || lower.includes("shell") || lower.includes("exec")) {
    const cmd = input.command ?? input.cmd;
    if (typeof cmd === "string") return cmd.split("\n")[0]?.slice(0, 72) ?? "";
  }
  if (/file[_-]?change/.test(lower)) {
    const preview = previewChangedPaths(input.changes);
    if (preview) return preview;
  }
  const path = input.file_path ?? input.filePath ?? input.path ?? input.relative_path;
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

/** The path preview for a Codex `file_change` payload ("src/foo.ts +2" when it
 *  touched three files). Paths, not line counts — the `+N` here is how many
 *  more files the change covered. */
function previewChangedPaths(changes: unknown): string {
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

const OUTPUT_TEXT_KEYS = ["text", "content", "result", "output"] as const;
const OUTPUT_ENVELOPE_KEYS = new Set([
  ...OUTPUT_TEXT_KEYS,
  "metadata",
  "title",
  "type",
  "url"
]);

export type FormattedToolOutput = { body: string; title: string | null };

/**
 * An MCP result is a JSON envelope carrying its payload in one string field,
 * so a `<pre>` shows the metadata first and then the real content with every
 * newline as a literal `\n`. Re-serializing does not help — `JSON.stringify`
 * escapes those newlines again — so lift the string out instead. Anything
 * else that parses is pretty-printed; anything that does not is left alone.
 */
export function formatToolOutput(output: string): FormattedToolOutput {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return { body: output, title: null };
  const parsed = safeJsonParse(trimmed, "toolCalls.output");
  if (parsed === undefined || parsed === null) return { body: output, title: null };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { body: JSON.stringify(parsed, null, 2), title: null };
  }
  const envelope = parsed as Record<string, unknown>;
  const textKeys = OUTPUT_TEXT_KEYS.filter((key) => typeof envelope[key] === "string");
  const [key] = textKeys;
  const hasDataFields = Object.keys(envelope).some((field) => !OUTPUT_ENVELOPE_KEYS.has(field));
  if (textKeys.length !== 1 || key === undefined || hasDataFields) {
    return { body: JSON.stringify(envelope, null, 2), title: null };
  }
  const title = typeof envelope.title === "string" ? envelope.title.trim() : "";
  return { body: envelope[key] as string, title: title.length > 0 ? title : null };
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
  for (const key of ["file_path", "filePath", "filepath", "path", "relative_path", "absolute_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function isBashLikeTool(name: string): boolean {
  const lower = name.toLowerCase();
  return /bash|shell|exec|terminal|cmd/.test(lower);
}

export type ToolTypeBucket = "bash" | "edit" | "read" | "search" | "web" | "agent" | "other";

export function getToolTypeBucket(name: string): ToolTypeBucket {
  const lower = name.toLowerCase();
  if (parseMcpToolName(name)) return "other";
  if (isAgentToolName(name)) return "agent";
  if (/bash|shell|exec|terminal|cmd/.test(lower)) return "bash";
  if (/write|edit|create|patch|replace|file[_-]?change/.test(lower)) return "edit";
  if (/read|view|open|cat|list/.test(lower)) return "read";
  if (/search|grep|find|glob/.test(lower)) return "search";
  if (/web|browser|navigate|fetch|url|http/.test(lower)) return "web";
  return "other";
}
