/**
 * The contract between this page and the native iPhone shell that hosts it.
 *
 * The shell loads `mobile.html?embed=1[&session=<id>]#token=<token>` once into
 * a single warm `WKWebView` and owns the chat list, the navigation stack and
 * the header; the page owns the transcript, the composer, the agent overlay
 * and the review screen. Everything they say to each other goes through the
 * two directions below.
 *
 * These types are mirrored in `ios/Argmax/Sources/Transcript/NativeMessages.swift`
 * and tabulated in `docs/plan/hybrid-native-phone.md`; a change to one is a
 * change to all three.
 */
import { logger } from "../../shared/logger.js";
import { ACCENT_OPTIONS, type AccentId } from "../lib/accent.js";
import type { ResolvedTheme } from "../lib/theme.js";
import { isUserBubbleTint, type UserBubbleTint } from "../lib/userBubbleTint.js";
import type { AttentionState, ProviderId, ReasoningEffort, SessionState } from "../../shared/types.js";
import { isDeepLinkSessionId } from "./deepLink.js";

/** `.impact(.light)` on send, `.notification(…)` for the other two. */
export type NativeHapticKind = "light" | "success" | "warning";

/** A queued follow-up, trimmed to what the native composer's compact stack
 *  draws: the text, the id its actions act on, and whether Steer is one of
 *  them — that rule reads the session and the row together
 *  (`canSteerQueuedMessage`), which the shell cannot do from this message
 *  alone. */
export interface NativeQueuedMessage {
  id: string;
  text: string;
  canSteer: boolean;
}

/** Web → native. Every message is an object with a `type` discriminant. */
export type NativeMessage =
  /** Mounted and the bridge is authenticated; native may call in. */
  | { type: "ready" }
  /** On open, and whenever any of these change for the open session. */
  | {
      type: "session";
      sessionId: string;
      title: string;
      state: SessionState;
      attention: AttentionState;
    }
  /**
   * On open, and whenever any of these change for the open session — the
   * composer's own state, so the native card can draw itself without
   * re-deriving the composer's rules (which efforts a model offers, queue vs
   * send while running).
   */
  | {
      type: "composer";
      sessionId: string;
      provider: ProviderId;
      modelId: string;
      modelLabel: string;
      effort: ReasoningEffort | null;
      efforts: ReasoningEffort[];
      queued: NativeQueuedMessage[];
      running: boolean;
    }
  /** The web asked to leave the session — its own back affordance, or Escape. */
  | { type: "back" }
  /** The review screen opened or closed, so native can hide its own bar. */
  | { type: "review"; open: boolean }
  /**
   * The peek at delegated work opened or closed. The sheet is meant to cover
   * the parent's composer, and in the shell that composer is native chrome
   * the sheet cannot reach over — so native drops its card for as long as the
   * peek is up.
   */
  | { type: "agents"; open: boolean }
  | { type: "haptic"; kind: NativeHapticKind }
  /** Bridge auth failed, or the socket has been down for more than 5s. */
  | { type: "error"; message: string };

/** Native → web, installed on `window.argmaxNative` by {@link installNativeApi}. */
export interface NativeApi {
  /** Switch the transcript in place — no reload. */
  openSession: (sessionId: string) => void;
  /** Park the pane, used when the native stack pops. */
  closeSession: () => void;
  /**
   * Open the review screen for the chat on screen — the native trailing
   * menu's "Changes". The review screen is still the page's, so the shell
   * asks for it rather than drawing one.
   */
  openReview: () => void;
  /** Follow the system appearance, overriding `argmax.theme.mode`. */
  setTheme: (mode: ResolvedTheme) => void;
  /** One of the desktop tints. */
  setAccent: (tint: AccentId) => void;
  /**
   * Whether user bubbles fill with the accent or stay a quiet gray — the
   * desktop's Appearance toggle, and the shell's, since the transcript the
   * bubbles are in is this page.
   */
  setUserBubble: (tint: UserBubbleTint) => void;
  /**
   * Hide (or restore) the page's own composer stack — field, queued lane,
   * model/effort chips — because the native shell draws its own card under
   * the web view instead. Embed mode only; the browser and the desktop
   * preview keep their composer.
   */
  setComposer: (hidden: boolean) => void;
}

declare global {
  interface Window {
    /** WebKit's script-message bridge; absent in every browser but the shell's. */
    webkit?: {
      messageHandlers?: {
        argmax?: { postMessage: (message: NativeMessage) => void };
      };
    };
    argmaxNative?: NativeApi;
  }
}

/**
 * `embed=1` says the native shell is the chrome. Unlike `?session=`, it is
 * never scrubbed: `importChunk` reloads the page when a chunk hash it holds
 * has gone missing, and that reload has to come back embedded.
 *
 * Read straight from the URL rather than cached, so a test can flip it; the
 * app pins the answer at mount, which is the only time it can change.
 */
export function isEmbedded(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("embed") === "1";
}

/**
 * Send one message to the shell. A no-op everywhere else — Safari, the
 * desktop preview, tests — so callers never have to ask where they are.
 */
export function postToNative(message: NativeMessage): void {
  if (typeof window === "undefined") return;
  window.webkit?.messageHandlers?.argmax?.postMessage(message);
}

const ACCENT_IDS = new Set<string>(ACCENT_OPTIONS.map((option) => option.id));

/**
 * Define `window.argmaxNative` and return the uninstall.
 *
 * Native calls these through `evaluateJavaScript`, so the arguments arrive as
 * whatever the Swift side stringified — validated here rather than trusted,
 * and a bad value is logged and dropped rather than half-applied.
 */
export function installNativeApi(handlers: NativeApi): () => void {
  if (typeof window === "undefined") return () => {};
  window.argmaxNative = {
    openSession: (sessionId: string) => {
      if (!isDeepLinkSessionId(sessionId)) {
        logger.error("renderer.native-host", "openSession: not a session id", { sessionId });
        return;
      }
      handlers.openSession(sessionId);
    },
    closeSession: () => handlers.closeSession(),
    openReview: () => handlers.openReview(),
    setTheme: (mode: ResolvedTheme) => {
      if (mode !== "light" && mode !== "dark") {
        logger.error("renderer.native-host", "setTheme: not a theme", { mode });
        return;
      }
      handlers.setTheme(mode);
    },
    setAccent: (tint: AccentId) => {
      if (!ACCENT_IDS.has(tint)) {
        logger.error("renderer.native-host", "setAccent: not an accent tint", { tint });
        return;
      }
      handlers.setAccent(tint);
    },
    setUserBubble: (tint: UserBubbleTint) => {
      if (!isUserBubbleTint(tint)) {
        logger.error("renderer.native-host", "setUserBubble: not a bubble tint", { tint });
        return;
      }
      handlers.setUserBubble(tint);
    },
    setComposer: (hidden: boolean) => {
      if (typeof hidden !== "boolean") {
        logger.error("renderer.native-host", "setComposer: not a boolean", { hidden });
        return;
      }
      handlers.setComposer(hidden);
    }
  };
  return () => {
    delete window.argmaxNative;
  };
}
