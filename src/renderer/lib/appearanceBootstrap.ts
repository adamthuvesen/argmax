import { ACCENT_OPTIONS, ACCENT_STORAGE_KEY, DEFAULT_ACCENT_ID } from "./accent.js";
import { APPEARANCE_LEVEL_PATTERN } from "./appearanceLevel.js";
import {
  BACKGROUND_INTENSITY_STORAGE_KEY,
  DEFAULT_BACKGROUND_INTENSITY,
  LEGACY_BACKGROUND_INTENSITY_PATTERN,
  LEGACY_BACKGROUND_INTENSITY_STORAGE_KEY,
} from "./backgroundIntensity.js";
import { CONTRAST_STORAGE_KEY } from "./contrast.js";
import { DEFAULT_SIDEBAR_INTENSITY, SIDEBAR_INTENSITY_STORAGE_KEY } from "./sidebarIntensity.js";
import { THEME_OPTIONS, THEME_STORAGE_KEY } from "./theme.js";
import { USER_BUBBLE_TINT_STORAGE_KEY } from "./userBubbleTint.js";

export type AppearanceSurface = "desktop" | "mobile";

const quoted = JSON.stringify;

function resolvedTheme(defaultMode: "system" | "dark"): string {
  return `var raw = localStorage.getItem(${quoted(THEME_STORAGE_KEY)});
var mode = ${THEME_OPTIONS.map((option) => `raw === ${quoted(option.id)}`).join(" || ")} ? raw : ${quoted(defaultMode)};
var resolved = mode === "system"
  ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  : mode;
root.setAttribute("data-theme", resolved);`;
}

function desktopBody(): string {
  return `try {
${resolvedTheme("system")}
var levelPattern = ${APPEARANCE_LEVEL_PATTERN.toString()};
var level = localStorage.getItem(${quoted(BACKGROUND_INTENSITY_STORAGE_KEY)});
var legacy = localStorage.getItem(${quoted(LEGACY_BACKGROUND_INTENSITY_STORAGE_KEY)});
var intensity = levelPattern.test(level || "")
  ? level
  : ${LEGACY_BACKGROUND_INTENSITY_PATTERN.toString()}.test(legacy || "")
    ? String(Number(legacy) * 10)
    : ${quoted(String(DEFAULT_BACKGROUND_INTENSITY))};
root.setAttribute("data-background-intensity", intensity);
root.style.setProperty("--background-intensity", intensity);
var contrast = localStorage.getItem(${quoted(CONTRAST_STORAGE_KEY)});
if (levelPattern.test(contrast || "")) {
  root.setAttribute("data-contrast", contrast);
  root.style.setProperty("--contrast", contrast);
}
var sidebar = localStorage.getItem(${quoted(SIDEBAR_INTENSITY_STORAGE_KEY)});
sidebar = levelPattern.test(sidebar || "") ? sidebar : ${quoted(String(DEFAULT_SIDEBAR_INTENSITY))};
root.setAttribute("data-sidebar-intensity", sidebar);
root.style.setProperty("--sidebar-intensity", sidebar);
} catch (e) {
root.setAttribute("data-theme", window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}`;
}

function mobileBody(): string {
  const accents = Object.fromEntries(ACCENT_OPTIONS.map((option) => [option.id, 1]));
  return `try {
${resolvedTheme("dark")}
} catch (e) {
root.setAttribute("data-theme", "dark");
}
try {
var accent = localStorage.getItem(${quoted(ACCENT_STORAGE_KEY)});
var accents = ${quoted(accents)};
root.setAttribute("data-accent", accents[accent] ? accent : ${quoted(DEFAULT_ACCENT_ID)});
} catch (e) {
root.setAttribute("data-accent", ${quoted(DEFAULT_ACCENT_ID)});
}
try {
var bubble = localStorage.getItem(${quoted(USER_BUBBLE_TINT_STORAGE_KEY)});
root.setAttribute("data-user-bubble", bubble === "neutral" ? "neutral" : "accent");
} catch (e) {
root.setAttribute("data-user-bubble", "accent");
}`;
}

/**
 * The inline script that paints the saved appearance before React mounts, so a
 * cold start has no flash. It runs before any module loads and cannot import, so
 * `scripts/build-appearance-bootstrap.mjs` writes this text into index.html and
 * mobile.html, using the keys and rules of the modules that own them.
 */
export function appearanceBootstrapScript(surface: AppearanceSurface): string {
  return `(function () {
var root = document.documentElement;
${surface === "desktop" ? desktopBody() : mobileBody()}
})();`;
}
