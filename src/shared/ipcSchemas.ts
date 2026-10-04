// Generated from `ipc::catalogue` by `export-bindings`.
// Rust owns channel names, signatures, and transport availability.

import type { commands } from './bindings.js';

export const IPC_CHANNELS = [
  "health:ping",
  "projects:list",
  "projects:pick-folder",
  "projects:check-prompt",
  "projects:resolve-check",
  "dashboard:list",
  "projects:register",
  "projects:remove",
  "projects:update-settings",
  "projects:list-branches",
  "projects:refresh-branch",
  "projects:switch-branch",
  "projects:list-checkouts",
  "workspaces:create-alongside",
  "workspaces:create-isolated",
  "workspaces:create-current",
  "workspaces:create-scratch",
  "workspaces:refresh-status",
  "workspaces:keep",
  "workspaces:archive",
  "workspaces:open-in-ide",
  "workspaces:autotitle",
  "workspace:status",
  "providers:discover",
  "providers:launch",
  "providers:send-input",
  "providers:steer-input",
  "providers:resize",
  "providers:terminate",
  "providers:cancel-queued-message",
  "providers:send-queued-message-now",
  "cloud:prepare",
  "cloud:launch",
  "attachments:save-image",
  "terminal:spawn",
  "terminal:write",
  "terminal:resize",
  "terminal:terminate",
  "approvals:resolve",
  "approvals:pending",
  "questions:resolve",
  "session:events-since",
  "session:agent-events",
  "session:fork",
  "session:fork-lineage",
  "session:fork-merge-preview",
  "session:fork-merge",
  "session:multitask",
  "session:clear",
  "session:suggest-follow-up",
  "settings:agent-tools",
  "settings:set-browser-tools",
  "settings:routing",
  "settings:set-project-check",
  "settings:set-routing-key",
  "settings:clear-routing-key",
  "settings:preview-chat-cleanup",
  "settings:delete-old-chats",
  "window-snapshot:status",
  "window-snapshot:configure",
  "window-snapshot:request-permission",
  "review:list-changed-files",
  "review:load-diff",
  "review:stage-file",
  "review:unstage-file",
  "review:stage-hunk",
  "review:unstage-hunk",
  "review:commit-staged",
  "review:revert-file",
  "review:revert-hunk",
  "goal:set",
  "goal:get",
  "goal:list",
  "goal:clear",
  "arc:create",
  "arc:list",
  "arc:get",
  "arc:update",
  "arc:set-state",
  "arc:launch-coordinator",
  "arc:timeline",
  "arc:draft-from-session",
  "arc:promote",
  "checkpoints:list",
  "checkpoints:preview-rewind",
  "checkpoints:rewind-files",
  "workspace:list-files",
  "workspace:read-file",
  "workspace:write-file",
  "workspace:stat-file",
  "workspace:read-external-file",
  "workspace:stat-external-file",
  "workspace:grep-content",
  "checks:run",
  "skills:list",
  "linked-repos:list",
  "linked-repos:add",
  "linked-repos:set-enabled",
  "linked-repos:remove",
  "projects:set-branch-template",
  "settings:branch-template",
  "settings:set-branch-template",
  "workspaces:set-snoozed-until",
  "sources:list",
  "sources:add",
  "sources:update",
  "sources:delete",
  "connections:list",
  "system:open-path",
  "system:open-file-in",
  "system:list-detected-ides",
  "system:diagnostics",
  "system:debug-snapshot",
  "system:performance-start",
  "system:performance-stop",
  "system:performance-status",
  "system:performance-capture",
  "system:renderer-stall",
  "system:vacuum-database",
  "system:set-theme",
  "system:set-default-agent",
  "system:set-notifications-enabled",
  "system:set-keep-awake",
  "system:test-notification",
  "window:open-session",
  "window:set-session",
  "session:cost-summary",
  "learnings:list",
  "learnings:update",
  "learnings:delete",
  "session:search",
  "workspaces:set-pinned",
  "workspaces:mark-viewed",
  "workspaces:set-priority-added",
  "workspaces:set-priority-dismissed",
  "workspaces:set-label",
  "workspaces:set-icon",
  "prs:list-for-session",
  "prs:refresh",
  "prs:set-primary",
  "prs:dismiss",
  "prs:cleanup",
  "git:commit",
  "git:push",
  "git:create-branch",
  "git:view-or-create-pr",
  "remote:get-status",
  "remote:set-config",
  "remote:test-notification",
  "remote:set-apns-config",
  "remote:register-push-device",
  "remote:unregister-push-device",
  "remote:push-test",
  "remote:push-capability",
  "sync:get-status",
  "sync:set-config",
  "sync:run-now",
  "browser:open",
  "browser:content-blocking",
  "browser:set-site-blocking",
  "browser:navigate",
  "browser:back",
  "browser:forward",
  "browser:reload",
  "browser:stop",
  "browser:set-bounds",
  "browser:focus",
  "browser:set-theme",
  "browser:close",
  "browser:fill-credentials",
  "browser:screenshot",
  "browser:evaluate",
  "browser:list-tabs",
  "browser:open-for-session",
  "browser:snapshot",
  "browser:find",
  "browser:get-text",
  "browser:extract",
  "browser:act",
  "browser:chrome-profiles",
  "browser:import-chrome-history",
  "routines:list",
  "routines:upsert",
  "routines:delete",
  "routines:set-enabled",
  "routines:run-now",
  "routines:reset-session",
  "usage:summary",
  "usage:remaining",
  "usage:router-cost",
  "activity:summary",
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

type Commands = typeof commands;
export interface IpcCommands {
  "health:ping": Commands["healthPing"];
  "projects:list": Commands["projectsList"];
  "projects:pick-folder": Commands["projectsPickFolder"];
  "projects:check-prompt": Commands["projectsCheckPrompt"];
  "projects:resolve-check": Commands["projectsResolveCheck"];
  "dashboard:list": Commands["dashboardList"];
  "projects:register": Commands["projectsRegister"];
  "projects:remove": Commands["projectsRemove"];
  "projects:update-settings": Commands["projectsUpdateSettings"];
  "projects:list-branches": Commands["projectsListBranches"];
  "projects:refresh-branch": Commands["projectsRefreshBranch"];
  "projects:switch-branch": Commands["projectsSwitchBranch"];
  "projects:list-checkouts": Commands["projectsListCheckouts"];
  "workspaces:create-alongside": Commands["workspacesCreateAlongside"];
  "workspaces:create-isolated": Commands["workspacesCreateIsolated"];
  "workspaces:create-current": Commands["workspacesCreateCurrent"];
  "workspaces:create-scratch": Commands["workspacesCreateScratch"];
  "workspaces:refresh-status": Commands["workspacesRefreshStatus"];
  "workspaces:keep": Commands["workspacesKeep"];
  "workspaces:archive": Commands["workspacesArchive"];
  "workspaces:open-in-ide": Commands["workspacesOpenInIde"];
  "workspaces:autotitle": Commands["workspacesAutotitle"];
  "workspace:status": Commands["workspaceStatus"];
  "providers:discover": Commands["providersDiscover"];
  "providers:launch": Commands["providersLaunch"];
  "providers:send-input": Commands["providersSendInput"];
  "providers:steer-input": Commands["providersSteerInput"];
  "providers:resize": Commands["providersResize"];
  "providers:terminate": Commands["providersTerminate"];
  "providers:cancel-queued-message": Commands["providersCancelQueuedMessage"];
  "providers:send-queued-message-now": Commands["providersSendQueuedMessageNow"];
  "cloud:prepare": Commands["cloudPrepare"];
  "cloud:launch": Commands["cloudLaunch"];
  "attachments:save-image": Commands["attachmentsSaveImage"];
  "terminal:spawn": Commands["terminalSpawn"];
  "terminal:write": Commands["terminalWrite"];
  "terminal:resize": Commands["terminalResize"];
  "terminal:terminate": Commands["terminalTerminate"];
  "approvals:resolve": Commands["approvalsResolve"];
  "approvals:pending": Commands["approvalsPending"];
  "questions:resolve": Commands["questionsResolve"];
  "session:events-since": Commands["sessionEventsSince"];
  "session:agent-events": Commands["sessionAgentEvents"];
  "session:fork": Commands["sessionFork"];
  "session:fork-lineage": Commands["sessionForkLineage"];
  "session:fork-merge-preview": Commands["sessionForkMergePreview"];
  "session:fork-merge": Commands["sessionForkMerge"];
  "session:multitask": Commands["sessionMultitask"];
  "session:clear": Commands["sessionClear"];
  "session:suggest-follow-up": Commands["sessionSuggestFollowUp"];
  "settings:agent-tools": Commands["settingsAgentTools"];
  "settings:set-browser-tools": Commands["settingsSetBrowserTools"];
  "settings:routing": Commands["settingsRouting"];
  "settings:set-project-check": Commands["settingsSetProjectCheck"];
  "settings:set-routing-key": Commands["settingsSetRoutingKey"];
  "settings:clear-routing-key": Commands["settingsClearRoutingKey"];
  "settings:preview-chat-cleanup": Commands["settingsPreviewChatCleanup"];
  "settings:delete-old-chats": Commands["settingsDeleteOldChats"];
  "window-snapshot:status": Commands["windowSnapshotStatus"];
  "window-snapshot:configure": Commands["windowSnapshotConfigure"];
  "window-snapshot:request-permission": Commands["windowSnapshotRequestPermission"];
  "review:list-changed-files": Commands["reviewListChangedFiles"];
  "review:load-diff": Commands["reviewLoadDiff"];
  "review:stage-file": Commands["reviewStageFile"];
  "review:unstage-file": Commands["reviewUnstageFile"];
  "review:stage-hunk": Commands["reviewStageHunk"];
  "review:unstage-hunk": Commands["reviewUnstageHunk"];
  "review:commit-staged": Commands["reviewCommitStaged"];
  "review:revert-file": Commands["reviewRevertFile"];
  "review:revert-hunk": Commands["reviewRevertHunk"];
  "goal:set": Commands["goalSet"];
  "goal:get": Commands["goalGet"];
  "goal:list": Commands["goalList"];
  "goal:clear": Commands["goalClear"];
  "arc:create": Commands["arcCreate"];
  "arc:list": Commands["arcList"];
  "arc:get": Commands["arcGet"];
  "arc:update": Commands["arcUpdate"];
  "arc:set-state": Commands["arcSetState"];
  "arc:launch-coordinator": Commands["arcLaunchCoordinator"];
  "arc:timeline": Commands["arcTimeline"];
  "arc:draft-from-session": Commands["arcDraftFromSession"];
  "arc:promote": Commands["arcPromote"];
  "checkpoints:list": Commands["checkpointsList"];
  "checkpoints:preview-rewind": Commands["checkpointsPreviewRewind"];
  "checkpoints:rewind-files": Commands["checkpointsRewindFiles"];
  "workspace:list-files": Commands["workspaceListFiles"];
  "workspace:read-file": Commands["workspaceReadFile"];
  "workspace:write-file": Commands["workspaceWriteFile"];
  "workspace:stat-file": Commands["workspaceStatFile"];
  "workspace:read-external-file": Commands["workspaceReadExternalFile"];
  "workspace:stat-external-file": Commands["workspaceStatExternalFile"];
  "workspace:grep-content": Commands["workspaceGrepContent"];
  "checks:run": Commands["checksRun"];
  "skills:list": Commands["skillsList"];
  "linked-repos:list": Commands["linkedReposList"];
  "linked-repos:add": Commands["linkedReposAdd"];
  "linked-repos:set-enabled": Commands["linkedReposSetEnabled"];
  "linked-repos:remove": Commands["linkedReposRemove"];
  "projects:set-branch-template": Commands["projectsSetBranchTemplate"];
  "settings:branch-template": Commands["settingsBranchTemplate"];
  "settings:set-branch-template": Commands["settingsSetBranchTemplate"];
  "workspaces:set-snoozed-until": Commands["workspacesSetSnoozedUntil"];
  "sources:list": Commands["sourcesList"];
  "sources:add": Commands["sourcesAdd"];
  "sources:update": Commands["sourcesUpdate"];
  "sources:delete": Commands["sourcesDelete"];
  "connections:list": Commands["connectionsList"];
  "system:open-path": Commands["systemOpenPath"];
  "system:open-file-in": Commands["systemOpenFileIn"];
  "system:list-detected-ides": Commands["systemListDetectedIdes"];
  "system:diagnostics": Commands["systemDiagnostics"];
  "system:debug-snapshot": Commands["systemDebugSnapshot"];
  "system:performance-start": Commands["systemPerformanceStart"];
  "system:performance-stop": Commands["systemPerformanceStop"];
  "system:performance-status": Commands["systemPerformanceStatus"];
  "system:performance-capture": Commands["systemPerformanceCapture"];
  "system:renderer-stall": Commands["systemRendererStall"];
  "system:vacuum-database": Commands["systemVacuumDatabase"];
  "system:set-theme": Commands["systemSetTheme"];
  "system:set-default-agent": Commands["systemSetDefaultAgent"];
  "system:set-notifications-enabled": Commands["systemSetNotificationsEnabled"];
  "system:set-keep-awake": Commands["systemSetKeepAwake"];
  "system:test-notification": Commands["systemTestNotification"];
  "window:open-session": Commands["windowOpenSession"];
  "window:set-session": Commands["windowSetSession"];
  "session:cost-summary": Commands["sessionCostSummary"];
  "learnings:list": Commands["learningsList"];
  "learnings:update": Commands["learningsUpdate"];
  "learnings:delete": Commands["learningsDelete"];
  "session:search": Commands["sessionSearch"];
  "workspaces:set-pinned": Commands["workspacesSetPinned"];
  "workspaces:mark-viewed": Commands["workspacesMarkViewed"];
  "workspaces:set-priority-added": Commands["workspacesSetPriorityAdded"];
  "workspaces:set-priority-dismissed": Commands["workspacesSetPriorityDismissed"];
  "workspaces:set-label": Commands["workspacesSetLabel"];
  "workspaces:set-icon": Commands["workspacesSetIcon"];
  "prs:list-for-session": Commands["prsListForSession"];
  "prs:refresh": Commands["prsRefresh"];
  "prs:set-primary": Commands["prsSetPrimary"];
  "prs:dismiss": Commands["prsDismiss"];
  "prs:cleanup": Commands["prsCleanup"];
  "git:commit": Commands["gitCommit"];
  "git:push": Commands["gitPush"];
  "git:create-branch": Commands["gitCreateBranch"];
  "git:view-or-create-pr": Commands["gitViewOrCreatePr"];
  "remote:get-status": Commands["remoteGetStatus"];
  "remote:set-config": Commands["remoteSetConfig"];
  "remote:test-notification": Commands["remoteTestNotification"];
  "remote:set-apns-config": Commands["remoteSetApnsConfig"];
  "remote:register-push-device": Commands["remoteRegisterPushDevice"];
  "remote:unregister-push-device": Commands["remoteUnregisterPushDevice"];
  "remote:push-test": Commands["remotePushTest"];
  "remote:push-capability": Commands["remotePushCapability"];
  "sync:get-status": Commands["syncGetStatus"];
  "sync:set-config": Commands["syncSetConfig"];
  "sync:run-now": Commands["syncRunNow"];
  "browser:open": Commands["browserOpen"];
  "browser:content-blocking": Commands["browserContentBlocking"];
  "browser:set-site-blocking": Commands["browserSetSiteBlocking"];
  "browser:navigate": Commands["browserNavigate"];
  "browser:back": Commands["browserBack"];
  "browser:forward": Commands["browserForward"];
  "browser:reload": Commands["browserReload"];
  "browser:stop": Commands["browserStop"];
  "browser:set-bounds": Commands["browserSetBounds"];
  "browser:focus": Commands["browserFocus"];
  "browser:set-theme": Commands["browserSetTheme"];
  "browser:close": Commands["browserClose"];
  "browser:fill-credentials": Commands["browserFillCredentials"];
  "browser:screenshot": Commands["browserScreenshot"];
  "browser:evaluate": Commands["browserEvaluate"];
  "browser:list-tabs": Commands["browserListTabs"];
  "browser:open-for-session": Commands["browserOpenForSession"];
  "browser:snapshot": Commands["browserSnapshot"];
  "browser:find": Commands["browserFind"];
  "browser:get-text": Commands["browserGetText"];
  "browser:extract": Commands["browserExtract"];
  "browser:act": Commands["browserAct"];
  "browser:chrome-profiles": Commands["browserChromeProfiles"];
  "browser:import-chrome-history": Commands["browserImportChromeHistory"];
  "routines:list": Commands["routinesList"];
  "routines:upsert": Commands["routinesUpsert"];
  "routines:delete": Commands["routinesDelete"];
  "routines:set-enabled": Commands["routinesSetEnabled"];
  "routines:run-now": Commands["routinesRunNow"];
  "routines:reset-session": Commands["routinesResetSession"];
  "usage:summary": Commands["usageSummary"];
  "usage:remaining": Commands["usageRemaining"];
  "usage:router-cost": Commands["usageRouterCost"];
  "activity:summary": Commands["activitySummary"];
}

type OptionalNullable<T> = { [K in keyof T as null extends T[K] ? never : K]: T[K] } &
{ [K in keyof T as null extends T[K] ? K : never]?: T[K] };
export type IpcInput<C extends IpcChannel> = Parameters<IpcCommands[C]> extends [] ? Record<string, never> : OptionalNullable<Parameters<IpcCommands[C]>[0]>;
type UnwrapResult<T> = T extends { status: 'ok'; data: infer D } ? D :
T extends { status: 'error'; error: unknown } ? never : T;
export type IpcOutput<C extends IpcChannel> = UnwrapResult<Awaited<ReturnType<IpcCommands[C]>>>;
export type IpcArguments<C extends IpcChannel> = Record<string, never> extends IpcInput<C> ? [input?: IpcInput<C>] : [input: IpcInput<C>];
