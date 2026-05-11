import { tryParseJsonObject } from "../../shared/safeJson.js";
import { stripTerminalControls } from "../../shared/terminalControls.js";
import type { RawProviderOutput } from "../../shared/types.js";

export function buildTerminalTranscript(rawOutputs: RawProviderOutput[], sessionId: string | null): string {
  if (!sessionId) {
    return "";
  }

  // Stream-json events can be split across multiple raw output chunks; concatenate
  // first so the JSON-line filter sees whole lines and hides them properly.
  const combined = rawOutputs
    .filter((output) => output.sessionId === sessionId && ["stdout", "stderr"].includes(output.stream))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((output) => stripTerminalControls(output.content))
    .join("");

  const transcript = visibleRawProviderLines(combined).join("").trim();

  return transcript.length > 8_000 ? transcript.slice(-8_000) : transcript;
}

export function visibleRawProviderLines(content: string): string[] {
  return content
    .split(/(\r?\n)/)
    .filter((part) => part === "\n" || part === "\r\n" || !isHiddenRawProviderLine(part.trim()));
}

function isHiddenRawProviderLine(line: string): boolean {
  const record = tryParseJsonObject(line);
  return record !== null && typeof record.type === "string";
}
