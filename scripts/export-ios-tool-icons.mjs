#!/usr/bin/env node
// Export the desktop's MCP server artwork as vector image sets for the native
// iPhone transcript. The paths and brand colours stay owned by
// src/renderer/lib/serverIcons.ts; this file only names the catalogue entries
// and their aliases so Swift can classify the provider-specific tool names.

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsRoot = path.join(repoRoot, "ios/Argmax/Sources/Assets.xcassets/Integrations");
const manifestPath = path.join(repoRoot, "ios/Argmax/Resources/toolIcons.json");

const integrations = [
  { key: "argmax", aliases: ["argmax"] },
  { key: "slack", aliases: ["slack"] },
  { key: "notion", aliases: ["notion"] },
  { key: "google-drive", aliases: ["google drive", "gdrive", "drive"] },
  { key: "gmail", aliases: ["gmail"] },
  { key: "google-calendar", aliases: ["google calendar", "gcal", "calendar"] },
  { key: "snowflake", aliases: ["snowflake"] },
  { key: "spotify", aliases: ["spotify"] },
  { key: "linear", aliases: ["linear"] },
  { key: "github", aliases: ["github"] },
  { key: "vercel", aliases: ["vercel"] },
  { key: "engram", aliases: ["engram"] },
  { key: "shunt", aliases: ["shunt"] },
  { key: "trace", aliases: ["trace", "trace hq"] }
];

// Kept in the generated manifest because OpenCode omits the MCP marker and
// only its known-server list distinguishes these from ordinary snake_case
// tool names. They intentionally have no image set and fall back to a plug.
const mcpServersWithoutIcons = [
  "browser use",
  "confidence experiments",
  "context7",
  "hex",
  "profound"
];

const foxFills = {
  "var(--fox-line)": "#592718",
  "var(--fox-fur)": "#C6663A",
  "var(--fox-fur-shade)": "#99442D",
  "var(--fox-cream)": "#EBE1CF",
  "var(--fox-cream-shade)": "#BCA595",
  "var(--fox-nose)": "#110B0F"
};

function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function svg(icon, monochromeFill) {
  const layers = icon.layers.map((layer) => {
    const fill = layer.fill === null ? monochromeFill : foxFills[layer.fill] ?? layer.fill;
    if (!fill || fill.startsWith("var(")) throw new Error(`Unsupported fill ${layer.fill} in ${icon.title}`);
    return `  <path d="${xml(layer.path)}" fill="${xml(fill)}"/>`;
  });
  const crispEdges = icon.title === "Argmax" ? ' shape-rendering="crispEdges"' : "";
  return [
    `<svg width="24" height="24" viewBox="${xml(icon.viewBox)}" xmlns="http://www.w3.org/2000/svg"${crispEdges}>`,
    `  <title>${xml(icon.title)}</title>`,
    ...layers,
    "</svg>",
    ""
  ].join("\n");
}

function imageSetContents(key, hasAppearanceVariants) {
  const images = hasAppearanceVariants
    ? [
        { filename: `${key}-light.svg`, idiom: "universal" },
        {
          appearances: [{ appearance: "luminosity", value: "dark" }],
          filename: `${key}-dark.svg`,
          idiom: "universal"
        }
      ]
    : [{ filename: `${key}.svg`, idiom: "universal" }];
  return {
    images,
    info: { author: "xcode", version: 1 },
    properties: { "preserves-vector-representation": true }
  };
}

async function loadServerIcons() {
  const server = await createServer({
    configFile: false,
    root: repoRoot,
    server: { middlewareMode: true },
    logLevel: "error"
  });
  try {
    return await server.ssrLoadModule("/src/renderer/lib/serverIcons.ts");
  } finally {
    await server.close();
  }
}

const { serverIconFor } = await loadServerIcons();
const catalogue = integrations.map((entry) => {
  const icon = serverIconFor(entry.aliases[0]);
  if (!icon) throw new Error(`serverIconFor has no artwork for ${entry.aliases[0]}`);
  return { ...entry, title: icon.title, icon };
});

await rm(assetsRoot, { recursive: true, force: true });
await mkdir(assetsRoot, { recursive: true });
await writeFile(
  path.join(assetsRoot, "Contents.json"),
  `${JSON.stringify({ info: { author: "xcode", version: 1 }, properties: { "provides-namespace": true } }, null, 2)}\n`
);

for (const { key, icon } of catalogue) {
  const imageSet = path.join(assetsRoot, `${key}.imageset`);
  const hasAppearanceVariants = icon.layers.some((layer) => layer.fill === null);
  await mkdir(imageSet, { recursive: true });
  if (hasAppearanceVariants) {
    await writeFile(path.join(imageSet, `${key}-light.svg`), svg(icon, "#1F1D18"));
    await writeFile(path.join(imageSet, `${key}-dark.svg`), svg(icon, "#F4F2EC"));
  } else {
    await writeFile(path.join(imageSet, `${key}.svg`), svg(icon, "#1F1D18"));
  }
  await writeFile(
    path.join(imageSet, "Contents.json"),
    `${JSON.stringify(imageSetContents(key, hasAppearanceVariants), null, 2)}\n`
  );
}

const manifest = {
  generatedBy: "scripts/export-ios-tool-icons.mjs",
  icons: catalogue.map(({ key, title, aliases }) => ({ key, title, aliases })),
  mcpServersWithoutIcons
};
await mkdir(path.dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${catalogue.length} integrations to ${path.relative(repoRoot, assetsRoot)}`);
console.log(`Wrote ${path.relative(repoRoot, manifestPath)}`);
