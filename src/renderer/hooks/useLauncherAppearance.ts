import { useEffect, useRef, useState } from "react";
import {
  applyFontToDocument,
  FONT_STORAGE_KEY,
  loadFontAssets,
  readStoredFont,
  type FontFamilyId
} from "../lib/fonts.js";
import { DEFAULT_IDE_KEY, readStoredDefaultIde } from "../lib/ide.js";
import type { DetectedIde, IdeId } from "../../shared/types.js";
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
  fontFamily: FontFamilyId;
  setFontFamily: (font: FontFamilyId) => void;
  defaultIde: IdeId | null;
  setDefaultIde: (ide: IdeId | null) => void;
  detectedIdes: DetectedIde[];
} {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readStoredTheme());
  const [fontFamily, setFontFamily] = useState<FontFamilyId>(() => readStoredFont());
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
      .catch(() => {
        // Detection failure leaves detectedIdes empty; the button disables.
      });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (defaultIde === null) {
      window.localStorage.removeItem(DEFAULT_IDE_KEY);
    } else {
      window.localStorage.setItem(DEFAULT_IDE_KEY, defaultIde);
    }
  }, [defaultIde]);

  return {
    themeMode,
    setThemeMode,
    fontFamily,
    setFontFamily,
    defaultIde,
    setDefaultIde,
    detectedIdes
  };
}
