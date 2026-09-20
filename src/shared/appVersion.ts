import pkg from "../../package.json";

// Single source of truth for the displayed app version is package.json's
// `version` (kept in lockstep with src-tauri/Cargo.toml and tauri.conf.json).
// Don't hardcode the number in the UI — read it from here.
export const APP_VERSION: string = pkg.version;

// Argmax is pre-1.0 and shipping as an early build. The stage word belongs in
// one place only — Settings → Advanced → About — so the everyday chrome shows
// a bare version like any other app. Use APP_VERSION everywhere else.
const APP_STAGE = "Alpha";

// About-only label, e.g. "Alpha 0.5.0".
export const APP_VERSION_LABEL = `${APP_STAGE} ${APP_VERSION}`;
