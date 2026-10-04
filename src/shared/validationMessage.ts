import { errorMessage } from "./error.js";

/**
 * The text to show beside a form field after a command rejected its input.
 * Rust reports a field failure as `ArgmaxError::InvalidInput`, which serializes
 * as `{ code, issues: [{ path, code, message }] }` with no top-level `message`,
 * so `errorMessage` alone would print `[object Object]`. Join the issues when
 * they are there and fall back to the usual extraction otherwise.
 */
export function validationMessage(error: unknown): string {
  const issues =
    error && typeof error === "object" && "issues" in error
      ? (error as { issues?: unknown }).issues
      : undefined;
  if (Array.isArray(issues)) {
    const messages = issues
      .map((issue) =>
        issue && typeof issue === "object" && "message" in issue
          ? (issue as { message?: unknown }).message
          : undefined
      )
      .filter((message): message is string => typeof message === "string" && message !== "");
    if (messages.length > 0) return messages.join(" ");
  }
  return errorMessage(error);
}
