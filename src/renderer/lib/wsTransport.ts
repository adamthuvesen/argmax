/**
 * Remote bridge transport: the same `window.argmax` surface, served over one
 * WebSocket to the Rust host instead of Tauri IPC.
 *
 * Wire protocol (mirrored by the Rust `/api/ws` handler):
 *
 * - client → `{ type: "auth", token }` on every open; the socket is not ready
 *   until the server answers `{ type: "auth-ok" }`.
 * - client → `{ type: "request", id, channel, input }`;
 *   server → `{ type: "response", id, ok }` or `{ type: "response", id, error }`.
 * - client → `{ type: "ping" }`; server → `{ type: "pong" }`. An app-level
 *   heartbeat, because a phone's radios drop the NAT mapping without ever
 *   closing the socket and the browser's own ping frames are invisible to JS.
 * - server → `{ type: "event", channel, payload }` for push channels. There is
 *   no subscribe frame: the server pushes to every authed client, so
 *   `subscribe()` only registers locally and resubscription after a reconnect
 *   is implicit.
 * - server → `{ type: "resync" }` when this client fell behind the event stream
 *   and the host dropped frames for it. The socket stays open, so this is the
 *   only signal that the snapshot is now stale.
 */

import type { IpcChannel } from "../../shared/ipcSchemas.js";
import type { EventSubscription } from "../../shared/types.js";
import type { BridgeTransport } from "./tauriBridge.js";
import { errorMessage } from "../../shared/error.js";
import { logger } from "../../shared/logger.js";

const TOKEN_KEY = "argmax.remote.token";
const MIN_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 8_000;
/** Keepalive cadence while the socket is open and authed. */
const HEARTBEAT_MS = 20_000;
/** No answer by then and the socket is a corpse, whatever `readyState` says. */
const PONG_TIMEOUT_MS = 8_000;

/**
 * How long a request may sit unsent before it fails. A queued command replayed
 * minutes later is worse than one that failed: the user tapped Archive on a
 * dead socket, saw nothing happen, and moved on — the worktree must not be
 * deleted when the phone finds the network again.
 */
const QUEUE_TIMEOUT_MS = 15_000;
/** Ceiling on the offline queue; the oldest entries fail first. */
const MAX_QUEUED_REQUESTS = 64;

const PING_FRAME = JSON.stringify({ type: "ping" });

/**
 * Rejection message for requests whose socket died before the answer arrived.
 * Backgrounding the phone kills the socket on every app switch, so toast
 * surfaces match on this and stay quiet — the connection banner already covers
 * it, and the transport reconnects on its own.
 */
export const REMOTE_CONNECTION_LOST_MESSAGE = "Argmax remote connection lost";

/** The socket handle the transport drives; the browser `WebSocket` is wrapped. */
export interface RemoteSocket {
  send(data: string): void;
  close(): void;
}

export interface RemoteSocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(): void;
}

export type ConnectRemote = (url: string, handlers: RemoteSocketHandlers) => RemoteSocket;

export interface WsTransportOptions {
  /** Defaults to `ws(s)://<host>/api/ws` for the page's own origin. */
  url?: string;
  /** Seam for tests; defaults to a real `WebSocket`. */
  connect?: ConnectRemote;
  /** Seam for tests; defaults to `window.prompt`. */
  promptForToken?: () => string | null;
}

export type RemoteConnectionStatus = "connecting" | "connected" | "offline";

export interface RemoteConnectionState {
  status: RemoteConnectionStatus;
  /**
   * A reconnect that follows an earlier successful auth. Pushed events are
   * fire-and-forget, so every delta the socket missed while it was dead is
   * gone for good and the app has to reload instead of resuming.
   */
  resync: boolean;
}

/**
 * Module-level because the transport is a page singleton owned by
 * `tauriBridge`, and the UI that renders the state (the mobile banner) never
 * sees the transport object. Runtimes without a remote bridge — Tauri, the
 * browser preview — never call `createWsTransport`, so they stay parked on the
 * initial "connected" and the banner never shows.
 */
let connectionState: RemoteConnectionState = { status: "connected", resync: false };
const connectionListeners = new Set<(state: RemoteConnectionState) => void>();

/** Current state is replayed on subscribe, so late subscribers are not blind. */
export function subscribeRemoteConnection(
  listener: (state: RemoteConnectionState) => void
): () => void {
  connectionListeners.add(listener);
  listener(connectionState);
  return () => {
    connectionListeners.delete(listener);
  };
}

function publishConnection(state: RemoteConnectionState): void {
  connectionState = state;
  for (const listener of [...connectionListeners]) listener(state);
}

interface PendingRequest {
  id: number;
  frame: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  /** Deadline while the request waits in `queued`; cleared once it is sent. */
  queueTimer: ReturnType<typeof setTimeout> | null;
}

function connectBrowserSocket(url: string, handlers: RemoteSocketHandlers): RemoteSocket {
  const socket = new WebSocket(url);
  socket.onopen = () => handlers.onOpen();
  socket.onmessage = (event: MessageEvent<string>) => handlers.onMessage(String(event.data));
  socket.onclose = () => handlers.onClose();
  // A browser socket always fires `close` after `error`, so the reconnect path
  // is driven from `onclose` alone.
  socket.onerror = () => undefined;
  return {
    send: (data: string) => socket.send(data),
    close: () => socket.close()
  };
}

function defaultRemoteUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/api/ws`;
}

function asFrame(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Rebuild the rejection Tauri's `invoke` would produce. `errorMessage()` is the
 * one extraction every renderer catch path uses, and the serialized
 * `ArgmaxError` fields (`code`, `sub_code`, `issues`) ride along so branching
 * on them keeps working.
 */
function remoteFailure(payload: unknown): Error {
  const failure = new Error(errorMessage(payload));
  const fields = asFrame(payload);
  if (fields) Object.assign(failure, fields, { message: failure.message });
  return failure;
}

export function createWsTransport(options: WsTransportOptions = {}): BridgeTransport {
  const connect = options.connect ?? connectBrowserSocket;
  const url = options.url ?? defaultRemoteUrl();
  const promptForToken = options.promptForToken ?? (() => window.prompt("Argmax remote token"));

  const queued: PendingRequest[] = [];
  const inFlight = new Map<number, PendingRequest>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  let socket: RemoteSocket | null = null;
  let generation = 0;
  let authed = false;
  let attempt = 0;
  let authCount = 0;
  let nextRequestId = 1;
  let token: string | null = null;
  let tokenResolved = false;
  let tokenPromptDismissed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let pongDeadline: ReturnType<typeof setTimeout> | null = null;

  let markAuthed: () => void = () => undefined;
  const authedOnce = new Promise<void>((resolve) => {
    markAuthed = resolve;
  });

  /**
   * Read the token once per page — pairing-URL fragment first (the Settings
   * QR code encodes `#token=…`; fragments never leave the browser), then
   * storage, then a prompt. A resolved token is reused across reconnects, so
   * backoff churn never turns into a prompt storm; a rejected one is dropped
   * from storage AND memory so the next connect asks again instead of
   * resending what the server just refused.
   *
   * Dismissing the prompt parks the reconnect loop (see `handleClose`) rather
   * than asking again on every backoff tick. The next deliberate wake —
   * foregrounding the page, the network returning — asks once more.
   */
  function resolveToken(): string {
    if (tokenResolved) return token ?? "";
    const paired = readPairingToken();
    if (paired) {
      window.localStorage.setItem(TOKEN_KEY, paired);
      tokenResolved = true;
      token = paired;
      return token;
    }
    const stored = window.localStorage.getItem(TOKEN_KEY);
    if (stored) {
      tokenResolved = true;
      token = stored;
      return token;
    }
    const entered = promptForToken();
    if (entered) {
      window.localStorage.setItem(TOKEN_KEY, entered);
      tokenResolved = true;
      tokenPromptDismissed = false;
      token = entered;
      return token;
    }
    tokenPromptDismissed = true;
    token = null;
    return "";
  }

  /** Pull `#token=…` from the URL and scrub it from the address bar. */
  function readPairingToken(): string | null {
    const match = /(?:^#|&)token=([0-9a-f]{32})(?:&|$)/.exec(window.location.hash);
    if (!match) return null;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    return match[1];
  }

  function clearQueueTimer(request: PendingRequest): void {
    if (request.queueTimer !== null) clearTimeout(request.queueTimer);
    request.queueTimer = null;
  }

  /** Fail a request that never left the queue, with the message the mobile
   *  toasts already treat as "the banner covers this". */
  function failQueued(request: PendingRequest): void {
    clearQueueTimer(request);
    request.reject(new Error(REMOTE_CONNECTION_LOST_MESSAGE));
  }

  function expireQueued(request: PendingRequest): void {
    const index = queued.indexOf(request);
    if (index === -1) return;
    queued.splice(index, 1);
    failQueued(request);
  }

  function flushQueue(): void {
    while (authed && socket && queued.length > 0) {
      const request = queued.shift();
      if (!request) return;
      clearQueueTimer(request);
      inFlight.set(request.id, request);
      socket.send(request.frame);
    }
  }

  function settleResponse(frame: Record<string, unknown>): void {
    const id = frame.id;
    if (typeof id !== "number") {
      logger.error("renderer.remote-bridge", "response frame without a numeric id", { url });
      return;
    }
    const request = inFlight.get(id);
    if (!request) {
      logger.warn("renderer.remote-bridge", "response for an unknown request", { id });
      return;
    }
    inFlight.delete(id);
    if ("error" in frame) {
      request.reject(remoteFailure(frame.error));
      return;
    }
    request.resolve(frame.ok);
  }

  function dispatchEvent(frame: Record<string, unknown>): void {
    const channel = frame.channel;
    if (typeof channel !== "string") {
      logger.error("renderer.remote-bridge", "event frame without a channel", { url });
      return;
    }
    const channelListeners = listeners.get(channel);
    if (!channelListeners) return;
    for (const listener of [...channelListeners]) listener(frame.payload);
  }

  function handleAuthRejected(): void {
    window.localStorage.removeItem(TOKEN_KEY);
    // Forget it in memory too. Leaving it resolved made every reconnect resend
    // the token the server just refused, forever, with no way back to a prompt.
    token = null;
    tokenResolved = false;
    logger.error("renderer.remote-bridge", "remote token rejected", { url });
    socket?.close();
  }

  function handleMessage(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      logger.error("renderer.remote-bridge", "unparsable frame", { error: errorMessage(error) });
      return;
    }
    const frame = asFrame(parsed);
    if (!frame) {
      logger.error("renderer.remote-bridge", "frame is not an object", { url });
      return;
    }
    switch (frame.type) {
      case "auth-ok":
        authed = true;
        attempt = 0;
        authCount += 1;
        markAuthed();
        startHeartbeat();
        publishConnection({ status: "connected", resync: authCount > 1 });
        flushQueue();
        return;
      case "auth-error":
        handleAuthRejected();
        return;
      case "pong":
        clearPongDeadline();
        return;
      // The host dropped events this client was too slow to read. The socket is
      // still live, so nothing else would ever flag the gap.
      case "resync":
        publishConnection({ status: "connected", resync: true });
        return;
      case "response":
        settleResponse(frame);
        return;
      case "event":
        dispatchEvent(frame);
        return;
      default:
        logger.warn("renderer.remote-bridge", "unknown frame type", { type: String(frame.type) });
    }
  }

  function handleClose(): void {
    authed = false;
    socket = null;
    stopHeartbeat();
    // Queued requests ride the reconnect, but only until their own deadline —
    // a command that lands after the user gave up on it is not a recovery.
    // In-flight ones lost their answer and have to fail now.
    for (const request of inFlight.values()) {
      request.reject(new Error(REMOTE_CONNECTION_LOST_MESSAGE));
    }
    inFlight.clear();
    publishConnection({ status: "offline", resync: false });
    // The server rejected the token and the user waved the prompt away.
    // Reconnecting would only ask again every few seconds; wait for a wake.
    if (tokenPromptDismissed) return;
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    const base = Math.min(MIN_RECONNECT_MS * 2 ** attempt, MAX_RECONNECT_MS);
    attempt += 1;
    const delay = base * (0.5 + Math.random() * 0.5);
    clearReconnectTimer();
    reconnectTimer = setTimeout(openSocket, delay);
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    heartbeat = setInterval(sendPing, HEARTBEAT_MS);
  }

  function stopHeartbeat(): void {
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = null;
    clearPongDeadline();
  }

  function clearPongDeadline(): void {
    if (pongDeadline !== null) clearTimeout(pongDeadline);
    pongDeadline = null;
  }

  function sendPing(): void {
    if (!authed || !socket) return;
    socket.send(PING_FRAME);
    // One deadline at a time: a wake ping that lands mid-flight rides the
    // deadline already running rather than pushing it out.
    if (pongDeadline !== null) return;
    pongDeadline = setTimeout(dropSilentSocket, PONG_TIMEOUT_MS);
  }

  /**
   * A socket the network killed without telling the browser never fires
   * `close`, so nothing else would ever start the reconnect. Close it, and
   * count it closed now: the late `close` this may still fire belongs to a
   * generation nobody listens to any more.
   */
  function dropSilentSocket(): void {
    pongDeadline = null;
    logger.warn("renderer.remote-bridge", "no pong before the deadline; dropping the socket", { url });
    const dead = socket;
    generation += 1;
    dead?.close();
    handleClose();
  }

  /**
   * A phone that slept or hopped from Wi-Fi to 5G comes back holding a socket
   * the network already threw away. Foregrounding is the cue to either
   * reconnect now — no backoff, the user is looking at the screen — or make
   * the socket prove it still answers.
   */
  function handleWake(): void {
    if (socket) {
      sendPing();
      return;
    }
    attempt = 0;
    openSocket();
  }

  function openSocket(): void {
    clearReconnectTimer();
    publishConnection({ status: "connecting", resync: false });
    const mine = ++generation;
    const current = connect(url, {
      onOpen: () => {
        if (mine !== generation) return;
        current.send(JSON.stringify({ type: "auth", token: resolveToken() }));
      },
      onMessage: (data: string) => {
        if (mine !== generation) return;
        handleMessage(data);
      },
      onClose: () => {
        if (mine !== generation) return;
        handleClose();
      }
    });
    socket = current;
  }

  function invoke<T>(channel: IpcChannel, input: unknown = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = nextRequestId++;
      const request: PendingRequest = {
        id,
        frame: JSON.stringify({ type: "request", id, channel, input }),
        resolve: (value: unknown) => resolve(value as T),
        reject,
        queueTimer: null
      };
      request.queueTimer = setTimeout(() => expireQueued(request), QUEUE_TIMEOUT_MS);
      queued.push(request);
      // A phone held against a dead socket keeps issuing calls; drop the
      // oldest, which are the least likely to still be what the user wants.
      while (queued.length > MAX_QUEUED_REQUESTS) {
        const dropped = queued.shift();
        if (dropped) failQueued(dropped);
      }
      flushQueue();
    });
  }

  function subscribe<T>(channel: string, listener: (payload: T) => void): EventSubscription {
    // Payloads are host-typed per channel exactly as with Tauri's `listen`.
    const erased = listener as (payload: unknown) => void;
    let channelListeners = listeners.get(channel);
    if (!channelListeners) {
      channelListeners = new Set();
      listeners.set(channel, channelListeners);
    }
    channelListeners.add(erased);

    const off = (): void => {
      const registered = listeners.get(channel);
      if (!registered) return;
      registered.delete(erased);
      if (registered.size === 0) listeners.delete(channel);
    };
    off.ready = authedOnce;
    return off;
  }

  window.addEventListener("online", handleWake);
  document.addEventListener("visibilitychange", () => {
    // iOS Safari fires this when a home-screen app foregrounds; it is the only
    // reliable wake signal a PWA gets.
    if (document.visibilityState === "visible") handleWake();
  });

  openSocket();

  return { invoke, subscribe };
}
