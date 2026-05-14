/**
 * Swallow-and-default helpers for filesystem reads that are *expected* to
 * miss. Skill/MCP/config discovery walks ~/.claude.json, ~/.cursor, etc.;
 * absence is the normal initial state, not an error. Centralizing the try
 * blocks keeps each call site to a single line and removes the ESLint noise
 * of empty `catch {}` braces from the production source.
 */
import { readFile, readdir, stat } from "node:fs/promises";

/** Read a UTF-8 file. Returns `null` when the file is missing or unreadable. */
export async function tryReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** List directory entries. Returns `[]` when the directory is missing. */
export async function tryReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

/**
 * `stat(path).size`, or `null` when the file is missing or unreadable.
 * Cheaper than the full stats object when only the size is needed.
 */
export async function tryFileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/** True iff the path exists and is a directory. Anything else returns false. */
export async function tryIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
