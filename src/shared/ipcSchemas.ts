import { isAbsolute } from "node:path";
import { z } from "zod";

/**
 * Zod schemas for every payload-bearing `ipcMain.handle` channel.
 *
 * IMPORTANT: This module is main-process only at runtime. It re-exports
 * `z.infer` types so other shared modules can keep their TypeScript-only
 * surface, but `zod` itself MUST NOT be imported into the renderer bundle.
 * Renderer code should continue to import the existing TS interfaces from
 * `./types.ts`; those interfaces will be migrated to `z.infer` aliases by
 * a later wave (Section 1, task 1.5).
 *
 * Failure mode: when a handler calls `schema.parse(input)` and the input
 * does not conform, zod throws `ZodError`. The IPC adapter rethrows as
 * `Error("ipc:invalid-input:" + channel + ":" + zodError.issues[0].path)`
 * (the BOOT/ipc agent owns wiring this).
 */

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

export const providerIdSchema = z.enum(["claude", "codex"]);
export const reasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);

const projectSettingsSchema = z.object({
  defaultProvider: providerIdSchema,
  defaultModelLabel: z.string().min(1),
  worktreeLocation: z.string().min(1),
  setupCommand: z.string(),
  checkCommands: z.array(z.string())
});

/**
 * filePath rules: must be relative (no leading "/"), no parent traversal,
 * cannot start with `-` (would be parsed as a flag by git argv).
 */
const relativeFilePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/"), { message: "filePath must be relative" })
  .refine((value) => !value.startsWith("-"), { message: "filePath cannot start with '-'" })
  .refine(
    (value) => !value.split(/[\\/]/).some((segment) => segment === ".."),
    { message: "filePath cannot contain '..' segments" }
  );

/**
 * baseRef rules: cannot start with `-` so it does not collide with git flag
 * parsing when forwarded as a positional argument.
 */
const baseRefSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("-"), { message: "baseRef cannot start with '-'" });

/**
 * Prompt rules: no embedded \r or \n (PTYs interpret newlines as submission)
 * and cannot start with `-` (would be parsed as a CLI flag by some providers).
 */
const promptSchema = z
  .string()
  .min(1)
  .refine((value) => !/[\r\n]/.test(value), { message: "prompt cannot contain newlines" })
  .refine((value) => !value.startsWith("-"), { message: "prompt cannot start with '-'" });

const workspaceIdSchema = z.string().min(1);
const sessionIdSchema = z.string().min(1);
const projectIdSchema = z.string().min(1);
const approvalIdSchema = z.string().min(1);

// ---------------------------------------------------------------------------
// Per-channel input schemas
// ---------------------------------------------------------------------------

export const healthPingInputSchema = z.void();
export const projectsListInputSchema = z.void();
export const projectsPickFolderInputSchema = z.void();
export const providersDiscoverInputSchema = z.void();
export const listBranchesInputSchema = z.object({ projectId: projectIdSchema });
export const switchBranchInputSchema = z.object({
  projectId: projectIdSchema,
  branch: z
    .string()
    .min(1)
    .refine((value) => !value.startsWith("-"), { message: "branch cannot start with '-'" })
});
export const dashboardLoadInputSchema = z.void();
export const dashboardListInputSchema = z.void();

export const sessionEventsSinceInputSchema = z.object({
  sessionId: sessionIdSchema,
  eventCursor: z.number().int().nonnegative().optional(),
  rawOutputCursor: z.number().int().nonnegative().optional()
});

export const workspaceStatusInputSchema = z
  .object({
    workspaceIds: z.array(workspaceIdSchema).optional()
  })
  .optional();

export const approvalsPendingInputSchema = z.void();

export const registerProjectInputSchema = z.object({
  repoPath: z
    .string()
    .min(1)
    .refine((value) => isAbsolute(value), { message: "repoPath must be absolute" })
    .refine((value) => !value.includes("\0"), { message: "repoPath cannot contain null bytes" })
});

export const updateProjectSettingsInputSchema = z.object({
  projectId: projectIdSchema,
  settings: projectSettingsSchema
});

export const createWorkspaceInputSchema = z.object({
  projectId: projectIdSchema,
  taskLabel: z.string().min(1),
  baseRef: baseRefSchema.optional()
});

export const createCurrentWorkspaceInputSchema = z.object({
  projectId: projectIdSchema,
  taskLabel: z.string().min(1)
});

export const workspaceIdInputSchema = workspaceIdSchema;

export const permissionModeSchema = z.enum(["auto-approve", "ask-each-time"]);

export const launchProviderSessionInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  provider: providerIdSchema,
  prompt: promptSchema,
  modelLabel: z.string().min(1),
  modelId: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  cols: z.number().int().min(20).max(400),
  rows: z.number().int().min(5).max(200)
});

export const providerSessionInputSchema = z.object({
  sessionId: sessionIdSchema,
  input: z.string(),
  modelLabel: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  reasoningEffort: reasoningEffortSchema.optional()
});

export const providerSessionResizeInputSchema = z.object({
  sessionId: sessionIdSchema,
  cols: z.number().int().min(20).max(400),
  rows: z.number().int().min(5).max(200)
});

export const providerSessionTerminateInputSchema = sessionIdSchema;

export const resolveApprovalInputSchema = z.object({
  approvalId: approvalIdSchema,
  status: z.enum(["approved", "rejected"])
});

export const reviewListChangedFilesInputSchema = workspaceIdSchema;

/**
 * `review:load-diff` is invoked positionally as `(workspaceId, filePath?)`.
 * Modeled as a tuple so the boot-side adapter can spread invocation args
 * into a parse call.
 */
export const loadDiffInputSchema = z.tuple([workspaceIdSchema, relativeFilePathSchema.optional()]);

export const workspaceListFilesInputSchema = z.object({
  workspaceId: workspaceIdSchema
});

export const workspaceReadFileInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  filePath: relativeFilePathSchema
});

export const runCheckInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  command: z.string().min(1)
});

export const createCheckpointInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  label: z.string().min(1)
});

export const selectPreferredAttemptInputSchema = z.object({
  sessionId: sessionIdSchema
});

export const prepareCommitInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  selectedFiles: z.array(relativeFilePathSchema),
  message: z.string().min(1)
});

export const skillsListInputSchema = z.object({
  provider: providerIdSchema,
  workspaceId: workspaceIdSchema.optional()
});

/**
 * Opens a file or folder in the OS default handler. The `path` may be absolute
 * or relative; relative paths are resolved against `cwd` if provided. We reject
 * leading `-` to avoid argv-style mis-parses downstream, but otherwise trust
 * the local single-user environment — there is no privilege boundary here.
 */
export const systemOpenPathInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .refine((value) => !value.startsWith("-"), { message: "path cannot start with '-'" }),
  cwd: z.string().min(1).optional()
});

// ---------------------------------------------------------------------------
// Cost & token transparency (additive — see SPEC_COST_TRANSPARENCY.md)
// ---------------------------------------------------------------------------

export const sessionCostSummaryInputSchema = z.object({
  sessionId: sessionIdSchema
});

// ---------------------------------------------------------------------------
// IDE launcher — `workspaces:openInIde` and `system:listDetectedIdes`
// ---------------------------------------------------------------------------

export const ideIdSchema = z.enum([
  "vscode",
  "cursor",
  "windsurf",
  "zed",
  "terminal",
  "iterm"
]);

export const openInIdeInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  ide: ideIdSchema.or(z.literal("default"))
});

export const listDetectedIdesInputSchema = z.void();

export const listDetectedIdesOutputSchema = z.array(
  z.object({
    id: ideIdSchema,
    label: z.string(),
    appPath: z.string().nullable(),
    hasCli: z.boolean()
  })
);

// ---------------------------------------------------------------------------
// Channel → schema map
// ---------------------------------------------------------------------------

export const ipcSchemas = {
  "health:ping": healthPingInputSchema,
  "projects:list": projectsListInputSchema,
  "projects:pick-folder": projectsPickFolderInputSchema,
  "dashboard:list": dashboardListInputSchema,
  "projects:register": registerProjectInputSchema,
  "projects:update-settings": updateProjectSettingsInputSchema,
  "projects:list-branches": listBranchesInputSchema,
  "projects:switch-branch": switchBranchInputSchema,
  "workspaces:create-isolated": createWorkspaceInputSchema,
  "workspaces:create-current": createCurrentWorkspaceInputSchema,
  "workspaces:refresh-status": workspaceIdInputSchema,
  "workspaces:keep": workspaceIdInputSchema,
  "workspaces:archive": workspaceIdInputSchema,
  "workspaces:openInIde": openInIdeInputSchema,
  "workspace:status": workspaceStatusInputSchema,
  "providers:discover": providersDiscoverInputSchema,
  "providers:launch": launchProviderSessionInputSchema,
  "providers:send-input": providerSessionInputSchema,
  "providers:resize": providerSessionResizeInputSchema,
  "providers:terminate": providerSessionTerminateInputSchema,
  "approvals:resolve": resolveApprovalInputSchema,
  "approvals:pending": approvalsPendingInputSchema,
  "session:eventsSince": sessionEventsSinceInputSchema,
  "review:list-changed-files": reviewListChangedFilesInputSchema,
  "review:load-diff": loadDiffInputSchema,
  "workspace:list-files": workspaceListFilesInputSchema,
  "workspace:read-file": workspaceReadFileInputSchema,
  "checks:run": runCheckInputSchema,
  "checkpoints:create": createCheckpointInputSchema,
  "attempts:select-preferred": selectPreferredAttemptInputSchema,
  "commits:prepare": prepareCommitInputSchema,
  "dashboard:load": dashboardLoadInputSchema,
  "skills:list": skillsListInputSchema,
  "system:open-path": systemOpenPathInputSchema,
  "system:listDetectedIdes": listDetectedIdesInputSchema,
  "system:diagnostics": z.void(),
  "system:vacuumDatabase": z.void(),
  "session:costSummary": sessionCostSummaryInputSchema
} as const;

export type IpcChannel = keyof typeof ipcSchemas;
export type IpcSchemaMap = typeof ipcSchemas;

export type IpcInput<C extends IpcChannel> = z.infer<IpcSchemaMap[C]>;

export const IPC_CHANNELS: readonly IpcChannel[] = Object.keys(ipcSchemas) as IpcChannel[];

// Inferred input type aliases — convenient for handler signatures.
export type RegisterProjectInputParsed = z.infer<typeof registerProjectInputSchema>;
export type UpdateProjectSettingsInputParsed = z.infer<typeof updateProjectSettingsInputSchema>;
export type CreateWorkspaceInputParsed = z.infer<typeof createWorkspaceInputSchema>;
export type CreateCurrentWorkspaceInputParsed = z.infer<typeof createCurrentWorkspaceInputSchema>;
export type LaunchProviderSessionInputParsed = z.infer<typeof launchProviderSessionInputSchema>;
export type ProviderSessionInputParsed = z.infer<typeof providerSessionInputSchema>;
export type ProviderSessionResizeInputParsed = z.infer<typeof providerSessionResizeInputSchema>;
export type ResolveApprovalInputParsed = z.infer<typeof resolveApprovalInputSchema>;
export type SessionEventsSinceInputParsed = z.infer<typeof sessionEventsSinceInputSchema>;
export type WorkspaceStatusInputParsed = z.infer<typeof workspaceStatusInputSchema>;
export type RunCheckInputParsed = z.infer<typeof runCheckInputSchema>;
export type CreateCheckpointInputParsed = z.infer<typeof createCheckpointInputSchema>;
export type SelectPreferredAttemptInputParsed = z.infer<typeof selectPreferredAttemptInputSchema>;
export type PrepareCommitInputParsed = z.infer<typeof prepareCommitInputSchema>;
export type LoadDiffInputParsed = z.infer<typeof loadDiffInputSchema>;
export type WorkspaceListFilesInputParsed = z.infer<typeof workspaceListFilesInputSchema>;
export type WorkspaceReadFileInputParsed = z.infer<typeof workspaceReadFileInputSchema>;
export type SkillsListInputParsed = z.infer<typeof skillsListInputSchema>;
export type SystemOpenPathInputParsed = z.infer<typeof systemOpenPathInputSchema>;
export type SessionCostSummaryInputParsed = z.infer<typeof sessionCostSummaryInputSchema>;
export type OpenInIdeInputParsed = z.infer<typeof openInIdeInputSchema>;
export type IdeIdParsed = z.infer<typeof ideIdSchema>;
export type DetectedIdeParsed = z.infer<typeof listDetectedIdesOutputSchema>[number];
