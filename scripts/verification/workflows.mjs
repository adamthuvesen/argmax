// Native proof for the agent-workflow features:
//
//   composer-reference  an ordinary-chat reference chip in the New chat
//                       composer, its draft persistence, and a background
//                       launch from the real composer
//   composer-editor     the real CodeMirror composer in the native window:
//                       typing, @ chip, undo, atomic chip delete, copy and cut
//                       payloads, and Enter right after a menu pick
//   workspace-settings  Settings branch-name and linked-repository forms, the
//                       branch they produce, and the snooze shelf
//   fork-merge          a portable fork at a selected finished turn, and the
//                       fork's findings merged back into a running source
//                       exactly once
//   browser-focus       a page in a hidden agent browser tab focusing its own
//                       field leaves the New chat composer with the keyboard
//
// Both run in the disposable app `scripts/verify.mjs` builds, against the
// scripted Claude fixture. Keys, clicks and visible text go through the native
// WebView; IPC and SQLite are the second read. Nothing here mocks a production
// path except native folder selection, whose result is scripted below.

import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { delay, runChecked } from "./common.mjs";
import { ensureDesktopForeground, openContextMenu, pressChord, pressMouseDown, readComposerText, selectComposerText, setInputValue, typeIntoComposer, waitForCodeMirror } from "./desktop.mjs";
import { writeJson } from "./evidence.mjs";
import {
  VERIFICATION_BARRIERS,
  VERIFICATION_FORK_MERGE_MARKER,
  VERIFICATION_PROVIDER,
  VERIFICATION_SCENARIOS,
} from "./provider-fixture.mjs";

const LAUNCHER_PROMPT_LABEL = "Task prompt";
const SESSION_PROMPT_LABEL = "Chat prompt";
const DRAFTS_STORAGE_KEY = "argmax.composer.drafts";
const LAUNCH_MODEL_STORAGE_KEY = "argmax.launch.model";
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

// The assertions of the workflow that is running, so a failed drive can still
// show which ones passed before it stopped (the report only takes them on success).
const progress = { assertions: [], diagnostics: [] };
export function workflowProgress() {
  return progress.assertions;
}
// Observations a failed drive needs to be read without a rerun (target
// identity, menu contents). They are evidence, never assertions.
export function workflowDiagnostics() {
  return progress.diagnostics;
}
function diagnose(name, value) {
  progress.diagnostics.push({ name, at: new Date().toISOString(), value });
}

// What the sidebar shows for a workspace right now: every element the row
// selector matches, with its identity and whether it is attached and laid out,
// and the shelf toggle's state.
async function describeSnoozeShelf(browser, workspaceId) {
  return browser.execute(function describe(id) {
    const matches = [...document.querySelectorAll(`[data-workspace-id="${id}"] button[title]`)].map((element) => {
      const box = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return {
        title: element.getAttribute("title"),
        connected: element.isConnected,
        rect: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)],
        opacity: style.opacity,
        laidOut: element.offsetParent !== null,
      };
    });
    const toggles = [...document.querySelectorAll('[aria-label$="Snoozed chats"]')].map((element) => ({
      label: element.getAttribute("aria-label"),
      expanded: element.getAttribute("aria-expanded"),
    }));
    const menuItems = [...document.querySelectorAll('[role="menuitem"]')].map((element) => element.textContent.trim());
    return { rows: document.querySelectorAll(`[data-workspace-id="${id}"]`).length, matches, toggles, menuItems };
  }, workspaceId);
}

function check(assertions, name, condition, value = undefined) {
  if (!condition) {
    throw new Error(`workflow verification failed: ${name}${value === undefined ? "" : ` (${JSON.stringify(value)})`}`);
  }
  assertions.push({ name, ok: true, ...(value === undefined ? {} : { value }) });
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await delay(50);
    }
  }
  throw new Error(`fixture barrier did not arrive: ${path.basename(filePath)}`);
}

async function readAllEvents(bridge, sessionId) {
  const events = [];
  let eventCursor = 0;
  let rawOutputCursor = 0;
  for (;;) {
    const page = await bridge.call("session:events-since", {
      sessionId,
      eventCursor,
      rawOutputCursor,
      changeCursor: null,
    });
    events.push(...page.events);
    eventCursor = page.eventCursor;
    rawOutputCursor = page.rawOutputCursor;
    if (!page.hasMore) return events;
  }
}

async function waitForSession(bridge, sessionId, accept, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const dashboard = await bridge.call("dashboard:list", {});
    last = dashboard.sessions.find((entry) => entry.id === sessionId) ?? null;
    if (last && accept(last, dashboard)) return { session: last, dashboard };
    await delay(150);
  }
  throw new Error(`${label}: session ${sessionId} did not get there within ${timeoutMs}ms (last state ${last?.state ?? "missing"})`);
}

async function waitForEventText(bridge, sessionId, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await readAllEvents(bridge, sessionId);
    if (events.some((event) => String(event.message ?? "").includes(text))) return events;
    await delay(150);
  }
  throw new Error(`session ${sessionId} did not show "${text}" within ${timeoutMs}ms`);
}

async function waitForCompleted(bridge, sessionId, timeoutMs, label) {
  const { session } = await waitForSession(bridge, sessionId, (entry) => entry.state === "complete", timeoutMs, label);
  return session;
}

// sqlite3 prints nothing for an empty result set. Ids come from our own IPC
// replies, so they are checked rather than bound (the CLI cannot bind).
async function sqliteRows(databasePath, sql) {
  const { stdout } = await runChecked("sqlite3", ["-json", databasePath, sql], { timeoutMs: 20_000 });
  const text = stdout.trim();
  return text ? JSON.parse(text) : [];
}

function safeId(value) {
  if (!SAFE_ID.test(value)) throw new Error(`refusing to put an unexpected id in SQL: ${value}`);
  return value;
}

async function sessionUserMessages(databasePath, sessionId) {
  return sqliteRows(
    databasePath,
    `SELECT id, message FROM events WHERE session_id = '${safeId(sessionId)}' AND type = 'user.message' ORDER BY rowid`,
  );
}

// A conversation launch starts a chat's provider process. The follow-up
// suggestion and title one-shots reuse the same binary with no session
// (`--no-session-persistence --tools ""`); they are helper calls, counted apart.
function isConversationLaunch(args) {
  return args.includes("--brief") || args.includes("--resume") || args.includes("--session-id") || args.includes("stream-json");
}

async function readInvocations(invocationLog) {
  const lines = (await readFile(invocationLog, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const invocations = [];
  let lastConversationLaunch = null;
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.args) {
      invocations.push({ args: entry.args, cwd: entry.cwd });
      if (isConversationLaunch(entry.args)) lastConversationLaunch = invocations.at(-1);
    } else if (typeof entry.prompt === "string" && lastConversationLaunch) {
      // A prompt record belongs to the conversation launch that logged it. A
      // helper one-shot (follow-up suggestion, title) can log its own args line
      // in between, and carries its prompt in argv, so it never gets one here.
      lastConversationLaunch.prompt = entry.prompt;
    }
  }
  return invocations;
}

async function bodyText(browser) {
  return browser.execute(function readBody() {
    return document.body.innerText;
  });
}

async function readDrafts(browser) {
  return browser.execute(function readStoredDrafts(key) {
    try {
      const stored = JSON.parse(window.localStorage.getItem(key) ?? "{}");
      return Object.entries(stored).map(([draftKey, draft]) => ({
        key: draftKey,
        text: typeof draft === "string" ? draft : String(draft?.text ?? ""),
      }));
    } catch {
      return [];
    }
  }, DRAFTS_STORAGE_KEY);
}

async function screenshot(browser, evidenceDir, name) {
  const file = path.join(evidenceDir, `${name}.png`);
  await browser.pause(100);
  await browser.saveScreenshot(file);
  return file;
}

async function openWorkspaceRow(browser, workspaceId, timeoutMs) {
  let row = null;
  await browser.waitUntil(
    async () => {
      const matches = await browser.$$(`[data-workspace-id="${workspaceId}"] button[title]`);
      if (matches.length > 0) {
        [row] = matches;
        return true;
      }
      const expanders = await browser.$$('button[aria-label^="Show "][aria-label$=" chats"]');
      for (const expander of expanders) await expander.click();
      return false;
    },
    { timeout: timeoutMs, interval: 250, timeoutMsg: `Sidebar row for workspace ${workspaceId} was not visible` },
  );
  await row.click();
  await ensureDesktopForeground(browser);
}

async function waitForIdleControls(browser, timeoutMs) {
  await browser.waitUntil(
    async () =>
      browser.execute(function sessionIsIdle() {
        return document.querySelector('[aria-label="Send follow-up"]') instanceof HTMLButtonElement
          && document.querySelector('[aria-label="Stop chat"]') === null;
      }),
    { timeout: timeoutMs, interval: 100, timeoutMsg: "Chat did not render idle controls" },
  );
}

async function openLauncher(browser, timeoutMs) {
  await ensureDesktopForeground(browser);
  const newChat = await browser.$('button[aria-label="New chat"]');
  await newChat.waitForClickable({ timeout: timeoutMs });
  await newChat.click();
  // The real editor, not the textarea shown while its chunk loads.
  return waitForCodeMirror(browser, LAUNCHER_PROMPT_LABEL, timeoutMs);
}

// The New chat launcher sends with its stored default model. Pin it to the
// model whose provider the fixture stands in for, then reload so the shell
// reads it, so the background launch cannot route to a provider with no fixture.
async function pinLauncherModel(browser, timeoutMs) {
  await browser.execute(function pinModel(key, value) {
    window.localStorage.setItem(key, value);
  }, LAUNCH_MODEL_STORAGE_KEY, JSON.stringify({ provider: VERIFICATION_PROVIDER.provider, modelId: VERIFICATION_PROVIDER.modelId }));
  await browser.refresh();
  const newChat = await browser.$('button[aria-label="New chat"]');
  await newChat.waitForDisplayed({ timeout: timeoutMs });
}

// The scripted remaining-usage source (usage/remaining/verification.rs) reports
// 37% used in the 5-hour window and 12% in the weekly one. The chip must show
// the tighter window within five seconds of the composer, in the real WebView,
// and its popover must list both windows.
const USAGE_CHIP_DEADLINE_MS = 5_000;

async function verifyUsageChip(browser, evidenceDir, assertions, screenshots) {
  const started = Date.now();
  const chip = await browser.$('button.composer-usage-chip[aria-label^="Claude plan:"]');
  await chip.waitForDisplayed({
    timeout: USAGE_CHIP_DEADLINE_MS,
    timeoutMsg: `The Claude usage chip did not appear within ${USAGE_CHIP_DEADLINE_MS}ms`,
  });
  const appearedAfterMs = Date.now() - started;
  const label = await chip.getAttribute("aria-label");
  check(
    assertions,
    "usage-chip-shows-the-tightest-window",
    label.includes("63% left in the 5-hour window") && label.includes("resets in") && (await chip.getAttribute("data-old")) === null,
    { label, appearedAfterMs },
  );
  await chip.click();
  const popover = await browser.$('[role="dialog"][aria-label="Plan usage"]');
  await popover.waitForDisplayed({ timeout: 5_000, timeoutMsg: "The usage popover did not open" });
  const text = await popover.getText();
  check(
    assertions,
    "usage-popover-lists-both-windows",
    ["5-hour", "Weekly", "63%", "88%"].every((part) => text.includes(part)),
    text,
  );
  screenshots.push(await screenshot(browser, evidenceDir, "usage-popover"));
  await browser.keys(["Escape"]);
  await popover.waitForExist({ reverse: true, timeout: 5_000, timeoutMsg: "Escape did not close the usage popover" });
  check(assertions, "usage-popover-closes-on-escape", true);
}

async function launcherChips(browser) {
  return browser.execute(function readChips() {
    return [...document.querySelectorAll(".composer-chat-chip")].map((chip) => ({
      status: chip.getAttribute("data-status"),
      label: chip.getAttribute("aria-label"),
    }));
  });
}

/**
 * Ordinary-chat reference chip in the real New chat composer, kept in the
 * draft across a trip to another chat, then sent to the background with the
 * remappable chord (default Alt+Enter) while the launcher stays open.
 */
export async function verifyComposerReference({
  bridge,
  browser,
  source,
  workspace,
  project,
  outputDir,
  databasePath,
  timeoutMs,
  verifyUi,
}) {
  const scenarios = VERIFICATION_SCENARIOS;
  const evidenceDir = path.join(outputDir, "native");
  await mkdir(evidenceDir, { recursive: true });
  const assertions = (progress.assertions = []);
  const phases = [];
  const sourceTitle = scenarios.composerSource.taskLabel;
  const sourceLink = `argmax://chat/${source.id}`;

  await pinLauncherModel(browser, timeoutMs);
  const sourceDone = await waitForCompleted(bridge, source.id, timeoutMs, "reference source chat");
  check(assertions, "source-chat-completed", sourceDone.state === "complete");
  phases.push(await verifyUi({
    name: "reference-source",
    expectedTexts: [scenarios.composerSource.visibleText],
    expectIdle: true,
  }));
  const sourceEventsBefore = (await readAllEvents(bridge, source.id)).length;

  // 1. Attach the source as a chip from the `@` menu.
  const launcher = await openLauncher(browser, timeoutMs);
  const usageShots = [];
  await verifyUsageChip(browser, evidenceDir, assertions, usageShots);
  await typeIntoComposer(
    browser,
    launcher,
    `${scenarios.composerBackground.prompt} compare with @Reference`,
  );
  await pickChatFromMenu(browser, sourceTitle);
  await browser.waitUntil(async () => (await launcherChips(browser)).length === 1, {
    timeout: 5_000,
    interval: 100,
    timeoutMsg: "Selecting the chat did not draw a reference chip",
  });
  const [chip] = await launcherChips(browser);
  check(assertions, "reference-chip-resolved", chip.status === "resolved" && chip.label.includes(sourceTitle), chip);
  await typeIntoComposer(browser, launcher, "and summarize");
  const draftShot = await screenshot(browser, evidenceDir, "reference-chip-in-composer");

  // 2. The stored draft is the plain link text, not a second copy of the chip.
  let draft = null;
  await browser.waitUntil(
    async () => {
      draft = (await readDrafts(browser)).find((entry) => entry.text.includes(sourceLink)) ?? null;
      return draft !== null;
    },
    { timeout: 5_000, interval: 150, timeoutMsg: "The draft with the reference was never stored" },
  );
  check(assertions, "draft-stores-link-text", draft.text.includes(`[${sourceTitle}](${sourceLink}`) && draft.text.includes(scenarios.composerBackground.prompt), draft.text);

  // 3. Leave for another chat and come back: the chip is restored.
  phases.push(await verifyUi({
    name: "reference-draft-away",
    expectedTexts: [scenarios.composerSource.visibleText],
    expectIdle: true,
  }));
  const restored = await openLauncher(browser, timeoutMs);
  await browser.waitUntil(async () => (await launcherChips(browser)).length === 1, {
    timeout: 10_000,
    interval: 150,
    timeoutMsg: "The reference chip was not restored when the launcher came back",
  });
  const restoredText = await readComposerText(browser, restored);
  check(assertions, "draft-restored-after-navigation", restoredText.includes(sourceLink) && restoredText.includes("and summarize"), restoredText);
  const restoredShot = await screenshot(browser, evidenceDir, "reference-chip-restored");

  // 4. Background send: the chord launches and leaves the launcher in place.
  const sessionsBefore = (await bridge.call("dashboard:list", {})).sessions.map((entry) => entry.id);
  const chordField = await browser.$(`[aria-label="${LAUNCHER_PROMPT_LABEL}"]`);
  await browser.execute(function focusField(element) {
    element.focus();
  }, chordField);
  // `browser.keys` drops the Alt modifier from Enter, so the chord is sent as a
  // keydown that carries it; the launcher's own handler must act on it.
  check(assertions, "alt-enter-chord-is-handled", await pressChord(browser, { key: "Enter", altKey: true }));
  let background = null;
  await browser.waitUntil(
    async () => {
      const dashboard = await bridge.call("dashboard:list", {});
      background = dashboard.sessions.find((entry) => !sessionsBefore.includes(entry.id)) ?? null;
      return background !== null;
    },
    { timeout: 20_000, interval: 150, timeoutMsg: "Alt+Enter did not start a new chat" },
  );
  const backgroundShot = await screenshot(browser, evidenceDir, "reference-background-launched");
  const afterLaunch = await browser.execute(function launcherState(promptLabel, sessionLabel) {
    return {
      launcherOpen: document.querySelector(`[aria-label="${promptLabel}"]`) !== null,
      sessionComposerOpen: document.querySelector(`[aria-label="${sessionLabel}"]`) !== null,
      chipCount: document.querySelectorAll(".composer-chat-chip").length,
      bodyText: document.body.innerText,
    };
  }, LAUNCHER_PROMPT_LABEL, SESSION_PROMPT_LABEL);
  check(assertions, "launcher-stays-open-after-background-send", afterLaunch.launcherOpen && !afterLaunch.sessionComposerOpen);
  check(assertions, "launcher-resets-for-next-draft", afterLaunch.chipCount === 0);
  const launcherAfter = await browser.$(`[aria-label="${LAUNCHER_PROMPT_LABEL}"]`);
  check(assertions, "launcher-text-cleared", (await readComposerText(browser, launcherAfter)) === "");
  check(
    assertions,
    "stored-draft-cleared",
    !(await readDrafts(browser)).some((entry) => entry.text.includes(sourceLink)),
  );
  await browser.waitUntil(async () => (await bodyText(browser)).includes("in the background"), {
    timeout: 10_000,
    interval: 150,
    timeoutMsg: "No 'started in the background' toast appeared",
  });

  // 5. The backend side: one new chat, in the same project, carrying the link.
  const done = await waitForCompleted(bridge, background.id, timeoutMs, "background chat");
  const dashboard = await bridge.call("dashboard:list", {});
  const backgroundWorkspace = dashboard.workspaces.find((entry) => entry.id === done.workspaceId);
  check(assertions, "background-chat-in-selected-project", backgroundWorkspace?.projectId === project.id);
  check(assertions, "background-chat-is-new", done.id !== source.id && done.workspaceId !== workspace.id);
  const userMessages = await sessionUserMessages(databasePath, done.id);
  const carrying = userMessages.filter((entry) => entry.message.includes(sourceLink));
  check(assertions, "background-prompt-carries-link-once", userMessages.length === 1 && carrying.length === 1, userMessages.map((entry) => entry.message));
  check(assertions, "source-chat-untouched", (await readAllEvents(bridge, source.id)).length === sourceEventsBefore);
  const pending = await sqliteRows(databasePath, "SELECT count(*) AS n FROM pending_messages");
  check(assertions, "no-queued-messages-left", pending[0].n === 0);
  const events = await readAllEvents(bridge, done.id);

  // 6. Open the new chat from its row; its transcript chip opens the source.
  phases.push(await verifyUi({
    name: "reference-background-chat",
    titleIncludes: backgroundWorkspace.taskLabel,
    expectedTexts: [scenarios.composerBackground.visibleText],
    expectIdle: true,
  }));
  check(assertions, "source-text-not-in-background-chat", !(await bodyText(browser)).includes(scenarios.composerSource.visibleText));
  const sourceChip = await browser.$(`button[aria-label="Open chat: ${sourceTitle}"]`);
  await sourceChip.waitForDisplayed({ timeout: 10_000 });
  await sourceChip.click();
  await browser.waitUntil(async () => (await bodyText(browser)).includes(scenarios.composerSource.visibleText), {
    timeout: 10_000,
    interval: 150,
    timeoutMsg: "Clicking the source chip did not open the source chat",
  });
  check(assertions, "transcript-chip-opens-source-chat", true);
  const chipShot = await screenshot(browser, evidenceDir, "reference-chip-opened-source");

  await writeJson(path.join(evidenceDir, "composer-reference.json"), {
    sourceSessionId: source.id,
    backgroundSessionId: done.id,
    draft: draft.text,
    screenshots: [...usageShots, draftShot, restoredShot, backgroundShot, chipShot],
    assertions,
  });
  return {
    session: done,
    workspace: backgroundWorkspace,
    records: events.map((event) => ({ kind: "event", ...event })),
    browser: phases,
    assertions,
  };
}

const MERGE_DIALOG = '[role="dialog"][aria-label="Bring findings back"]';
const FORK_FROM_TURN = "Fork from this turn";
const FORK_FROM_TURN_ISOLATED = "Fork from this turn into an isolated checkout";

async function forkRows(databasePath, sourceId) {
  return sqliteRows(
    databasePath,
    `SELECT id, child_session_id, boundary_event_id, workspace_mode, native_mode FROM session_forks WHERE source_session_id = '${safeId(sourceId)}' ORDER BY created_at, rowid`,
  );
}

// A turn's footer actions are hidden until the pointer is over the turn, so
// hover first, then click, the way a person reaches them.
async function clickTurnForkAction(browser, label, turnIndex) {
  const buttons = await browser.$$(`button[aria-label="${label}"]`);
  if (buttons.length <= turnIndex) throw new Error(`Expected a "${label}" action on turn ${turnIndex + 1}, found ${buttons.length}`);
  await buttons[turnIndex].scrollIntoView({ block: "center" });
  await buttons[turnIndex].moveTo();
  await buttons[turnIndex].click();
}

async function clickInForkBar(browser, label, timeoutMs) {
  const control = await browser.$(`//*[@aria-label="Forked chat"]//button[normalize-space(.)="${label}"]`);
  await control.waitForClickable({ timeout: timeoutMs, timeoutMsg: `The fork bar never offered "${label}"` });
  await control.click();
}

async function openMergeDialog(browser, timeoutMs) {
  await clickInForkBar(browser, "Bring findings back", timeoutMs);
  const dialog = await browser.$(MERGE_DIALOG);
  await dialog.waitForDisplayed({ timeout: timeoutMs });
  await browser.waitUntil(async () => !(await dialog.getText()).includes("Reading the fork"), {
    timeout: timeoutMs,
    interval: 150,
    timeoutMsg: "The merge dialog never finished reading the fork",
  });
  return browser.execute(function readMergeDialog(selector) {
    const dialog = document.querySelector(selector);
    return {
      summary: dialog.querySelector(".fork-merge-summary")?.textContent ?? "",
      notes: [...dialog.querySelectorAll(".fork-merge-note")].map((note) => note.textContent),
      text: dialog.querySelector('pre[aria-label="Message the source will receive"]')?.textContent ?? null,
      buttons: [...dialog.querySelectorAll("footer button")].map((button) => button.textContent.trim()),
    };
  }, MERGE_DIALOG);
}

async function clickMergeDialogButton(browser, label, timeoutMs) {
  const button = await browser.$(`//*[@role="dialog"][@aria-label="Bring findings back"]//footer//button[normalize-space(.)="${label}"]`);
  await button.waitForClickable({ timeout: timeoutMs, timeoutMsg: `The merge dialog has no "${label}" button` });
  await button.click();
  await browser.$(MERGE_DIALOG).then((dialog) => dialog.waitForExist({ reverse: true, timeout: timeoutMs }));
}

/**
 * Fork at a selected finished turn from the turn's own footer action, then
 * bring the fork's findings back from the fork bar to a source that is still
 * working: the merge queues once, drains once, and the next merge carries only
 * new work. Fork and merge are clicked in the native window. IPC and SQLite are
 * the second read.
 */
export async function verifyForkMergeBack({
  bridge,
  browser,
  source,
  workspace,
  controlDir,
  invocationLog,
  databasePath,
  outputDir,
  timeoutMs,
  verifyUi,
  sendInput,
}) {
  const scenarios = VERIFICATION_SCENARIOS;
  const evidenceDir = path.join(outputDir, "native");
  await mkdir(evidenceDir, { recursive: true });
  const assertions = (progress.assertions = []);
  const phases = [];
  const sendToSource = (sessionId, input) => bridge.call("providers:send-input", {
    sessionId,
    input,
    provider: null,
    modelLabel: null,
    modelId: null,
    reasoningEffort: null,
    fastMode: false,
  });
  const bodyHas = (text) => bodyText(browser).then((body) => body.includes(text));
  const waitForBody = (text, message) => browser.waitUntil(() => bodyHas(text), { timeout: 15_000, interval: 150, timeoutMsg: message });

  // Two finished turns, so the fork point is a selected earlier turn.
  await waitForCompleted(bridge, source.id, timeoutMs, "fork source turn one");
  await sendToSource(source.id, scenarios.forkTurnTwo.prompt);
  await waitForEventText(bridge, source.id, scenarios.forkTurnTwo.visibleText, timeoutMs);
  await waitForCompleted(bridge, source.id, timeoutMs, "fork source turn two");
  const sourceEvents = await readAllEvents(bridge, source.id);
  const boundary = sourceEvents.find(
    (event) => event.type === "user.message" && String(event.message).includes(scenarios.forkTurnOne.prompt),
  );
  check(assertions, "turn-one-boundary-found", Boolean(boundary));
  const sourceSnapshot = JSON.stringify(sourceEvents.map((event) => [event.id, event.type, event.message ?? null]));
  const invocationsBeforeFork = await readInvocations(invocationLog);
  const launchesBeforeFork = invocationsBeforeFork.filter((entry) => isConversationLaunch(entry.args)).length;

  // 1. Fork from turn one's footer action. Turn two's footer offers the same
  // action, so the boundary in SQLite is what proves the selected turn.
  await openWorkspaceRow(browser, workspace.id, timeoutMs);
  await waitForBody(scenarios.forkTurnTwo.visibleText, "The source chat never showed turn two");
  await clickTurnForkAction(browser, FORK_FROM_TURN, 0);
  let forks = [];
  await browser.waitUntil(async () => (forks = await forkRows(databasePath, source.id)).length === 1, {
    timeout: 20_000,
    interval: 200,
    timeoutMsg: `Clicking "${FORK_FROM_TURN}" on turn one created no fork`,
  });
  const [forkRow] = forks;
  check(assertions, "fork-boundary-is-the-clicked-turn", forkRow.boundary_event_id === boundary.id, forkRow);
  check(assertions, "fork-is-portable-and-shares-the-checkout", forkRow.native_mode === "none" && forkRow.workspace_mode === "shared", forkRow);
  const childId = forkRow.child_session_id;
  const dashboardAfterFork = await bridge.call("dashboard:list", {});
  const child = dashboardAfterFork.sessions.find((entry) => entry.id === childId);
  const childWorkspace = dashboardAfterFork.workspaces.find((entry) => entry.id === child.workspaceId);
  check(assertions, "fork-is-a-new-chat", childId !== source.id && childWorkspace.id !== workspace.id);
  check(assertions, "fork-has-no-native-conversation-yet", !child.providerConversationId);
  const childEvents = await readAllEvents(bridge, childId);
  const childText = childEvents.map((event) => String(event.message ?? "")).join("\n");
  check(assertions, "fork-copies-turn-one", childText.includes(scenarios.forkTurnOne.visibleText));
  check(
    assertions,
    "fork-leaves-out-turn-two",
    !childText.includes(scenarios.forkTurnTwo.visibleText) && !childText.includes(scenarios.forkTurnTwo.prompt),
  );
  check(
    assertions,
    "fork-leaves-source-unchanged",
    JSON.stringify((await readAllEvents(bridge, source.id)).map((event) => [event.id, event.type, event.message ?? null])) === sourceSnapshot,
  );
  await delay(1_000);
  const invocationsAfterFork = await readInvocations(invocationLog);
  check(
    assertions,
    "fork-starts-no-provider-conversation",
    invocationsAfterFork.filter((entry) => isConversationLaunch(entry.args)).length === launchesBeforeFork,
    { helperOneShotsSinceFork: invocationsAfterFork.slice(invocationsBeforeFork.length).filter((entry) => !isConversationLaunch(entry.args) && entry.args.includes("--no-session-persistence")).length },
  );
  const lineage = await bridge.call("session:fork-lineage", { sessionId: childId });
  check(
    assertions,
    "lineage-names-source-and-boundary",
    lineage?.sourceSessionId === source.id && lineage.boundaryEventId === boundary.id && lineage.workspace === "shared" && lineage.lastMergedThroughEventId == null,
    lineage,
  );

  // 2. The app opened the fork: its bar, history and first message.
  // The action's own comment says it jumps into the fork; a fork that exists
  // in the sidebar while the app stays on the source is a failure, not a cue
  // for the driver to click the new row.
  const bar = await browser.$('[aria-label="Forked chat"]');
  const opened = await bar.waitForDisplayed({ timeout: 15_000 }).catch(() => false);
  check(assertions, "fork-action-opens-the-new-chat", opened === true, { childSessionId: childId });
  phases.push(await verifyUi({
    name: "fork-child-history",
    titleIncludes: childWorkspace.taskLabel,
    expectedTexts: [scenarios.forkTurnOne.visibleText],
    expectIdle: true,
  }));
  check(assertions, "child-chat-hides-turn-two", !(await bodyHas(scenarios.forkTurnTwo.visibleText)));
  const barShot = await screenshot(browser, evidenceDir, "fork-bar");
  await clickInForkBar(browser, "Open source", 10_000);
  await waitForBody(scenarios.forkTurnTwo.visibleText, '"Open source" did not open the source chat');
  check(assertions, "open-source-action-opens-the-source", true);
  await openWorkspaceRow(browser, childWorkspace.id, timeoutMs);
  await sendInput(childId, scenarios.forkChild.prompt);
  await waitForEventText(bridge, childId, scenarios.forkChild.visibleText, timeoutMs);
  await waitForCompleted(bridge, childId, timeoutMs, "fork child first turn");
  phases.push(await verifyUi({
    name: "fork-child-first-turn",
    titleIncludes: childWorkspace.taskLabel,
    expectedTexts: [scenarios.forkChild.visibleText],
    expectIdle: true,
  }));
  const childLaunch = (await readInvocations(invocationLog)).find((entry) => entry.prompt?.includes(scenarios.forkChild.prompt));
  check(assertions, "child-first-turn-reached-the-provider", Boolean(childLaunch));
  check(
    assertions,
    "child-starts-a-fresh-provider-conversation",
    !childLaunch.args.includes("--resume") && !childLaunch.args.includes("--fork-session"),
    childLaunch.args,
  );
  const portable = childLaunch.prompt;
  check(
    assertions,
    "portable-context-holds-turn-one-only",
    (portable.includes(scenarios.forkTurnOne.visibleText) || portable.includes(scenarios.forkTurnOne.prompt))
      && !portable.includes(scenarios.forkTurnTwo.visibleText)
      && !portable.includes(scenarios.forkTurnTwo.prompt),
  );
  check(assertions, "current-prompt-stays-intact-and-single", portable.split(scenarios.forkChild.prompt).length === 2);

  // 3. Merge from the fork bar while the source works: it queues once, never steers.
  await sendToSource(source.id, scenarios.forkHold.prompt);
  await waitForFile(path.join(controlDir, `${VERIFICATION_BARRIERS.forkSourceHold}.ready`), timeoutMs);
  const running = await waitForSession(bridge, source.id, (entry) => entry.state === "running", timeoutMs, "held source turn");
  check(assertions, "source-is-running-during-merge", running.session.state === "running");
  const dialog = await openMergeDialog(browser, 10_000);
  check(
    assertions,
    "dialog-previews-fork-findings",
    dialog.text !== null
      && dialog.text.includes("Findings from the forked chat")
      && dialog.text.includes(scenarios.forkChild.visibleText)
      && !dialog.text.includes(scenarios.forkTurnTwo.visibleText)
      && /new message/.test(dialog.summary),
    { summary: dialog.summary },
  );
  check(
    assertions,
    "dialog-says-the-source-queue-waits",
    dialog.notes.some((note) => note.includes("waits in its queue")) && dialog.buttons.includes("Queue for source"),
    dialog,
  );
  const dialogShot = await screenshot(browser, evidenceDir, "fork-merge-dialog");
  await clickMergeDialogButton(browser, "Queue for source", 10_000);
  await waitForBody("Queued for", "No 'Queued for …' toast followed the merge");
  check(assertions, "native-merge-queued-toast", true);
  const claimed = await sqliteRows(databasePath, `SELECT through_event_id FROM fork_merges WHERE fork_id = '${safeId(lineage.forkId)}'`);
  check(assertions, "one-merge-range-claimed", claimed.length === 1, claimed);
  const throughEventId = claimed[0].through_event_id;
  const queuedRows = await sqliteRows(
    databasePath,
    `SELECT id, content FROM pending_messages WHERE session_id = '${safeId(source.id)}'`,
  );
  check(
    assertions,
    "one-queued-merge-message",
    queuedRows.length === 1
      && queuedRows[0].content.includes(VERIFICATION_FORK_MERGE_MARKER)
      && queuedRows[0].content.includes(scenarios.forkChild.visibleText),
    queuedRows.map((row) => row.id),
  );
  const again = await openMergeDialog(browser, 10_000);
  check(assertions, "second-dialog-offers-nothing-new", again.summary.includes("Nothing new to bring back") && again.text === null && again.buttons.includes("Close"), again);
  await clickMergeDialogButton(browser, "Close", 10_000);
  const repeated = await bridge.call("session:fork-merge", { sessionId: childId, throughEventId });
  check(assertions, "repeat-merge-over-ipc-is-a-no-op", repeated.merged === false);
  await openWorkspaceRow(browser, workspace.id, timeoutMs);
  await browser.waitUntil(
    async () => (await browser.$$('button[aria-label^="Send queued follow-up: Findings from the forked chat"]')).length === 1,
    { timeout: 10_000, interval: 150, timeoutMsg: "The source chat did not show exactly one queued merge message" },
  );
  check(assertions, "native-source-shows-queued-merge", true);
  const queuedShot = await screenshot(browser, evidenceDir, "fork-merge-queued");

  // 4. Release the source: the queued merge drains once.
  await writeFile(path.join(controlDir, `${VERIFICATION_BARRIERS.forkSourceHold}.continue`), "continue\n");
  await waitForEventText(bridge, source.id, scenarios.forkMerge.visibleText, timeoutMs);
  const finalSource = await waitForCompleted(bridge, source.id, timeoutMs, "source after merge drain");
  const delivered = (await sessionUserMessages(databasePath, source.id)).filter((entry) => entry.message.includes(VERIFICATION_FORK_MERGE_MARKER));
  check(assertions, "merge-delivered-exactly-once", delivered.length === 1, delivered.map((entry) => entry.id));
  const leftover = await sqliteRows(databasePath, `SELECT count(*) AS n FROM pending_messages WHERE session_id = '${safeId(source.id)}'`);
  check(assertions, "queue-empty-after-drain", leftover[0].n === 0);
  const mergeInvocations = (await readInvocations(invocationLog)).filter((entry) => entry.prompt?.includes(VERIFICATION_FORK_MERGE_MARKER));
  check(assertions, "provider-received-merge-once", mergeInvocations.length === 1);
  await waitForIdleControls(browser, timeoutMs);
  await browser.waitUntil(
    async () => (await browser.$$('button[aria-label^="Send queued follow-up: Findings from the forked chat"]')).length === 0
      && (await bodyHas(scenarios.forkMerge.visibleText)),
    { timeout: 15_000, interval: 150, timeoutMsg: "The source chat did not show the delivered merge and an empty queue" },
  );
  check(assertions, "native-source-shows-delivered-merge", true);
  const deliveredShot = await screenshot(browser, evidenceDir, "fork-merge-delivered");
  await openWorkspaceRow(browser, childWorkspace.id, timeoutMs);
  const afterDelivery = await openMergeDialog(browser, 10_000);
  check(assertions, "dialog-after-delivery-offers-nothing-new", afterDelivery.summary.includes("Nothing new to bring back") && afterDelivery.text === null, afterDelivery);
  await clickMergeDialogButton(browser, "Close", 10_000);

  // 5. The next merge carries only what the fork did since.
  await sendToSource(childId, scenarios.forkChildFollowUp.prompt);
  await waitForEventText(bridge, childId, scenarios.forkChildFollowUp.visibleText, timeoutMs);
  await waitForCompleted(bridge, childId, timeoutMs, "fork child follow-up");
  const next = await openMergeDialog(browser, 10_000);
  check(
    assertions,
    "next-dialog-carries-only-new-work",
    next.text !== null
      && next.text.includes(scenarios.forkChildFollowUp.visibleText)
      && !next.text.includes(scenarios.forkChild.visibleText),
    { summary: next.summary },
  );
  await clickMergeDialogButton(browser, "Cancel", 10_000);
  check(assertions, "cancel-sends-nothing", (await sqliteRows(databasePath, `SELECT count(*) AS n FROM fork_merges WHERE fork_id = '${safeId(lineage.forkId)}'`))[0].n === 1);

  // 6. Isolated fork from the same turn: a new checkout that starts from the
  // source's current files.
  await openWorkspaceRow(browser, workspace.id, timeoutMs);
  await clickTurnForkAction(browser, FORK_FROM_TURN_ISOLATED, 0);
  let both = [];
  await browser.waitUntil(async () => (both = await forkRows(databasePath, source.id)).length === 2, {
    timeout: 60_000,
    interval: 300,
    timeoutMsg: `Clicking "${FORK_FROM_TURN_ISOLATED}" created no second fork`,
  });
  const isolated = both.find((row) => row.child_session_id !== childId);
  check(assertions, "isolated-fork-records-its-mode-and-boundary", isolated.workspace_mode === "isolated" && isolated.boundary_event_id === boundary.id, isolated);
  const dashboardNow = await bridge.call("dashboard:list", {});
  const isolatedWorkspace = dashboardNow.workspaces.find(
    (entry) => entry.id === dashboardNow.sessions.find((session) => session.id === isolated.child_session_id)?.workspaceId,
  );
  const sourceWorkspaceNow = dashboardNow.workspaces.find((entry) => entry.id === workspace.id);
  check(assertions, "isolated-fork-has-its-own-checkout", isolatedWorkspace && isolatedWorkspace.path !== sourceWorkspaceNow.path, isolatedWorkspace?.path);
  await access(path.join(isolatedWorkspace.path, "README.md"));
  check(assertions, "isolated-fork-starts-from-the-current-files", true);
  const isolatedBar = await browser.$('[aria-label="Forked chat"]');
  await isolatedBar.waitForDisplayed({ timeout: 15_000 });
  await browser.waitUntil(async () => (await isolatedBar.getText()).includes("isolated checkout"), {
    timeout: 10_000,
    interval: 150,
    timeoutMsg: "The isolated fork's bar did not say it is isolated",
  });
  check(assertions, "native-isolated-fork-bar", true);
  const isolatedShot = await screenshot(browser, evidenceDir, "fork-isolated");

  const coverage = {
    forkAndMergeDrive: "native clicks: turn footer fork actions (shared and isolated), fork bar Open source and Bring findings back, merge dialog Queue for source, Close and Cancel",
    secondRead: "SQLite (session_forks, fork_merges, pending_messages, events), IPC (session:fork-lineage, repeated session:fork-merge), provider prompt log",
    notDriven: "merge into an idle source (Send to source), and a fork of a running source",
  };
  await writeJson(path.join(evidenceDir, "fork-merge.json"), {
    sourceSessionId: source.id,
    childSessionId: childId,
    isolatedChildSessionId: isolated.child_session_id,
    boundaryEventId: boundary.id,
    mergeThroughEventId: throughEventId,
    screenshots: [barShot, dialogShot, queuedShot, deliveredShot, isolatedShot],
    coverage,
    assertions,
  });
  return {
    session: finalSource,
    workspace,
    records: (await readAllEvents(bridge, source.id)).map((event) => ({ kind: "event", ...event })),
    browser: phases,
    assertions,
    coverage,
  };
}


const SNOOZE_HOUR_MS = 60 * 60 * 1000;

// Text match for controls whose role the renderer does not fix (menu items,
// settings nav entries).
function byText(text) {
  return `//*[self::button or self::a or @role="menuitem" or @role="tab" or @role="option"][normalize-space(.)="${text}"]`;
}

async function clickByText(browser, text, timeoutMs) {
  const control = await browser.$(byText(text));
  await control.waitForClickable({ timeout: timeoutMs, timeoutMsg: `No control labelled "${text}" became clickable` });
  await control.click();
}

async function waitForText(browser, selector, expected, timeoutMs) {
  await browser.waitUntil(
    async () => {
      for (const element of await browser.$$(selector)) {
        if ((await element.getText()).includes(expected)) return true;
      }
      return false;
    },
    { timeout: timeoutMs, interval: 150, timeoutMsg: `${selector} never showed "${expected}"` },
  );
}

async function workspaceSnoozedUntil(bridge, workspaceId) {
  const dashboard = await bridge.call("dashboard:list", {});
  return dashboard.workspaces.find((entry) => entry.id === workspaceId)?.snoozedUntil ?? null;
}

async function waitForSnooze(bridge, workspaceId, accept, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await workspaceSnoozedUntil(bridge, workspaceId);
    if (accept(value)) return value;
    await delay(150);
  }
  throw new Error(`${label}: snoozedUntil never reached the expected value`);
}

/**
 * Settings → Projects (branch names, linked repositories) and the sidebar
 * snooze shelf, driven through the native window. The branch a template
 * produces is read back from a worktree chat created over production IPC.
 */
export async function verifyWorkspaceSettings({
  bridge,
  browser,
  source,
  workspace,
  project,
  repoPath,
  invocationLog,
  outputDir,
  databasePath,
  timeoutMs,
  verifyUi,
}) {
  const scenarios = VERIFICATION_SCENARIOS;
  const evidenceDir = path.join(outputDir, "native");
  await mkdir(evidenceDir, { recursive: true });
  const assertions = (progress.assertions = []);
  progress.diagnostics = [];
  const phases = [];
  const screenshots = [];

  const seeded = await waitForCompleted(bridge, source.id, timeoutMs, "settings seed chat");
  phases.push(await verifyUi({
    name: "settings-seed",
    expectedTexts: [scenarios.workspaceSettings.visibleText],
    expectIdle: true,
  }));

  // 1. Snooze shelf: snooze from the row menu, find it on the collapsed shelf, unsnooze.
  const rowSelector = `[data-workspace-id="${workspace.id}"] button[data-open][title]`;
  diagnose("snooze-contextmenu", await openContextMenu(browser, rowSelector));
  await clickByText(browser, "Snooze for 1 hour", 10_000);
  const snoozedUntil = await waitForSnooze(bridge, workspace.id, (value) => value !== null, 10_000, "snooze");
  const remainingMs = Date.parse(snoozedUntil) - Date.now();
  check(assertions, "snooze-lasts-about-an-hour", remainingMs > SNOOZE_HOUR_MS - 5 * 60_000 && remainingMs <= SNOOZE_HOUR_MS, snoozedUntil);
  check(assertions, "snooze-leaves-execution-state-alone", (await waitForCompleted(bridge, source.id, 5_000, "snoozed chat")).state === seeded.state);
  // The snoozed chat is the open one, so the shelf opens by itself to keep it
  // in view (Sidebar.tsx). Hide it, then show it again: both are real toggles.
  // The toggle is invisible (opacity 0) until the heading is hovered, and
  // WebdriverIO's displayed check treats that as hidden, so these wait for the
  // control to exist and read its `aria-expanded`.
  const hideShelf = await browser.$('[aria-label="Hide Snoozed chats"]');
  await hideShelf.waitForExist({ timeout: 10_000, timeoutMsg: "The Snoozed shelf did not open for the selected snoozed chat" });
  const shelfNow = await describeSnoozeShelf(browser, workspace.id);
  diagnose("shelf-after-snooze", shelfNow);
  const openedSnoozed = await browser.$(rowSelector);
  await openedSnoozed.waitForDisplayed({ timeout: 10_000, timeoutMsg: "The selected snoozed chat did not become visible" });
  check(assertions, "shelf-opens-for-the-selected-snoozed-chat", (await hideShelf.getAttribute("aria-expanded")) === "true" && (await openedSnoozed.isDisplayed()), shelfNow);
  screenshots.push(await screenshot(browser, evidenceDir, "snooze-shelf-expanded"));
  await hideShelf.click();
  const showShelf = await browser.$('[aria-label="Show Snoozed chats"]');
  await showShelf.waitForExist({ timeout: 10_000, timeoutMsg: "Hiding the Snoozed shelf did not collapse it" });
  check(assertions, "snoozed-row-hides-while-shelf-collapsed", (await showShelf.getAttribute("aria-expanded")) === "false" && (await browser.$$(rowSelector)).length === 0);
  screenshots.push(await screenshot(browser, evidenceDir, "snooze-shelf-collapsed"));
  await showShelf.click();
  const shelved = await browser.$(rowSelector);
  await shelved.waitForDisplayed({ timeout: 10_000, timeoutMsg: "Showing the Snoozed shelf did not bring the row back" });
  diagnose("unsnooze-contextmenu", await openContextMenu(browser, rowSelector));
  diagnose("menu-after-unsnooze-contextmenu", await describeSnoozeShelf(browser, workspace.id));
  await clickByText(browser, "Unsnooze", 10_000);
  await waitForSnooze(bridge, workspace.id, (value) => value === null, 10_000, "unsnooze");
  check(assertions, "manual-unsnooze-clears-the-time", true);

  // 2. Settings → Projects.
  await ensureDesktopForeground(browser);
  await (await browser.$('[aria-label="Customize"]')).click();
  await clickByText(browser, "Projects", 10_000);
  const branchCard = await browser.$("#settings-branch-names");
  await branchCard.waitForDisplayed({ timeout: 10_000, timeoutMsg: "Settings → Projects did not show the Branch names card" });

  await setInputValue(browser, await browser.$("#settings-branch-template-app"), "adam/{nope}");
  await clickByText(browser, "Save default", 5_000);
  await waitForText(browser, '#settings-branch-names [role="alert"]', "Unknown placeholder {nope}", 10_000);
  check(assertions, "invalid-template-is-rejected-on-save", true);
  await setInputValue(browser, await browser.$("#settings-branch-template-project"), "adam/{type}-{slug}");
  await clickByText(browser, "Save project template", 5_000);
  await waitForText(browser, '#settings-branch-names [role="status"]', "Project branch template saved.", 10_000);
  check(assertions, "project-template-saves", true);
  screenshots.push(await screenshot(browser, evidenceDir, "settings-branch-names"));

  const linkedCard = "#settings-linked-repos";
  const linkedDir = path.join(path.dirname(repoPath), "linked-docs");
  await mkdir(linkedDir, { recursive: true });
  await writeFile(path.join(linkedDir, "README.md"), "# Shared API\n\nShared API contracts and types for the application.\n");
  const canonicalLinked = await realpath(linkedDir);
  const linkedRows = () => sqliteRows(databasePath, "SELECT * FROM project_linked_repos");
  check(assertions, "linked-repository-has-no-path-input", !(await (await browser.$(`${linkedCard} input[type=\"text\"]`)).isExisting()));
  for (const [bad, expected] of [
    ["relative/dir", "must be absolute"],
    [repoPath, "cannot be, contain, or sit inside"],
  ]) {
    const error = await browser.execute(async (projectId, candidate) => {
      try {
        await window.argmax.linkedRepos.add({ projectId, repo: { name: null, path: candidate } });
        return "";
      } catch (reason) {
        return JSON.stringify(reason);
      }
    }, project.id, bad);
    check(assertions, `linked-repository-rejects:${expected}`, error.includes(expected) && (await linkedRows()).length === 0, error);
  }
  // This driver controls the webview, not the OS folder sheet. Script only that
  // selection result and keep persistence, helper generation, and row actions real.
  await browser.execute(() => { window.argmax.linkedRepos.pickFolder = async () => null; });
  await clickByText(browser, "Connect repository…", 5_000);
  check(assertions, "linked-repository-picker-cancellation-keeps-list-empty", (await linkedRows()).length === 0);
  await browser.execute((candidate) => {
    window.argmax.linkedRepos.pickFolder = ({ projectId: owner }) =>
      window.argmax.linkedRepos.add({ projectId: owner, repo: { name: null, path: candidate } });
  }, linkedDir);
  await clickByText(browser, "Connect repository…", 5_000);
  await waitForText(browser, `${linkedCard} strong`, "linked-docs", 10_000);
  const expectedSummary = "Shared API contracts and types for the application.";
  await waitForText(browser, linkedCard, expectedSummary, 20_000);
  const added = (await linkedRows()).find((row) => Object.values(row).includes(canonicalLinked));
  check(assertions, "linked-repository-stores-canonical-root", Boolean(added) && added.enabled === 1, added);
  check(assertions, "linked-repository-summary-generated-and-persisted", added.summary === expectedSummary, added);
  screenshots.push(await screenshot(browser, evidenceDir, "settings-linked-repository"));
  await (await browser.$('[aria-label="Enable linked repository linked-docs"]')).click();
  await browser.waitUntil(async () => (await linkedRows())[0]?.enabled === 0, {
    timeout: 10_000,
    interval: 150,
    timeoutMsg: "Toggling the linked repository did not disable it",
  });
  check(assertions, "linked-repository-toggle-disables-it", true);
  await (await browser.$('[aria-label="Remove linked repository linked-docs"]')).click();
  await browser.waitUntil(async () => (await linkedRows()).length === 0, {
    timeout: 10_000,
    interval: 150,
    timeoutMsg: "Removing the linked repository left its row",
  });
  check(assertions, "linked-repository-remove-deletes-it", true);

  // 3. The saved project template names real worktree branches.
  const createWorktreeChat = () => bridge.call("workspaces:create-isolated", { projectId: project.id, taskLabel: "Hello World" });
  const first = await createWorktreeChat();
  const second = await createWorktreeChat();
  check(
    assertions,
    "template-names-worktree-branches",
    first.branch === "adam/feat-hello-world" && second.branch === "adam/feat-hello-world-2",
    [first.branch, second.branch],
  );

  // 4. New chat picker with a branch that a worktree already holds. Picking it
  // must not check it out in the main checkout (git refuses: it is in use):
  // Worktree off starts a fresh chat in the worktree that has the branch, and
  // Worktree on starts a new isolated tree from it. Either way the earlier chat
  // and the main checkout stay as they were.
  const occupied = await bridge.call("workspaces:create-isolated", { projectId: project.id, taskLabel: "Occupied branch" });
  await writeFile(path.join(occupied.path, "occupied.txt"), "work on the occupied branch\n");
  await git(occupied.path, "add", "occupied.txt");
  await git(occupied.path, "commit", "-q", "-m", "occupied branch work");
  const occupiedTip = await git(occupied.path, "rev-parse", "HEAD");
  check(assertions, "occupied-branch-differs-from-main", occupiedTip !== (await git(repoPath, "rev-parse", "main")), { branch: occupied.branch });
  const oldChat = await bridge.call("providers:launch", {
    workspaceId: occupied.id,
    provider: VERIFICATION_PROVIDER.provider,
    prompt: scenarios.occupiedSeed.prompt,
    modelLabel: VERIFICATION_PROVIDER.modelLabel,
    modelId: VERIFICATION_PROVIDER.modelId,
    reasoningEffort: null,
    fastMode: false,
    agentMode: null,
    permissionMode: null,
    cols: 120,
    rows: 32,
    attachments: null,
  });
  await waitForEventText(bridge, oldChat.id, scenarios.occupiedSeed.visibleText, timeoutMs);
  const oldChatBefore = await waitForCompleted(bridge, oldChat.id, timeoutMs, "existing chat in the occupied worktree");
  let oldEventCount = (await readAllEvents(bridge, oldChat.id)).length;
  const occupiedPath = await realpath(occupied.path);
  const stillAsItWas = async (name) => {
    const dashboard = await bridge.call("dashboard:list", {});
    const old = dashboard.sessions.find((entry) => entry.id === oldChat.id);
    const oldWorkspace = dashboard.workspaces.find((entry) => entry.id === occupied.id);
    check(
      assertions,
      `${name}:existing-chat-and-its-worktree-are-untouched`,
      old?.state === oldChatBefore.state
        && (await readAllEvents(bridge, oldChat.id)).length === oldEventCount
        && oldWorkspace?.state !== "archived"
        && (await realpath(oldWorkspace.path)) === occupiedPath
        && (await git(occupied.path, "rev-parse", "HEAD")) === occupiedTip
        && (await git(occupied.path, "rev-parse", "--abbrev-ref", "HEAD")) === occupied.branch,
    );
  };

  await pinLauncherModel(browser, timeoutMs);
  const rootBefore = await rootState(repoPath);
  check(assertions, "main-checkout-starts-on-main", rootBefore.branch === "main", rootBefore);

  // Worktree off: share the worktree that has the branch.
  const sharePrompt = `${scenarios.occupiedShare.prompt} share the checkout`;
  const shared = await launchFromPicker({ bridge, browser, repoPath, branch: occupied.branch, worktree: false, prompt: sharePrompt, timeoutMs });
  check(assertions, "picking-an-occupied-branch-raises-no-error", shared.alert === null && shared.chipLabel === occupied.branch, { alert: shared.alert, chipLabel: shared.chipLabel });
  check(assertions, "picking-an-occupied-branch-leaves-the-main-checkout-alone", JSON.stringify(shared.rootAtPick) === JSON.stringify(rootBefore), shared.rootAtPick);
  screenshots.push(await screenshot(browser, evidenceDir, "picker-occupied-branch-picked"));
  const sharedChat = await waitForNewCompletedChat(bridge, shared.sessionsBefore, timeoutMs, "chat sharing the occupied worktree");
  const sharedWorkspace = (await bridge.call("dashboard:list", {})).workspaces.find((entry) => entry.id === sharedChat.workspaceId);
  // The user asked for a NEW chat: a new session and a new workspace row, even
  // though the checkout underneath is the existing one.
  check(assertions, "worktree-off-starts-a-new-session", sharedChat.id !== oldChat.id, { sessionId: sharedChat.id, existingSessionId: oldChat.id });
  check(assertions, "worktree-off-starts-a-new-workspace-row", sharedWorkspace.id !== occupied.id, { workspaceId: sharedWorkspace.id, existingWorkspaceId: occupied.id });
  check(
    assertions,
    "worktree-off-shares-the-existing-checkout",
    (await realpath(sharedWorkspace.path)) === occupiedPath && sharedWorkspace.branch === occupied.branch,
    { path: sharedWorkspace.path, branch: sharedWorkspace.branch },
  );
  check(assertions, "worktree-off-launch-shows-no-error", (await visibleError(browser)) === null);
  check(assertions, "worktree-off-provider-runs-in-the-existing-checkout", (await providerCwdFor(invocationLog, scenarios.occupiedShare.prompt)) === occupiedPath);
  await stillAsItWas("worktree-off");
  const rootAfterShare = await rootState(repoPath);
  check(assertions, "worktree-off-leaves-the-main-checkout-alone", JSON.stringify(rootAfterShare) === JSON.stringify(rootBefore), rootAfterShare);

  // Worktree on: a fresh isolated tree from the picked branch.
  const worktreePrompt = `${scenarios.occupiedWorktree.prompt} isolate the work`;
  const isolated = await launchFromPicker({ bridge, browser, repoPath, branch: occupied.branch, worktree: true, prompt: worktreePrompt, timeoutMs });
  check(assertions, "worktree-on-picking-an-occupied-branch-raises-no-error", isolated.alert === null && isolated.chipLabel === occupied.branch, { alert: isolated.alert, chipLabel: isolated.chipLabel });
  check(assertions, "worktree-on-pick-leaves-the-main-checkout-alone", JSON.stringify(isolated.rootAtPick) === JSON.stringify(rootBefore), isolated.rootAtPick);
  const isolatedChat = await waitForNewCompletedChat(bridge, isolated.sessionsBefore, timeoutMs, "chat in a fresh worktree");
  const isolatedWorkspace = (await bridge.call("dashboard:list", {})).workspaces.find((entry) => entry.id === isolatedChat.workspaceId);
  const isolatedPath = await realpath(isolatedWorkspace.path);
  check(
    assertions,
    "worktree-on-starts-a-new-session-and-workspace-row",
    isolatedChat.id !== oldChat.id && isolatedChat.id !== sharedChat.id && isolatedWorkspace.id !== occupied.id && isolatedWorkspace.id !== sharedWorkspace.id,
  );
  check(
    assertions,
    "worktree-on-makes-a-fresh-tree-from-the-picked-branch",
    isolatedPath !== occupiedPath
      && isolatedPath !== (await realpath(repoPath))
      && isolatedWorkspace.branch !== occupied.branch
      && isolatedWorkspace.branch.startsWith("adam/")
      && (await git(isolatedWorkspace.path, "rev-parse", "HEAD")) === occupiedTip,
    { path: isolatedWorkspace.path, branch: isolatedWorkspace.branch },
  );
  check(assertions, "worktree-on-launch-shows-no-error", (await visibleError(browser)) === null);
  check(assertions, "worktree-on-provider-runs-in-the-new-tree", (await providerCwdFor(invocationLog, scenarios.occupiedWorktree.prompt)) === isolatedPath);
  await stillAsItWas("worktree-on");
  const rootAfterIsolated = await rootState(repoPath);
  check(
    assertions,
    "worktree-on-leaves-the-main-checkout-alone",
    rootAfterIsolated.branch === rootBefore.branch
      && rootAfterIsolated.head === rootBefore.head
      && rootAfterIsolated.status === rootBefore.status
      && rootAfterIsolated.worktrees.length === rootBefore.worktrees.length + 1,
    rootAfterIsolated,
  );
  screenshots.push(await screenshot(browser, evidenceDir, "picker-occupied-branch-result"));

  // The earlier chat in the occupied worktree still takes a follow-up.
  await bridge.call("providers:send-input", {
    sessionId: oldChat.id,
    input: scenarios.occupiedFollowUp.prompt,
    provider: null,
    modelLabel: null,
    modelId: null,
    reasoningEffort: null,
    fastMode: false,
  });
  await waitForEventText(bridge, oldChat.id, scenarios.occupiedFollowUp.visibleText, timeoutMs);
  check(assertions, "existing-chat-still-takes-a-follow-up", (await waitForCompleted(bridge, oldChat.id, timeoutMs, "existing chat follow-up")).state === "complete");
  oldEventCount = (await readAllEvents(bridge, oldChat.id)).length;
  check(assertions, "follow-up-ran-in-the-existing-checkout", (await providerCwdFor(invocationLog, scenarios.occupiedFollowUp.prompt)) === occupiedPath);

  // A branch no worktree holds, Worktree off: nothing changes until Start,
  // then the main checkout is switched to it and the chat runs there.
  await git(repoPath, "branch", "unoccupied-feature");
  // Compared after the Worktree-on launch added a worktree, so the baseline is
  // taken here, right before this pick.
  const rootBeforeCheckout = await rootState(repoPath);
  const checkoutPrompt = `${scenarios.occupiedCheckout.prompt} work in the main checkout`;
  const checkout = await launchFromPicker({ bridge, browser, repoPath, branch: "unoccupied-feature", worktree: false, prompt: checkoutPrompt, timeoutMs });
  check(assertions, "unoccupied-branch-pick-raises-no-error", checkout.alert === null && checkout.chipLabel === "unoccupied-feature", { alert: checkout.alert, chipLabel: checkout.chipLabel });
  check(assertions, "unoccupied-branch-is-not-checked-out-before-start", JSON.stringify(checkout.rootAtPick) === JSON.stringify(rootBeforeCheckout), checkout.rootAtPick);
  const checkoutChat = await waitForNewCompletedChat(bridge, checkout.sessionsBefore, timeoutMs, "chat in the main checkout");
  check(assertions, "unoccupied-branch-launch-shows-no-error", (await visibleError(browser)) === null);
  const rootAfterCheckout = await rootState(repoPath);
  check(assertions, "unoccupied-branch-is-checked-out-on-start", rootAfterCheckout.branch === "unoccupied-feature", rootAfterCheckout);
  check(assertions, "unoccupied-branch-chat-runs-in-the-main-checkout", (await providerCwdFor(invocationLog, scenarios.occupiedCheckout.prompt)) === (await realpath(repoPath)) && checkoutChat.id !== oldChat.id);
  await stillAsItWas("unoccupied-branch");

  const events = await readAllEvents(bridge, source.id);
  const result = {
    session: await waitForCompleted(bridge, source.id, 5_000, "settings seed chat"),
    workspace,
    records: events.map((event) => ({ kind: "event", ...event })),
    browser: phases,
    assertions,
  };
  await writeJson(path.join(evidenceDir, "workspace-settings.json"), { branches: [first.branch, second.branch], screenshots, assertions });
  return result;
}


async function git(cwd, ...args) {
  const { stdout } = await runChecked("git", args, { cwd, timeoutMs: 20_000 });
  return stdout.trim();
}

// What a branch checkout in the main checkout would change: its branch, commit,
// pending changes, and the set of worktrees.
async function rootState(repoPath) {
  const worktrees = (await git(repoPath, "worktree", "list", "--porcelain"))
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .sort();
  return {
    branch: await git(repoPath, "rev-parse", "--abbrev-ref", "HEAD"),
    head: await git(repoPath, "rev-parse", "HEAD"),
    status: await git(repoPath, "status", "--porcelain"),
    worktrees,
  };
}

// The working directory the scripted provider ran in for the launch that
// carried `marker`, from the invocation log.
async function providerCwdFor(invocationLog, marker) {
  const launch = (await readInvocations(invocationLog)).find((entry) => entry.prompt?.includes(marker));
  if (!launch) throw new Error(`No provider launch carried ${marker}`);
  return realpath(launch.cwd);
}

// The error the app is showing now, as a launcher alert or an error toast.
async function visibleError(browser) {
  return browser.execute(function readError() {
    return document.querySelector(".launcher-error[role=\"alert\"]")?.textContent
      ?? document.querySelector(".toast.toast-error:not([aria-hidden=\"true\"]) .toast-text")?.textContent
      ?? null;
  });
}

async function waitForNewCompletedChat(bridge, knownSessionIds, timeoutMs, label) {
  let fresh = null;
  const deadline = Date.now() + 30_000;
  while (!fresh && Date.now() < deadline) {
    fresh = (await bridge.call("dashboard:list", {})).sessions.find((entry) => !knownSessionIds.includes(entry.id)) ?? null;
    if (!fresh) await delay(150);
  }
  if (!fresh) throw new Error(`${label}: the launch started no chat`);
  return waitForCompleted(bridge, fresh.id, timeoutMs, label);
}


// The picker lists branches and checkouts over IPC before it opens. If it does
// not appear, the samples say whether it never opened (handler returned or an
// error toast), opened and closed again (the launcher remounted), or was slow.
async function waitForBranchPicker(browser) {
  const samples = [];
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const sample = await browser.execute(function readPicker() {
      const chip = document.querySelector('[aria-label="Switch branch"]');
      return {
        chip: chip ? chip.getAttribute("aria-expanded") : "missing",
        list: document.querySelector('[aria-label="Select branch"]') !== null,
        error: document.querySelector(".toast.toast-error .toast-text")?.textContent ?? document.querySelector(".launcher-error")?.textContent ?? null,
      };
    });
    if (sample.list) return;
    const last = samples.at(-1);
    if (!last || last.chip !== sample.chip || last.error !== sample.error) samples.push({ afterMs: Date.now() - started, ...sample });
    await delay(100);
  }
  diagnose("branch-picker-never-opened", samples);
  throw new Error(`The branch picker did not open (${JSON.stringify(samples)})`);
}

/**
 * Start a chat from the New chat launcher the way a person does: pick a branch
 * in the picker, set the Worktree toggle, type, and press Start. Returns what
 * the launcher showed (the branch chip and any error), the main checkout as it
 * stood after the pick and before Start, and the chats that existed before.
 */
async function launchFromPicker({ bridge, browser, repoPath, branch, worktree, prompt, timeoutMs }) {
  const sessionsBefore = (await bridge.call("dashboard:list", {})).sessions.map((entry) => entry.id);
  const field = await openLauncher(browser, timeoutMs);
  await (await browser.$('[aria-label="Switch branch"]')).click();
  await waitForBranchPicker(browser);
  const list = await browser.$('[aria-label="Select branch"]');
  await list.waitForDisplayed({ timeout: 10_000, timeoutMsg: "The branch picker did not open" });
  const option = await browser.$(`//*[@aria-label="Select branch"]//button[.//span[contains(@class, "picker-label") and normalize-space(.)="${branch}"]]`);
  await option.waitForExist({ timeout: 10_000, timeoutMsg: `The branch picker did not list ${branch}` });
  await option.click();
  await browser.pause(750);
  const toggle = await browser.$('[aria-label="Worktree"]');
  if (((await toggle.getAttribute("aria-pressed")) === "true") !== worktree) await toggle.click();
  await browser.waitUntil(async () => ((await toggle.getAttribute("aria-pressed")) === "true") === worktree, {
    timeout: 5_000,
    timeoutMsg: `The Worktree toggle did not turn ${worktree ? "on" : "off"}`,
  });
  const shown = await browser.execute(function readLauncher() {
    return {
      chipLabel: document.querySelector('[aria-label="Switch branch"] .composer-context-chip-label')?.textContent ?? null,
      // A failed branch switch is an error toast; a failed launch can be either.
      alert: document.querySelector(".launcher-error[role=\"alert\"]")?.textContent
        ?? document.querySelector(".toast.toast-error:not([aria-hidden=\"true\"]) .toast-text")?.textContent
        ?? null,
    };
  });
  // The pick alone changes nothing on disk; only Start can.
  const rootAtPick = await rootState(repoPath);
  await typeIntoComposer(browser, field, prompt);
  await (await browser.$('button[aria-label="Start agent"]')).click();
  return { ...shown, sessionsBefore, rootAtPick };
}

// Records what a copy or cut puts on the clipboard. It listens on `document`,
// after the editor's own handler has run, so it sees the editor's data.
async function recordClipboardEvents(browser) {
  await browser.execute(function installClipboardRecorder() {
    window.__verifyClipboard = [];
    if (window.__verifyClipboardInstalled) return;
    window.__verifyClipboardInstalled = true;
    for (const type of ["copy", "cut"]) {
      document.addEventListener(type, (event) => {
        const data = event.clipboardData;
        window.__verifyClipboard.push({
          type,
          defaultPrevented: event.defaultPrevented,
          plain: data?.getData("text/plain") ?? null,
          typed: data?.getData("application/x-argmax-composer+json") ?? null,
        });
      });
    }
  });
}

async function clipboardEvents(browser) {
  return browser.execute(function readClipboardEvents() {
    return window.__verifyClipboard ?? [];
  });
}

// Copy and cut by the keyboard first, as a person does. If the host's
// WebDriver cannot raise a native copy, fall back to the document command and
// say so in the evidence; a copy that never fires is a failure either way.
async function copyOrCut(browser, command) {
  const before = (await clipboardEvents(browser)).length;
  await browser.keys(["Meta", command === "copy" ? "c" : "x"]);
  await browser.pause(300);
  if ((await clipboardEvents(browser)).length > before) return "keys";
  await browser.execute(function runCommand(name) {
    document.execCommand(name);
  }, command);
  await browser.pause(300);
  if ((await clipboardEvents(browser)).length > before) return "execCommand";
  throw new Error(`No ${command} event fired from Cmd+${command === "copy" ? "C" : "X"} or document.execCommand`);
}

async function selectAllInEditor(browser, field) {
  await selectComposerText(browser, field, "all");
  await browser.pause(150);
}

async function collapseSelectionToEnd(browser, field) {
  await selectComposerText(browser, field, "end");
  await browser.pause(150);
}

async function pickChatFromMenu(browser, title) {
  let option = null;
  await browser.waitUntil(
    async () => {
      for (const candidate of await browser.$$('li[role="option"][data-kind="chat"]')) {
        if ((await candidate.getAttribute("aria-label")).startsWith(`Chat: ${title}`)) {
          option = candidate;
          return true;
        }
      }
      return false;
    },
    { timeout: 10_000, interval: 150, timeoutMsg: `The @ menu never offered the chat "${title}"` },
  );
  // Rows select on mousedown, which this WebDriver's click does not send.
  await pressMouseDown(browser, option);
}

/**
 * The real CodeMirror composer, in the native window. Proves what a textarea
 * mock cannot: the editor is CodeMirror, undo after an @ pick leaves no link
 * fragment, a chip deletes whole, copy and cut carry the typed payload, an
 * empty selection copies and cuts nothing, and Enter right after a menu pick
 * sends the full text. A real IME candidate window is not driven here.
 */
export async function verifyComposerEditor({
  bridge,
  browser,
  source,
  project,
  outputDir,
  databasePath,
  timeoutMs,
  verifyUi,
}) {
  const scenarios = VERIFICATION_SCENARIOS;
  const evidenceDir = path.join(outputDir, "native");
  await mkdir(evidenceDir, { recursive: true });
  const assertions = (progress.assertions = []);
  const phases = [];
  const screenshots = [];
  const sourceTitle = scenarios.composerSource.taskLabel;
  const sourceLink = `argmax://chat/${source.id}`;
  const fragments = (text) => (text.includes("argmax://") || text.includes("](")) && !text.includes(`(${sourceLink}`);
  const chipCount = async () => (await launcherChips(browser)).length;

  await pinLauncherModel(browser, timeoutMs);
  await waitForCompleted(bridge, source.id, timeoutMs, "editor source chat");
  phases.push(await verifyUi({
    name: "editor-source",
    expectedTexts: [scenarios.composerSource.visibleText],
    expectIdle: true,
  }));
  const sessionField = await waitForCodeMirror(browser, SESSION_PROMPT_LABEL, timeoutMs);
  await typeIntoComposer(browser, sessionField, "abc def");
  check(assertions, "session-composer-takes-typing", (await readComposerText(browser, sessionField)) === "abc def");
  screenshots.push(await screenshot(browser, evidenceDir, "editor-session-codemirror"));
  await browser.keys(["Meta", "z"]);
  check(assertions, "session-composer-undo-changes-the-text", (await readComposerText(browser, await browser.$(`[aria-label="${SESSION_PROMPT_LABEL}"]`))) !== "abc def");
  await selectAllInEditor(browser, await browser.$(`[aria-label="${SESSION_PROMPT_LABEL}"]`));
  await browser.keys(["Backspace"]);

  // 1. The launcher editor is CodeMirror, not the fallback textarea.
  let field = await openLauncher(browser, timeoutMs);
  const shape = await browser.execute(function editorShape(label) {
    const element = document.querySelector(`[aria-label="${label}"]`);
    return {
      codeMirror: element.closest(".cm-editor") !== null,
      textareaFallback: document.querySelector(`textarea[aria-label="${label}"]`) !== null,
      editable: element.isContentEditable,
      role: element.getAttribute("role"),
    };
  }, LAUNCHER_PROMPT_LABEL);
  check(assertions, "launcher-field-is-codemirror", shape.codeMirror && !shape.textareaFallback && shape.editable && shape.role === "textbox", shape);
  // Positive control for every "the field is empty" read below: the placeholder
  // is on screen, and the reader must still answer with the empty document.
  const placeholderText = await browser.execute(function readPlaceholder() {
    return document.querySelector('[aria-label="Task prompt"] .cm-placeholder')?.textContent ?? null;
  });
  check(assertions, "reader-returns-empty-while-the-placeholder-shows", Boolean(placeholderText) && (await readComposerText(browser, field)) === "", placeholderText);
  screenshots.push(await screenshot(browser, evidenceDir, "editor-launcher-empty"));
  await recordClipboardEvents(browser);

  // 2. Undo after an @ pick leaves no link fragment.
  await typeIntoComposer(browser, field, "look at @Reference");
  const beforePick = await readComposerText(browser, field);
  await pickChatFromMenu(browser, sourceTitle);
  await browser.waitUntil(async () => (await chipCount()) === 1, { timeout: 5_000, interval: 100, timeoutMsg: "No chip after the @ pick" });
  field = await browser.$(`[aria-label="${LAUNCHER_PROMPT_LABEL}"]`);
  // Positive control for the fragment checks below: the reader sees the link
  // behind the chip, not just the chip's label.
  check(assertions, "reader-sees-the-link-behind-the-chip", (await readComposerText(browser, field)).includes(sourceLink));
  screenshots.push(await screenshot(browser, evidenceDir, "editor-launcher-chip"));
  await browser.keys(["Meta", "z"]);
  await browser.pause(250);
  const undone = await readComposerText(browser, field);
  check(assertions, "undo-after-pick-leaves-no-link-fragment", !fragments(undone) && undone.includes("look at"), { beforePick, undone });

  // 3. A chip deletes whole.
  if ((await chipCount()) === 0) {
    await pickChatFromMenu(browser, sourceTitle);
    await browser.waitUntil(async () => (await chipCount()) === 1, { timeout: 5_000, interval: 100, timeoutMsg: "No chip after re-picking" });
  }
  field = await browser.$(`[aria-label="${LAUNCHER_PROMPT_LABEL}"]`);
  await browser.execute(function focusField(element) {
    element.focus();
  }, field);
  for (let press = 0; press < 3 && (await chipCount()) === 1; press += 1) {
    await browser.keys(["Backspace"]);
    await browser.pause(150);
    const now = await readComposerText(browser, field);
    check(assertions, `backspace-${press + 1}-never-leaves-half-a-chip`, (await chipCount()) === 1 || !now.includes("argmax://"), now);
  }
  check(assertions, "backspace-removes-the-chip-whole", (await chipCount()) === 0);

  // 4. Copy and cut carry the typed payload; an empty selection takes nothing.
  await typeIntoComposer(browser, field, "@Reference");
  await pickChatFromMenu(browser, sourceTitle);
  await browser.waitUntil(async () => (await chipCount()) === 1, { timeout: 5_000, interval: 100, timeoutMsg: "No chip before copy" });
  field = await browser.$(`[aria-label="${LAUNCHER_PROMPT_LABEL}"]`);
  await typeIntoComposer(browser, field, "tail");
  const fullText = await readComposerText(browser, field);
  await selectAllInEditor(browser, field);
  const copyTrigger = await copyOrCut(browser, "copy");
  const copied = (await clipboardEvents(browser)).filter((entry) => entry.type === "copy").at(-1);
  const typed = copied?.typed ? JSON.parse(copied.typed) : null;
  check(
    assertions,
    "copy-carries-plain-text-and-typed-payload",
    copied.plain === fullText && typed?.v === 1 && typed.text === fullText && typed.references?.[0]?.sessionId === source.id,
    { trigger: copyTrigger, plain: copied.plain },
  );
  check(assertions, "copy-leaves-the-text", (await readComposerText(browser, field)) === fullText);
  const cutTrigger = await copyOrCut(browser, "cut");
  check(assertions, "cut-empties-the-field-and-fills-the-payload", (await readComposerText(browser, field)) === "" && (await chipCount()) === 0, { trigger: cutTrigger });
  await browser.keys(["Meta", "z"]);
  await browser.pause(250);
  check(assertions, "undo-restores-a-cut", (await readComposerText(browser, field)) === fullText && (await chipCount()) === 1);
  await collapseSelectionToEnd(browser, field);
  const eventsBefore = (await clipboardEvents(browser)).length;
  await browser.keys(["Meta", "x"]).catch(() => undefined);
  await browser.execute(function emptyCut() {
    document.execCommand("cut");
  });
  await browser.pause(300);
  check(assertions, "empty-selection-cut-leaves-the-text", (await readComposerText(browser, field)) === fullText, await readComposerText(browser, field));
  check(
    assertions,
    "empty-selection-cut-puts-no-line-on-the-clipboard",
    (await clipboardEvents(browser)).slice(eventsBefore).every((entry) => !entry.plain),
  );
  screenshots.push(await screenshot(browser, evidenceDir, "editor-launcher-after-clipboard"));

  // 5. Enter right after a menu pick sends the full text.
  field = await browser.$(`[aria-label="${LAUNCHER_PROMPT_LABEL}"]`);
  await selectAllInEditor(browser, field);
  await browser.keys(["Backspace"]);
  await browser.pause(150);
  const sessionsBefore = (await bridge.call("dashboard:list", {})).sessions.map((entry) => entry.id);
  await typeIntoComposer(browser, field, `${scenarios.composerBackground.prompt} editor submit @Reference`);
  await browser.waitUntil(async () => (await browser.$$('li[role="option"][data-kind="chat"]')).length > 0, {
    timeout: 10_000,
    interval: 100,
    timeoutMsg: "The @ menu did not open before the keyboard pick",
  });
  await browser.keys(["Enter"]);
  await browser.keys(["Enter"]);
  let sent = null;
  await browser.waitUntil(
    async () => {
      sent = (await bridge.call("dashboard:list", {})).sessions.find((entry) => !sessionsBefore.includes(entry.id)) ?? null;
      return sent !== null;
    },
    { timeout: 20_000, interval: 150, timeoutMsg: "Enter after the menu pick started no chat" },
  );
  const done = await waitForCompleted(bridge, sent.id, timeoutMs, "editor submit chat");
  const userMessages = await sessionUserMessages(databasePath, done.id);
  check(
    assertions,
    "enter-after-pick-sends-the-full-text",
    userMessages.length === 1
      && userMessages[0].message.includes("editor submit")
      && userMessages[0].message.includes(`(${sourceLink}`)
      && !userMessages[0].message.includes("@Reference"),
    userMessages.map((entry) => entry.message),
  );
  const dashboard = await bridge.call("dashboard:list", {});
  const sentWorkspace = dashboard.workspaces.find((entry) => entry.id === done.workspaceId);
  check(assertions, "submitted-chat-is-in-the-selected-project", sentWorkspace?.projectId === project.id);
  phases.push(await verifyUi({
    name: "editor-submitted-chat",
    titleIncludes: sentWorkspace.taskLabel,
    expectedTexts: [scenarios.composerBackground.visibleText],
    expectIdle: true,
  }));
  screenshots.push(await screenshot(browser, evidenceDir, "editor-submitted-chat"));

  await writeJson(path.join(evidenceDir, "composer-editor.json"), { sourceSessionId: source.id, submittedSessionId: done.id, screenshots, assertions });
  return {
    session: done,
    workspace: sentWorkspace,
    records: (await readAllEvents(bridge, done.id)).map((event) => ({ kind: "event", ...event })),
    browser: phases,
    assertions,
  };
}

// WebKit hands a hidden tab's WKWebView the window's keyboard when its page
// focuses one of its own fields, while the page's `document.hasFocus()` still
// reads false. What the person feels is the app document losing focus: their
// keystrokes stop landing in the composer until they click it again.
export async function verifyBrowserFocus({ bridge, browser, source, workspace, outputDir, timeoutMs, verifyUi }) {
  const evidenceDir = path.join(outputDir, "native");
  await mkdir(evidenceDir, { recursive: true });
  const assertions = (progress.assertions = []);
  const phases = [];
  const screenshots = [];

  await waitForCompleted(bridge, source.id, timeoutMs, "browser focus source chat");
  phases.push(await verifyUi({
    name: "focus-source",
    expectedTexts: [VERIFICATION_SCENARIOS.composerSource.visibleText],
    expectIdle: true,
  }));

  const page = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end('<!doctype html><title>Focus probe</title><input id="probe" aria-label="Probe field">');
  });
  await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));
  let result;
  try {
    const field = await openLauncher(browser, timeoutMs);
    await typeIntoComposer(browser, field, "keep typing");
    // The renderer drives the tab itself: while the window holds a child webview,
    // Tauri stops listing it as a webview window, so WebDriver cannot reach it
    // until the tab closes.
    await browser.execute(function probeHiddenTabFocus(sessionId, url, label) {
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const focusState = () => {
        const composer = document.querySelector(`[aria-label="${label}"]`);
        return {
          documentHasFocus: document.hasFocus(),
          composerActive: composer !== null && composer.contains(document.activeElement),
          blurs: window.__verifyBlurs,
        };
      };
      const evaluate = async (tabId, script) => {
        const { resultJson } = await window.argmax.browser.evaluate({ tabId, script, timeoutMs: 5_000 });
        const value = JSON.parse(resultJson);
        return typeof value === "string" ? JSON.parse(value) : value;
      };
      window.__verifyBlurs = 0;
      window.__verifyFocusProbe = null;
      window.addEventListener("blur", () => { window.__verifyBlurs += 1; });
      void (async () => {
        const before = focusState();
        let tabId = null;
        try {
          // The path an agent's browser_open takes: a hidden tab owned by the chat.
          ({ tabId } = await window.argmax.browser.openForSession({ sessionId, url }));
          for (let attempt = 0; ; attempt += 1) {
            if (await evaluate(tabId, 'JSON.stringify(document.getElementById("probe") !== null)').catch(() => false)) break;
            if (attempt === 100) throw new Error("The hidden tab never loaded its probe page");
            await pause(200);
          }
          const opened = focusState();
          const probe = await evaluate(tabId, `JSON.stringify((() => {
            const input = document.getElementById("probe");
            input.focus();
            return { focused: document.activeElement === input, pageHasFocus: document.hasFocus() };
          })())`);
          // WebKit asks the window for first responder a few milliseconds later.
          await pause(750);
          window.__verifyFocusProbe = { tabId, before, opened, probe, after: focusState() };
        } catch (error) {
          window.__verifyFocusProbe = { tabId, error: String(error?.message ?? error) };
        } finally {
          if (tabId) await window.argmax.browser.close(tabId).catch(() => undefined);
        }
      })();
    }, source.id, `http://127.0.0.1:${page.address().port}/`, LAUNCHER_PROMPT_LABEL);
    result = await browser.waitUntil(
      () => browser.execute(function readFocusProbe() { return window.__verifyFocusProbe; }).catch(() => null),
      { timeout: timeoutMs, interval: 250, timeoutMsg: "The hidden tab focus probe never finished" },
    );
    if (result.error) throw new Error(result.error);

    check(assertions, "composer-has-the-keyboard-before-the-page-moves-focus",
      [result.before, result.opened].every((state) => state.documentHasFocus && state.composerActive), { before: result.before, opened: result.opened });
    // Positive control: the page did move its own focus, so the pass below is not vacuous.
    check(assertions, "hidden-page-focused-its-field", result.probe.focused === true, result.probe);
    check(assertions, "composer-keeps-the-keyboard-after-the-page-moves-focus",
      result.after.documentHasFocus && result.after.composerActive && result.after.blurs === 0, result.after);
    check(assertions, "composer-text-is-untouched", (await readComposerText(browser, field)) === "keep typing");
    screenshots.push(await screenshot(browser, evidenceDir, "focus-launcher-after-probe"));
  } finally {
    page.close();
  }

  await writeJson(path.join(evidenceDir, "browser-focus.json"), { sourceSessionId: source.id, tabId: result?.tabId ?? null, screenshots, assertions });
  return {
    session: await waitForCompleted(bridge, source.id, 5_000, "browser focus source chat"),
    workspace,
    records: (await readAllEvents(bridge, source.id)).map((event) => ({ kind: "event", ...event })),
    browser: phases,
    assertions,
  };
}
