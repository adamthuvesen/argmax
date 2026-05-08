import type { MaestroDatabase } from "../persistence/database.js";
import type { CommitPreparation, PrepareCommitInput } from "../../shared/types.js";

export class CommitPreparationService {
  constructor(private readonly database: MaestroDatabase) {}

  prepareCommit(input: PrepareCommitInput): CommitPreparation {
    const workspace = this.database.getWorkspace(input.workspaceId);
    const selectedFiles = [...new Set(input.selectedFiles.map((file) => file.trim()).filter(Boolean))];
    const message = input.message.trim();

    if (selectedFiles.length === 0) {
      throw new Error("Select at least one file before preparing a commit.");
    }
    if (!message) {
      throw new Error("Enter a commit message before preparing a commit.");
    }

    return {
      workspaceId: workspace.id,
      branch: workspace.branch,
      selectedFiles,
      message,
      commands: [`git add -- ${selectedFiles.map(shellQuote).join(" ")}`, `git commit -m ${shellQuote(message)}`]
    };
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
