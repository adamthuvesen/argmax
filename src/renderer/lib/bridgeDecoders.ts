import { decodeWireTimelineEvent } from "./canonicalTimeline.js";
import type * as Wire from "../../shared/bindings.js";
import type * as Client from "../../shared/types.js";

/** Validate the stored string columns that the client exposes as closed unions. */
function member<const T extends readonly string[]>(value: string, values: T, field: string): T[number] {
  if (!values.includes(value)) throw new Error(`Invalid bridge response: ${field}=${JSON.stringify(value)}`);
  return value;
}
function agentMode(value: string): Client.AgentMode {
  // Hosts from before Plan mode was retired still return its persisted tag.
  if (value === "plan") return "auto";
  return member(value, ["auto"], "agentMode");
}
const providers = ["claude", "codex", "cursor", "opencode", "grok"] as const;
const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
const prStates = ["OPEN", "CLOSED", "MERGED"] as const;
const checkStates = ["unknown", "pending", "success", "failure", "neutral", "cancelled", "skipped"] as const;

export function workspace(row: Wire.WorkspaceSummary): Client.WorkspaceSummary {
  return {
    ...row,
    state: member(row.state, ["created", "running", "waiting", "blocked", "complete", "failed", "cancelled", "archiving", "archive-failed", "kept", "archived"], "workspace.state"),
    kind: member(row.kind, ["git", "scratch", "popup"], "workspace.kind"),
    prState: row.prState == null ? null : member(row.prState, prStates, "workspace.prState"),
    prSummaryState: row.prSummaryState == null ? row.prSummaryState : member(row.prSummaryState, prStates, "workspace.prSummaryState"),
    prCheckState: row.prCheckState == null ? null : member(row.prCheckState, checkStates, "workspace.prCheckState")
  };
}
export function session(row: Wire.SessionSummary): Client.SessionSummary {
  return {
    ...row,
    provider: member(row.provider, providers, "session.provider"),
    permissionMode: member(row.permissionMode, ["provider-defaults", "auto-approve", "ask-each-time"], "session.permissionMode"),
    agentMode: row.agentMode == null ? row.agentMode : agentMode(row.agentMode),
    reasoningEffort: row.reasoningEffort == null ? row.reasoningEffort : member(row.reasoningEffort, efforts, "session.reasoningEffort")
  };
}
export function approval(row: Wire.ApprovalRequest): Client.ApprovalRequest {
  return { ...row, provider: member(row.provider, providers, "approval.provider"),
    riskLevel: member(row.riskLevel, ["low", "medium", "high"], "approval.riskLevel"),
    status: member(row.status, ["pending", "approved", "rejected", "cancelled"], "approval.status") };
}
export function check(row: Wire.CheckRun): Client.CheckRun {
  return { ...row, status: member(row.status, ["queued", "running", "passed", "failed", "cancelled"], "check.status") };
}
export function rawOutput(row: Wire.RawProviderOutput): Client.RawProviderOutput {
  return { ...row, rowCursor: row.rowCursor ?? undefined, stream: member(row.stream, ["stdout", "stderr", "pty", "system"], "output.stream") };
}
export function pendingMessage(row: Wire.PendingMessage): Client.PendingMessage {
  return { ...row, agentMode: agentMode(row.agentMode),
    provider: row.provider == null ? undefined : member(row.provider, providers, "pendingMessage.provider"),
    modelLabel: row.modelLabel ?? undefined, modelId: row.modelId ?? undefined,
    reasoningEffort: row.reasoningEffort == null ? undefined : member(row.reasoningEffort, efforts, "pendingMessage.reasoningEffort"),
    recoveryStatus: row.recoveryStatus == null ? undefined : member(row.recoveryStatus, ["unsent", "delivery-unknown"], "pendingMessage.recoveryStatus") };
}
export function pendingMessages(rows: Wire.DashboardListSnapshot["pendingMessages"]): Client.DashboardSnapshot["pendingMessages"] {
  return Object.fromEntries(Object.entries(rows).map(([id, messages]) => [id, messages?.map(pendingMessage) ?? []]));
}
export function dashboard(row: Wire.DashboardListSnapshot): Client.DashboardListSnapshot {
  return { ...row, workspaces: row.workspaces.map(workspace), sessions: row.sessions.map(session),
    checks: row.checks.map(check), pendingMessages: pendingMessages(row.pendingMessages) };
}
export function workspaceStatus(row: Wire.WorkspaceStatusSnapshot): Client.WorkspaceStatusSnapshot {
  return { ...row, workspaces: row.workspaces.map(workspace), sessions: row.sessions.map(session), checks: row.checks.map(check) };
}
export function routine(row: Wire.Routine): Client.Routine {
  return { ...row, provider: member(row.provider, providers, "routine.provider") };
}
export function learning(row: Wire.Learning): Client.Learning {
  return { ...row, kind: member(row.kind, ["pitfall", "convention", "command"], "learning.kind") };
}
export function pullRequest(row: Wire.GhPrRecord): Client.GhPrRecord {
  return { ...row, prState: row.prState == null ? null : member(row.prState, prStates, "pr.state"),
    lastSeenCheckState: member(row.lastSeenCheckState, checkStates, "pr.checkState") };
}
export function pickedFolder(row: Wire.ProjectFolderPickResult): Client.ProjectFolderPickResult {
  if (row.cancelled === true) return { cancelled: true };
  if (row.cancelled === false && "project" in row) return { cancelled: false, project: row.project };
  throw new Error("Invalid bridge response: selected folder has no project");
}
export function syncStatus(row: Wire.SyncStatus): Client.SyncStatus {
  const { claude, codex, cursor, opencode, grok, windowHours } = row.config;
  if ([claude, codex, cursor, opencode, grok].some(value => typeof value !== "boolean") || typeof windowHours !== "number") {
    throw new Error("Invalid bridge response: incomplete sync configuration");
  }
  return { ...row, config: { claude: claude!, codex: codex!, cursor: cursor!, opencode: opencode!, grok: grok!, windowHours } };
}

export function transcript(row: Wire.SessionEventsSinceResult): Client.SessionEventsSinceResult {
  return { ...row, events: row.events.map(decodeWireTimelineEvent), rawOutputs: row.rawOutputs.map(rawOutput) };
}
export function delta(row: Wire.DashboardDelta): Client.DashboardDelta {
  return { ...row,
    workspaces: row.workspaces?.map(workspace), sessions: row.sessions?.map(session),
    approvals: row.approvals?.map(approval), events: row.events?.map(decodeWireTimelineEvent),
    rawOutputs: row.rawOutputs?.map(rawOutput),
    pendingMessages: row.pendingMessages == null ? undefined : pendingMessages(row.pendingMessages)
  };
}
export function pageExtraction(row: Wire.PageExtraction): Client.BrowserPageExtraction {
  if (typeof row.tabId !== "string" || typeof row.state !== "string") {
    throw new Error("Invalid bridge response: page extraction has no tab or state");
  }
  return { ...row, tabId: row.tabId, state: row.state, items: (row.items ?? []).map(item => ({ ...item, ref: item.ref ?? null })), fields: (row.fields ?? []).map(field => ({ ...field, ref: field.ref ?? null })) };
}
