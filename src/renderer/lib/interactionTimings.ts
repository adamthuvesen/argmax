import { useLayoutEffect, useRef } from "react";
import { registerPerfSource } from "./perfRegistry.js";

/**
 * Interaction timing for the latency program. `beginInteraction` stamps the
 * input, `shown()` stamps the frame that holds the target content, and the
 * paint is the frame after it (double rAF). Times in a record are milliseconds
 * after `start`, which is `performance.now()`.
 *
 * `settled` is an approximation, kept for comparing before and after: the last
 * moment of DOM mutation or IPC completion, once no IPC call is in flight and
 * 150 ms have passed with neither. Only IPC calls started since the
 * interaction began hold it open; calls already in flight do not. Calls from
 * unrelated work that starts during it still count.
 */

export type InteractionDetail = Record<string, string | number | boolean>;

export interface InteractionRecord {
  name: string;
  detail?: InteractionDetail;
  start: number;
  shownMs?: number;
  paintedMs?: number;
  settledMs?: number;
  /** IPC calls started between the input and the settle. */
  ipcCalls: number;
  /** Painted, but the IPC or DOM activity never went quiet. */
  timedOut?: boolean;
}

export interface InteractionHandle {
  shown(): void;
}

const RING_SIZE = 200;
const QUIET_MS = 150;
const GIVE_UP_MS = 10_000;

interface ActiveInteraction {
  record: InteractionRecord;
  target?: string;
  ipcBase: number;
}

const ring: InteractionRecord[] = [];
const active: ActiveInteraction[] = [];
const pendingByName = new Map<string, ActiveInteraction>();
const visited = new Set<string>();
let ipcStarted = 0;
/** Sequence numbers of IPC calls still in flight, comparable to `ipcBase`. */
const ipcInflight = new Set<number>();
let lastActivity = 0;
let checkTimer: ReturnType<typeof setTimeout> | null = null;
let observer: MutationObserver | null = null;

function now(): number {
  return performance.now();
}

function nextFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(callback);
  else setTimeout(callback, 16);
}

function emitMeasure(record: InteractionRecord, end: number): void {
  try {
    performance.measure(`argmax:${record.name}`, {
      start: record.start,
      end,
      detail: { ...record.detail, shownMs: record.shownMs, settledMs: record.settledMs },
    });
  } catch {
    // Older WebKit rejects the options form; the ring still has the record.
  }
}

// The document-wide observer costs a record per streamed token, so it runs
// only while an interaction is active.
function remove(entry: ActiveInteraction): void {
  const index = active.indexOf(entry);
  if (index >= 0) active.splice(index, 1);
  if (pendingByName.get(entry.record.name) === entry) pendingByName.delete(entry.record.name);
  if (active.length === 0) {
    observer?.disconnect();
    observer = null;
  }
}

function inflightSince(base: number): boolean {
  for (const id of ipcInflight) if (id >= base) return true;
  return false;
}

function finish(entry: ActiveInteraction): void {
  remove(entry);
  const { record } = entry;
  record.ipcCalls = ipcStarted - entry.ipcBase;
  ring.push(record);
  if (ring.length > RING_SIZE) ring.shift();
  emitMeasure(record, record.start + (record.paintedMs ?? record.shownMs ?? 0));
}

function check(): void {
  checkTimer = null;
  const t = now();
  for (const entry of [...active]) {
    const { record } = entry;
    if (t - record.start > GIVE_UP_MS) {
      // Never shown: the input changed nothing on screen, so there is nothing to report.
      if (record.shownMs === undefined) {
        remove(entry);
      } else {
        record.timedOut = true;
        finish(entry);
      }
    }
  }
  if (active.length === 0) return;
  if (t - lastActivity >= QUIET_MS) {
    for (const entry of [...active]) {
      const { record } = entry;
      if (record.paintedMs === undefined || inflightSince(entry.ipcBase)) continue;
      record.settledMs = Math.max(lastActivity - record.start, record.paintedMs);
      finish(entry);
    }
  }
  if (active.length > 0) scheduleCheck(Math.max(QUIET_MS - (now() - lastActivity), 50));
}

function scheduleCheck(delay: number): void {
  if (checkTimer === null) checkTimer = setTimeout(check, delay);
}

function touch(): void {
  lastActivity = now();
  if (active.length > 0) scheduleCheck(QUIET_MS);
}

export function beginInteraction(name: string, detail?: InteractionDetail): InteractionHandle {
  const { target, ...rest } = detail ?? {};
  const record: InteractionRecord = {
    name,
    detail: Object.keys(rest).length > 0 ? rest : undefined,
    start: now(),
    ipcCalls: 0,
  };
  const entry: ActiveInteraction = {
    record,
    target: typeof target === "string" ? target : undefined,
    ipcBase: ipcStarted,
  };
  const superseded = pendingByName.get(name);
  if (superseded && superseded.record.shownMs === undefined) remove(superseded);
  pendingByName.set(name, entry);
  active.push(entry);
  if (!observer && typeof MutationObserver === "function") {
    observer = new MutationObserver(touch);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
  }
  touch();
  return { shown: () => markShown(entry) };
}

function markShown(entry: ActiveInteraction): void {
  const { record } = entry;
  if (record.shownMs !== undefined || !active.includes(entry)) return;
  if (pendingByName.get(record.name) === entry) pendingByName.delete(record.name);
  record.shownMs = now() - record.start;
  touch();
  nextFrame(() =>
    nextFrame(() => {
      record.paintedMs = now() - record.start;
      touch();
    }),
  );
}

/**
 * Marks the latest `name` interaction shown. For call sites far from the one
 * that began it. With a `target`, only an interaction begun for that target
 * matches, so another pane's render cannot claim it.
 */
export function markInteractionShown(name: string, target?: string): void {
  const entry = pendingByName.get(name);
  if (!entry) return;
  if (entry.target !== undefined && entry.target !== target) return;
  markShown(entry);
}

/** Call in a component whose commit contains the target content. */
export function useInteractionShown(name: string, ready = true, target?: string): void {
  useLayoutEffect(() => {
    if (ready) markInteractionShown(name, target);
  }, [name, ready, target]);
}

/**
 * For a surface that opens inside React, with no store to begin from: begins
 * when `open` turns true or `name` changes while open, and marks shown once
 * `ready`. The begin runs during render, a few ms after the input event.
 */
export function useOpenInteraction(name: string, open: boolean, ready = open): void {
  const begunFor = useRef<string | null>(null);
  const key = open ? name : null;
  if (key !== begunFor.current) {
    begunFor.current = key;
    if (key) beginInteraction(key);
  }
  useInteractionShown(name, open && ready);
}

/** True the first time `key` is seen, so chat switches can tell first visits from revisits. */
export function firstVisit(key: string): boolean {
  if (visited.has(key)) return false;
  visited.add(key);
  return true;
}

/** Records how long a lazy chunk took to arrive, apart from rendering it. */
export function recordChunkLoad(name: string, startedAt: number): void {
  const record: InteractionRecord = {
    name: `chunk.${name}`,
    start: startedAt,
    shownMs: now() - startedAt,
    ipcCalls: 0,
  };
  ring.push(record);
  if (ring.length > RING_SIZE) ring.shift();
  emitMeasure(record, startedAt + (record.shownMs ?? 0));
}

/** The newest records, newest first, for the Perf HUD. */
export function recentInteractions(limit: number): InteractionRecord[] {
  return ring.slice(-limit).reverse();
}

/**
 * Notes one IPC call starting, so `settled` waits for it. Returns the callback
 * for when it settles. `timeIpcCall` in ipcLatency.ts is the only caller: it
 * already wraps every request/response call at the bridge.
 */
export function noteIpcCall(): () => void {
  const id = ipcStarted;
  ipcStarted += 1;
  ipcInflight.add(id);
  return () => {
    ipcInflight.delete(id);
    touch();
  };
}

registerPerfSource(
  "interactions",
  () => ring.map((record) => ({ ...record, detail: record.detail && { ...record.detail } })),
  () => {
    ring.length = 0;
  },
);
