import readChannels from "../../shared/remoteReadChannels.json";
import { uuidV4 } from "./uuid.js";

const CLIENT_KEY = "argmax.remote.clientId";
const OPERATIONS_KEY = "argmax.remote.unresolvedOperations";
const reads = new Set<string>(readChannels);

export interface RemoteOperation {
  clientId: string;
  operationId: string;
}

interface UnresolvedOperation {
  request: string;
  identity: RemoteOperation;
  sent?: boolean;
  owner: string;
  uncertain?: boolean;
  hostInterrupted?: boolean;
}

function readUnresolved(): UnresolvedOperation[] {
  const raw = sessionStorage.getItem(OPERATIONS_KEY);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("request" in entry) || !("identity" in entry)) return false;
    const identity = entry.identity;
    return typeof entry.request === "string" && "owner" in entry && typeof entry.owner === "string"
      && identity !== null && typeof identity === "object"
      && "clientId" in identity && typeof identity.clientId === "string"
      && "operationId" in identity && typeof identity.operationId === "string";
  })) throw new Error("Cannot read unresolved remote actions. Check the host before clearing browser storage.");
  return parsed as UnresolvedOperation[];
}

/** Reuse an uncertain action after reconnect or page reload. Settled actions
 * are removed, so a later intentional send gets a fresh identity. */
export function prepareRemoteOperation(channel: string, input: unknown, owner: string): RemoteOperation | undefined {
  if (reads.has(channel)) return undefined;
  const request = JSON.stringify([channel, input]);
  const unresolved = readUnresolved();
  const existing = unresolved.find((entry) => entry.request === request && (entry.uncertain || entry.owner !== owner));
  if (existing) {
    if (existing.hostInterrupted) {
      const retry = window.confirm("The host stopped before confirming the previous action. It may already have happened. After checking the chat or workspace, run it again as a new action?");
      if (!retry) throw new Error("Action left unconfirmed. Nothing new was sent.");
      unresolved.splice(unresolved.indexOf(existing), 1);
    } else {
      existing.owner = owner;
      existing.uncertain = false;
      sessionStorage.setItem(OPERATIONS_KEY, JSON.stringify(unresolved));
      return existing.identity;
    }
  }
  const clientId = localStorage.getItem(CLIENT_KEY) ?? uuidV4();
  localStorage.setItem(CLIENT_KEY, clientId);
  const identity = { clientId, operationId: uuidV4() };
  // Persist before any socket send. A storage failure must not dispatch an
  // action whose identity would disappear when the phone reloads.
  unresolved.push({ request, identity, owner });
  sessionStorage.setItem(OPERATIONS_KEY, JSON.stringify(unresolved));
  return identity;
}

export function settleRemoteOperation(operation: RemoteOperation): void {
  const remaining = readUnresolved().filter((entry) => entry.identity.operationId !== operation.operationId);
  sessionStorage.setItem(OPERATIONS_KEY, JSON.stringify(remaining));
}

export function remoteOperationWasSent(operation: RemoteOperation): boolean {
  return readUnresolved().some((entry) => entry.identity.operationId === operation.operationId && entry.sent === true);
}

export function markRemoteOperationSent(operation: RemoteOperation): void {
  const unresolved = readUnresolved();
  const entry = unresolved.find((entry) => entry.identity.operationId === operation.operationId);
  if (!entry) throw new Error("Remote action identity was lost before sending. Reload before trying again.");
  entry.sent = true;
  sessionStorage.setItem(OPERATIONS_KEY, JSON.stringify(unresolved));
}

export function markRemoteOperationUncertain(operation: RemoteOperation, hostInterrupted = false): void {
  const unresolved = readUnresolved();
  const entry = unresolved.find((entry) => entry.identity.operationId === operation.operationId);
  if (!entry) return;
  entry.uncertain = true;
  entry.hostInterrupted ||= hostInterrupted;
  sessionStorage.setItem(OPERATIONS_KEY, JSON.stringify(unresolved));
}

export const createRemoteOperationOwner = uuidV4;
