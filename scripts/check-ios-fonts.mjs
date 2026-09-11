#!/usr/bin/env node
// The phone app's typeface setting, kept reachable.
//
// A font named at a call site — `.font(.body)`, `UIFont.systemFont(…)` — is a
// surface Settings › Typeface cannot reach: it draws in SF whatever the
// picker says. Every role goes through ios/Argmax/Sources/Design/Typography.swift
// instead, and this fails the push on anything that does not.
//
// The second rule is the transcript's three sizes: output at .body, chrome at
// .footnote, badges at .caption2. A `.subheadline` or a bare `.caption` in
// there is a fourth size nobody decided on.
//
//   node scripts/check-ios-fonts.mjs

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCES = join(ROOT, "ios/Argmax/Sources");
// The one file allowed to name a system font: it is what the roles resolve to.
const TYPOGRAPHY = join(SOURCES, "Design/Typography.swift");
const TRANSCRIPT = join(SOURCES, "Transcript");

/** A line opts out by saying which rule it breaks and why, in the code. */
const EXEMPTION = /\/\/ *type-exception:/;

const FONT_RULES = [
  // `.font(.body)`, `.font(.caption2.weight(.semibold))` — a literal Font.
  { pattern: /\.font\(\s*(\.|Font\.)/, message: "names a font directly; use typeStyle / typeSize / typeSymbol" },
  { pattern: /\bFont\.(system|custom)\(/, message: "builds a Font by hand; use the TypeScale in the environment" },
  { pattern: /\bargmaxMono\b/, message: "argmaxMono is gone; use mono: true" },
  {
    pattern: /\bUIFont\.(systemFont|monospacedSystemFont|preferredFont)\(|\bUIFont\(name:/,
    message: "builds a UIFont by hand; use TypeScale.uiFont"
  }
];

const TIER_RULES = [
  {
    pattern: /type(Style\(\s*\.subheadline|Content\(\))/,
    message: "the transcript has three sizes: output .body, chrome .footnote, badge .caption2"
  },
  {
    // `.caption` is the mono payload's size and nothing else's.
    pattern: /typeStyle\(\s*\.caption\b(?!2)(?![^)]*mono: true)/,
    message: "bare .caption is a fourth size; chrome is .footnote, and only mono payload stays at .caption"
  }
];

function swiftFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return swiftFiles(path);
    return entry.isFile() && entry.name.endsWith(".swift") ? [path] : [];
  });
}

const failures = [];
for (const path of swiftFiles(SOURCES)) {
  const rules = [
    ...(path === TYPOGRAPHY ? [] : FONT_RULES),
    ...(path.startsWith(TRANSCRIPT) ? TIER_RULES : [])
  ];
  if (rules.length === 0) continue;
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (EXEMPTION.test(line)) return;
    // `Text(a) + Text(b).font(typeScale.font(…))`: concatenated Text takes a
    // Font value rather than a modifier, so the resolver is the call site.
    const subject = line.replaceAll(/\b(typeScale|scale)\.font\(/g, "resolved(");
    for (const rule of rules) {
      if (rule.pattern.test(subject)) {
        failures.push(`${relative(ROOT, path)}:${index + 1}  ${rule.message}\n    ${line.trim()}`);
      }
    }
  });
}

if (failures.length > 0) {
  console.error(`iOS typography: ${failures.length} call site(s) outside the type roles\n`);
  console.error(`${failures.join("\n")}\n`);
  console.error("Fix by reaching for a role in ios/Argmax/Sources/Design/Typography.swift,");
  console.error("or, where the exception is real, say so on the line: // type-exception: <why>");
  process.exit(1);
}

console.log("iOS typography: every call site goes through the type roles.");
