import pkg from "../../package.json";

// Single source of truth for the displayed app version is package.json's
// `version` (kept in lockstep with src-tauri/Cargo.toml and tauri.conf.json).
// Don't hardcode the number in the UI — read it from here.
export const APP_VERSION: string = pkg.version;

// Argmax is pre-1.0 and shipping as an early build — bugs are expected (see the
// README "Status" section). The stage label is shown alongside the version.
export const APP_STAGE = "Alpha";

// User-facing label, e.g. "Alpha 0.2.0".
export const APP_VERSION_LABEL = `${APP_STAGE} ${APP_VERSION}`;
