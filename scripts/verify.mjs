#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { connectBridge } from "./bridge-client.mjs";
import { buildScratchApp, freePort, scratchBinaryPath, startScratchApp } from "./scratch-app.mjs";
import { verifyBrowserSession } from "./verification/browser.mjs";
import { checkoutFingerprint, delay, fileSha256, runChecked, terminateRunningCommands, uniqueRunId } from "./verification/common.mjs";
import { copyIfPresent, listEvidenceFiles, redact, redactEvidenceTextFiles, writeJson, writeNdjson } from "./verification/evidence.mjs";
import { verifySessionMove } from "./verification/session-move.mjs";
import { verifyStagedPreservingRevert } from "./verification/workspace-recovery.mjs";
import {
  VERIFICATION_BARRIERS,
  VERIFICATION_CONVERSATION_ID,
  VERIFICATION_CODEX_PROVIDER,
  VERIFICATION_CODEX_SUBAGENT,
  VERIFICATION_CURSOR_PROVIDER,
  VERIFICATION_CURSOR_SUBAGENT,
  VERIFICATION_OPENCODE_PROVIDER,
  VERIFICATION_OPENCODE_SUBAGENT,
  VERIFICATION_PROVIDER,
  VERIFICATION_MOVED_CONVERSATION_ID,
  VERIFICATION_SCENARIOS,
  VERIFICATION_SUBAGENT,
} from "./verification/provider-fixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const terminalStates = new Set(["complete", "failed", "cancelled"]);
const persistentSubagentScenarios = new Set(["persistent-subagent", "persistent-codex-subagent", "persistent-opencode-subagent", "persistent-cursor-subagent"]);
const scenarioDefinitionKeys = Object.freeze({
  "chat-resume": "chatResumeFirst",
  "queued-restart": "chatResumeFirst",
  "persistent-subagent": "persistentSubagentFirst",
  "persistent-codex-subagent": "persistentCodexSubagentFirst",
  "codex-user-input": "codexUserInput",
  "persistent-opencode-subagent": "persistentOpencodeSubagentFirst",
  "persistent-cursor-subagent": "persistentCursorSubagentFirst",
  cancellation: "cancellation",
  "provider-error": "providerError",
  "session-move": "sessionMoveFirst",
  "staged-revert": "providerError",
});

function providerForScenario(scenario) {
  if (scenario === "persistent-codex-subagent" || scenario === "codex-user-input") return VERIFICATION_CODEX_PROVIDER;
  if (scenario === "persistent-opencode-subagent") return VERIFICATION_OPENCODE_PROVIDER;
  if (scenario === "persistent-cursor-subagent") return VERIFICATION_CURSOR_PROVIDER;
  return VERIFICATION_PROVIDER;
}

function definitionForScenario(scenario) {
  return VERIFICATION_SCENARIOS[scenarioDefinitionKeys[scenario]];
}

export function parseVerifyArgs(argv) {
  const options = {
    scenario: "chat-resume",
    outputDir: null,
    keep: false,
    release: false,
    native: "required",
    timeoutMs: 90_000
  };
  const valueAfter = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scenario") options.scenario = valueAfter(index++, arg);
    else if (arg === "--out") options.outputDir = valueAfter(index++, arg);
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--release") options.release = true;
    else if (arg === "--native") options.native = valueAfter(index++, arg);
    else if (arg === "--timeout") options.timeoutMs = Number(valueAfter(index++, arg)) * 1000;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Object.hasOwn(scenarioDefinitionKeys, options.scenario)) {
    throw new Error(`--scenario must be one of: ${Object.keys(scenarioDefinitionKeys).join(", ")}`);
  }
  if (!['required', 'auto', 'off'].includes(options.native)) {
    throw new Error("--native must be required, auto, or off");
  }
  if (["session-move", "staged-revert"].includes(options.scenario)
      && options.native !== "required") {
    throw new Error(`${options.scenario} requires native verification`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 5000) throw new Error("--timeout must be at least 5 seconds");
  return options;
}

async function prepareEvidenceDirectory(outputDir) {
  try {
    const entries = await readdir(outputDir);
    if (entries.length) throw new Error(`evidence directory is not empty: ${outputDir}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(outputDir, { recursive: true });
}

async function prepareNativeAppBinary(binaryDirectory, sourceBinary) {
  if (process.platform !== "darwin") return sourceBinary;

  // A raw executable has no macOS app identity and can lose activation to the
  // installed Argmax process. WebDriver still launches the executable itself.
  const contentsDirectory = path.join(binaryDirectory, "Argmax Verification.app", "Contents");
  const macosDirectory = path.join(contentsDirectory, "MacOS");
  const nativeBinary = path.join(macosDirectory, "argmax");
  await mkdir(macosDirectory, { recursive: true });
  await copyFile(sourceBinary, nativeBinary);
  await chmod(nativeBinary, (await stat(sourceBinary)).mode);
  await writeFile(path.join(contentsDirectory, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>argmax</string>
  <key>CFBundleIdentifier</key>
  <string>com.argmax.verification</string>
  <key>CFBundleName</key>
  <string>Argmax Verification</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
</dict>
</plist>
`);
  return nativeBinary;
}

function isolatedEnvironment(home, fixturePath, controlDir, invocationLog, provider) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/(TOKEN|SECRET|PASSWORD|API_?KEY|AUTHORIZATION|COOKIE|CREDENTIAL)/i.test(key)) env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    CURSOR_CONFIG_DIR: path.join(home, ".cursor"),
    GROK_HOME: path.join(home, ".grok"),
    ARGMAX_VERIFICATION: "1",
    [provider.modeEnv]: "1",
    [provider.binaryEnv]: fixturePath,
    [provider.homeEnv]: home,
    ARGMAX_VERIFICATION_CONTROL_DIR: controlDir,
    ARGMAX_VERIFICATION_LOG: invocationLog
  };
}

function silenceDriverOutput() {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  };
}

function replayDetails({ report, repoRoot, home, profile, env, fixturePath, provider }) {
  if (!report.build) return null;
  return {
    ownedProcessesStopped: true,
    cwd: repoRoot,
    executable: report.build.launchedBinary,
    args: [],
    env: {
      HOME: home,
      XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: env.XDG_DATA_HOME,
      XDG_CACHE_HOME: env.XDG_CACHE_HOME,
      XDG_STATE_HOME: env.XDG_STATE_HOME,
      CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
      CODEX_HOME: env.CODEX_HOME,
      CURSOR_CONFIG_DIR: env.CURSOR_CONFIG_DIR,
      GROK_HOME: env.GROK_HOME,
      ARGMAX_DATA_DIR: profile,
      ARGMAX_VERIFICATION: "1",
      ARGMAX_VERIFICATION_HOME: home,
      [provider.binaryEnv]: fixturePath
    }
  };
}

async function initializeRepo(repoPath) {
  await mkdir(repoPath, { recursive: true });
  await runChecked("git", ["init", "-q", "-b", "main"], { cwd: repoPath, timeoutMs: 10_000 });
  await runChecked("git", ["config", "user.name", "Argmax Verification"], { cwd: repoPath, timeoutMs: 10_000 });
  await runChecked("git", ["config", "user.email", "verification@argmax.invalid"], { cwd: repoPath, timeoutMs: 10_000 });
  await writeFile(path.join(repoPath, "README.md"), "# Argmax verification fixture\n");
  await runChecked("git", ["add", "README.md"], { cwd: repoPath, timeoutMs: 10_000 });
  await runChecked("git", ["commit", "-q", "-m", "verification fixture"], { cwd: repoPath, timeoutMs: 10_000 });
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await delay(50);
  }
  throw new Error(`fixture barrier did not arrive: ${path.basename(filePath)}`);
}

async function resolveProjectAndWorkspace(bridge, repoPath, taskLabel) {
  const project = await bridge.call("projects:register", { repoPath });
  const workspace = await bridge.call("workspaces:create-current", { projectId: project.id, taskLabel });
  return { project, workspace };
}

async function launchFixture(bridge, workspaceId, prompt, provider) {
  return bridge.call("providers:launch", {
    workspaceId,
    provider: provider.provider,
    prompt,
    modelLabel: provider.modelLabel,
    modelId: provider.modelId,
    reasoningEffort: null,
    fastMode: false,
    agentMode: null,
    permissionMode: null,
    cols: 120,
    rows: 32,
    attachments: null
  });
}

async function collectUntilTerminal(bridge, sessionId, timeoutMs, initialCursors = {}) {
  const startedAt = Date.now();
  const records = [];
  let eventCursor = initialCursors.eventCursor ?? null;
  let rawOutputCursor = initialCursors.rawOutputCursor ?? null;
  let changeCursor = initialCursors.changeCursor ?? null;
  for (;;) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`session ${sessionId} did not finish within ${timeoutMs}ms`);
    const batch = await bridge.call("session:events-since", { sessionId, eventCursor, rawOutputCursor, changeCursor });
    eventCursor = batch.eventCursor;
    rawOutputCursor = batch.rawOutputCursor;
    changeCursor = batch.changeCursor;
    records.push(...batch.events.map((event) => ({ kind: "event", ...event })));
    records.push(...batch.rawOutputs.map((output) => ({ kind: "rawOutput", ...output })));
    const dashboard = await bridge.call("dashboard:list", {});
    const session = dashboard.sessions.find((entry) => entry.id === sessionId);
    if (!session) throw new Error(`session ${sessionId} disappeared from dashboard`);
    if (terminalStates.has(session.state)) return { session, records, cursors: { eventCursor, rawOutputCursor, changeCursor } };
    await delay(100);
  }
}

async function collectUntilText(bridge, sessionId, expected, timeoutMs) {
  const startedAt = Date.now();
  const records = [];
  let eventCursor = null;
  let rawOutputCursor = null;
  let changeCursor = null;
  while (Date.now() - startedAt <= timeoutMs) {
    const batch = await bridge.call("session:events-since", { sessionId, eventCursor, rawOutputCursor, changeCursor });
    eventCursor = batch.eventCursor;
    rawOutputCursor = batch.rawOutputCursor;
    changeCursor = batch.changeCursor;
    records.push(...batch.events.map((event) => ({ kind: "event", ...event })));
    records.push(...batch.rawOutputs.map((output) => ({ kind: "rawOutput", ...output })));
    if (records.some((record) => String(record.message ?? record.content ?? "").includes(expected))) {
      return { records, cursors: { eventCursor, rawOutputCursor, changeCursor } };
    }
    await delay(100);
  }
  throw new Error(`session ${sessionId} did not emit ${expected} within ${timeoutMs}ms`);
}

function assertIncludes(records, expected, label) {
  if (!records.some((record) => String(record.message ?? record.content ?? "").includes(expected))) {
    throw new Error(`${label} missing from normalized and raw provider output: ${expected}`);
  }
}

function assertRecordIncludes(records, expected, label) {
  if (!records.some((record) => String(record.content ?? JSON.stringify(record)).includes(expected))) {
    throw new Error(`${label} missing from provider records: ${expected}`);
  }
}

function assertOnlyPendingMessage(entries, expected, label) {
  if (
    entries.length !== 1
    || entries[0].id !== expected.id
    || entries[0].content !== expected.content
  ) {
    throw new Error(`${label} must contain exactly queued follow-up ${expected.id}`);
  }
  return entries[0];
}

async function runScenario({
  bridge,
  scenario,
  provider,
  repoPath,
  movePath,
  controlDir,
  invocationLog,
  databasePath,
  outputDir,
  browser,
  verifyUi,
  sendInput,
  queueInput,
  sendQueuedInput,
  terminate,
  restartBackend,
  timeoutMs,
  timeline
}) {
  const definition = definitionForScenario(scenario);
  const { workspace } = await resolveProjectAndWorkspace(bridge, repoPath, definition.prompt);
  const launched = await launchFixture(bridge, workspace.id, definition.prompt, provider);
  timeline.push({ at: new Date().toISOString(), type: "session-launched", sessionId: launched.id, workspaceId: workspace.id });

  if (scenario === "session-move") {
    return verifySessionMove({
      bridge,
      browser,
      sourceSession: launched,
      sourceWorkspace: workspace,
      repoPath,
      movePath,
      controlDir,
      outputDir: path.join(outputDir, "native"),
      timeoutMs,
      invocationLog,
    });
  }

  if (scenario === "codex-user-input") {
    const deadline = Date.now() + timeoutMs;
    let requestId = null;
    while (Date.now() < deadline) {
      const batch = await bridge.call("session:events-since", { sessionId: launched.id });
      const question = batch.events.find((event) => event.type === "command.started"
        && event.payload?.input?.questions?.some((entry) => entry.id === definition.questionId));
      if (question) {
        requestId = question.payload.input.requestId;
        if (!requestId) throw new Error("Codex question omitted its response request ID");
        timeline.push({ at: new Date().toISOString(), type: "pending-question", event: question });
        break;
      }
      await delay(100);
    }
    if (!requestId) throw new Error("Codex did not publish its pending question");
    const dashboard = await bridge.call("dashboard:list", {});
    const waiting = dashboard.sessions.find((session) => session.id === launched.id);
    if (waiting?.state !== "waiting" || waiting.attention !== "question-asked") {
      throw new Error(`Pending question has incorrect session state: ${waiting?.state}/${waiting?.attention}`);
    }
    const waitingUi = await verifyUi({ name: "question-waiting", expectedTexts: [definition.questionText], expectIdle: false });
    await bridge.call("questions:resolve", {
      sessionId: launched.id, requestId,
      answers: { [definition.questionId]: [definition.expectedAnswer] },
    });
    const result = await collectUntilTerminal(bridge, launched.id, timeoutMs);
    if (result.session.state !== "complete") throw new Error(`question turn ended in ${result.session.state}`);
    assertIncludes(result.records, definition.visibleText, "same-turn answer");
    const ui = await verifyUi({ name: "question-answered", expectedTexts: [definition.visibleText], expectIdle: true });
    return { session: result.session, workspace, records: result.records, browser: [waitingUi, ui] };
  }

  if (scenario === "chat-resume") {
    await waitForFile(path.join(controlDir, `${VERIFICATION_BARRIERS.chatResumeStream}.ready`), timeoutMs);
    const streamingUi = await verifyUi({ name: "streaming", expectedTexts: ["Verification first turn complete."], expectIdle: false });
    timeline.push({ at: new Date().toISOString(), type: "ui-streaming", ...streamingUi.uiState });
    await writeFile(path.join(controlDir, `${VERIFICATION_BARRIERS.chatResumeStream}.continue`), "continue\n");

    await waitForFile(path.join(controlDir, `${VERIFICATION_BARRIERS.chatResumeTool}.ready`), timeoutMs);
    const toolUi = await verifyUi({ name: "tool-running", expectedTexts: ["Read"], expectIdle: false });
    timeline.push({ at: new Date().toISOString(), type: "ui-tool-running", ...toolUi.uiState });
    await writeFile(path.join(controlDir, `${VERIFICATION_BARRIERS.chatResumeTool}.continue`), "continue\n");
    const first = await collectUntilTerminal(bridge, launched.id, timeoutMs);
    if (first.session.state !== "complete") throw new Error(`first turn ended in ${first.session.state}`);
    if (first.session.providerConversationId !== VERIFICATION_CONVERSATION_ID) throw new Error("provider conversation id was not persisted");
    assertIncludes(first.records, VERIFICATION_SCENARIOS.chatResumeFirst.visibleText, "first turn");

    const before = await bridge.call("session:events-since", {
      sessionId: launched.id,
      eventCursor: null,
      rawOutputCursor: null,
      changeCursor: null
    });
    await sendInput(launched.id, VERIFICATION_SCENARIOS.chatResumeSecond.prompt);
    const second = await collectUntilTerminal(bridge, launched.id, timeoutMs, before);
    if (second.session.state !== "complete") throw new Error(`resumed turn ended in ${second.session.state}`);
    assertIncludes(second.records, VERIFICATION_SCENARIOS.chatResumeSecond.visibleText, "resumed turn");
    const combined = [...first.records, ...second.records];
    const ui = await verifyUi({
      name: "complete",
      expectedTexts: [VERIFICATION_SCENARIOS.chatResumeFirst.visibleText, VERIFICATION_SCENARIOS.chatResumeSecond.visibleText],
      expectIdle: true
    });
    return { session: second.session, workspace, records: combined, browser: [streamingUi, toolUi, ui] };
  }

  if (scenario === "queued-restart") {
    const secondPrompt = VERIFICATION_SCENARIOS.chatResumeSecond.prompt;
    await waitForFile(path.join(controlDir, `${VERIFICATION_BARRIERS.chatResumeStream}.ready`), timeoutMs);
    const streamingUi = await verifyUi({
      name: "queued-running",
      expectedTexts: [VERIFICATION_SCENARIOS.chatResumeFirst.visibleText],
      expectIdle: false
    });
    const queuedAction = await queueInput(launched.id, secondPrompt);
    const pendingMessage = queuedAction.queuedMessage;
    if (!pendingMessage?.id || pendingMessage.content !== secondPrompt) {
      throw new Error("native composer did not return the persisted queued follow-up");
    }
    const expectedQueuedMessage = { id: pendingMessage.id, content: secondPrompt };
    const queuedDashboard = await bridge.call("dashboard:list", {});
    assertOnlyPendingMessage(
      queuedDashboard.pendingMessages[launched.id] ?? [],
      expectedQueuedMessage,
      "dashboard queue before restart"
    );
    const beforeRestart = await sqliteSnapshot(databasePath, launched.id);
    await writeJson(path.join(outputDir, "queued-before-restart.json"), beforeRestart);
    const firstTurnDeltaSequence = beforeRestart.events
      .filter((event) => event.type === "message.delta" && typeof event.message === "string" && event.message.length > 0)
      .map((event) => ({ id: event.id, message: event.message }));
    if (firstTurnDeltaSequence.length === 0) {
      throw new Error("held first turn did not persist any streamed content before restart");
    }
    const durableBefore = assertOnlyPendingMessage(
      beforeRestart.pendingMessages,
      expectedQueuedMessage,
      "SQLite queue before restart"
    );
    if (durableBefore.deliveryState !== "pending") {
      throw new Error("SQLite queued follow-up was not pending before restart");
    }
    if (beforeRestart.events.some((event) => event.type === "user.message" && event.message === secondPrompt)) {
      throw new Error("queued follow-up was recorded as a user turn before delivery");
    }

    const resumedBridge = await restartBackend();
    timeline.push({ at: new Date().toISOString(), type: "backend-restarted", sessionId: launched.id });
    await delay(1_000);
    const recoveredDashboard = await resumedBridge.call("dashboard:list", {});
    const recoveredDashboardMessage = assertOnlyPendingMessage(
      recoveredDashboard.pendingMessages[launched.id] ?? [],
      expectedQueuedMessage,
      "dashboard queue after restart"
    );
    if (!["unsent", "delivery-unknown"].includes(recoveredDashboardMessage.recoveryStatus)) {
      throw new Error("restart did not recover the queued follow-up as paused or delivery-uncertain");
    }
    const recovered = await sqliteSnapshot(databasePath, launched.id);
    await writeJson(path.join(outputDir, "queued-after-restart.json"), recovered);
    const recoveredFirstTurnDeltaSequence = recovered.events
      .filter((event) => event.type === "message.delta" && typeof event.message === "string" && event.message.length > 0)
      .map((event) => ({ id: event.id, message: event.message }));
    if (JSON.stringify(recoveredFirstTurnDeltaSequence) !== JSON.stringify(firstTurnDeltaSequence)) {
      throw new Error("restart changed the persisted first-turn stream fragments");
    }
    const durableRecovered = assertOnlyPendingMessage(
      recovered.pendingMessages,
      expectedQueuedMessage,
      "SQLite queue after restart"
    );
    if (!["recovered", "delivery_unknown"].includes(durableRecovered.deliveryState)) {
      throw new Error("SQLite did not mark the queued follow-up as recovered");
    }
    if (recovered.events.some((event) => event.type === "user.message" && event.message === secondPrompt)) {
      throw new Error("recovered queued follow-up replayed without an explicit send");
    }
    const recoveryLabel = recoveredDashboardMessage.recoveryStatus === "delivery-unknown"
      ? "Delivery uncertain • check the chat before sending again"
      : "Paused • not sent";
    const recoveredUi = await verifyUi({
      name: "queued-recovered",
      expectedTexts: [secondPrompt, recoveryLabel],
      expectIdle: true
    });

    const beforeSend = await resumedBridge.call("session:events-since", {
      sessionId: launched.id,
      eventCursor: null,
      rawOutputCursor: null,
      changeCursor: null
    });
    const recoveredRecords = [
      ...beforeSend.events.map((event) => ({ kind: "event", ...event })),
      ...beforeSend.rawOutputs.map((output) => ({ kind: "rawOutput", ...output }))
    ];
    const beforeExplicitSend = await sqliteSnapshot(databasePath, launched.id);
    assertOnlyPendingMessage(
      beforeExplicitSend.pendingMessages,
      expectedQueuedMessage,
      "SQLite queue before explicit Send"
    );
    const userMessagesBeforeExplicitSend = beforeExplicitSend.events
      .filter((event) => event.type === "user.message" && event.message === secondPrompt);
    if (userMessagesBeforeExplicitSend.length !== 0) {
      throw new Error("recovered queued follow-up replayed before explicit Send");
    }
    await sendQueuedInput(launched.id, pendingMessage.id, secondPrompt);
    const second = await collectUntilTerminal(resumedBridge, launched.id, timeoutMs, beforeSend);
    if (second.session.state !== "complete") throw new Error(`recovered follow-up ended in ${second.session.state}`);
    assertIncludes(second.records, VERIFICATION_SCENARIOS.chatResumeSecond.visibleText, "recovered follow-up");
    const finalSnapshot = await sqliteSnapshot(databasePath, launched.id);
    const deliveredUserMessages = finalSnapshot.events
      .filter((event) => event.type === "user.message" && event.message === secondPrompt);
    if (deliveredUserMessages.length !== 1) {
      throw new Error(`recovered follow-up persisted ${deliveredUserMessages.length} user turns instead of one`);
    }
    if (finalSnapshot.pendingMessages.length !== 0) {
      throw new Error("SQLite session queue was not empty after delivering the follow-up");
    }
    const finalDashboard = await resumedBridge.call("dashboard:list", {});
    if ((finalDashboard.pendingMessages[launched.id] ?? []).length !== 0) {
      throw new Error("dashboard session queue was not empty after delivering the follow-up");
    }
    const completeUi = await verifyUi({
      name: "queued-complete",
      expectedTexts: [
        VERIFICATION_SCENARIOS.chatResumeFirst.visibleText,
        VERIFICATION_SCENARIOS.chatResumeSecond.visibleText
      ],
      expectIdle: true
    });
    return {
      session: second.session,
      workspace,
      records: [...recoveredRecords, ...second.records],
      browser: [streamingUi, recoveredUi, completeUi],
      bridge: resumedBridge,
      assertions: [
        { name: "held-first-turn-fragments-preserved", ok: true, value: firstTurnDeltaSequence.length },
        { name: "queued-follow-up-persisted-before-restart", ok: true, value: pendingMessage.id },
        { name: "recovered-follow-up-requires-explicit-send", ok: true, value: recoveredDashboardMessage.recoveryStatus },
        { name: "recovered-follow-up-delivered-exactly-once", ok: true, value: deliveredUserMessages[0].id },
        { name: "delivered-follow-up-cleared-from-pending-journal", ok: true }
      ]
    };
  }

  if (persistentSubagentScenarios.has(scenario)) {
    const isCodex = provider.provider === "codex";
    const isOpencode = provider.provider === "opencode";
    const isCursor = provider.provider === "cursor";
    const subagent = isCodex
      ? VERIFICATION_CODEX_SUBAGENT
      : isOpencode
        ? VERIFICATION_OPENCODE_SUBAGENT
        : isCursor
          ? VERIFICATION_CURSOR_SUBAGENT
          : VERIFICATION_SUBAGENT;
    const firstDefinition = isCodex
      ? VERIFICATION_SCENARIOS.persistentCodexSubagentFirst
      : isOpencode
        ? VERIFICATION_SCENARIOS.persistentOpencodeSubagentFirst
        : isCursor
          ? VERIFICATION_SCENARIOS.persistentCursorSubagentFirst
          : VERIFICATION_SCENARIOS.persistentSubagentFirst;
    const secondDefinition = isCodex
      ? VERIFICATION_SCENARIOS.persistentCodexSubagentSecond
      : isOpencode
        ? VERIFICATION_SCENARIOS.persistentOpencodeSubagentSecond
        : isCursor
          ? VERIFICATION_SCENARIOS.persistentCursorSubagentSecond
          : VERIFICATION_SCENARIOS.persistentSubagentSecond;
    const first = await collectUntilTerminal(bridge, launched.id, timeoutMs);
    if (first.session.state !== "complete") throw new Error(`persistent child first turn ended in ${first.session.state}`);
    if (first.session.providerConversationId !== VERIFICATION_CONVERSATION_ID) throw new Error("persistent child parent conversation id was not persisted");
    if (isCodex) {
      assertRecordIncludes(first.records, `\"tool\":\"spawn_agent\"`, "persistent Codex child spawn");
      assertRecordIncludes(first.records, `\"receiver_thread_ids\":[\"${subagent.id}\"]`, "persistent Codex child identity");
      assertRecordIncludes(first.records, firstDefinition.visibleText, "persistent Codex child first response");
    } else if (isOpencode) {
      assertRecordIncludes(first.records, `\"tool\":\"task\"`, "persistent OpenCode child task");
      assertRecordIncludes(first.records, `\"sessionId\":\"${subagent.id}\"`, "persistent OpenCode child identity");
      assertRecordIncludes(first.records, firstDefinition.visibleText, "persistent OpenCode child first response");
    } else if (isCursor) {
      assertRecordIncludes(first.records, `\"message\":\"task\"`, "persistent Cursor ACP child task");
      assertRecordIncludes(first.records, `\"agentId\":\"${subagent.id}\"`, "persistent Cursor authoritative child identity");
      assertRecordIncludes(first.records, firstDefinition.visibleText, "persistent Cursor child first response");
    } else {
      assertRecordIncludes(first.records, `\"task_id\":\"${subagent.id}\"`, "persistent child start");
      assertRecordIncludes(first.records, `\"parent_tool_use_id\":\"${subagent.rootToolUseId}\"`, "persistent child parent linkage");
      assertRecordIncludes(first.records, firstDefinition.visibleText, "persistent child first response");
    }

    const resumedBridge = await restartBackend();
    timeline.push({ at: new Date().toISOString(), type: "backend-restarted", sessionId: launched.id });
    const before = await resumedBridge.call("session:events-since", {
      sessionId: launched.id,
      eventCursor: null,
      rawOutputCursor: null,
      changeCursor: null,
    });
    await sendInput(launched.id, secondDefinition.prompt);
    const second = await collectUntilTerminal(resumedBridge, launched.id, timeoutMs, before);
    if (second.session.state !== "complete") throw new Error(`persistent child follow-up ended in ${second.session.state}`);
    if (isCodex) {
      assertRecordIncludes(second.records, `\"tool\":\"resume_agent\"`, "persistent Codex child resume");
      assertRecordIncludes(second.records, `\"tool\":\"send_input\"`, "persistent Codex child input");
      assertRecordIncludes(second.records, `\"id\":\"${subagent.followUpToolUseId}\"`, "persistent Codex child follow-up invocation");
      assertRecordIncludes(second.records, `\"receiver_thread_ids\":[\"${subagent.id}\"]`, "persistent Codex child stable identity");
      assertRecordIncludes(second.records, `\"status\":\"pending_init\"`, "persistent Codex child restart state");
      assertRecordIncludes(second.records, secondDefinition.visibleText, "persistent Codex child follow-up response");
    } else if (isOpencode) {
      assertRecordIncludes(second.records, `\"task_id\":\"${subagent.id}\"`, "persistent OpenCode child continuation");
      assertRecordIncludes(second.records, `\"callID\":\"${subagent.followUpToolUseId}\"`, "persistent OpenCode child follow-up invocation");
      assertRecordIncludes(second.records, secondDefinition.visibleText, "persistent OpenCode child follow-up response");
    } else if (isCursor) {
      assertRecordIncludes(second.records, `\"resume\":\"${subagent.id}\"`, "persistent Cursor child continuation");
      assertRecordIncludes(second.records, `\"call_id\":\"${subagent.followUpToolUseId}\"`, "persistent Cursor child follow-up invocation");
      assertRecordIncludes(second.records, secondDefinition.visibleText, "persistent Cursor child follow-up response");
    } else {
      assertRecordIncludes(second.records, `\"resumedAgentId\":\"${subagent.id}\"`, "persistent child resume identity");
      assertRecordIncludes(second.records, `\"tool_use_id\":\"${subagent.followUpToolUseId}\"`, "persistent child follow-up invocation");
      assertRecordIncludes(second.records, secondDefinition.visibleText, "persistent child follow-up response");
    }
    const agentEvents = await resumedBridge.call("session:agent-events", {
      sessionId: launched.id,
      parentToolUseId: subagent.rootToolUseId,
    });
    const lifecycle = agentEvents.events.filter((event) => event.type === "agent.started" || event.type === "agent.completed");
    for (const event of lifecycle) {
      const payload = event.payload ?? {};
      if (
        payload.providerChildSessionId !== subagent.id
        || payload.providerParentConversationId !== VERIFICATION_CONVERSATION_ID
        || payload.agentRootToolUseId !== subagent.rootToolUseId
        || typeof payload.providerInvocationId !== "string"
      ) {
        throw new Error("persistent child lifecycle correlation fields were not persisted");
      }
    }
    for (const runId of [subagent.rootToolUseId, subagent.followUpToolUseId]) {
      if (!lifecycle.some((event) => event.payload?.agentRunId === runId && event.type === "agent.started")) {
        throw new Error(`persistent child start for ${runId} was not queryable after restart`);
      }
      if (!lifecycle.some((event) => event.payload?.agentRunId === runId && event.type === "agent.completed")) {
        throw new Error(`persistent child completion for ${runId} was not queryable after restart`);
      }
    }
    const invocationIds = new Set(lifecycle.map((event) => event.payload?.providerInvocationId));
    if (invocationIds.size < 2) {
      throw new Error("persistent child runs did not retain distinct provider invocation identities");
    }
    timeline.push({
      at: new Date().toISOString(),
      type: "persistent-agent-events",
      count: agentEvents.events.length,
      source: "agent-events",
    });
    const browser = [];
    for (const theme of ["light", "dark"]) {
      browser.push(await verifyUi({
        name: `persistent-agent-${theme}`,
        expectedTexts: [],
        agentExpectedTexts: [
          firstDefinition.visibleText,
          secondDefinition.visibleText,
        ],
        agentMustSucceed: true,
        theme,
      }));
    }
    return {
      session: second.session,
      workspace,
      records: [...first.records, ...second.records],
      browser,
      bridge: resumedBridge,
      nativeChildId: subagent.id,
      agentEventCount: agentEvents.events.length,
    };
  }

  if (scenario === "cancellation") {
    const partial = await collectUntilText(bridge, launched.id, definition.visibleText, timeoutMs);
    const streamingUi = await verifyUi({ name: "cancellation-streaming", expectedTexts: [definition.visibleText], expectIdle: false });
    await terminate(launched.id);
    const result = await collectUntilTerminal(bridge, launched.id, timeoutMs, partial.cursors);
    if (result.session.state !== "cancelled") throw new Error(`cancelled scenario ended in ${result.session.state}`);
    const completeUi = await verifyUi({ name: "cancellation-complete", expectedTexts: [definition.visibleText], expectIdle: true });
    return { session: result.session, workspace, records: [...partial.records, ...result.records], browser: [streamingUi, completeUi] };
  }

  const result = await collectUntilTerminal(bridge, launched.id, timeoutMs);
  if (result.session.state !== "failed") throw new Error(`${scenario} scenario ended in ${result.session.state}`);
  assertIncludes(result.records, definition.diagnostic, `${scenario} diagnostic`);
  const ui = await verifyUi({ name: scenario, expectedTexts: [definition.diagnostic], expectIdle: true });
  return { session: result.session, workspace, records: result.records, browser: [ui] };
}

async function sqliteSnapshot(databasePath, sessionId) {
  const sql = "SELECT json_object('sessions',(SELECT json_group_array(json_object('id',id,'state',state,'provider',provider,'providerConversationId',provider_conversation_id)) FROM sessions),'events',(SELECT json_group_array(json_object('id',id,'sessionId',session_id,'type',type,'message',message,'createdAt',created_at)) FROM events ORDER BY created_at),'rawOutputs',(SELECT json_group_array(json_object('sessionId',session_id,'stream',stream,'content',content,'createdAt',created_at)) FROM raw_outputs ORDER BY created_at),'pendingMessages',(SELECT json_group_array(json_object('id',id,'sessionId',session_id,'content',content,'position',position,'deliveryState',delivery_state,'queuedAt',queued_at)) FROM pending_messages ORDER BY position));";
  const result = await runChecked("sqlite3", [databasePath, sql], { timeoutMs: 20_000 });
  const all = JSON.parse(result.stdout.trim());
  return {
    sessions: all.sessions.filter((entry) => entry.id === sessionId),
    events: all.events.filter((entry) => entry.sessionId === sessionId),
    rawOutputs: all.rawOutputs.filter((entry) => entry.sessionId === sessionId),
    pendingMessages: all.pendingMessages.filter((entry) => entry.sessionId === sessionId)
  };
}

function expectedPersistenceTexts(scenario) {
  if (scenario === "codex-user-input") return [VERIFICATION_SCENARIOS.codexUserInput.visibleText];
  if (scenario === "chat-resume") {
    return [VERIFICATION_SCENARIOS.chatResumeFirst.visibleText, VERIFICATION_SCENARIOS.chatResumeSecond.visibleText];
  }
  if (scenario === "queued-restart") return [VERIFICATION_SCENARIOS.chatResumeSecond.visibleText];
  if (scenario === "session-move") {
    return [VERIFICATION_SCENARIOS.sessionMoveFirst.visibleText, VERIFICATION_SCENARIOS.sessionMoveSecond.visibleText];
  }
  if (scenario === "persistent-subagent") {
    return [
      VERIFICATION_SCENARIOS.persistentSubagentFirst.visibleText,
      VERIFICATION_SCENARIOS.persistentSubagentSecond.visibleText,
    ];
  }
  if (scenario === "persistent-codex-subagent") {
    return [
      VERIFICATION_SCENARIOS.persistentCodexSubagentFirst.visibleText,
      VERIFICATION_SCENARIOS.persistentCodexSubagentSecond.visibleText,
    ];
  }
  if (scenario === "persistent-opencode-subagent") {
    return [
      VERIFICATION_SCENARIOS.persistentOpencodeSubagentFirst.visibleText,
      VERIFICATION_SCENARIOS.persistentOpencodeSubagentSecond.visibleText,
    ];
  }
  if (scenario === "persistent-cursor-subagent") {
    return [
      VERIFICATION_SCENARIOS.persistentCursorSubagentFirst.visibleText,
      VERIFICATION_SCENARIOS.persistentCursorSubagentSecond.visibleText,
    ];
  }
  if (scenario === "cancellation") return [VERIFICATION_SCENARIOS.cancellation.visibleText];
  return [VERIFICATION_SCENARIOS.providerError.diagnostic];
}

async function connectBridgeWhenReady(connection, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const bridge = await connectBridge({ ...connection, timeoutMs: 2000, callTimeoutMs: 15_000 });
      await bridge.call("health:ping", {});
      return bridge;
    } catch (error) {
      lastError = error;
      await delay(200);
    }
  }
  throw new Error(`bridge did not become ready: ${lastError?.message ?? "unknown error"}`);
}

async function terminateProviderForCleanup(bridge, sessionId, report, context) {
  try {
    await bridge.call("providers:terminate", { sessionId });
    report.process.providerCleanup = { context, sessionId, stopped: true };
    report.assertions.push({ name: `provider-stopped:${context}`, ok: true });
  } catch (error) {
    report.process.providerCleanup = { context, sessionId, stopped: false };
    report.errors.push({ message: `provider cleanup failed during ${context}: ${error.message}` });
  }
}

export async function runVerification(options) {
  const runId = uniqueRunId();
  const outputDir = path.resolve(options.outputDir ?? path.join(repoRoot, "scratch", "verification", runId));
  await prepareEvidenceDirectory(outputDir);
  const runRoot = await mkdtemp(path.join(tmpdir(), "argmax-verify-"));
  const profile = path.join(runRoot, "profile");
  const home = path.join(runRoot, "home");
  const repoPath = path.join(runRoot, "repo");
  const controlDir = path.join(runRoot, "control");
  const invocationLog = path.join(outputDir, "provider-invocations.ndjson");
  await Promise.all([mkdir(profile, { recursive: true }), mkdir(home, { recursive: true }), mkdir(controlDir, { recursive: true })]);
  await writeFile(path.join(profile, "sync.json"), `${JSON.stringify({ claude: false, codex: false, cursor: false, opencode: false, grok: false, windowHours: 24 })}\n`);
  await initializeRepo(repoPath);
  let movePath = null;
  if (options.scenario === "session-move") {
    const siblingPath = path.join(runRoot, "sibling");
    await runChecked(
      "git",
      ["worktree", "add", "-q", "-b", "verification-session-move-target", siblingPath],
      { cwd: repoPath, timeoutMs: 10_000 },
    );
    movePath = await realpath(siblingPath);
  }

  const fixturePath = path.join(repoRoot, "scripts", "verification", "provider-fixture.mjs");
  const provider = providerForScenario(options.scenario);
  const env = {
    ...isolatedEnvironment(home, fixturePath, controlDir, invocationLog, provider),
    ...(movePath ? { ARGMAX_VERIFICATION_MOVE_PATH: movePath } : {}),
  };
  const report = {
    schemaVersion: 1,
    runId,
    scenario: options.scenario,
    status: "running",
    startedAt: new Date().toISOString(),
    outputDir,
    source: {},
    assertions: [],
    timeline: [],
    process: {},
    errors: []
  };
  let app = null;
  let pendingScratchStart = null;
  let desktopHandle = null;
  let pendingDesktopConnection = null;
  let desktopModule = null;
  let bridge = null;
  let databasePath = path.join(profile, "local-state", "argmax.sqlite");
  let restoreDriverOutput = null;
  let scenarioResult = null;
  let interrupting = false;
  const interrupt = (signal) => {
    if (interrupting) return;
    interrupting = true;
    void (async () => {
      const scratchStartup = pendingScratchStart;
      const desktopStartup = pendingDesktopConnection;
      report.status = "failed";
      report.interruptedBy = signal;
      report.errors.push({ message: `verification interrupted by ${signal}` });
      terminateRunningCommands("SIGTERM");
      await delay(250);
      terminateRunningCommands("SIGKILL");
      const sessionId = report.timeline.find((entry) => entry.type === "session-launched")?.sessionId;
      if (bridge) {
        try {
          report.debugSnapshot = redact(await bridge.call("system:debug-snapshot", { afterLogSeq: null }));
        } catch {}
        if (sessionId) {
          try {
            const batch = await bridge.call("session:events-since", {
              sessionId,
              eventCursor: null,
              rawOutputCursor: null,
              changeCursor: null
            });
            await writeNdjson(path.join(outputDir, "timeline.ndjson"), [
              ...batch.events.map((event) => ({ kind: "event", ...event })),
              ...batch.rawOutputs.map((output) => ({ kind: "rawOutput", ...output }))
            ]);
          } catch {}
          await terminateProviderForCleanup(bridge, sessionId, report, "interruption");
        }
        bridge.close();
      }
      if (!desktopHandle && desktopStartup) {
        try {
          desktopHandle = await desktopStartup;
        } catch (error) {
          report.errors.push({ message: `desktop startup ended during interruption: ${error.message}` });
        }
      }
      if (desktopHandle) {
        try {
          await mkdir(path.join(outputDir, "native"), { recursive: true });
          const screenshot = path.join(outputDir, "native", "interrupted.png");
          await desktopHandle.browser.saveScreenshot(screenshot);
          report.native.interruptionEvidence = {
            screenshot,
            uiState: await desktopHandle.browser.execute(function captureInterruptedState() {
              return {
                title: document.title,
                bodyText: document.body.innerText.slice(0, 10_000),
                diagnostics: window.__ARGMAX_VERIFICATION__?.snapshot() ?? null
              };
            })
          };
        } catch (error) {
          report.errors.push({ message: `native interruption evidence failed: ${error.message}` });
        }
        try {
          await desktopHandle.close();
          report.process.desktop = { ...report.process.desktop, closed: true };
        } catch (error) {
          report.errors.push({ message: `desktop interruption cleanup failed: ${error.message}` });
        } finally {
          restoreDriverOutput?.();
        }
      }
      restoreDriverOutput?.();
      if (!app && scratchStartup) {
        try {
          app = await scratchStartup;
        } catch (error) {
          report.errors.push({ message: `scratch startup ended during interruption: ${error.message}` });
        }
      }
      if (app) {
        try {
          report.process.scratch.exit = await app.stop();
        } catch (error) {
          report.errors.push({ message: `scratch interruption cleanup failed: ${error.message}` });
        }
      }
      if (sessionId && existsSync(databasePath)) {
        try {
          await writeJson(path.join(outputDir, "database.json"), await sqliteSnapshot(databasePath, sessionId));
        } catch {}
      }
      await copyIfPresent(path.join(profile, "app.log"), path.join(outputDir, "app.log"));
      await redactEvidenceTextFiles(outputDir);
      report.finishedAt = new Date().toISOString();
      report.keptRunRoot = options.keep ? runRoot : null;
      if (options.keep) report.replay = replayDetails({ report, repoRoot, home, profile, env, fixturePath, provider });
      if (!options.keep) await rm(runRoot, { recursive: true, force: true });
      report.evidenceFiles = [...await listEvidenceFiles(outputDir), "report.json"].sort();
      await writeJson(path.join(outputDir, "report.json"), report);
      process.stderr.write(`INTERRUPTED ${options.scenario} evidence=${outputDir}\n`);
      process.exit(130);
    })();
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    if (persistentSubagentScenarios.has(options.scenario) && options.native !== "off") {
      throw new Error(`${options.scenario} requires --native off because it verifies a scratch backend restart`);
    }
    if (["queued-restart", "session-move", "staged-revert"].includes(options.scenario)
        && options.native !== "required") {
      throw new Error(`${options.scenario} requires native verification`);
    }
    report.source.beforeBuild = await checkoutFingerprint(repoRoot);
    const targetDir = path.join(repoRoot, "src-tauri", "target", "verification");
    const rendererOutDir = path.join(repoRoot, "dist", "verification");
    const builtBinary = scratchBinaryPath({ release: options.release, targetDir });
    await buildScratchApp({
      release: options.release,
      features: ["custom-protocol", "verification"],
      env: {
        ...process.env,
        VITE_ARGMAX_VERIFICATION: "1",
        TAURI_CONFIG: JSON.stringify({ build: { frontendDist: "../dist/verification" } })
      },
      targetDir,
      rendererOutDir,
      logDir: path.join(outputDir, "build")
    });
    if (!existsSync(builtBinary)) throw new Error(`verification binary missing at ${builtBinary}`);
    report.source.afterBuild = await checkoutFingerprint(repoRoot);
    if (report.source.beforeBuild.sha256 !== report.source.afterBuild.sha256) throw new Error("checkout changed while the verification build was running");
    const binaryDirectory = path.join(runRoot, "bin");
    const binary = path.join(binaryDirectory, "argmax");
    await mkdir(binaryDirectory, { recursive: true });
    await copyFile(builtBinary, binary);
    await chmod(binary, (await stat(builtBinary)).mode);
    const nativeBinary = options.native === "off"
      ? binary
      : await prepareNativeAppBinary(binaryDirectory, builtBinary);
    const binarySha256 = await fileSha256(binary);
    const nativeBinarySha256 = await fileSha256(nativeBinary);
    report.build = {
      sourceBinary: builtBinary,
      launchedBinary: options.native === "off" ? binary : nativeBinary,
      backendBinary: binary,
      nativeBinary,
      binarySha256,
      release: options.release,
      rendererDiagnostics: true,
      rendererOutDir,
      targetDir,
      features: ["custom-protocol", "verification"]
    };

    const remotePort = await freePort();
    const remoteToken = randomUUID().replaceAll("-", "");
    await writeFile(path.join(profile, "remote.json"), `${JSON.stringify({ enabled: true, port: remotePort, token: remoteToken }, null, 2)}\n`, { mode: 0o600 });
    if (options.native !== "off") {
      desktopModule = await import("./verification/desktop.mjs");
      const prerequisites = await desktopModule.inspectDesktopPrerequisites({ appBinaryPath: nativeBinary });
      report.native = { prerequisites };
      if (prerequisites.available) {
        const desktopPort = await freePort();
        if (interrupting) throw new Error("verification interrupted before native startup");
        restoreDriverOutput = silenceDriverOutput();
        const desktopConnection = desktopModule.connectDesktop({
          appBinaryPath: nativeBinary,
          outputDir: path.join(outputDir, "native"),
          env: { ...env, ARGMAX_DATA_DIR: profile },
          port: desktopPort,
          startTimeoutMs: Math.min(options.timeoutMs, 60_000)
        });
        pendingDesktopConnection = desktopConnection;
        try {
          desktopHandle = await desktopConnection;
        } finally {
          if (pendingDesktopConnection === desktopConnection) pendingDesktopConnection = null;
        }
        if (interrupting) throw new Error("verification interrupted during native startup");
        report.coverage = { backend: "real", provider: "fixture-through-production-adapter", ui: "native-webview" };
        report.process.desktop = { driverOwned: true, remotePort };
      } else if (options.native === "required") {
        throw new Error(`native verification unavailable: ${prerequisites.issues.join("; ")}`);
      }
    }
    if (!desktopHandle) {
      if (interrupting) throw new Error("verification interrupted before scratch startup");
      report.build.launchedBinary = binary;
      const scratchStart = startScratchApp({
        dataDir: profile,
        binary,
        env,
        port: remotePort,
        readyTimeoutMs: Math.min(options.timeoutMs, 60_000)
      });
      pendingScratchStart = scratchStart;
      try {
        app = await scratchStart;
      } finally {
        if (pendingScratchStart === scratchStart) pendingScratchStart = null;
      }
      if (interrupting) throw new Error("verification interrupted during scratch startup");
      report.coverage = { backend: "real", provider: "fixture-through-production-adapter", ui: "remote-browser" };
      report.process.scratch = { pid: app.pid, port: app.port, log: "app.log" };
    }
    bridge = await connectBridgeWhenReady({ port: remotePort, token: remoteToken }, options.timeoutMs);
    const health = await bridge.call("health:ping", {});
    report.assertions.push({ name: "backend-ready", ok: Boolean(health) });
    const titleIncludes = definitionForScenario(options.scenario).prompt;
    const verifyUi = desktopHandle
      ? async ({ name, expectedTexts, expectIdle }) => {
          const result = await desktopModule.verifyDesktopSession({
            browser: desktopHandle.browser,
            outputDir: path.join(outputDir, "native"),
            name,
            titleIncludes,
            expectedTexts,
            expectIdle
          });
          report.native.phases ??= [];
          report.native.phases.push(result);
          if (!result.ok) throw new Error(`native UI verification failed: ${result.errors.join("; ")}`);
          return result;
        }
      : ({ name, expectedTexts, agentExpectedTexts, agentMustSucceed, theme }) => verifyBrowserSession({
          repoRoot,
          port: remotePort,
          token: remoteToken,
          outputDir,
          name: `browser-${name}`,
          titleIncludes,
          expectedTexts,
          agentExpectedTexts,
          agentMustSucceed,
          theme
        });
    const recordNativeAction = (result) => {
      report.native.actions ??= [];
      report.native.actions.push(result);
      if (!result.ok) throw new Error(`native UI action failed: ${result.errors.join("; ")}`);
      return result;
    };
    const sendInput = desktopHandle
      ? async (_sessionId, input) => recordNativeAction(await desktopModule.sendDesktopMessage({ browser: desktopHandle.browser, input }))
      : (sessionId, input) => bridge.call("providers:send-input", {
          sessionId,
          input,
          provider: null,
          modelLabel: null,
          modelId: null,
          reasoningEffort: null,
          fastMode: false
        });
    const queueInput = desktopHandle
      ? async (sessionId, input) => recordNativeAction(await desktopModule.sendDesktopMessage({
          browser: desktopHandle.browser,
          input,
          sessionId,
          expectQueued: true
        }))
      : () => { throw new Error("queued-restart requires the native composer"); };
    const sendQueuedInput = desktopHandle
      ? async (sessionId, messageId, input) => recordNativeAction(await desktopModule.sendDesktopQueuedMessage({
          browser: desktopHandle.browser,
          sessionId,
          messageId,
          input
        }))
      : () => { throw new Error("queued-restart requires the native queued-message action"); };
    const terminate = desktopHandle
      ? async (sessionId) => recordNativeAction(await desktopModule.stopDesktopSession({ browser: desktopHandle.browser, sessionId }))
      : (sessionId) => bridge.call("providers:terminate", { sessionId });
    const restartBackend = async () => {
      bridge?.close();
      bridge = null;
      if (desktopHandle) {
        const cleanup = await desktopHandle.close();
        desktopHandle = null;
        restoreDriverOutput?.();
        report.process.desktop.restart = { closed: true, cleanup };
        if (interrupting) throw new Error("verification interrupted before native restart");
        const desktopPort = await freePort();
        restoreDriverOutput = silenceDriverOutput();
        const desktopConnection = desktopModule.connectDesktop({
          appBinaryPath: nativeBinary,
          outputDir: path.join(outputDir, "native"),
          env: { ...env, ARGMAX_DATA_DIR: profile },
          port: desktopPort,
          startTimeoutMs: Math.min(options.timeoutMs, 60_000)
        });
        pendingDesktopConnection = desktopConnection;
        try {
          desktopHandle = await desktopConnection;
        } finally {
          if (pendingDesktopConnection === desktopConnection) pendingDesktopConnection = null;
        }
        if (interrupting) throw new Error("verification interrupted during native restart");
        report.process.desktop.restarted = { driverOwned: true, remotePort, embeddedPort: desktopHandle.port };
      } else {
        if (!app) throw new Error("scratch backend restart is unavailable");
        report.process.scratch.restart = await app.stop();
        app = await startScratchApp({
          dataDir: profile,
          binary,
          env,
          port: remotePort,
          readyTimeoutMs: Math.min(options.timeoutMs, 60_000),
        });
        report.process.scratch.restarted = { pid: app.pid, port: app.port };
      }
      bridge = await connectBridgeWhenReady({ port: remotePort, token: remoteToken }, options.timeoutMs);
      const health = await bridge.call("health:ping", {});
      if (!health) throw new Error("scratch backend did not become healthy after restart");
      return bridge;
    };
    try {
      scenarioResult = await runScenario({
        bridge,
        scenario: options.scenario,
        provider,
        repoPath,
        movePath,
        controlDir,
        invocationLog,
        databasePath,
        outputDir,
        browser: desktopHandle?.browser ?? null,
        timeoutMs: options.timeoutMs,
        timeline: report.timeline,
        verifyUi,
        sendInput,
        queueInput,
        sendQueuedInput,
        terminate,
        restartBackend,
      });
    } catch (error) {
      if (options.scenario === "session-move") {
        const nativeOutput = path.join(outputDir, "native");
        const failurePath = path.join(nativeOutput, "session-move-failure.json");
        const artifacts = ["session-move-source.png", "session-move-destination.png", "session-move.json"]
          .filter((name) => existsSync(path.join(nativeOutput, name)));
        await writeJson(failurePath, { message: error.message, repoPath, movePath, artifacts });
        report.native.sessionMove = { failure: failurePath, artifacts };
      }
      throw error;
    }
    bridge = scenarioResult.bridge ?? bridge;
    if (options.scenario === "session-move") {
      report.native.sessionMove = {
        proof: path.join(outputDir, "native", "session-move.json"),
        phases: scenarioResult.browser,
      };
    }
    if (options.scenario === "staged-revert") {
      const recovery = await verifyStagedPreservingRevert({
        bridge,
        browser: desktopHandle.browser,
        workspace: scenarioResult.workspace,
        outputDir: path.join(outputDir, "native"),
        timeoutMs: options.timeoutMs
      });
      report.workspaceRecovery = recovery;
      report.assertions.push(...recovery.assertions);
    }
    report.session = { id: scenarioResult.session.id, workspaceId: scenarioResult.workspace.id, state: scenarioResult.session.state };
    report.assertions.push({ name: "scenario-state", ok: true, value: scenarioResult.session.state });
    report.assertions.push(...(scenarioResult.assertions ?? []));
    if (persistentSubagentScenarios.has(options.scenario)) {
      report.assertions.push(
        { name: "persistent-child-stable-id", ok: true, value: scenarioResult.nativeChildId },
        { name: "persistent-child-queryable-after-restart", ok: true, value: scenarioResult.agentEventCount },
      );
    }
    await writeNdjson(path.join(outputDir, "timeline.ndjson"), scenarioResult.records);
    report.debugSnapshot = redact(await bridge.call("system:debug-snapshot", { afterLogSeq: null }));
    if (desktopHandle) {
      const diagnostics = await desktopHandle.browser.execute(async function readDatabasePath() {
        return window.argmax.system.diagnostics();
      });
      databasePath = diagnostics.databasePath;
      report.database = { path: databasePath, isolated: path.resolve(databasePath) === path.resolve(profile, "local-state", "argmax.sqlite") };
      if (!report.database.isolated) throw new Error(`native app escaped its isolated database profile: ${databasePath}`);
    }
    bridge.close();
    bridge = null;
    if (desktopHandle) {
      const cleanup = await desktopHandle.close();
      desktopHandle = null;
      restoreDriverOutput?.();
      report.process.desktop.closed = true;
      report.process.desktop.cleanup = cleanup;
    } else {
      report.process.scratch.exit = await app.stop();
      app = null;
    }

    const persistence = await sqliteSnapshot(databasePath, scenarioResult.session.id);
    await writeJson(path.join(outputDir, "database.json"), persistence);
    const persistedSession = persistence.sessions.find((entry) => entry.id === scenarioResult.session.id);
    const persistedMessages = [...persistence.events.map((entry) => entry.message), ...persistence.rawOutputs.map((entry) => entry.content)];
    const persistenceAssertions = [
      { name: "sqlite-session-persisted", ok: Boolean(persistedSession) },
      { name: "sqlite-terminal-state-persisted", ok: persistedSession?.state === scenarioResult.session.state, value: persistedSession?.state },
      ...expectedPersistenceTexts(options.scenario).map((text) => ({
        name: `sqlite-event-persisted:${text}`,
        ok: persistedMessages.some((message) => message.includes(text))
      }))
    ];
    if (options.scenario === "chat-resume" || options.scenario === "queued-restart" || options.scenario === "session-move") {
      persistenceAssertions.push({
        name: "sqlite-provider-conversation-persisted",
        ok: persistedSession?.providerConversationId === (options.scenario === "session-move"
          ? VERIFICATION_MOVED_CONVERSATION_ID
          : VERIFICATION_CONVERSATION_ID),
        value: persistedSession?.providerConversationId
      });
    }
    report.assertions.push(...persistenceAssertions);
    const persistenceFailure = persistenceAssertions.find((assertion) => !assertion.ok);
    if (persistenceFailure) throw new Error(`persistence assertion failed: ${persistenceFailure.name}`);

    report.source.afterRun = await checkoutFingerprint(repoRoot);
    if (report.source.afterBuild.sha256 !== report.source.afterRun.sha256) throw new Error("checkout changed during verification; evidence does not describe one source state");
    if (await fileSha256(binary) !== binarySha256) throw new Error("verification binary changed during the run");
    if (await fileSha256(nativeBinary) !== nativeBinarySha256) throw new Error("native verification binary changed during the run");
    report.assertions.push({ name: "checkout-stable", ok: true });
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.errors.push({ message: error.message, stack: error.stack });
  } finally {
    if (interrupting) return { report, outputDir };
    const launchedSessionId = scenarioResult?.session.id ?? report.timeline.find((entry) => entry.type === "session-launched")?.sessionId;
    if (bridge) {
      try {
        report.debugSnapshot ??= redact(await bridge.call("system:debug-snapshot", { afterLogSeq: null }));
      } catch (error) {
        report.errors.push({ message: `debug snapshot failed: ${error.message}` });
      }
      if (launchedSessionId) {
        try {
          const batch = await bridge.call("session:events-since", {
            sessionId: launchedSessionId,
            eventCursor: null,
            rawOutputCursor: null,
            changeCursor: null
          });
          const records = [
            ...batch.events.map((event) => ({ kind: "event", ...event })),
            ...batch.rawOutputs.map((output) => ({ kind: "rawOutput", ...output }))
          ];
          await writeNdjson(path.join(outputDir, "timeline.ndjson"), records);
        } catch (error) {
          report.errors.push({ message: `timeline collection failed: ${error.message}` });
        }
        if (report.status === "failed") {
          await terminateProviderForCleanup(bridge, launchedSessionId, report, "failed-run");
        }
      }
      bridge.close();
    }
    if (desktopHandle) {
      if (report.status === "failed") {
        try {
          await mkdir(path.join(outputDir, "native"), { recursive: true });
          const screenshot = path.join(outputDir, "native", "failure.png");
          await desktopHandle.browser.saveScreenshot(screenshot);
          const uiState = await desktopHandle.browser.execute(function captureFailureState() {
            return {
              title: document.title,
              bodyText: document.body.innerText.slice(0, 10_000),
              diagnostics: window.__ARGMAX_VERIFICATION__?.snapshot() ?? null
            };
          });
          report.native.failureEvidence = { screenshot, uiState };
        } catch (error) {
          report.errors.push({ message: `native failure evidence failed: ${error.message}` });
        }
      }
      try {
        const cleanup = await desktopHandle.close();
        restoreDriverOutput?.();
        report.process.desktop = { ...report.process.desktop, closed: true, cleanup };
      } catch (error) {
        report.status = "failed";
        report.errors.push({ message: `desktop cleanup failed: ${error.message}` });
      }
    }
    restoreDriverOutput?.();
    if (app) {
      try {
        report.process.scratch.exit = await app.stop();
      } catch (error) {
        report.status = "failed";
        report.errors.push({ message: `scratch cleanup failed: ${error.message}` });
      }
    }
    if (launchedSessionId && existsSync(databasePath) && !existsSync(path.join(outputDir, "database.json"))) {
      try {
        await writeJson(path.join(outputDir, "database.json"), await sqliteSnapshot(databasePath, launchedSessionId));
      } catch (error) {
        report.errors.push({ message: `failure database snapshot failed: ${error.message}` });
      }
    }
    await copyIfPresent(path.join(profile, "app.log"), path.join(outputDir, "app.log"));
    await redactEvidenceTextFiles(outputDir);
    report.finishedAt = new Date().toISOString();
    report.keptRunRoot = options.keep ? runRoot : null;
    if (options.keep) report.replay = replayDetails({ report, repoRoot, home, profile, env, fixturePath, provider });
    if (!options.keep) await rm(runRoot, { recursive: true, force: true });
    report.evidenceFiles = [...await listEvidenceFiles(outputDir), "report.json"].sort();
    await writeJson(path.join(outputDir, "report.json"), report);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
  return { report, outputDir };
}

async function main() {
  try {
    const options = parseVerifyArgs(process.argv.slice(2));
    const { report, outputDir } = await runVerification(options);
    process.stderr.write(`${report.status === "passed" ? "PASS" : "FAIL"} ${report.scenario} evidence=${outputDir}\n`);
    process.stdout.write(`${JSON.stringify({ ok: report.status === "passed", scenario: report.scenario, evidence: outputDir, report: path.join(outputDir, "report.json") })}\n`);
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`verification setup failed: ${error.message}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
