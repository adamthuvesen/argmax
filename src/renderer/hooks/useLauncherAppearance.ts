import { useEffect, useRef, useState } from "react";
import {
  applyFontSizeToDocument,
  applyFontToDocument,
  CHAT_FONT_SIZE_STORAGE_KEY,
  FONT_SIZE_STORAGE_KEY,
  FONT_STORAGE_KEY,
  loadFontAssets,
  readStoredChatFontSize,
  readStoredFontSize,
  readStoredFont,
  type FontSize,
  type FontFamilyId
} from "../lib/fonts.js";
import {
  applyAccentToDocument,
  readStoredAccent,
  writeStoredAccent,
  type AccentId
} from "../lib/accent.js";
import { DEFAULT_IDE_KEY, NO_DEFAULT_IDE, readStoredDefaultIde } from "../lib/ide.js";
import type { DetectedIde, IdeId } from "../../shared/types.js";
import { errorMessage } from "../../shared/error.js";
import { logger } from "../../shared/logger.js";
import type { ThemeMode } from "../lib/theme.js";
import {
  animateThemeChange,
  applyThemeToDocument,
  prefersDarkSystem,
  readStoredTheme,
  resolveTheme,
  writeStoredTheme
} from "../lib/theme.js";
export function useLauncherAppearance(): {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  accentId: AccentId;
  setAccentId: (accentId: AccentId) => void;
  fontFamily: FontFamilyId;
  setFontFamily: (font: FontFamilyId) => void;
  fontSize: FontSize;
  setFontSize: (fontSize: FontSize) => void;
  chatFontSize: FontSize;
  setChatFontSize: (fontSize: FontSize) => void;
  defaultIde: IdeId | null;
  setDefaultIde: (ide: IdeId | null) => void;
  detectedIdes: DetectedIde[];
} {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readStoredTheme());
  const [accentId, setAccentId] = useState<AccentId>(() => readStoredAccent());
  const [fontFamily, setFontFamily] = useState<FontFamilyId>(() => readStoredFont());
  const [fontSize, setFontSize] = useState<FontSize>(() => readStoredFontSize());
  const [chatFontSize, setChatFontSize] = useState<FontSize>(() => readStoredChatFontSize());
  const [defaultIde, setDefaultIde] = useState<IdeId | null>(() => readStoredDefaultIde());
  const [detectedIdes, setDetectedIdes] = useState<DetectedIde[]>([]);
  const ideListLoadedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(FONT_STORAGE_KEY, fontFamily);
    applyFontToDocument(fontFamily);
    void loadFontAssets(fontFamily);
  }, [fontFamily]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(fontSize));
    applyFontSizeToDocument(fontSize);
  }, [fontSize]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CHAT_FONT_SIZE_STORAGE_KEY, String(chatFontSize));
  }, [chatFontSize]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    writeStoredAccent(accentId);
    applyAccentToDocument(accentId);
  }, [accentId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const apply = (): void => {
      const resolved = resolveTheme(themeMode, prefersDarkSystem());
      applyThemeToDocument(resolved);
      writeStoredTheme(themeMode);
      const argmax = (window as unknown as {
        argmax?: { system?: { setTheme?: (m: ThemeMode) => Promise<unknown> } };
      }).argmax;
      if (argmax?.system?.setTheme) {
        void argmax.system.setTheme(themeMode);
      }
    };
    apply();
    if (themeMode !== "system" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => {
      animateThemeChange();
      apply();
    };
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [themeMode]);

  useEffect(() => {
    if (ideListLoadedRef.current) return;
    if (!window.argmax) return;
    ideListLoadedRef.current = true;
    void window.argmax.system
      .listDetectedIdes()
      .then((list) => setDetectedIdes(list))
      .catch((error: unknown) => {
        // Detection failure leaves detectedIdes empty and the button disables;
        // log a breadcrumb so the empty list isn't a silent fallback.
        logger.warn("renderer.launcher", "IDE detection failed", {
          error: errorMessage(error)
        });
      });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // "Ask each time" persists as a sentinel: a removed key would fall back
    // to the factory default (Cursor) on the next launch.
    window.localStorage.setItem(DEFAULT_IDE_KEY, defaultIde ?? NO_DEFAULT_IDE);
  }, [defaultIde]);

  return {
    themeMode,
    setThemeMode,
    accentId,
    setAccentId,
    fontFamily,
    setFontFamily,
    fontSize,
    setFontSize,
    chatFontSize,
    setChatFontSize,
    defaultIde,
    setDefaultIde,
    detectedIdes
  };
}
