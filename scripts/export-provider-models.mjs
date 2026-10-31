#!/usr/bin/env node
// Write the model catalogues the iPhone app and the Rust runtime read, from the
// catalogue the rest of Argmax reads.
//
// `src/shared/providerModels.ts` is the single source for model labels, ids,
// effort ladders and per-provider defaults, and half of what the launcher
// needs there is a function rather than a table (`reasoningEffortsForModel`
// resolves Codex's ladder by model id, `effortForModel` clamps a preference
// onto it). A Swift or Rust copy would be a second source that drifts silently
// (the phone would offer Grok an Ultra rung its CLI rejects), so the ladders
// are resolved here, per model, and shipped as data.
//
//   npm run export:provider-models
//   npm run check:provider-models     # no write; exits 1 on drift (precheck + CI)
//
// Outputs:
// - ios/Argmax/Resources/providerModels.json, bundled by ios/Argmax/project.yml
//   and decoded by Sources/Chats/ProviderCatalog.swift.
// - src-tauri/src/providers/model_catalogue.generated.rs, included by
//   providers/model_catalogue.rs.
//
// Re-run it after any catalogue change. ProviderCatalogTests fails the iOS suite
// when the JSON is missing or unreadable, but the iOS suite does not run in CI,
// so `--check` is the gate. It fails on a stale output, a test that looks up a
// dropped id, a default or title model the catalogue no longer lists, a priced
// id that left the catalogue with no successor, and production code that still
// names a retired id.
//
// The catalogue's import graph is not runnable under plain node (see the same
// note in scripts/bridge.mjs), so this loads it through Vite's SSR loader,
// which is the dev dependency the renderer already builds with.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(repoRoot, "ios/Argmax/Resources/providerModels.json");
const rustOutputPath = path.join(repoRoot, "src-tauri/src/providers/model_catalogue.generated.rs");

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
    SUCCESSOR_MODEL_IDS,
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
      // Retired id → the catalog id that replaced it, so a stored chat on a
      // retired model reads and relaunches as its successor.
      successors: { ...(SUCCESSOR_MODEL_IDS[provider] ?? {}) },
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

function rustVariant(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function rustOption(value, render = JSON.stringify) {
  return value === undefined || value === null ? "None" : `Some(${render(value)})`;
}

function rustCatalogueRow(provider, model, efforts) {
  const effortList = efforts.map((effort) => `ReasoningEffort::${rustVariant(effort)}`).join(", ");
  return [
    "    CatalogueModel {",
    `        provider: ProviderId::${rustVariant(provider)},`,
    `        model_id: ${JSON.stringify(model.modelId)},`,
    `        label: ${rustOption(model.label)},`,
    `        efforts: &[${effortList}],`,
    `        supports_fast_mode: ${model.supportsFastMode === true},`,
    `        fast_mode_model_id: ${rustOption(model.fastModeModelId)},`,
    `        context_window: ${rustOption(model.contextWindow, String)},`,
    "    },"
  ].join("\n");
}

function rustProviderMatch(name, returnType, providers, arm) {
  const arms = providers.map((provider) => `        ProviderId::${rustVariant(provider)} => ${arm(provider)},`);
  return [`pub fn ${name}(provider: ProviderId) -> ${returnType} {`, "    match provider {", ...arms, "    }", "}"].join("\n");
}

function renderRustCatalogue({ models, picker }) {
  const {
    PROVIDER_MODELS,
    STORED_ONLY_MODELS,
    PROVIDER_TITLE_MODEL,
    SUCCESSOR_MODEL_IDS,
    reasoningEffortsForModel
  } = models;
  const providers = picker.PROVIDER_LAUNCH_PRIORITY;
  const rows = providers.flatMap((provider) =>
    [...PROVIDER_MODELS[provider], ...(STORED_ONLY_MODELS[provider] ?? [])].map((model) =>
      rustCatalogueRow(
        provider,
        model,
        model.supportsReasoningEffort ? reasoningEffortsForModel(provider, model.modelId) : []
      )
    )
  );
  const successors = providers.flatMap((provider) =>
    Object.entries(SUCCESSOR_MODEL_IDS[provider] ?? {}).map(
      ([retired, successor]) =>
        `    (ProviderId::${rustVariant(provider)}, ${JSON.stringify(retired)}, ${JSON.stringify(successor)}),`
    )
  );
  const vercelSlugs = PROVIDER_MODELS.opencode
    .filter((model) => model.vercelSlug)
    .map((model) => `    (${JSON.stringify(model.modelId.replace(/^openrouter\//, ""))}, ${JSON.stringify(model.vercelSlug)}),`);
  return [
    "// Generated by scripts/export-provider-models.mjs from src/shared/providerModels.ts.",
    "// Do not edit. Run: npm run export:provider-models",
    "",
    "pub static CATALOGUE_MODELS: &[CatalogueModel] = &[",
    ...rows,
    "];",
    "",
    "/// Retired id to the catalogue id that replaced it, per provider.",
    "pub static SUCCESSOR_MODEL_IDS: &[(ProviderId, &str, &str)] = &[",
    ...successors,
    "];",
    "",
    "/// OpenRouter model part to Vercel AI Gateway slug, where the two differ.",
    "pub static VERCEL_SLUGS: &[(&str, &str)] = &[",
    ...vercelSlugs,
    "];",
    "",
    rustProviderMatch("provider_defaults", "ProviderDefaults", providers, (provider) => {
      const model = picker.modelDefaultForProvider(provider);
      return [
        "ProviderDefaults {",
        `            model_label: ${JSON.stringify(model.label)},`,
        `            model_id: ${JSON.stringify(model.modelId)},`,
        `            reasoning_effort: ${rustOption(model.reasoningEffort)},`,
        "        }"
      ].join("\n");
    }),
    "",
    rustProviderMatch("helper_model", "&'static str", providers, (provider) =>
      JSON.stringify(PROVIDER_TITLE_MODEL[provider])
    ),
    ""
  ].join("\n");
}

function catalogueIds(models, provider) {
  return new Set(models.PROVIDER_MODELS[provider].map((model) => model.modelId));
}

/** Facts the catalogue states about itself that a hand edit can break. */
function catalogueFailures({ models }) {
  const { PROVIDER_MODELS, PROVIDER_MODEL_DEFAULTS, PROVIDER_TITLE_MODEL, STORED_ONLY_MODELS, SUCCESSOR_MODEL_IDS, MODEL_PRICING } = models;
  const failures = [];
  const accounted = new Set();
  for (const provider of Object.keys(PROVIDER_MODELS)) {
    const ids = catalogueIds(models, provider);
    if (!ids.has(PROVIDER_MODEL_DEFAULTS[provider].modelId)) {
      failures.push(`PROVIDER_MODEL_DEFAULTS.${provider} names ${PROVIDER_MODEL_DEFAULTS[provider].modelId}, which PROVIDER_MODELS.${provider} no longer lists`);
    }
    if (!ids.has(PROVIDER_TITLE_MODEL[provider])) {
      failures.push(`PROVIDER_TITLE_MODEL.${provider} names ${PROVIDER_TITLE_MODEL[provider]}, which PROVIDER_MODELS.${provider} no longer lists`);
    }
    for (const [retired, successor] of Object.entries(SUCCESSOR_MODEL_IDS[provider] ?? {})) {
      if (!ids.has(successor)) {
        failures.push(`SUCCESSOR_MODEL_IDS.${provider} sends ${retired} to ${successor}, which PROVIDER_MODELS.${provider} does not list`);
      }
      if (ids.has(retired)) {
        failures.push(`SUCCESSOR_MODEL_IDS.${provider} retires ${retired}, which PROVIDER_MODELS.${provider} still lists`);
      }
      accounted.add(retired);
    }
    for (const model of [...PROVIDER_MODELS[provider], ...(STORED_ONLY_MODELS[provider] ?? [])]) {
      accounted.add(model.modelId);
      if (model.fastModeModelId) accounted.add(model.fastModeModelId);
    }
  }
  // A stored chat can still name a priced id. Dropping a row without saying
  // what happens to those chats is the mistake #223 and #225 shipped.
  for (const id of Object.keys(MODEL_PRICING)) {
    if (!accounted.has(id)) {
      failures.push(
        `${id} is priced but left PROVIDER_MODELS. In src/shared/providerModels.ts add it to SUCCESSOR_MODEL_IDS or STORED_ONLY_MODELS, or move its rate to STORED_MODEL_PRICING_ALIASES`
      );
    }
  }
  return failures;
}

const RETIRED_ID_ROOTS = ["src-tauri/src", "src-tauri/crates", "src/renderer", "src/shared"];
// These hold a retired id on purpose: the source of the map, its output, and the rate old usage rows bill at.
const RETIRED_ID_HOMES = new Set([
  "src/shared/providerModels.ts",
  "src-tauri/src/providers/model_catalogue.generated.rs",
  "src-tauri/src/providers/pricing.rs"
]);

async function productionFiles(root) {
  const entries = await readdir(path.join(repoRoot, root), { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(rs|ts|tsx)$/.test(entry.name))
    .map((entry) => path.relative(repoRoot, path.join(entry.parentPath, entry.name)))
    .filter((file) => !RETIRED_ID_HOMES.has(file) && !/(\.test\.tsx?|_tests?\.rs|\/test\/.*)$/.test(file));
}

function withoutRustTestModule(source) {
  const testModule = source.search(/^\s*#\[cfg\(test\)\]\s*\n\s*(?:pub(?:\(crate\))?\s+)?mod\s/m);
  return testModule < 0 ? source : source.slice(0, testModule);
}

/** The old `grep -rn "<old-id>"` step of the retire recipe, as a check. */
async function retiredIdFailures({ models }) {
  const retiredIds = Object.values(models.SUCCESSOR_MODEL_IDS).flatMap((map) => Object.keys(map));
  const failures = [];
  const files = (await Promise.all(RETIRED_ID_ROOTS.map(productionFiles))).flat();
  for (const file of files) {
    const source = withoutRustTestModule(await readFile(path.join(repoRoot, file), "utf8"));
    source.split("\n").forEach((line, index) => {
      for (const retired of retiredIds) {
        const escaped = retired.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
        if (new RegExp(`(?<![\\w.-])${escaped}(?![\\w.-])`).test(line)) {
          failures.push(`${file}:${index + 1} names the retired model ${retired}. Name its successor`);
        }
      }
    });
  }
  return failures;
}

const loaded = await loadCatalogue();
const catalogue = buildCatalogue(loaded);
const serialized = `${JSON.stringify(catalogue, null, 2)}\n`;
const rustSerialized = renderRustCatalogue(loaded);
const relativeOutput = path.relative(repoRoot, outputPath);
const relativeRustOutput = path.relative(repoRoot, rustOutputPath);

if (process.argv.includes("--check")) {
  const failures = [...catalogueFailures(loaded), ...(await retiredIdFailures(loaded))];
  if ((await readFile(outputPath, "utf8").catch(() => null)) !== serialized) {
    failures.push(`${relativeOutput} is stale. Run: npm run export:provider-models`);
  }
  if ((await readFile(rustOutputPath, "utf8").catch(() => null)) !== rustSerialized) {
    failures.push(`${relativeRustOutput} is stale. Run: npm run export:provider-models`);
  }

  // A test that names a retired id fails only on a Mac with Xcode, so read the
  // lookups here. A retired id is fine when a successor row resolves it.
  const testPath = path.join(repoRoot, "ios/Argmax/Tests/ProviderCatalogTests.swift");
  const testSource = await readFile(testPath, "utf8");
  for (const [, provider, modelId] of testSource.matchAll(/model\(provider: "([^"]+)", modelId: "([^"]+)"\)/g)) {
    const entry = catalogue.providers.find((candidate) => candidate.id === provider);
    const resolved = entry?.successors[modelId] ?? modelId;
    if (!entry?.models.some((model) => model.modelId === resolved)) {
      failures.push(`ProviderCatalogTests.swift looks up ${provider}/${modelId}, which the catalogue no longer lists`);
    }
  }

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("provider-models: iOS and Rust catalogues are current.");
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized);
  await writeFile(rustOutputPath, rustSerialized);
  console.log(`Wrote ${relativeOutput} and ${relativeRustOutput}`);
}
