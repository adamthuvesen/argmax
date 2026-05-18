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
// Shared size caps. Hoisted here so terminal-write, mcp-auth-write, and
// workspace file IO all agree on a single budget — bumping the cap in one
// place propagates everywhere instead of drifting per channel.
// ---------------------------------------------------------------------------

/** Per-write streaming chunk (PTY input, mcp-auth keystrokes). */
export const MAX_STREAM_CHUNK_BYTES = 64 * 1024;
/**
 * Per-file content payload over IPC (write-file). 4 MB is ~4× the read cap;
 * writes can grow by an order of magnitude if the user pastes a large blob.
 */
export const MAX_FILE_CONTENT_BYTES = 4 * 1024 * 1024;

/**
 * z.string().max() counts UTF-16 code units. For "this string can't be larger
 * than N bytes when serialized" semantics (any user-supplied payload that
 * passes a stream chunk or file-content cap), we need an explicit byte check
 * — otherwise a string full of multibyte chars can be up to ~3× the declared
 * cap once encoded. (audit-2026-05-17 H3)
 */
function utf8Bytes(maxBytes: number) {
  return z
    .string()
    .refine((value) => Buffer.byteLength(value, "utf8") <= maxBytes, {
      message: `must not exceed ${maxBytes} bytes when encoded as UTF-8`
    });
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

export const providerIdSchema = z.enum(["claude", "codex", "cursor"]);
export const reasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);
export const agentModeSchema = z.enum(["auto", "plan"]);

// Terminal/PTY size bounds. xterm sizes both grids and the underlying PTY
// from the same numbers; the renderer measures its viewport in cells and
// clamps before sending these to main.
const terminalCols = z.number().int().min(20).max(400);
const terminalRows = z.number().int().min(5).max(200);

const projectSettingsSchema = z.object({
  defaultProvider: providerIdSchema,
  defaultModelLabel: z.string().min(1),
  worktreeLocation: z.string().min(1),
  setupCommand: z.string(),
  checkCommands: z.array(z.string())
});

/**
 * filePath rules: must be relative (no leading "/"), no parent traversal,
 * cannot start with `-` (would be parsed as a flag by git argv), and cannot
 * contain null bytes (which truncate inside libc fs calls and can produce
 * out-of-tree reads/writes).
 */
const relativeFilePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/"), { message: "filePath must be relative" })
  .refine((value) => !value.startsWith("-"), { message: "filePath cannot start with '-'" })
  .refine(
    (value) => !value.split(/[\\/]/).some((segment) => segment === ".."),
    { message: "filePath cannot contain '..' segments" }
  )
  .refine((value) => !value.includes("\u0000"), { message: "filePath cannot contain null bytes" });

/**
 * Allowed characters for git refs forwarded as positional arguments — same
 * alphabet as gitCreateBranch (alphanumerics, dot, underscore, slash, dash).
 * The leading-'-' check is kept for clarity even though the regex already
 * forbids it. Defense in depth is still `--` separator at the call site.
 */
const STRICT_GIT_REF_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * git refs (branches / base refs) cannot start with `-` so they do not collide
 * with git flag parsing when forwarded as positional arguments. Always also
 * pass `--` as an argv separator AFTER user-controlled refs at every callsite
 * — the zod refine is the validation, the `--` is the defense in depth.
 */
function gitRefSchema(fieldName: string) {
  return z
    .string()
    .min(1)
    .max(255)
    .refine((value) => !value.startsWith("-"), { message: `${fieldName} cannot start with '-'` })
    .refine((value) => STRICT_GIT_REF_RE.test(value), {
      message: `${fieldName} must match ${STRICT_GIT_REF_RE.source}`
    });
}

const baseRefSchema = gitRefSchema("baseRef");

/**
 * Prompt rule: cannot start with `-` (would be parsed as a CLI flag by some
 * providers). PTY launches collapse embedded newlines at the adapter boundary
 * so textarea prompts can still be multiline in the renderer.
 */
const promptSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("-"), { message: "prompt cannot start with '-'" });

// Soft DoS guardrails — these ids flow into SQLite WHERE clauses, filesystem
// paths, and IPC payload metadata. Parameterized queries already prevent SQL
// injection, but an unbounded id is a memory/log-amplification footgun.
const workspaceIdSchema = z.string().min(1).max(256);
const sessionIdSchema = z.string().min(1).max(256);
const projectIdSchema = z.string().min(1).max(256);
const approvalIdSchema = z.string().min(1).max(256);

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
  branch: gitRefSchema("branch")
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
    workspaceIds: z.array(workspaceIdSchema).max(200).optional()
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

export const removeProjectInputSchema = z.object({
  projectId: projectIdSchema
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

export const archiveWorkspaceInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  force: z.boolean().optional()
});

export const permissionModeSchema = z.enum(["auto-approve", "ask-each-time"]);

export const attachmentMimeTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp"
]);

/** Composer attachment metadata persisted alongside the user.message event so
 *  the timeline can render thumbnails without a separate IPC round-trip.
 *
 *  filePath must be absolute (the store returns app.getPath('userData')/...).
 *  Reject relative paths and null bytes here so a buggy renderer can't echo
 *  back arbitrary on-disk paths and have them persisted in the timeline.
 *
 *  sizeBytes is capped to the same 10 MB post-decode budget the attachment
 *  store enforces, so a renderer can't claim a huge size without uploading
 *  the bytes.
 */
const ATTACHMENT_BYTE_CAP = 10 * 1024 * 1024;
export const composerAttachmentSchema = z.object({
  filePath: z
    .string()
    .min(1)
    .max(2048)
    .refine((v) => isAbsolute(v), { message: "filePath must be absolute" })
    .refine((v) => !v.includes("\u0000"), { message: "filePath cannot contain null bytes" }),
  mimeType: attachmentMimeTypeSchema,
  sizeBytes: z.number().int().positive().max(ATTACHMENT_BYTE_CAP)
});

export const launchProviderSessionInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  provider: providerIdSchema,
  prompt: promptSchema,
  modelLabel: z.string().min(1),
  modelId: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.optional(),
  agentMode: agentModeSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  cols: terminalCols,
  rows: terminalRows,
  attachments: z.array(composerAttachmentSchema).max(20).optional()
});

export const providerSessionInputSchema = z.object({
  sessionId: sessionIdSchema,
  input: z.string(),
  modelLabel: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  agentMode: agentModeSchema.optional(),
  attachments: z.array(composerAttachmentSchema).max(20).optional()
});

/** Renderer pipes pasted/dropped image bytes through here; the main-process
 *  AttachmentStore writes them under userData and returns an absolute path
 *  the agent can read via its file tool. */
export const attachmentSaveImageInputSchema = z.object({
  sessionId: sessionIdSchema,
  mimeType: attachmentMimeTypeSchema,
  // Base64 of the raw image bytes (no `data:` prefix). 14 MB cap leaves
  // headroom over the 10 MB byte limit enforced by the store (~33% base64
  // overhead) so a valid 10 MB image is never rejected at the IPC boundary.
  // Alphabet check fails fast at the IPC boundary rather than deeper in the
  // store with an opaque error.
  dataBase64: z
    .string()
    .min(1)
    .max(14 * 1024 * 1024)
    .regex(/^[A-Za-z0-9+/=\s]*$/, { message: "dataBase64 must be base64-encoded" })
});

export const attachmentSaveImageResultSchema = z.object({
  filePath: z.string(),
  sizeBytes: z.number().int().positive()
});

export const providerSessionResizeInputSchema = z.object({
  sessionId: sessionIdSchema,
  cols: terminalCols,
  rows: terminalRows
});

export const providerSessionTerminateInputSchema = sessionIdSchema;

export const providersCancelQueuedMessageInputSchema = z.object({
  sessionId: sessionIdSchema,
  messageId: z.string().min(1)
});

const terminalIdSchema = z.string().min(1);

export const terminalSpawnInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  cols: terminalCols,
  rows: terminalRows
});

export const terminalWriteInputSchema = z.object({
  terminalId: terminalIdSchema,
  data: utf8Bytes(MAX_STREAM_CHUNK_BYTES)
});

export const terminalResizeInputSchema = z.object({
  terminalId: terminalIdSchema,
  cols: terminalCols,
  rows: terminalRows
});

export const terminalTerminateInputSchema = terminalIdSchema;

// ---------------------------------------------------------------------------
// MCP auth — interactive in-app PTY that runs `claude` and auto-types `/mcp`
// so the user can complete OAuth from Settings. The PTY is sized by xterm in
// the renderer; same cols/rows bounds as the integrated terminal. Only the
// Claude provider has an in-CLI auth flow today; Codex/Cursor configs are
// file-only and have no button. See agents/docs/ipc.md.
// ---------------------------------------------------------------------------

const mcpAuthSessionIdSchema = z.string().min(1);

export const mcpAuthStartInputSchema = z.object({
  cols: terminalCols,
  rows: terminalRows
});

export const mcpAuthWriteInputSchema = z.object({
  sessionId: mcpAuthSessionIdSchema,
  data: utf8Bytes(MAX_STREAM_CHUNK_BYTES)
});

export const mcpAuthResizeInputSchema = z.object({
  sessionId: mcpAuthSessionIdSchema,
  cols: terminalCols,
  rows: terminalRows
});

export const mcpAuthTerminateInputSchema = mcpAuthSessionIdSchema;

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

// Project-scoped read-only variants. Render the same Changes + Files panel
// against the project's main checkout (selected on the launch surface, before
// any session/worktree exists). Write/stat are intentionally workspace-only —
// the main checkout shouldn't be edited from the landing page.
export const reviewListChangedFilesForProjectInputSchema = projectIdSchema;

export const loadDiffForProjectInputSchema = z.tuple([
  projectIdSchema,
  relativeFilePathSchema.optional()
]);

export const workspaceListFilesForProjectInputSchema = z.object({
  projectId: projectIdSchema
});

// Workspace-wide content search (⌘⇧F). `kind` picks which path the backend
// runs `git grep` in — worktree for active sessions, project main checkout
// for the launcher. Query is capped at 256 chars so the IPC envelope stays
// bounded; the backend treats the string as a fixed substring, not a regex.
export const workspaceGrepContentInputSchema = z.object({
  kind: z.enum(["workspace", "project"]),
  id: z.string().min(1).max(128),
  query: z.string().min(1).max(256)
});

export const workspaceReadFileForProjectInputSchema = z.object({
  projectId: projectIdSchema,
  filePath: relativeFilePathSchema
});

/**
 * `workspace:write-file` writes UTF-8 content to a worktree file. Caller passes
 * the mtime they last observed (from read-file or stat-file); if the file moved
 * since then, the handler refuses with `{ ok: false, reason: "stale", ... }`
 * rather than clobbering an out-of-band edit (typically a provider session).
 *
 * `expectedMtimeMs: null` skips the guard for a brand-new file write — needed
 * only if we later add a "save as" path; today the editor only opens files
 * that already exist on disk, so a baseline mtime is always available.
 *
 * Cap at 4 MB so a runaway editor buffer can't ship megabytes through IPC.
 * That's 4× the read cap, but reads are display-bound while writes can grow
 * by an order of magnitude if the user pastes a large blob.
 */
export const workspaceWriteFileInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  filePath: relativeFilePathSchema,
  content: utf8Bytes(MAX_FILE_CONTENT_BYTES),
  expectedMtimeMs: z.number().nonnegative().nullable()
});

export const workspaceStatFileInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  filePath: relativeFilePathSchema
});

export const workspaceWriteFileForProjectInputSchema = z.object({
  projectId: projectIdSchema,
  filePath: relativeFilePathSchema,
  content: utf8Bytes(MAX_FILE_CONTENT_BYTES),
  expectedMtimeMs: z.number().nonnegative().nullable()
});

export const workspaceStatFileForProjectInputSchema = z.object({
  projectId: projectIdSchema,
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

// ---------------------------------------------------------------------------
// Git actions (commit / push / branch / PR)
// ---------------------------------------------------------------------------

/**
 * Commit message rules: non-empty after trim, capped to 64 KB so a runaway
 * paste cannot blow past argv length limits.
 */
// ---------------------------------------------------------------------------
// Tournament mode (idea #1: parallel agents + auto-judge). See
// openspec/changes/add-tournament-mode/.
// ---------------------------------------------------------------------------

// Cap the per-contestant free-form `config` blob. Without this a buggy or
// runaway caller can ship megabytes of nested JSON that will be persisted in
// tournament storage and ferried through the dashboard delta channel.
const CONTESTANT_CONFIG_BYTE_CAP = 16 * 1024;
const contestantConfigSchema = z.object({
  provider: providerIdSchema,
  modelId: z.string().min(1).max(256),
  modelLabel: z.string().min(1).max(256),
  reasoningEffort: reasoningEffortSchema.optional(),
  // Restrict the contestant config blob to JSON-flat scalar values so it
  // cannot smuggle arbitrary nested structures that would later be persisted
  // and re-ferried through the dashboard delta channel. The byte cap stays
  // as a backstop. (audit-2026-05-17 M1)
  config: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional()
    .superRefine((value, ctx) => {
      if (!value) return;
      const encoded = JSON.stringify(value);
      if (encoded.length > CONTESTANT_CONFIG_BYTE_CAP) {
        ctx.addIssue({
          code: "custom",
          message: `config exceeds ${CONTESTANT_CONFIG_BYTE_CAP} bytes when serialized`
        });
      }
    })
});

export const tournamentLaunchInputSchema = z.object({
  projectId: projectIdSchema,
  taskLabel: z.string().min(1).max(200),
  prompt: promptSchema,
  policyId: z.string().min(1),
  contestants: z.array(contestantConfigSchema).min(2).max(8),
  cols: terminalCols,
  rows: terminalRows
});

export const tournamentListInputSchema = z.object({
  projectId: projectIdSchema
});

export const tournamentGetInputSchema = z.object({
  tournamentId: z.string().min(1)
});

export const tournamentKeepInputSchema = z.object({
  tournamentId: z.string().min(1),
  contestantIndex: z.number().int().nonnegative(),
  reason: z.string().max(500).optional()
});

export const gitCommitInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  message: z
    .string()
    .min(1)
    .max(65536)
    .refine((value) => value.trim().length > 0, { message: "message cannot be blank" }),
  // Optional per-file selection. When omitted or empty, the handler falls back
  // to `git add -A` (stage the whole worktree). When present, only the listed
  // paths are staged via `git add -- <paths>`; the schema reuses the
  // relative-path guard that rejects absolute paths, parent traversal, and
  // leading `-` so the argv stays safe.
  selectedFiles: z.array(relativeFilePathSchema).optional()
});

export const gitPushInputSchema = z.object({
  workspaceId: workspaceIdSchema
});

/**
 * Branch names follow the same git-ref shape as `gitRefSchema` plus an
 * additional character-set guard. We accept letters, digits, `_./-` (the
 * common subset that `git check-ref-format --branch` allows) and reject
 * leading `-` to keep argv-safety identical to other refs.
 */
export const gitCreateBranchInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  branch: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => !value.startsWith("-"), { message: "branch cannot start with '-'" })
    .refine((value) => /^[A-Za-z0-9._/-]+$/.test(value), {
      message: "branch name contains illegal characters"
    })
});

export const gitViewOrCreatePrInputSchema = z.object({
  sessionId: sessionIdSchema
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
// IDE launcher — `workspaces:open-in-ide` and `system:list-detected-ides`
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
  "projects:remove": removeProjectInputSchema,
  "projects:update-settings": updateProjectSettingsInputSchema,
  "projects:list-branches": listBranchesInputSchema,
  "projects:switch-branch": switchBranchInputSchema,
  "workspaces:create-isolated": createWorkspaceInputSchema,
  "workspaces:create-current": createCurrentWorkspaceInputSchema,
  "workspaces:refresh-status": workspaceIdInputSchema,
  "workspaces:keep": workspaceIdInputSchema,
  "workspaces:archive": archiveWorkspaceInputSchema,
  "workspaces:open-in-ide": openInIdeInputSchema,
  "workspace:status": workspaceStatusInputSchema,
  "providers:discover": providersDiscoverInputSchema,
  "providers:launch": launchProviderSessionInputSchema,
  "providers:send-input": providerSessionInputSchema,
  "providers:resize": providerSessionResizeInputSchema,
  "providers:terminate": providerSessionTerminateInputSchema,
  "providers:cancel-queued-message": providersCancelQueuedMessageInputSchema,
  "attachments:save-image": attachmentSaveImageInputSchema,
  "terminal:spawn": terminalSpawnInputSchema,
  "terminal:write": terminalWriteInputSchema,
  "terminal:resize": terminalResizeInputSchema,
  "terminal:terminate": terminalTerminateInputSchema,
  "approvals:resolve": resolveApprovalInputSchema,
  "approvals:pending": approvalsPendingInputSchema,
  "session:events-since": sessionEventsSinceInputSchema,
  "review:list-changed-files": reviewListChangedFilesInputSchema,
  "review:load-diff": loadDiffInputSchema,
  "review:list-changed-files-for-project": reviewListChangedFilesForProjectInputSchema,
  "review:load-diff-for-project": loadDiffForProjectInputSchema,
  "workspace:list-files": workspaceListFilesInputSchema,
  "workspace:read-file": workspaceReadFileInputSchema,
  "workspace:list-files-for-project": workspaceListFilesForProjectInputSchema,
  "workspace:read-file-for-project": workspaceReadFileForProjectInputSchema,
  "workspace:write-file": workspaceWriteFileInputSchema,
  "workspace:stat-file": workspaceStatFileInputSchema,
  "workspace:write-file-for-project": workspaceWriteFileForProjectInputSchema,
  "workspace:stat-file-for-project": workspaceStatFileForProjectInputSchema,
  "workspace:grep-content": workspaceGrepContentInputSchema,
  "checks:run": runCheckInputSchema,
  "checkpoints:create": createCheckpointInputSchema,
  "attempts:select-preferred": selectPreferredAttemptInputSchema,
  "dashboard:load": dashboardLoadInputSchema,
  "skills:list": skillsListInputSchema,
  "system:open-path": systemOpenPathInputSchema,
  "system:list-detected-ides": listDetectedIdesInputSchema,
  "system:diagnostics": z.void(),
  "system:vacuum-database": z.void(),
  "mcp:list": z.void(),
  "mcp:auth:start": mcpAuthStartInputSchema,
  "mcp:auth:write": mcpAuthWriteInputSchema,
  "mcp:auth:resize": mcpAuthResizeInputSchema,
  "mcp:auth:terminate": mcpAuthTerminateInputSchema,
  "session:cost-summary": sessionCostSummaryInputSchema,
  "learnings:list": z.object({
    projectId: projectIdSchema,
    limit: z.number().int().min(1).max(200).optional()
  }),
  "learnings:update": z.object({
    id: z.string().min(1),
    summary: z.string().min(1).optional(),
    verified: z.boolean().optional()
  }),
  "learnings:delete": z.object({
    id: z.string().min(1)
  }),
  "session:search": z.object({
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(200).optional()
  }),
  "workspaces:set-pinned": z.object({
    workspaceId: workspaceIdSchema,
    pinned: z.boolean()
  }),
  "prs:list-for-session": z.object({ sessionId: sessionIdSchema }),
  "prs:refresh": z.object({ sessionId: sessionIdSchema }),
  "git:commit": gitCommitInputSchema,
  "git:push": gitPushInputSchema,
  "git:create-branch": gitCreateBranchInputSchema,
  "git:view-or-create-pr": gitViewOrCreatePrInputSchema,
  "tournament:launch": tournamentLaunchInputSchema,
  "tournament:list": tournamentListInputSchema,
  "tournament:get": tournamentGetInputSchema,
  "tournament:keep": tournamentKeepInputSchema,
  "scoring:list-policies": z.void()
} as const;

export type IpcChannel = keyof typeof ipcSchemas;
export type IpcSchemaMap = typeof ipcSchemas;

export type IpcInput<C extends IpcChannel> = z.infer<IpcSchemaMap[C]>;

export const IPC_CHANNELS: readonly IpcChannel[] = Object.keys(ipcSchemas) as IpcChannel[];

// Inferred input type aliases — convenient for handler signatures.
export type RegisterProjectInputParsed = z.infer<typeof registerProjectInputSchema>;
export type RemoveProjectInputParsed = z.infer<typeof removeProjectInputSchema>;
export type UpdateProjectSettingsInputParsed = z.infer<typeof updateProjectSettingsInputSchema>;
export type CreateWorkspaceInputParsed = z.infer<typeof createWorkspaceInputSchema>;
export type CreateCurrentWorkspaceInputParsed = z.infer<typeof createCurrentWorkspaceInputSchema>;
export type LaunchProviderSessionInputParsed = z.infer<typeof launchProviderSessionInputSchema>;
export type ProviderSessionInputParsed = z.infer<typeof providerSessionInputSchema>;
export type ProvidersCancelQueuedMessageInputParsed = z.infer<typeof providersCancelQueuedMessageInputSchema>;
export type ComposerAttachmentParsed = z.infer<typeof composerAttachmentSchema>;
export type AttachmentSaveImageInputParsed = z.infer<typeof attachmentSaveImageInputSchema>;
export type AttachmentSaveImageResultParsed = z.infer<typeof attachmentSaveImageResultSchema>;
export type AttachmentMimeTypeParsed = z.infer<typeof attachmentMimeTypeSchema>;
export type ProviderSessionResizeInputParsed = z.infer<typeof providerSessionResizeInputSchema>;
export type ResolveApprovalInputParsed = z.infer<typeof resolveApprovalInputSchema>;
export type SessionEventsSinceInputParsed = z.infer<typeof sessionEventsSinceInputSchema>;
export type WorkspaceStatusInputParsed = z.infer<typeof workspaceStatusInputSchema>;
export type RunCheckInputParsed = z.infer<typeof runCheckInputSchema>;
export type CreateCheckpointInputParsed = z.infer<typeof createCheckpointInputSchema>;
export type SelectPreferredAttemptInputParsed = z.infer<typeof selectPreferredAttemptInputSchema>;
export type LoadDiffInputParsed = z.infer<typeof loadDiffInputSchema>;
export type WorkspaceListFilesInputParsed = z.infer<typeof workspaceListFilesInputSchema>;
export type WorkspaceReadFileInputParsed = z.infer<typeof workspaceReadFileInputSchema>;
export type LoadDiffForProjectInputParsed = z.infer<typeof loadDiffForProjectInputSchema>;
export type WorkspaceListFilesForProjectInputParsed = z.infer<typeof workspaceListFilesForProjectInputSchema>;
export type WorkspaceReadFileForProjectInputParsed = z.infer<typeof workspaceReadFileForProjectInputSchema>;
export type WorkspaceWriteFileInputParsed = z.infer<typeof workspaceWriteFileInputSchema>;
export type WorkspaceStatFileInputParsed = z.infer<typeof workspaceStatFileInputSchema>;
export type WorkspaceWriteFileForProjectInputParsed = z.infer<typeof workspaceWriteFileForProjectInputSchema>;
export type WorkspaceStatFileForProjectInputParsed = z.infer<typeof workspaceStatFileForProjectInputSchema>;
export type WorkspaceGrepContentInputParsed = z.infer<typeof workspaceGrepContentInputSchema>;
export type SkillsListInputParsed = z.infer<typeof skillsListInputSchema>;
export type SystemOpenPathInputParsed = z.infer<typeof systemOpenPathInputSchema>;
export type SessionCostSummaryInputParsed = z.infer<typeof sessionCostSummaryInputSchema>;
export type OpenInIdeInputParsed = z.infer<typeof openInIdeInputSchema>;
export type IdeIdParsed = z.infer<typeof ideIdSchema>;
export type DetectedIdeParsed = z.infer<typeof listDetectedIdesOutputSchema>[number];
export type TerminalSpawnInputParsed = z.infer<typeof terminalSpawnInputSchema>;
export type TerminalWriteInputParsed = z.infer<typeof terminalWriteInputSchema>;
export type TerminalResizeInputParsed = z.infer<typeof terminalResizeInputSchema>;
export type McpAuthStartInputParsed = z.infer<typeof mcpAuthStartInputSchema>;
export type McpAuthWriteInputParsed = z.infer<typeof mcpAuthWriteInputSchema>;
export type McpAuthResizeInputParsed = z.infer<typeof mcpAuthResizeInputSchema>;
export type GitCommitInputParsed = z.infer<typeof gitCommitInputSchema>;
export type GitPushInputParsed = z.infer<typeof gitPushInputSchema>;
export type GitCreateBranchInputParsed = z.infer<typeof gitCreateBranchInputSchema>;
export type GitViewOrCreatePrInputParsed = z.infer<typeof gitViewOrCreatePrInputSchema>;
export type TournamentLaunchInputParsed = z.infer<typeof tournamentLaunchInputSchema>;
export type TournamentListInputParsed = z.infer<typeof tournamentListInputSchema>;
export type TournamentGetInputParsed = z.infer<typeof tournamentGetInputSchema>;
export type TournamentKeepInputParsed = z.infer<typeof tournamentKeepInputSchema>;
