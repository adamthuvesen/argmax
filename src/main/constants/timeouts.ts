/**
 * Centralized timeouts and per-subprocess buffer caps.
 *
 * Originally these constants lived next to each subsystem (checkService,
 * git/exec, gh/ghService, ghPoller). A single "speed up gh polling" refactor
 * had to touch three files and risked drift. Single source of truth here so
 * a deliberate tuning change updates everywhere consistently.
 * (audit-2026-05-17 L10)
 */

/** Wall-clock cap on any single `git` invocation. */
export const GIT_EXEC_TIMEOUT_MS = 30_000;
/** Wall-clock cap on a `git` invocation that returns binary stdout (checkpoints). */
export const GIT_EXEC_BINARY_TIMEOUT_MS = 60_000;
/** Bound on stdout buffered by a text-decoded git invocation. */
export const GIT_EXEC_MAX_BUFFER = 64 * 1024 * 1024;
/** Bound on stdout buffered by a buffer-decoded git invocation (binary patches). */
export const GIT_EXEC_BINARY_MAX_BUFFER = 256 * 1024 * 1024;

/** Wall-clock cap on a single `gh` invocation. */
export const GH_EXEC_TIMEOUT_MS = 15_000;
/** Bound on stdout buffered by a `gh` invocation. */
export const GH_EXEC_MAX_BUFFER = 8 * 1024 * 1024;
/** Interval between GhPoller ticks. */
export const GH_POLL_INTERVAL_MS = 60_000;

/** Default cap on a workspace check command's wall-clock runtime. */
export const CHECK_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
