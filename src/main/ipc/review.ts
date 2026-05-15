import { ipcMain } from "electron";
import {
  loadDiffInputSchema,
  loadDiffForProjectInputSchema,
  reviewListChangedFilesForProjectInputSchema,
  workspaceGrepContentInputSchema,
  workspaceIdInputSchema,
  workspaceListFilesInputSchema,
  workspaceListFilesForProjectInputSchema,
  workspaceReadFileInputSchema,
  workspaceReadFileForProjectInputSchema,
  workspaceStatFileInputSchema,
  workspaceStatFileForProjectInputSchema,
  workspaceWriteFileInputSchema,
  workspaceWriteFileForProjectInputSchema,
  type IpcChannel
} from "../../shared/ipcSchemas.js";
import type { GitReviewService } from "../review/gitReviewService.js";
import type { WorkspaceFilesService } from "../files/workspaceFilesService.js";
import { timed } from "../util/ipcLatency.js";
import { withTupleValidation, withValidation } from "../ipc.js";

/** Review/diff + workspace files IPC handlers (Ralph SPEC D3 — fifth split). */
export function registerReviewHandlers(
  review: GitReviewService,
  workspaceFiles: WorkspaceFilesService
): readonly IpcChannel[] {
  const registered: IpcChannel[] = [];
  const register = (channel: IpcChannel, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, timed(channel, listener as (event: unknown, ...args: unknown[]) => unknown));
    registered.push(channel);
  };

  register(
    "review:list-changed-files",
    withValidation(workspaceIdInputSchema, (workspaceId) => review.listChangedFiles(workspaceId))
  );
  // `review:load-diff` is invoked positionally as (workspaceId, filePath?).
  register(
    "review:load-diff",
    withTupleValidation(loadDiffInputSchema, ([workspaceId, filePath]) => review.loadDiff(workspaceId, filePath))
  );
  register(
    "review:list-changed-files-for-project",
    withValidation(reviewListChangedFilesForProjectInputSchema, (projectId) =>
      review.listChangedFilesForProject(projectId)
    )
  );
  // Mirrors `review:load-diff`'s positional invocation — `(projectId, filePath?)`.
  register(
    "review:load-diff-for-project",
    withTupleValidation(loadDiffForProjectInputSchema, ([projectId, filePath]) =>
      review.loadDiffForProject(projectId, filePath)
    )
  );
  register(
    "workspace:list-files",
    withValidation(workspaceListFilesInputSchema, (input) => workspaceFiles.listFiles(input.workspaceId))
  );
  register(
    "workspace:read-file",
    withValidation(workspaceReadFileInputSchema, (input) => workspaceFiles.readFile(input.workspaceId, input.filePath))
  );
  register(
    "workspace:list-files-for-project",
    withValidation(workspaceListFilesForProjectInputSchema, (input) =>
      workspaceFiles.listFilesForProject(input.projectId)
    )
  );
  register(
    "workspace:read-file-for-project",
    withValidation(workspaceReadFileForProjectInputSchema, (input) =>
      workspaceFiles.readFileForProject(input.projectId, input.filePath)
    )
  );
  register(
    "workspace:write-file",
    withValidation(workspaceWriteFileInputSchema, (input) =>
      workspaceFiles.writeFile(input.workspaceId, input.filePath, input.content, input.expectedMtimeMs)
    )
  );
  register(
    "workspace:stat-file",
    withValidation(workspaceStatFileInputSchema, (input) => workspaceFiles.statFile(input.workspaceId, input.filePath))
  );
  register(
    "workspace:write-file-for-project",
    withValidation(workspaceWriteFileForProjectInputSchema, (input) =>
      workspaceFiles.writeFileForProject(input.projectId, input.filePath, input.content, input.expectedMtimeMs)
    )
  );
  register(
    "workspace:stat-file-for-project",
    withValidation(workspaceStatFileForProjectInputSchema, (input) =>
      workspaceFiles.statFileForProject(input.projectId, input.filePath)
    )
  );
  register(
    "workspace:grep-content",
    withValidation(workspaceGrepContentInputSchema, (input) =>
      input.kind === "workspace"
        ? workspaceFiles.grepContentForWorkspace(input.id, input.query)
        : workspaceFiles.grepContentForProject(input.id, input.query)
    )
  );

  return registered;
}
