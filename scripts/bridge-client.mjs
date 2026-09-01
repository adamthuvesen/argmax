// WebSocket client for the remote bridge (protocol: docs/remote.md).
//
// The bridge speaks JSON frames over `ws://127.0.0.1:<port>/api/ws` and maps
// requests onto the same `*_impl` handlers the desktop IPC uses, which makes
// it the scriptable surface for driving a live Argmax instance: launch real
// sessions, read timelines, pull the debug snapshot. `scripts/bridge.mjs` is
// the CLI over this module; `scripts/scratch-app.mjs` uses it as the boot
// readiness probe.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Read `remote.json` from an app data dir. Throws if missing or disabled. */
export function readBridgeConfig(dataDir) {
  const configPath = path.join(dataDir, "remote.json");
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    throw new Error(`no remote.json at ${configPath} — is this an Argmax data dir?`);
  }
  const config = JSON.parse(raw);
  if (!config.enabled) {
    throw new Error(`remote bridge is disabled in ${configPath} (set "enabled": true and restart the app)`);
  }
  if (typeof config.port !== "number" || typeof config.token !== "string") {
    throw new Error(`remote.json at ${configPath} is missing port/token`);
  }
  return { port: config.port, token: config.token };
}

/** The running desktop app's own profile (identifier com.argmax.rs). */
export function realProfileDataDir() {
  return path.join(homedir(), "Library", "Application Support", "com.argmax.rs");
}

/**
 * Connect and authenticate. Resolves to a handle:
 *   call(channel, input)  → response payload (rejects on bridge error)
 *   onEvent(fn)           → fn({channel, payload}) for every pushed event
 *   close()
 */
export function connectBridge({ port, token, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    const pending = new Map();
    const eventListeners = new Set();
    let nextId = 1;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.close();
        reject(new Error(`bridge did not answer within ${timeoutMs}ms on port ${port}`));
      }
    }, timeoutMs);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "auth", token }));
    });
    socket.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`could not connect to ws://127.0.0.1:${port}/api/ws`));
      }
    });
    socket.addEventListener("close", () => {
      const error = new Error("bridge connection closed");
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    socket.addEventListener("message", (message) => {
      let frame;
      try {
        frame = JSON.parse(String(message.data));
      } catch {
        return;
      }
      switch (frame.type) {
        case "auth-ok": {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            call(channel, input = {}) {
              return new Promise((resolveCall, rejectCall) => {
                const id = nextId++;
                pending.set(id, { resolve: resolveCall, reject: rejectCall });
                socket.send(JSON.stringify({ type: "request", id, channel, input }));
              });
            },
            onEvent(listener) {
              eventListeners.add(listener);
              return () => eventListeners.delete(listener);
            },
            close() {
              socket.close();
            }
          });
          return;
        }
        case "auth-error": {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.close();
          reject(new Error("bridge rejected the token — the app may have rotated it; re-read remote.json"));
          return;
        }
        case "response": {
          const entry = pending.get(frame.id);
          if (!entry) return;
          pending.delete(frame.id);
          if ("error" in frame) {
            const detail = typeof frame.error === "object" ? JSON.stringify(frame.error) : String(frame.error);
            entry.reject(new Error(`${detail}`));
          } else {
            entry.resolve(frame.ok);
          }
          return;
        }
        case "event": {
          for (const listener of eventListeners) listener({ channel: frame.channel, payload: frame.payload });
          return;
        }
        case "ping": {
          socket.send(JSON.stringify({ type: "pong" }));
          return;
        }
        default:
      }
    });
  });
}
