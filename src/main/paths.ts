import { app } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function getDataDirectory(): string {
  const dataDir = join(app.getPath("userData"), "local-state");
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

export function getDatabasePath(): string {
  return join(getDataDirectory(), "argmax.sqlite");
}
