import { isPlainObject } from "../../shared/typeGuards.js";
import type { ToolCall } from "./toolCalls.js";

export const ACTIVITY_KINDS = [
  "read", "edit", "image", "search", "list", "web-search", "web-fetch",
  "discovery", "command", "tool", "agent", "skill", "image-capture", "image-generate", "computer",
  "agent-message", "agent-wait", "agent-stop", "memory-recall", "memory-save", "git", "browser", "plan"
] as const;
export type ToolActivityKind = typeof ACTIVITY_KINDS[number];
export type ToolActivity = {
  version: 1;
  kind: ToolActivityKind;
  evidence: "native" | "tool" | "command";
  targets: string[];
  operation?: "create" | "edit" | "delete" | "move";
  toolCount?: number;
};

/** Unknown versions stay readable through the ordinary tool presentation. */
export function decodeToolActivity(value: unknown): ToolActivity | null {
  if (!isPlainObject(value) || value.version !== 1 ||
    !ACTIVITY_KINDS.some((kind) => kind === value.kind) ||
    typeof value.evidence !== "string" || !["native", "tool", "command"].includes(value.evidence) ||
    !Array.isArray(value.targets) || !value.targets.every((path) => typeof path === "string" && path.length > 0)) return null;
  if (value.operation !== undefined && (typeof value.operation !== "string" || !["create", "edit", "delete", "move"].includes(value.operation))) return null;
  if (value.toolCount !== undefined && (typeof value.toolCount !== "number" || !Number.isSafeInteger(value.toolCount) || value.toolCount < 0)) return null;
  return value as ToolActivity;
}

export function mergeToolActivity(start: ToolActivity | null, end: ToolActivity | null): ToolActivity | undefined {
  if (!end) return start ?? undefined;
  if (start && end.kind === "tool") return start.kind === "discovery" && end.toolCount !== undefined
    ? { ...start, toolCount: end.toolCount } : start;
  if (start && end.kind === "image" && ["image-capture", "image-generate", "computer", "browser"].includes(start.kind)) return start;
  return { ...start, ...end, targets: end.targets.length ? end.targets : start?.targets ?? [] };
}

type ActivityState = "running" | "succeeded" | "failed" | "cancelled" | "unconfirmed";
export function toolActivityState(tool: ToolCall): ActivityState {
  if (tool.cancelled) return "cancelled";
  if (tool.status === "running") return "running";
  if (tool.status === "error") return "failed";
  return tool.completionObserved === true ? "succeeded" : "unconfirmed";
}

export function activityLabel(activity: ToolActivity, state: ActivityState, plural = false, target?: string): string {
  const file = target || (plural ? "files" : "a file");
  const image = target || (plural ? "images" : "an image");
  const operation = activity.operation;
  let verbs: [string, string, string];
  switch (activity.kind) {
    case "read": verbs = [`Reading ${file}`, `Read ${file}`, "File read"]; break;
    case "edit": {
      const verb = operation === "create" ? ["Creating", "Created"] : operation === "delete" ? ["Deleting", "Deleted"] : operation === "move" ? ["Moving", "Moved"] : ["Editing", "Edited"];
      verbs = [`${verb[0]} ${file}`, `${verb[1]} ${file}`, "File change"]; break;
    }
    case "image": verbs = [`Viewing ${image}`, `Viewed ${image}`, "Image view"]; break;
    case "image-capture": verbs = ["Capturing a screenshot", "Captured a screenshot", "Screenshot capture"]; break;
    case "image-generate": verbs = [`Generating ${image}`, `Generated ${image}`, "Image generation"]; break;
    case "search": verbs = ["Searching files", "Searched files", "File search"]; break;
    case "list": verbs = ["Listing files", "Listed files", "File listing"]; break;
    case "web-search": verbs = ["Searching the web", "Searched the web", "Web search"]; break;
    case "web-fetch": verbs = ["Fetching a URL", "Fetched a URL", "Web request"]; break;
    case "discovery": verbs = ["Searching for tools", activity.toolCount ? `Loaded ${activity.toolCount === 1 && !plural ? "a tool" : "tools"}` : "Searched tools", "Tool discovery"]; break;
    case "command": verbs = [plural ? "Running commands" : "Running a command", plural ? "Ran commands" : "Ran a command", "Command"]; break;
    case "computer": verbs = ["Using a computer", "Used a computer", "Computer use"]; break;
    case "agent": verbs = ["Starting an agent", plural ? "Started agents" : "Started an agent", "Agent launch"]; break;
    case "agent-message": verbs = ["Messaging an agent", plural ? "Messaged agents" : "Messaged an agent", "Agent message"]; break;
    case "agent-wait": verbs = ["Waiting for an agent", plural ? "Waited for agents" : "Waited for an agent", "Agent wait"]; break;
    case "agent-stop": verbs = ["Stopping an agent", plural ? "Stopped agents" : "Stopped an agent", "Agent stop"]; break;
    case "memory-recall": verbs = ["Recalling memory", "Recalled memory", "Memory recall"]; break;
    case "memory-save": verbs = ["Saving a memory", plural ? "Saved memories" : "Saved a memory", "Memory save"]; break;
    case "git": {
      const subcommand = target ? `git ${target}` : "git commands";
      verbs = [`Running ${subcommand}`, `Ran ${subcommand}`, "Git command"]; break;
    }
    case "browser": verbs = ["Using the browser", "Used the browser", "Browser action"]; break;
    case "plan": verbs = ["Updating the plan", "Updated the plan", "Plan update"]; break;
    case "skill": verbs = ["Activating a skill", "Activated a skill", "Skill activation"]; break;
    case "tool": verbs = [plural ? "Using tools" : "Using a tool", plural ? "Used tools" : "Used a tool", "Tool call"]; break;
  }
  if (state === "running") return verbs[0];
  if (state === "succeeded") return verbs[1];
  return `${verbs[2]} ${state === "unconfirmed" ? "(unconfirmed)" : state}`;
}

export function describeActivity(tool: ToolCall): string | null {
  const activity = tool.activity;
  if (!activity) return null;
  const target = activity.targets.length === 1 ? activity.targets[0]?.split(/[\\/]/).pop() : undefined;
  return activityLabel(activity, toolActivityState(tool), activity.targets.length > 1, target);
}

export function summarizeActivities(tools: ToolCall[]): { headline: string; iconKind: ToolActivityKind } {
  const groups = new Map<string, { activity: ToolActivity; state: ActivityState; count: number; targets: Set<string> }>();
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.id)) continue;
    seen.add(tool.id);
    const activity = tool.activity ?? { version: 1, kind: "tool", evidence: "tool", targets: [] };
    const state = toolActivityState(tool);
    const key = `${activity.kind}:${activity.operation ?? ""}:${state}:${activity.kind === "discovery" && Boolean(activity.toolCount)}`;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      activity.targets.forEach((path) => group.targets.add(path));
    } else groups.set(key, { activity, state, count: 1, targets: new Set(activity.targets) });
  }
  const labels = [...groups.values()].map(({ activity, state, count, targets }) =>
    activityLabel(activity, state, targets.size ? targets.size > 1 : count > 1));
  return {
    headline: labels.map((label, index) => index ? label[0]?.toLowerCase() + label.slice(1) : label).join(", "),
    iconKind: groups.values().next().value?.activity.kind ?? "tool"
  };
}
