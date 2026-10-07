import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transpileModule, ScriptTarget, ModuleKind } from "typescript";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [runtime, css, lucide, license] = await Promise.all([
  read("src/shared/visualization/runtime.ts"), read("src/shared/visualization/runtime.css"),
  read("node_modules/lucide/dist/umd/lucide.min.js"), read("node_modules/lucide/LICENSE")
]);
const cdns = "https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com";
const csp = [
  "default-src 'none'", `script-src 'unsafe-inline' ${cdns}`,
  `style-src 'unsafe-inline' ${cdns} https://fonts.googleapis.com https://fonts.bunny.net`,
  `font-src data: ${cdns} https://fonts.gstatic.com https://fonts.bunny.net`,
  `img-src data: blob: ${cdns}`, "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-src 'none'", "object-src 'none'"
].join("; ");
const compiled = transpileModule(runtime, {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext }
}).outputText.replace(/^export \{\};?\s*$/gm, "");
const script = `/*\n${license.replace(/\*\//g, "*\\/")}\n*/\n${lucide}\n${compiled}`.replace(/<\/script/gi, "<\\/script");
const output = `${JSON.stringify({ version: 1, csp, css, script }, null, 2)}\n`;
const destination = new URL("assets/visualization-runtime.json", root);
if (process.argv.includes("--check")) {
  if (await readFile(destination, "utf8") !== output) {
    console.error("Visualization runtime is stale. Run node scripts/build-visualization-runtime.mjs.");
    process.exitCode = 1;
  }
} else {
  await writeFile(destination, output);
  console.log(`Generated ${fileURLToPath(destination)}`);
}
