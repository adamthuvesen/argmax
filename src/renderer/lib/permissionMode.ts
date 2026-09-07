/**
 * User preference for provider permission gating.
 *
 * - `provider-defaults`: launch without Argmax bypass flags or an Argmax-owned
 *   approval policy. Each provider follows its native CLI configuration. This
 *   is the default for new installs.
 * - `auto-approve`: provider launches with the broad bypass flags
 *   (`bypassPermissions` / `--dangerously-bypass-approvals-and-sandbox` /
 *   `--force --trust`). This legacy wire value is shown as “Full access”.
 * - `ask-each-time`: drop the bypass flags. Native approval requests go through
 *   the provider's native approval gate, which Argmax surfaces in-app when the
 *   provider supports live replies.
 *
 * Persisted to localStorage. Reads tolerate missing/corrupt values by
 * returning the safe default.
 */
export type PermissionMode = "provider-defaults" | "auto-approve" | "ask-each-time";

export const PERMISSION_MODE_KEY = "argmax.permissionMode";
export const DEFAULT_PERMISSION_MODE: PermissionMode = "provider-defaults";

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "provider-defaults" || value === "auto-approve" || value === "ask-each-time";
}

export function readStoredPermissionMode(): PermissionMode {
  if (typeof window === "undefined") {
    return DEFAULT_PERMISSION_MODE;
  }
  const stored = window.localStorage.getItem(PERMISSION_MODE_KEY);
  return isPermissionMode(stored) ? stored : DEFAULT_PERMISSION_MODE;
}
