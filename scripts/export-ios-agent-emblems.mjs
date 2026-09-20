#!/usr/bin/env node
// Export the subagent emblem set for the native iPhone transcript: the twelve
// shapes, the hue each codename wears, and the codename table.
//
// The set is owned by src/renderer/lib/agentEmblems.ts and the palette by
// this file only translates them into something Swift can draw. Two things are
// resolved here rather than at runtime:
//
//   * Elliptical arcs. Every shape is a 16x16 SVG path, and five of them are
//     built out of `A` commands — including rotated ellipses (the wreath).
//     They come out as cubic béziers, so the phone needs no path parser and
//     Xcode's SVG asset support is never in the loop.
//   * The codename order. `fallbackCodename` indexes SCIENTIST_NAMES, so the
//     array has to survive as an array — a decoded Swift dictionary would not
//     keep it.
//
// Run `npm run export:ios-agent-emblems` after editing a shape or the codename
// table. The generated file is committed.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = path.join(repoRoot, "ios/Argmax/Sources/Design/AgentEmblemArt.swift");

// ---------------------------------------------------------------- path maths

/** The `d` attribute as a flat command list, absolute coordinates only. */
function parsePath(d) {
  const tokens = d.match(/[MLCZA]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  const commands = [];
  let index = 0;
  let command = null;
  const number = () => {
    const value = Number(tokens[index++]);
    if (!Number.isFinite(value)) throw new Error(`Bad number in path: ${d}`);
    return value;
  };
  while (index < tokens.length) {
    if (/[A-Za-z]/.test(tokens[index])) command = tokens[index++];
    switch (command) {
      case "M":
        commands.push({ op: "M", x: number(), y: number() });
        // A repeated coordinate pair after M is an implicit lineto.
        command = "L";
        break;
      case "L":
        commands.push({ op: "L", x: number(), y: number() });
        break;
      case "C":
        commands.push({
          op: "C",
          x1: number(),
          y1: number(),
          x2: number(),
          y2: number(),
          x: number(),
          y: number()
        });
        break;
      case "A":
        commands.push({
          op: "A",
          rx: number(),
          ry: number(),
          rotation: number(),
          largeArc: number(),
          sweep: number(),
          x: number(),
          y: number()
        });
        break;
      case "Z":
        commands.push({ op: "Z" });
        break;
      default:
        throw new Error(`Unsupported path command ${command} in ${d}`);
    }
  }
  return commands;
}

/**
 * One elliptical arc as cubic béziers, by the endpoint-to-centre conversion in
 * the SVG spec's implementation notes, split so no segment sweeps past 90°.
 */
function arcToCurves(from, arc) {
  const { rx: rxIn, ry: ryIn, rotation, largeArc, sweep, x, y } = arc;
  if (from.x === x && from.y === y) return [];
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [{ op: "L", x, y }];

  const dx = (from.x - x) / 2;
  const dy = (from.y - y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;

  // Scale the radii up when they are too small to join the two endpoints.
  const oversize = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (oversize > 1) {
    const scale = Math.sqrt(oversize);
    rx *= scale;
    ry *= scale;
  }

  const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const factor =
    Math.sqrt(Math.max(0, (rx * rx * ry * ry - denominator) / denominator)) *
    (largeArc === sweep ? -1 : 1);
  const cx1 = (factor * rx * y1) / ry;
  const cy1 = (-factor * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (from.x + x) / 2;
  const cy = sin * cx1 + cos * cy1 + (from.y + y) / 2;

  const angle = (ux, uy, vx, vy) => {
    const sign = ux * vy - uy * vx < 0 ? -1 : 1;
    const cosine = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy));
    return sign * Math.acos(Math.min(1, Math.max(-1, cosine)));
  };
  const start = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let sweepAngle = angle(
    (x1 - cx1) / rx,
    (y1 - cy1) / ry,
    (-x1 - cx1) / rx,
    (-y1 - cy1) / ry
  );
  if (!sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
  if (sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI;

  const segments = Math.max(1, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2)));
  const step = sweepAngle / segments;
  // The control-point distance that makes a cubic match a circular arc of
  // `step` radians.
  const reach = (4 / 3) * Math.tan(step / 4);
  const point = (theta) => ({
    x: cx + rx * Math.cos(theta) * cos - ry * Math.sin(theta) * sin,
    y: cy + rx * Math.cos(theta) * sin + ry * Math.sin(theta) * cos
  });
  const derivative = (theta) => ({
    x: -rx * Math.sin(theta) * cos - ry * Math.cos(theta) * sin,
    y: -rx * Math.sin(theta) * sin + ry * Math.cos(theta) * cos
  });

  const curves = [];
  for (let segment = 0; segment < segments; segment++) {
    const theta1 = start + segment * step;
    const theta2 = theta1 + step;
    const p1 = point(theta1);
    const p2 = point(theta2);
    const d1 = derivative(theta1);
    const d2 = derivative(theta2);
    curves.push({
      op: "C",
      x1: p1.x + reach * d1.x,
      y1: p1.y + reach * d1.y,
      x2: p2.x - reach * d2.x,
      y2: p2.y - reach * d2.y,
      // The last segment lands on the command's own endpoint, so an arc never
      // drifts off its declared destination through accumulated rounding.
      x: segment === segments - 1 ? x : p2.x,
      y: segment === segments - 1 ? y : p2.y
    });
  }
  return curves;
}

/** The path with every arc replaced by cubics. */
function flatten(d) {
  const out = [];
  let cursor = { x: 0, y: 0 };
  let subpathStart = { x: 0, y: 0 };
  for (const command of parsePath(d)) {
    if (command.op === "A") {
      for (const curve of arcToCurves(cursor, command)) out.push(curve);
      cursor = { x: command.x, y: command.y };
      continue;
    }
    out.push(command);
    if (command.op === "M") {
      cursor = { x: command.x, y: command.y };
      subpathStart = cursor;
    } else if (command.op === "L" || command.op === "C") {
      cursor = { x: command.x, y: command.y };
    } else if (command.op === "Z") {
      cursor = subpathStart;
    }
  }
  return out;
}

// ------------------------------------------------------------------- sources

async function loadEmblems() {
  const server = await createServer({
    configFile: false,
    root: repoRoot,
    server: { middlewareMode: true },
    logLevel: "error"
  });
  try {
    return await server.ssrLoadModule("/src/renderer/lib/agentEmblems.ts");
  } finally {
    await server.close();
  }
}

const { EMBLEM_PATHS, EMBLEM_SHAPES, EMBLEM_HUES, EMBLEM_BY_CODENAME } = await loadEmblems();
const codenames = JSON.parse(
  await readFile(path.join(repoRoot, "src/shared/agentCodenames.json"), "utf8")
);

for (const codename of Object.keys(EMBLEM_BY_CODENAME)) {
  if (!codenames.includes(codename)) {
    throw new Error(`EMBLEM_BY_CODENAME has ${codename}, which is not a scientist name`);
  }
}
for (const codename of codenames) {
  if (!EMBLEM_BY_CODENAME[codename]) throw new Error(`No emblem assigned to ${codename}`);
}

// ------------------------------------------------------------------- emitter

const round = (value) => `${Number(value.toFixed(3))}`;
const point = (x, y) => `CGPoint(x: ${round(x)}, y: ${round(y)})`;

function swiftPath(shape) {
  const lines = [`        case "${shape}":`];
  for (const command of flatten(EMBLEM_PATHS[shape].d)) {
    if (command.op === "M") lines.push(`            path.move(to: ${point(command.x, command.y)})`);
    else if (command.op === "L")
      lines.push(`            path.addLine(to: ${point(command.x, command.y)})`);
    else if (command.op === "C")
      lines.push(
        `            path.addCurve(to: ${point(command.x, command.y)}, ` +
          `control1: ${point(command.x1, command.y1)}, control2: ${point(command.x2, command.y2)})`
      );
    else lines.push("            path.closeSubpath()");
  }
  return lines.join("\n");
}

const evenOddShapes = EMBLEM_SHAPES.filter((shape) => EMBLEM_PATHS[shape].evenOdd);

const source = `// Generated by scripts/export-ios-agent-emblems.mjs. Do not edit by hand.
//
// The subagent emblem set: twelve shapes on a 16x16 grid, and the shape and
// session-icon hue each codename owns. Owned by
// src/renderer/lib/agentEmblems.ts — edit there and re-run
// \`npm run export:ios-agent-emblems\`.

import SwiftUI

enum AgentEmblemArt {
    static let shapes: [String] = [
${EMBLEM_SHAPES.map((shape) => `        "${shape}"`).join(",\n")}
    ]

    static let hues: [String] = [
${EMBLEM_HUES.map((hue) => `        "${hue}"`).join(",\n")}
    ]

    /// SCIENTIST_NAMES in order, because \`fallbackCodename\` indexes it.
    static let codenames: [String] = [
${codenames.map((codename) => `        "${codename}"`).join(",\n")}
    ]

    /// Codename → (shape, hue).
    static let byCodename: [String: (shape: String, hue: String)] = [
${Object.entries(EMBLEM_BY_CODENAME)
  .map(([codename, [shape, hue]]) => `        "${codename}": (shape: "${shape}", hue: "${hue}")`)
  .join(",\n")}
    ]

    /// The shapes that carry a hole — the orbit's ring, the bloom's open
    /// centre, the gem's facets — and so have to be filled even-odd. The rest
    /// are unions of subpaths wound the same way.
    static let evenOddShapes: Set<String> = [
${evenOddShapes.map((shape) => `        "${shape}"`).join(",\n")}
    ]

    /// The shape's outline on the 16x16 grid. Built once: an emblem is drawn
    /// three times over in every row, and a list of them scrolls.
    static func path(_ shape: String) -> Path { paths[shape] ?? paths["quad"]! }

    private static let paths: [String: Path] = Dictionary(
        uniqueKeysWithValues: shapes.map { ($0, makePath($0)) }
    )

    private static func makePath(_ shape: String) -> Path {
        var path = Path()
        switch shape {
${EMBLEM_SHAPES.map(swiftPath).join("\n")}
        default:
            break
        }
        return path
    }
}
`;

await writeFile(outPath, source);
console.log(
  `Wrote ${EMBLEM_SHAPES.length} shapes and ${codenames.length} codenames to ` +
    `${path.relative(repoRoot, outPath)}`
);
