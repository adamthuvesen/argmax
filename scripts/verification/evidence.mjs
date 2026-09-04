import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const SECRET_KEYS = /(^|_)(token|secret|password|api_?key|authorization|cookie)($|_)/i;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_FRAGMENT_TOKEN = /(#token=)[^&#\s"']+/gi;
const JSON_SECRET = /((?:token|secret|password|api_?key|authorization|cookie)[^"'\s]*["']?\s*:\s*["'])[^"']+/gi;
const ESCAPED_JSON_SECRET = /((?:token|secret|password|api_?key|authorization|cookie)[A-Z0-9_]*\\?"\s*:\s*\\?")[^"\\]+/gi;
const ENV_SECRET = /((?:TOKEN|SECRET|PASSWORD|API_?KEY|AUTHORIZATION|COOKIE)[A-Z0-9_]*=)[^\s"']+/g;

export function redact(value, key = "") {
  if (SECRET_KEYS.test(key)) return "[redacted]";
  if (typeof value === "string") {
    return value
      .replace(BEARER, "Bearer [redacted]")
      .replace(URL_FRAGMENT_TOKEN, "$1[redacted]")
      .replace(ESCAPED_JSON_SECRET, "$1[redacted]")
      .replace(JSON_SECRET, "$1[redacted]")
      .replace(ENV_SECRET, "$1[redacted]");
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, redact(entry, entryKey)]));
  }
  return value;
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(redact(value), null, 2)}\n`);
}

export async function writeNdjson(filePath, values) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, values.map((value) => JSON.stringify(redact(value))).join("\n") + (values.length ? "\n" : ""));
}

export async function copyIfPresent(source, destination) {
  try {
    await stat(source);
  } catch {
    return false;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
  return true;
}

export async function redactTextFile(filePath) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return;
  }
  await writeFile(filePath, redact(content));
}

export async function redactEvidenceTextFiles(root) {
  for (const file of await listEvidenceFiles(root)) {
    if (/\.(?:json|log|ndjson|txt)$/i.test(file)) await redactTextFile(path.join(root, file));
  }
}

export async function listEvidenceFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else files.push(path.relative(root, absolute));
    }
  }
  await visit(root);
  return files.sort();
}
