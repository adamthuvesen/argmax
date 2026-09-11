#!/usr/bin/env node
// Write the model catalogue the iPhone app reads, from the catalogue the rest
// of Argmax reads.
//
// `src/shared/providerModels.ts` is the single source for model labels, ids,
// effort ladders and per-provider defaults, and half of what the launcher
// needs there is a function rather than a table (`reasoningEffortsForModel`
// resolves Codex's ladder by model id, `effortForModel` clamps a preference
// onto it). A Swift copy would be a second source that drifts silently — the
// phone would offer Grok an Ultra rung its CLI rejects — so the ladders are
// resolved here, per model, and shipped as data.
//
//   npm run export:provider-models
//
// Output: ios/Argmax/Resources/providerModels.json, bundled by
// ios/Argmax/project.yml and decoded by Sources/Chats/ProviderCatalog.swift.
// Re-run it after any catalogue change; ProviderCatalogTests fails the iOS
// suite when the file is missing or unreadable.
//
// The catalogue's import graph is not runnable under plain node (see the same
// note in scripts/bridge.mjs), so this loads it through Vite's SSR loader,
// which is the dev dependency the renderer already builds with.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(repoRoot, "ios/Argmax/Resources/providerModels.json");

async function loadCatalogue() {
  const server = await createServer({
    configFile: false,
    root: repoRoot,
    server: { middlewareMode: true },
    logLevel: "error"
  });
  try {
    return {
      models: await server.ssrLoadModule("/src/shared/providerModels.ts"),
      picker: await server.ssrLoadModule("/src/renderer/lib/models.ts")
    };
  } finally {
    await server.close();
  }
}

/** A picker selection as the phone stores it: effort is always a key. */
function selection(model) {
  return {
    provider: model.provider,
    label: model.label,
    modelId: model.modelId,
    reasoningEffort: model.reasoningEffort ?? null
  };
}

function buildCatalogue({ models, picker }) {
  const {
    PROVIDER_DISPLAY_NAMES,
    PROVIDER_MODELS,
    PROVIDER_MODEL_DEFAULTS,
    PROVIDER_TITLE_MODEL,
    FORK_CAPABLE_PROVIDERS,
    REASONING_EFFORTS,
    DEFAULT_REASONING_EFFORT,
    reasoningEffortsForModel,
    effortForModel
  } = models;
  const { PROVIDER_LAUNCH_PRIORITY, FALLBACK_LAUNCH_MODEL, factoryLaunchModel, effortLabel, modelDefaultForProvider } =
    picker;

  return {
    // Not a version: a reader that finds a key missing should re-run the
    // script, and this says which one to run.
    generatedBy: "scripts/export-provider-models.mjs",
    // Ordered low → high. JSON objects carry no order, and the phone clamps
    // an effort down this ladder when the model it moves to is missing a rung.
    efforts: [...REASONING_EFFORTS],
    effortLabels: Object.fromEntries(REASONING_EFFORTS.map((effort) => [effort, effortLabel(effort)])),
    defaultEffort: DEFAULT_REASONING_EFFORT,
    launchPriority: [...PROVIDER_LAUNCH_PRIORITY],
    factoryModel: selection(factoryLaunchModel()),
    fallbackModel: selection(FALLBACK_LAUNCH_MODEL),
    providers: PROVIDER_LAUNCH_PRIORITY.map((provider) => ({
      id: provider,
      displayName: PROVIDER_DISPLAY_NAMES[provider],
      forkCapable: FORK_CAPABLE_PROVIDERS.has(provider),
      titleModelId: PROVIDER_TITLE_MODEL[provider],
      defaultModel: selection({ provider, ...modelDefaultForProvider(provider) }),
      models: PROVIDER_MODELS[provider].map((model) => ({
        label: model.label,
        modelId: model.modelId,
        // The phone's model picker prints this in its trailing column
        // ("1M", "200K"). Null for a model whose window nobody has written
        // down: the column goes blank there rather than guessing a number
        // someone would then plan a context budget against.
        contextWindow: model.contextWindow ?? null,
        // Empty for a fast model: the phone hides the effort control on the
        // same signal the web picker does.
        reasoningEfforts: model.supportsReasoningEffort ? [...reasoningEffortsForModel(provider, model.modelId)] : [],
        defaultEffort: model.supportsReasoningEffort ? effortForModel(provider, model.modelId) ?? null : null
      }))
    })),
    // A cross-check the Swift side asserts: every default names a model the
    // provider actually lists.
    defaultModelIds: Object.fromEntries(
      Object.entries(PROVIDER_MODEL_DEFAULTS).map(([provider, model]) => [provider, model.modelId])
    )
  };
}

const catalogue = buildCatalogue(await loadCatalogue());
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(catalogue, null, 2)}\n`);
console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
