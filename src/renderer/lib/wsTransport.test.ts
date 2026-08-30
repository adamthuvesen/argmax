// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWsTransport, subscribeRemoteConnection } from "./wsTransport.js";
import type {
  ConnectRemote,
  RemoteConnectionState,
  RemoteSocket,
  RemoteSocketHandlers
} from "./wsTransport.js";

const TOKEN_KEY = "argmax.remote.token";
/** Backoff cap: advancing past it fires whichever delay was scheduled. */
const MAX_BACKOFF_MS = 8_000;
/** Heartbeat cadence and pong deadline, mirroring the transport's constants. */
const HEARTBEAT_MS = 20_000;
const PONG_TIMEOUT_MS = 8_000;
/** Offline-queue deadline and ceiling, mirroring the transport's constants. */
const QUEUE_TIMEOUT_MS = 15_000;
const MAX_QUEUED_REQUESTS = 64;

class FakeSocket implements RemoteSocket {
  readonly sent: string[] = [];
  closed = false;

  constructor(
    readonly url: string,
    private readonly handlers: RemoteSocketHandlers
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose();
  }

  open(): void {
    this.handlers.onOpen();
  }

  deliver(frame: unknown): void {
    this.handlers.onMessage(JSON.stringify(frame));
  }

  /** Authed socket: open, then accept the token the client sends. */
  authenticate(): void {
    this.open();
    this.deliver({ type: "auth-ok" });
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  requests(): Record<string, unknown>[] {
    return this.frames().filter((frame) => frame.type === "request");
  }

  pings(): Record<string, unknown>[] {
    return this.frames().filter((frame) => frame.type === "ping");
  }
}

function fakeTransportSeam(): { connect: ConnectRemote; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const connect: ConnectRemote = (url, handlers) => {
    const socket = new FakeSocket(url, handlers);
    sockets.push(socket);
    return socket;
  };
  return { connect, sockets };
}

describe("wsTransport", () => {
  // Connection state is module-level (the transport is a page singleton), so
  // every subscription is dropped between tests.
  const subscriptions: Array<() => void> = [];

  function recordConnectionStates(): RemoteConnectionState[] {
    const states: RemoteConnectionState[] = [];
    subscriptions.push(subscribeRemoteConnection((state) => states.push(state)));
    return states;
  }

  beforeEach(() => {
    window.localStorage.setItem(TOKEN_KEY, "secret-token");
  });

  afterEach(() => {
    for (const off of subscriptions.splice(0)) off();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("derives the socket URL from the page origin", () => {
    const { connect, sockets } = fakeTransportSeam();

    createWsTransport({ connect });

    expect(sockets[0].url).toBe(`ws://${window.location.host}/api/ws`);
  });

  it("holds invokes until the server accepts the token", async () => {
    const { connect, sockets } = fakeTransportSeam();
    const transport = createWsTransport({ connect });
    const socket = sockets[0];

    const pending = transport.invoke<{ ok: true }>("health:ping", {});
    expect(socket.requests()).toHaveLength(0);

    socket.open();
    expect(socket.frames()).toEqual([{ type: "auth", token: "secret-token" }]);
    expect(socket.requests()).toHaveLength(0);

    socket.deliver({ type: "auth-ok" });
    expect(socket.requests()).toEqual([
      { type: "request", id: 1, channel: "health:ping", input: {} }
    ]);

    socket.deliver({ type: "response", id: 1, ok: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("rejects a response error with the same message renderer catches read today", async () => {
    const { connect, sockets } = fakeTransportSeam();
    const transport = createWsTransport({ connect });
    const socket = sockets[0];
    socket.authenticate();

    const pending = transport.invoke("workspaces:archive", { workspaceId: "w-1" });
    socket.deliver({
      type: "response",
      id: 1,
      error: { code: "SERVICE_ERROR", sub_code: "GIT_FAILED", message: "worktree is dirty" }
    });

    await expect(pending).rejects.toThrow("worktree is dirty");
    await expect(pending).rejects.toMatchObject({ code: "SERVICE_ERROR", sub_code: "GIT_FAILED" });
  });

  it("fans event frames out to channel subscribers until they unsubscribe", () => {
    const { connect, sockets } = fakeTransportSeam();
    const transport = createWsTransport({ connect });
    const socket = sockets[0];
    const first = vi.fn();
    const second = vi.fn();

    const offFirst = transport.subscribe("dashboard:delta", first);
    transport.subscribe("dashboard:delta", second);
    transport.subscribe("terminal:data", vi.fn());
    socket.authenticate();

    socket.deliver({ type: "event", channel: "dashboard:delta", payload: { sessions: [] } });
    expect(first).toHaveBeenCalledWith({ sessions: [] });
    expect(second).toHaveBeenCalledWith({ sessions: [] });

    offFirst();
    socket.deliver({ type: "event", channel: "dashboard:delta", payload: { sessions: ["s-1"] } });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("resolves subscription readiness once the socket is authed", async () => {
    const { connect, sockets } = fakeTransportSeam();
    const transport = createWsTransport({ connect });
    const off = transport.subscribe("terminal:data", vi.fn());
    let ready = false;
    void off.ready?.then(() => {
      ready = true;
    });

    await Promise.resolve();
    expect(ready).toBe(false);

    sockets[0].authenticate();
    await Promise.resolve();
    expect(ready).toBe(true);
  });

  it("fails in-flight requests on a drop and flushes queued ones after re-auth", async () => {
    vi.useFakeTimers();
    const { connect, sockets } = fakeTransportSeam();
    const transport = createWsTransport({ connect });
    const states = recordConnectionStates();
    const first = sockets[0];
    first.authenticate();

    const inFlight = transport.invoke("session:events-since", { sessionId: "s-1" });
    expect(first.requests()).toHaveLength(1);

    first.close();
    await expect(inFlight).rejects.toThrow("Argmax remote connection lost");

    // Queued while offline: never sent, so it survives the reconnect.
    const queued = transport.invoke("health:ping", {});
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS);
    expect(sockets).toHaveLength(2);
    const second = sockets[1];
    second.authenticate();

    expect(second.frames()[0]).toEqual({ type: "auth", token: "secret-token" });
    expect(second.requests()).toEqual([
      { type: "request", id: 2, channel: "health:ping", input: {} }
    ]);

    second.deliver({ type: "response", id: 2, ok: { ok: true, timestamp: "2026-08-28T00:00:00Z" } });
    await expect(queued).resolves.toEqual({ ok: true, timestamp: "2026-08-28T00:00:00Z" });
    expect(states.map((state) => state.status)).toEqual([
      "connecting",
      "connected",
      "offline",
      "connecting",
      "connected"
    ]);
  });

  it("pings on the heartbeat interval once the socket is authed", () => {
    vi.useFakeTimers();
    const { connect, sockets } = fakeTransportSeam();
    createWsTransport({ connect });
    const socket = sockets[0];
    socket.authenticate();
    expect(socket.pings()).toHaveLength(0);

    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(socket.pings()).toEqual([{ type: "ping" }]);

    socket.deliver({ type: "pong" });
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(socket.pings()).toHaveLength(2);
    expect(socket.closed).toBe(false);
  });

  it("drops a socket that never answers a ping and reconnects", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { connect, sockets } = fakeTransportSeam();
    createWsTransport({ connect });
    const socket = sockets[0];
    socket.authenticate();

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(socket.pings()).toHaveLength(1);
    expect(socket.closed).toBe(false);

    // A phone whose NAT mapping died leaves the socket looking open forever;
    // only the missing pong reveals it.
    await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS);
    expect(socket.closed).toBe(true);
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS);
    expect(sockets).toHaveLength(2);
    sockets[1].authenticate();
    expect(sockets[1].frames()[0]).toEqual({ type: "auth", token: "secret-token" });
  });

  it("flags a reconnect as needing a resync, and a first connect as not", async () => {
    vi.useFakeTimers();
    const { connect, sockets } = fakeTransportSeam();
    createWsTransport({ connect });
    const states = recordConnectionStates();

    sockets[0].authenticate();
    expect(states).toEqual([
      { status: "connecting", resync: false },
      { status: "connected", resync: false }
    ]);

    sockets[0].close();
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS);
    sockets[1].authenticate();

    // Deltas pushed while the socket was dead are gone, so the app is told to
    // reload rather than resume.
    expect(states.at(-1)).toEqual({ status: "connected", resync: true });
  });

  it("flags a resync frame on a socket that never dropped", () => {
    const { connect, sockets } = fakeTransportSeam();
    createWsTransport({ connect });
    const states = recordConnectionStates();
    sockets[0].authenticate();

    // The host dropped events this client was too slow to read. The socket is
    // still live, so nothing else would ever tell the app its snapshot is stale.
    sockets[0].deliver({ type: "resync" });

    expect(states.at(-1)).toEqual({ status: "connected", resync: true });
  });

  it("reconnects without waiting out the backoff when the page comes back", () => {
    vi.useFakeTimers();
    const { connect, sockets } = fakeTransportSeam();
    createWsTransport({ connect });
    sockets[0].authenticate();
    sockets[0].close();
    expect(sockets).toHaveLength(1);

    document.dispatchEvent(new Event("visibilitychange"));
    expect(sockets).toHaveLength(2);

    // Foregrounding onto a socket that still looks open makes it prove it.
    sockets[1].authenticate();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sockets[1].pings()).toHaveLength(1);
  });

  it("clears a rejected token and asks for a new one on the next connect", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { connect, sockets } = fakeTransportSeam();
    const promptForToken = vi.fn(() => "fresh-token");
    createWsTransport({ connect, promptForToken });
    const socket = sockets[0];

    socket.open();
    socket.deliver({ type: "auth-error" });

    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(socket.closed).toBe(true);

    // The rejected token must not be resent forever: the reconnect prompts.
    vi.advanceTimersByTime(MAX_BACKOFF_MS);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(promptForToken).toHaveBeenCalledTimes(1);
    expect(sockets[1].frames()).toEqual([{ type: "auth", token: "fresh-token" }]);
  });

  it("parks the reconnect loop when the token prompt is dismissed, and asks again on wake", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { connect, sockets } = fakeTransportSeam();
    const promptForToken = vi.fn(() => null);
    createWsTransport({ connect, promptForToken });

    sockets[0].open();
    sockets[0].deliver({ type: "auth-error" });
    vi.advanceTimersByTime(MAX_BACKOFF_MS);

    // Second connect has no stored token left, so it asks — and is waved away.
    sockets[1].open();
    expect(promptForToken).toHaveBeenCalledTimes(1);
    sockets[1].deliver({ type: "auth-error" });

    // Backoff must not turn the dismissal into a prompt every few seconds.
    vi.advanceTimersByTime(MAX_BACKOFF_MS * 10);
    expect(sockets).toHaveLength(2);
    expect(promptForToken).toHaveBeenCalledTimes(1);

    // Foregrounding the page is a deliberate retry, so it asks once more.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sockets).toHaveLength(3);
    sockets[2].open();
    expect(promptForToken).toHaveBeenCalledTimes(2);
  });

  it("fails a queued request that waits out its deadline instead of replaying it", async () => {
    vi.useFakeTimers();
    const { connect, sockets } = fakeTransportSeam();
    const transport = createWsTransport({ connect });

    const archive = transport.invoke("workspaces:archive", { workspaceId: "w-1" });
    vi.advanceTimersByTime(QUEUE_TIMEOUT_MS);
    await expect(archive).rejects.toThrow("Argmax remote connection lost");

    // The destructive command must be gone, not waiting for the reconnect.
    sockets[0].authenticate();
    expect(sockets[0].requests()).toHaveLength(0);
  });

  it("caps the offline queue, failing the oldest request first", async () => {
    vi.useFakeTimers();
    const { connect, sockets } = fakeTransportSeam();
    const transport = createWsTransport({ connect });

    const pending = Array.from({ length: MAX_QUEUED_REQUESTS + 1 }, () =>
      transport.invoke("health:ping", {})
    );

    await expect(pending[0]).rejects.toThrow("Argmax remote connection lost");
    sockets[0].authenticate();
    expect(sockets[0].requests()).toHaveLength(MAX_QUEUED_REQUESTS);
  });

  it("prompts once for a missing token and persists it", () => {
    window.localStorage.removeItem(TOKEN_KEY);
    const { connect, sockets } = fakeTransportSeam();
    const promptForToken = vi.fn(() => "typed-token");

    createWsTransport({ connect, promptForToken });
    sockets[0].open();

    expect(promptForToken).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe("typed-token");
    expect(sockets[0].frames()).toEqual([{ type: "auth", token: "typed-token" }]);
  });
});
