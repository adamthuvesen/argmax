import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MaestroDatabase } from "../persistence/database.js";
import { computeSessionAttention } from "../sessions/sessionAttention.js";
import type { LaunchProviderSessionInput, ProviderId, SessionSummary } from "../../shared/types.js";
import { getProviderAdapter } from "./providerAdapters.js";
import { normalizeProviderEvent } from "./providerEventNormalizer.js";
import type { ProviderAdapter, ProviderEvent, ProviderSessionHandle } from "./providerTypes.js";

const launchProviderSessionInput = z.object({
  workspaceId: z.string().min(1),
  provider: z.enum(["claude", "codex"]),
  prompt: z.string().min(1),
  modelLabel: z.string().min(1),
  cols: z.number().int().min(20).max(400),
  rows: z.number().int().min(5).max(200)
});

export class ProviderSessionService {
  private readonly handles = new Map<string, ProviderSessionHandle>();

  constructor(
    private readonly database: MaestroDatabase,
    private readonly adapterFactory: (provider: ProviderId) => ProviderAdapter = getProviderAdapter
  ) {}

  async launch(rawInput: LaunchProviderSessionInput): Promise<SessionSummary> {
    const input = launchProviderSessionInput.parse(rawInput);
    const workspace = this.database.getWorkspace(input.workspaceId);
    const sessionId = randomUUID();

    const session = this.database.persistSession({
      id: sessionId,
      workspaceId: workspace.id,
      provider: input.provider,
      modelLabel: input.modelLabel,
      prompt: input.prompt,
      state: "running",
      attention: computeSessionAttention({ state: "running" })
    });

    this.database.updateWorkspaceState(workspace.id, "running");
    this.database.persistTimelineEvent({
      id: randomUUID(),
      sessionId,
      type: "session.started",
      message: `${input.provider} session started.`,
      payload: {
        provider: input.provider,
        workspacePath: workspace.path,
        modelLabel: input.modelLabel
      }
    });

    const adapter = this.adapterFactory(input.provider);
    try {
      const handle = await adapter.launch(
        {
          sessionId,
          workspacePath: workspace.path,
          prompt: input.prompt,
          modelLabel: input.modelLabel,
          mode: "interactive-pty",
          cols: input.cols,
          rows: input.rows
        },
        (event) => this.handleProviderEvent(workspace.id, event)
      );
      this.handles.set(sessionId, handle);
      return session;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Provider launch failed.";
      this.database.updateSessionState(sessionId, {
        state: "failed",
        attention: computeSessionAttention({ state: "failed" }),
        completedAt: new Date().toISOString()
      });
      this.database.updateWorkspaceState(workspace.id, "failed");
      this.database.persistTimelineEvent({
        id: randomUUID(),
        sessionId,
        type: "error",
        message,
        payload: {
          provider: input.provider
        }
      });
      throw error;
    }
  }

  sendInput(sessionId: string, input: string): void {
    this.getHandle(sessionId).sendInput(input);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.getHandle(sessionId).resize(cols, rows);
  }

  terminate(sessionId: string): void {
    this.getHandle(sessionId).terminate();
  }

  private handleProviderEvent(workspaceId: string, event: ProviderEvent): void {
    this.database.persistRawOutput({
      id: randomUUID(),
      sessionId: event.sessionId,
      stream: event.stream,
      content: event.message,
      createdAt: event.createdAt
    });

    if (event.type === "output") {
      for (const normalizedEvent of normalizeProviderEvent(event)) {
        this.database.persistTimelineEvent(normalizedEvent);
      }
      return;
    }

    const completedAt = event.createdAt;
    const succeeded = event.type === "exit" && event.exitCode === 0;
    const state = succeeded ? "complete" : "failed";
    this.database.updateSessionState(event.sessionId, {
      state,
      attention: computeSessionAttention({ state }),
      completedAt,
      lastActivityAt: completedAt
    });
    this.database.updateWorkspaceState(workspaceId, state);
    this.database.persistTimelineEvent({
      id: randomUUID(),
      sessionId: event.sessionId,
      type: succeeded ? "session.completed" : "error",
      message: event.message,
      payload: {
        exitCode: event.exitCode
      },
      createdAt: event.createdAt
    });
    this.handles.delete(event.sessionId);
  }

  private getHandle(sessionId: string): ProviderSessionHandle {
    const handle = this.handles.get(sessionId);
    if (!handle) {
      throw new Error(`No running provider session found for ${sessionId}`);
    }
    return handle;
  }
}
