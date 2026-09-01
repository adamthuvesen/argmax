#!/usr/bin/env node
// CLI over the remote bridge: drive a live Argmax instance from a script.
//
// Made for verification loops — an agent (or you) launches a scratch instance
// with `scripts/scratch-app.mjs`, then uses this to run real sessions against
// the real Rust backend and read back what happened. See docs/verification.md.
//
// Usage:
//   node scripts/bridge.mjs call <channel> [input-json]
//   node scripts/bridge.mjs watch [--seconds 30]
//   node scripts/bridge.mjs logs [--after-seq N]
//   node scripts/bridge.mjs chat --repo <path> --prompt '…' [--provider claude]
//        [--worktree] [--timeout 600] [--model-id …] [--model-label …] [--effort …]
//   node scripts/bridge.mjs reply --session <id> --prompt '…' [--timeout 600]
//   node scripts/bridge.mjs terminal --workspace <id> --run '<shell command>' [--seconds 10]
//
// Connection resolution, first match wins:
//   --port <n> --token <t>        explicit
//   --data-dir <dir>              that profile's remote.json
//   $ARGMAX_DATA_DIR              same, via the environment
//   the real app profile          ~/Library/Application Support/com.argmax.rs
//
// `chat` and `reply` exit codes: 0 session complete · 2 failed/cancelled · 3 timeout.
// `reply` sends a follow-up turn to an existing session (the resume path) and
// streams it the same way. `terminal` spawns a PTY in a workspace over the
// bridge, runs one command, and reports how the output reached a remote client:
// chunk count, bytes, largest chunk — the observable side of terminal push
// conflation (docs/performance.md "Push Payloads").

import path from "node:path";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

import { connectBridge, readBridgeConfig, realProfileDataDir } from "./bridge-client.mjs";

// Mirrors PROVIDER_MODEL_DEFAULTS in src/shared/providerModels.ts. Duplicated
// because that module's import graph is not runnable under plain node;
// src/test/bridgeDefaults.test.ts fails the suite when the two drift.
export const LAUNCH_MODEL_DEFAULTS = {
  claude: { modelLabel: "Opus 5", modelId: "claude-opus-5", reasoningEffort: null },
  codex: { modelLabel: "GPT-5.6 Sol", modelId: "gpt-5.6-sol", reasoningEffort: null },
  cursor: { modelLabel: "Grok 4.6 (Cursor)", modelId: "cursor-grok-4.6-medium", reasoningEffort: null },
  opencode: { modelLabel: "GLM-5.3-Flash", modelId: "opencode-go/glm-5.3-flash", reasoningEffort: "high" },
  grok: { modelLabel: "Grok 4.6", modelId: "grok-4.6", reasoningEffort: null }
};

const TERMINAL_SESSION_STATES = new Set(["complete", "failed", "cancelled"]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Split argv into positionals and --flag value pairs (--worktree is bare). */
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  const bare = new Set(["--worktree"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
    } else if (bare.has(arg)) {
      flags[arg.slice(2)] = true;
    } else {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} requires a value`);
      flags[arg.slice(2)] = value;
    }
  }
  return { positionals, flags };
}

function resolveConnection(flags) {
  if (flags.port || flags.token) {
    if (!flags.port || !flags.token) fail("--port and --token go together");
    return { port: Number(flags.port), token: flags.token };
  }
  const dataDir = flags["data-dir"] ?? process.env.ARGMAX_DATA_DIR ?? realProfileDataDir();
  return readBridgeConfig(dataDir);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function commandCall(bridge, positionals) {
  const [channel, inputJson] = positionals;
  if (!channel) fail("usage: bridge.mjs call <channel> [input-json]");
  const input = inputJson ? JSON.parse(inputJson) : {};
  printJson(await bridge.call(channel, input));
}

async function commandWatch(bridge, flags) {
  const seconds = Number(flags.seconds ?? 30);
  bridge.onEvent((event) => console.log(JSON.stringify(event)));
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

async function commandLogs(bridge, flags) {
  const afterLogSeq = flags["after-seq"] === undefined ? null : Number(flags["after-seq"]);
  printJson(await bridge.call("system:debug-snapshot", { afterLogSeq }));
}

async function resolveProject(bridge, repoFlag) {
  const repoPath = realpathSync(path.resolve(repoFlag));
  const projects = await bridge.call("projects:list", {});
  const existing = projects.find((project) => {
    try {
      return realpathSync(project.repoPath) === repoPath;
    } catch {
      return false;
    }
  });
  if (existing) return existing;
  return bridge.call("projects:register", { repoPath });
}

async function commandChat(bridge, flags) {
  if (!flags.repo || !flags.prompt) fail("usage: bridge.mjs chat --repo <path> --prompt '…'");
  const provider = flags.provider ?? "claude";
  const defaults = LAUNCH_MODEL_DEFAULTS[provider];
  if (!defaults) fail(`unknown provider "${provider}" (${Object.keys(LAUNCH_MODEL_DEFAULTS).join(", ")})`);
  const timeoutMs = Number(flags.timeout ?? 600) * 1000;

  const project = await resolveProject(bridge, flags.repo);
  const taskLabel = flags.prompt.length > 60 ? `${flags.prompt.slice(0, 57)}…` : flags.prompt;
  const workspace = flags.worktree
    ? await bridge.call("workspaces:create-isolated", { projectId: project.id, taskLabel, baseRef: null })
    : await bridge.call("workspaces:create-current", { projectId: project.id, taskLabel });

  const startedAt = Date.now();
  const session = await bridge.call("providers:launch", {
    workspaceId: workspace.id,
    provider,
    prompt: flags.prompt,
    modelLabel: flags["model-label"] ?? defaults.modelLabel,
    modelId: flags["model-id"] ?? defaults.modelId,
    reasoningEffort: flags.effort ?? defaults.reasoningEffort,
    fastMode: false,
    agentMode: null,
    permissionMode: null,
    cols: 120,
    rows: 32,
    attachments: null
  });
  console.log(JSON.stringify({ launched: true, sessionId: session.id, workspaceId: workspace.id }));
  await followSession(bridge, { sessionId: session.id, workspaceId: workspace.id, initialState: session.state, startedAt, timeoutMs });
}

async function commandReply(bridge, flags) {
  if (!flags.session || !flags.prompt) fail("usage: bridge.mjs reply --session <id> --prompt '…'");
  const timeoutMs = Number(flags.timeout ?? 600) * 1000;
  const dashboard = await bridge.call("dashboard:list", {});
  const session = dashboard.sessions.find((entry) => entry.id === flags.session);
  if (!session) fail(`no session ${flags.session}`);
  // Only the timeline written after the send is streamed: the cursor is read
  // first so the earlier turns are not replayed.
  const before = await bridge.call("session:events-since", { sessionId: session.id, eventCursor: null, rawOutputCursor: null });
  const startedAt = Date.now();
  const sent = await bridge.call("providers:send-input", {
    sessionId: session.id,
    input: flags.prompt,
    provider: null,
    modelLabel: null,
    modelId: null,
    reasoningEffort: null,
    fastMode: false
  });
  console.log(JSON.stringify({ sent: true, queued: sent.queued, sessionId: session.id }));
  await followSession(bridge, {
    sessionId: session.id,
    workspaceId: session.workspaceId,
    initialState: "running",
    startedAt,
    timeoutMs,
    eventCursor: before.eventCursor,
    rawOutputCursor: before.rawOutputCursor
  });
}

// Stream a session's timeline as NDJSON until it reaches a terminal state,
// then print the cost summary and exit 0 / 2 / 3. State is polled from
// dashboard:list because a session's terminal transition can land after its
// last event.
async function followSession(bridge, options) {
  const { sessionId, workspaceId, startedAt, timeoutMs } = options;
  let eventCursor = options.eventCursor ?? null;
  let rawOutputCursor = options.rawOutputCursor ?? null;
  let eventCount = 0;
  let state = options.initialState;
  while (!TERMINAL_SESSION_STATES.has(state)) {
    if (Date.now() - startedAt > timeoutMs) {
      console.log(JSON.stringify({ timeout: true, sessionId, state, eventCount }));
      process.exit(3);
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
    const batch = await bridge.call("session:events-since", {
      sessionId,
      eventCursor,
      rawOutputCursor
    });
    eventCursor = batch.eventCursor;
    rawOutputCursor = batch.rawOutputCursor;
    for (const event of batch.events) {
      eventCount += 1;
      const message = event.message.length > 2000 ? `${event.message.slice(0, 2000)}…` : event.message;
      console.log(JSON.stringify({ at: event.createdAt, type: event.type, message }));
    }
    const dashboard = await bridge.call("dashboard:list", {});
    const live = dashboard.sessions.find((entry) => entry.id === sessionId);
    if (live) state = live.state;
  }

  const cost = await bridge.call("session:cost-summary", { sessionId }).catch(() => null);
  console.log(
    JSON.stringify({
      sessionId,
      workspaceId,
      state,
      eventCount,
      seconds: Math.round((Date.now() - startedAt) / 100) / 10,
      costUsd: cost?.costUsd ?? null,
      tokens: cost?.tokens ?? null
    })
  );
  process.exit(state === "complete" ? 0 : 2);
}

async function commandTerminal(bridge, flags) {
  if (!flags.workspace || !flags.run) fail("usage: bridge.mjs terminal --workspace <id> --run '<shell command>'");
  const seconds = Number(flags.seconds ?? 10);
  const chunks = [];
  let exit = null;
  let terminalId = null;
  bridge.onEvent(({ channel, payload }) => {
    if (payload?.terminalId !== terminalId) return;
    if (channel === "terminal:data") chunks.push(payload.data.length);
    else if (channel === "terminal:exit") exit = payload;
  });
  const spawned = await bridge.call("terminal:spawn", { workspaceId: flags.workspace, cols: 120, rows: 32 });
  terminalId = spawned.terminalId ?? spawned.id;
  if (!terminalId) fail(`terminal:spawn returned no id: ${JSON.stringify(spawned)}`);
  // A short settle lets the shell print its prompt before the command lands.
  await new Promise((resolve) => setTimeout(resolve, 800));
  const promptChunks = chunks.length;
  await bridge.call("terminal:write", { terminalId, data: `${flags.run}\n` });
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  await bridge.call("terminal:terminate", { terminalId }).catch(() => undefined);
  const output = chunks.slice(promptChunks);
  console.log(
    JSON.stringify({
      terminalId,
      chunks: output.length,
      bytes: output.reduce((sum, size) => sum + size, 0),
      largestChunk: output.reduce((max, size) => Math.max(max, size), 0),
      exit
    })
  );
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positionals, flags } = parseArgs(rest);
  if (!command || flags.help) {
    fail("usage: bridge.mjs <call|watch|logs|chat|reply|terminal> …  (see header comment)");
  }
  let connection;
  try {
    connection = resolveConnection(flags);
  } catch (error) {
    fail(error.message);
  }
  const bridge = await connectBridge({ ...connection, timeoutMs: 5000 });
  try {
    if (command === "call") await commandCall(bridge, positionals);
    else if (command === "watch") await commandWatch(bridge, flags);
    else if (command === "logs") await commandLogs(bridge, flags);
    else if (command === "chat") await commandChat(bridge, flags);
    else if (command === "reply") await commandReply(bridge, flags);
    else if (command === "terminal") await commandTerminal(bridge, flags);
    else fail(`unknown command "${command}"`);
  } finally {
    bridge.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error.message));
}
