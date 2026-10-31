import type { ArgmaxApi, WorkspaceSummary } from "../../shared/types.js";
import { warmLedgerPagesOnIntent } from "../lib/ledgerPrefetch.js";
import { resolveOpenablePath } from "../lib/openableFile.js";
import { projectFolderInput, type ProjectTarget } from "../lib/projectTarget.js";

/**
 * The bridge calls a component may start from a handler: writes, and reads a
 * click asks for. Each accessor reads `window.argmax` at call time and returns
 * `undefined` where the host has no such domain, so a component guards with
 * `if (!arcs) return;`.
 *
 * A read that follows state belongs in `useBridgeQuery`, which drops a stale
 * reply. Keep such reads out of these lists, so the shorter path does not compile.
 */
type Actions<Domain extends keyof ArgmaxApi, Method extends keyof NonNullable<ArgmaxApi[Domain]>> =
  Pick<NonNullable<ArgmaxApi[Domain]>, Method>;

export function bridgeAvailable(): boolean {
  return typeof window !== "undefined" && Boolean(window.argmax);
}

export function arcActions(): Actions<"arcs", "create" | "update" | "setState" | "setArchived" | "launchCoordinator" | "promote"> | undefined {
  return window.argmax?.arcs;
}

export function browserActions(): ArgmaxApi["browser"] | undefined {
  return window.argmax?.browser;
}

export function checkpointActions(): Actions<"checkpoints", "previewRewind" | "rewindFiles"> | undefined {
  return window.argmax?.checkpoints;
}

export function cloudActions(): Actions<"cloud", "launch"> | undefined {
  return window.argmax?.cloud;
}

export function dashboardEvents(): Actions<"dashboard", "onDelta"> | undefined {
  return window.argmax?.dashboard;
}

/** `statFile` and friends here answer "does this file exist", asked per hover or click. */
export function fileActions(): Actions<"workspace", "statFile" | "statExternalFile" | "listFiles"> | undefined {
  return window.argmax?.workspace;
}

export function goalActions(): Actions<"goals", "set" | "clear"> | undefined {
  return window.argmax?.goals;
}

export function learningActions(): Actions<"learnings", "update" | "delete"> | undefined {
  return window.argmax?.learnings;
}

export function linkedRepoActions(): Actions<"linkedRepos", "summarize" | "setEnabled"> | undefined {
  return window.argmax?.linkedRepos;
}

export function prActions(): Actions<"prs", "setPrimary" | "dismiss" | "cleanup"> | undefined {
  return window.argmax?.prs;
}

export function projectActions(): Actions<"projects", "configure" | "generateOverview" | "updateOverview" | "applyOverviewDraft" | "discardOverviewDraft" | "pickDirectory" | "updateSettings" | "setBranchTemplate" | "resolveCheck"> | undefined {
  return window.argmax?.projects;
}

export function providerActions(): Actions<"providers", "terminate"> | undefined {
  return window.argmax?.providers;
}

export function questionActions(): Actions<"questions", "resolve"> | undefined {
  return window.argmax?.questions;
}

export function remoteActions(): Actions<"remote", "setConfig" | "testNotification" | "setApnsConfig" | "unregisterPushDevice" | "pushTest"> | undefined {
  return window.argmax?.remote;
}

export function routineActions(): Actions<"routines", "upsert" | "delete" | "setEnabled" | "runNow" | "resetSession"> | undefined {
  return window.argmax?.routines;
}

export function sessionActions(): Actions<"session", "forkMerge"> | undefined {
  return window.argmax?.session;
}

export function settingsActions(): Actions<"settings", "setRoutingKey" | "clearRoutingKey" | "setProjectCheck" | "setOpencodeGateway" | "setOpencodeGatewayKey" | "clearOpencodeGatewayKey" | "setBranchTemplate" | "previewChatCleanup" | "deleteOldChats"> | undefined {
  return window.argmax?.settings;
}

export function sourceActions(): Actions<"sources", "add" | "update" | "delete"> | undefined {
  return window.argmax?.sources;
}

export function syncActions(): Actions<"sync", "setConfig"> | undefined {
  return window.argmax?.sync;
}

/** Host services a click asks for. The performance and snapshot calls drive the debug HUD. */
export function systemActions(): Actions<"system", "confirm" | "openPath" | "openFileIn" | "listDetectedIdes" | "diagnostics" | "vacuumDatabase" | "testNotification" | "debugSnapshot" | "performanceStart" | "performanceStop" | "performanceStatus" | "performanceCapture"> | undefined {
  return window.argmax?.system;
}

export function visualizationActions(): Actions<"visualization", "setState" | "setControls" | "preview" | "publish" | "export"> | undefined {
  return window.argmax?.visualization;
}

export function windowActions(): Actions<"windows", "openSession"> | undefined {
  return window.argmax?.windows;
}

/** `status` re-reads the chord inside the handler that just failed to change it. */
export function windowSnapshotActions(): Actions<"windowSnapshot", "status" | "configure" | "requestPermission"> | undefined {
  return window.argmax?.windowSnapshot;
}

export function workspaceActions(): Actions<"workspaces", "archive" | "openInIde"> | undefined {
  return window.argmax?.workspaces;
}

export function resolveFileForOpening(workspaceId: string, path: string): Promise<string | null> {
  return resolveOpenablePath(window.argmax, workspaceId, path);
}

export function warmLedgerPrefetch(): void {
  const api = window.argmax;
  if (api) warmLedgerPagesOnIntent(api);
}

/**
 * The shared checkout workspace of a project folder. It takes a `ProjectTarget`,
 * so a terminal shortcut cannot leave out the folder that is picked.
 */
export function createProjectCheckout(target: ProjectTarget): Promise<WorkspaceSummary> | undefined {
  return window.argmax?.workspaces.createCurrent({
    projectId: target.project.id,
    taskLabel: target.project.name,
    ...projectFolderInput(target)
  });
}
