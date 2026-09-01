import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS, reasoningEffortsForModel } from "../../shared/providerModels.js";
import type { DiscoveredProvider, ProviderId, SessionSummary } from "../../shared/types.js";
import {
  allModelOptions,
  FALLBACK_LAUNCH_MODEL,
  factoryLaunchModel,
  modelDefaultForProvider,
  modelPickerSelectionFromSession,
  modelSelectionFromSession,
  preferredLaunchModel,
  preferredLaunchProvider,
  PROVIDER_LAUNCH_PRIORITY
} from "./models.js";

const BASE_SESSION: SessionSummary = {
  id: "session-1",
  workspaceId: "workspace-1",
  provider: "codex",
  modelLabel: "GPT-5.6 Sol",
  modelId: "gpt-5.6-sol",
  permissionMode: "auto-approve",
  providerConversationId: null,
  prompt: "Review this",
  state: "complete",
  attention: "normal",
  startedAt: "2026-07-04T10:00:00.000Z",
  completedAt: "2026-07-04T10:01:00.000Z",
  lastActivityAt: "2026-07-04T10:01:00.000Z"
};

describe("modelSelectionFromSession", () => {
  it("preserves the stored session model", () => {
    expect(modelSelectionFromSession(BASE_SESSION)).toEqual({
      label: "GPT-5.6 Sol",
      modelId: "gpt-5.6-sol",
    });
    expect(modelPickerSelectionFromSession(BASE_SESSION)).toEqual({
      provider: "codex",
      label: "GPT-5.6 Sol",
      modelId: "gpt-5.6-sol",
    });
  });

  it("shows the catalog label when a session stored a raw API id", () => {
    // An imported Claude session records `claude-opus-5` as its label, because
    // that is what the provider's transcript names. The chip must read "Opus 5".
    const imported: SessionSummary = {
      ...BASE_SESSION,
      provider: "claude",
      modelLabel: "claude-opus-5",
      modelId: "claude-opus-5"
    };

    expect(modelSelectionFromSession(imported)).toEqual({
      label: "Opus 5",
      modelId: "claude-opus-5"
    });
  });

  it("falls back to the provider's default when the model is not in the catalog", () => {
    const retired: SessionSummary = {
      ...BASE_SESSION,
      provider: "claude",
      modelLabel: "claude-opus-3-ancient",
      modelId: "claude-opus-3-ancient"
    };

    const selection = modelSelectionFromSession(retired);

    expect(selection).toEqual(modelDefaultForProvider("claude"));
    expect(selection.modelId).not.toBe("claude-opus-3-ancient");
  });
});

function discovered(
  provider: ProviderId,
  flags: { installed?: boolean; authenticated?: boolean | null } = {}
): DiscoveredProvider {
  const installed = flags.installed ?? true;
  return {
    provider,
    displayName: provider,
    binaryName: provider,
    installed,
    binaryPath: installed ? `/bin/${provider}` : null,
    version: installed ? "1.0" : null,
    authenticated: flags.authenticated === undefined ? true : flags.authenticated,
    setupGuidance: null,
    approvalSupport: "unsupported"
  };
}

describe("preferredLaunchModel", () => {
  it("seeds Claude Opus 5 as the factory default", () => {
    expect(factoryLaunchModel()).toEqual({
      provider: "claude",
      label: "Opus 5",
      modelId: "claude-opus-5",
      reasoningEffort: "medium"
    });
  });

  it("prefers Claude, then Codex, then Cursor, then OpenCode", () => {
    const all = [
      discovered("opencode"),
      discovered("cursor"),
      discovered("codex"),
      discovered("claude")
    ];
    expect(preferredLaunchProvider(all)).toBe("claude");
    expect(preferredLaunchModel(all)).toEqual({
      provider: "claude",
      ...modelDefaultForProvider("claude")
    });

    expect(preferredLaunchModel([discovered("codex"), discovered("cursor"), discovered("opencode")])).toEqual({
      provider: "codex",
      ...modelDefaultForProvider("codex")
    });
    expect(preferredLaunchModel([discovered("cursor"), discovered("opencode")])).toEqual({
      provider: "cursor",
      ...modelDefaultForProvider("cursor")
    });
    expect(preferredLaunchModel([discovered("opencode")])).toEqual({
      provider: "opencode",
      ...modelDefaultForProvider("opencode")
    });
  });

  it("skips a provider that is installed but logged out", () => {
    expect(
      preferredLaunchProvider([
        discovered("claude", { authenticated: false }),
        discovered("codex")
      ])
    ).toBe("codex");
  });

  it("falls back to Big Pickle when no provider is usable", () => {
    expect(preferredLaunchModel([])).toEqual(FALLBACK_LAUNCH_MODEL);
    expect(
      preferredLaunchModel([
        discovered("claude", { installed: false, authenticated: null }),
        discovered("codex", { installed: false, authenticated: null })
      ])
    ).toEqual(FALLBACK_LAUNCH_MODEL);
  });

  it("defaults OpenCode to GLM-5.3-Flash at high effort", () => {
    expect(modelDefaultForProvider("opencode")).toEqual({
      label: "GLM-5.3-Flash",
      modelId: "opencode-go/glm-5.3-flash",
      reasoningEffort: "high"
    });
  });

  it("defaults Cursor to Grok 4.6 at medium effort", () => {
    expect(modelDefaultForProvider("cursor")).toEqual({
      label: "Grok 4.6 (Cursor)",
      modelId: "cursor-grok-4.6-medium",
      reasoningEffort: "medium"
    });
  });
});

describe("allModelOptions", () => {
  it("seeds every effort-capable model with an effort that model actually offers", () => {
    // The seed is what the picker shows and what launch sends, so a level the
    // model has no variant for is silently remapped by the adapter.
    const offenders = allModelOptions
      .filter(
        (option) =>
          option.supportsReasoningEffort &&
          (!option.reasoningEffort ||
            !reasoningEffortsForModel(option.provider, option.modelId).includes(option.reasoningEffort))
      )
      .map((option) => `${option.modelId}=${String(option.reasoningEffort)}`);
    expect(offenders).toEqual([]);
  });

  it("seeds Kimi K3 with max, its only variant, not the default medium", () => {
    const kimi = allModelOptions.find((option) => option.modelId === "opencode-go/kimi-k3");
    expect(kimi?.reasoningEffort).toBe("max");
  });
});

describe("PROVIDER_LAUNCH_PRIORITY", () => {
  // The constant is a plain array, so omitting a provider compiles fine and
  // then silently hides it from the launcher. PROVIDER_MODELS is keyed by
  // ProviderId, so it is the authority on what must be listed.
  it("lists every provider exactly once", () => {
    expect([...PROVIDER_LAUNCH_PRIORITY].sort()).toEqual(Object.keys(PROVIDER_MODELS).sort());
  });

  it("picks Grok when it is the only installed provider", () => {
    expect(preferredLaunchModel([discovered("grok")])).toEqual({
      provider: "grok",
      label: "Grok 4.6",
      modelId: "grok-4.6",
      reasoningEffort: "medium"
    });
  });
});
