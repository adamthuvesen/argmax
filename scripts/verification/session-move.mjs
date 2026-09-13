import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { delay, runChecked } from "./common.mjs";
import { writeJson } from "./evidence.mjs";
import {
  VERIFICATION_BARRIERS,
  VERIFICATION_CONVERSATION_ID,
  VERIFICATION_MOVED_CONVERSATION_ID,
  VERIFICATION_SCENARIOS,
} from "./provider-fixture.mjs";

const FAILED_SESSION_STATES = new Set(["failed", "cancelled"]);
const BASELINE_README = Buffer.from("# Argmax verification fixture\n");

function check(assertions, name, condition, value = undefined) {
  if (!condition) throw new Error(`session move verification failed: ${name}`);
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
  throw new Error(`session move barrier did not arrive: ${path.basename(filePath)}`);
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

async function openSourceAndWaitForText(browser, workspaceId, expectedText, timeoutMs) {
  let button = null;
  await browser.waitUntil(
    async () => {
      const matches = await browser.$$(`[data-workspace-id="${workspaceId}"] button[title]`);
      if (matches.length > 0) {
        [button] = matches;
        return true;
      }
      const expanders = await browser.$$('button[aria-label^="Show "][aria-label$=" chats"]');
      for (const expander of expanders) await expander.click();
      return false;
    },
    { timeout: timeoutMs, interval: 250, timeoutMsg: `Source workspace row ${workspaceId} was not visible` },
  );
  await button.waitForDisplayed({ timeout: timeoutMs });
  await button.waitForEnabled({ timeout: timeoutMs });
  const accessibleName = await button.getAttribute("aria-label")
    || await button.getAttribute("title")
    || (await button.getText()).trim();
  if (!accessibleName) throw new Error("source session row button has no accessible name");
  await button.click();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await browser.execute(function sourceState(text) {
      const bodyText = document.body.innerText;
      return {
        ok: bodyText.includes(text),
        title: document.title,
        textLength: bodyText.length,
        selectedWorkspaceId: document.querySelector('.session-row [aria-current="true"]')
          ?.closest(".session-row")?.getAttribute("data-workspace-id") ?? null,
      };
    }, expectedText);
    if (state.ok) return { ...state, rowAccessibleName: accessibleName };
    await delay(100);
  }
  throw new Error(`native source chat did not show: ${expectedText}`);
}

async function waitForMovedUi(browser, statusLabel, branchLabel, expectedText, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await browser.execute(function movedState(statusName, branchName, text) {
      const status = [...document.querySelectorAll('[role="status"]')]
        .find((element) => element.getAttribute("aria-label") === statusName);
      const branch = [...document.querySelectorAll("button")]
        .find((element) => element.getAttribute("aria-label") === branchName);
      const bodyText = document.body.innerText;
      const idle = document.querySelector('[aria-label="Send follow-up"]') instanceof HTMLButtonElement
        && document.querySelector('[aria-label="Stop chat"]') === null
        && document.querySelector('[aria-label="Thinking"]') === null;
      return {
        ok: Boolean(status && branch && bodyText.includes(text) && idle),
        idle,
        status: status?.getAttribute("aria-label") ?? null,
        branch: branch?.getAttribute("aria-label") ?? null,
        continuationVisible: bodyText.includes(text),
        selectedWorkspaceId: document.querySelector('.session-row [aria-current="true"]')
          ?.closest(".session-row")?.getAttribute("data-workspace-id") ?? null,
        title: document.title,
        textLength: bodyText.length,
      };
    }, statusLabel, branchLabel, expectedText);
    if (lastState.ok) return lastState;
    await delay(100);
  }
  throw new Error(`native app did not follow the moved chat: ${JSON.stringify(lastState)}`);
}

export async function verifySessionMove({
  bridge,
  browser,
  sourceSession,
  sourceWorkspace,
  repoPath,
  movePath,
  controlDir,
  outputDir,
  timeoutMs,
  invocationLog = null,
}) {
  const assertions = [];
  const canonicalRepoPath = await realpath(repoPath);
  const canonicalMovePath = await realpath(movePath);
  await mkdir(outputDir, { recursive: true });

  const readyPath = path.join(controlDir, `${VERIFICATION_BARRIERS.sessionMoveScheduled}.ready`);
  await waitForFile(readyPath, timeoutMs);
  const cliResult = JSON.parse(await readFile(path.join(controlDir, "session-move-cli-result.json"), "utf8"));
  const scheduled = cliResult.response?.scheduled;
  const scheduledPath = typeof scheduled?.path === "string" ? await realpath(scheduled.path) : null;
  check(assertions, "cli-move-scheduled", scheduled?.scheduled === true);
  check(assertions, "cli-source-session", scheduled?.sourceSessionId === sourceSession.id, scheduled?.sourceSessionId);
  check(assertions, "cli-destination-path", scheduledPath === canonicalMovePath, scheduledPath);
  check(assertions, "cli-move-argv", cliResult.args?.join("\0") === [
    "session", "move", "--path", movePath, "--prompt",
    VERIFICATION_SCENARIOS.sessionMoveSecond.prompt, "--keep-source",
  ].join("\0"));

  const scheduledDashboard = await bridge.call("dashboard:list", {});
  const runningSource = scheduledDashboard.sessions.find((session) => session.id === sourceSession.id);
  check(assertions, "source-running-while-move-scheduled", runningSource?.state === "running", runningSource?.state);
  const sourceEventsAtBarrier = await readAllEvents(bridge, sourceSession.id);
  const moveRequests = sourceEventsAtBarrier.filter((event) => event.type === "session.move-requested");
  check(assertions, "one-source-move-request", moveRequests.length === 1, moveRequests.length);
  const requestedPath = typeof moveRequests[0]?.payload?.destinationPath === "string"
    ? await realpath(moveRequests[0].payload.destinationPath)
    : null;
  check(assertions, "source-move-request-destination", requestedPath === canonicalMovePath
    && moveRequests[0].payload?.keepSource === true);

  const sourceUi = await openSourceAndWaitForText(
    browser,
    sourceWorkspace.id,
    VERIFICATION_SCENARIOS.sessionMoveFirst.visibleText,
    timeoutMs,
  );
  check(assertions, "native-source-visible-before-release", sourceUi.selectedWorkspaceId === sourceWorkspace.id);
  const sourceScreenshot = path.join(outputDir, "session-move-source.png");
  await browser.saveScreenshot(sourceScreenshot);
  await writeFile(
    path.join(controlDir, `${VERIFICATION_BARRIERS.sessionMoveScheduled}.continue`),
    "continue\n",
  );

  const deadline = Date.now() + timeoutMs;
  let finalDashboard = null;
  let destinationWorkspace = null;
  let destinationSession = null;
  while (Date.now() < deadline) {
    const dashboard = await bridge.call("dashboard:list", {});
    const destinationWorkspaces = [];
    for (const workspace of dashboard.workspaces) {
      if (workspace.id === sourceWorkspace.id) continue;
      try {
        if (await realpath(workspace.path) === canonicalMovePath) destinationWorkspaces.push(workspace);
      } catch {}
    }
    if (destinationWorkspaces.length > 1) throw new Error("session move created more than one destination workspace");
    const workspace = destinationWorkspaces[0];
    const sessions = workspace
      ? dashboard.sessions.filter((session) => session.workspaceId === workspace.id)
      : [];
    if (sessions.length > 1) throw new Error("session move created more than one destination session");
    if (sessions[0] && FAILED_SESSION_STATES.has(sessions[0].state)) {
      throw new Error(`session move destination ended in ${sessions[0].state}`);
    }
    if (workspace && sessions[0]?.state === "complete") {
      finalDashboard = dashboard;
      destinationWorkspace = workspace;
      destinationSession = sessions[0];
      break;
    }
    await delay(100);
  }
  if (!destinationWorkspace || !destinationSession || !finalDashboard) {
    throw new Error("session move destination did not complete before timeout");
  }

  check(assertions, "one-destination-workspace", true, destinationWorkspace.id);
  check(assertions, "one-destination-session", true, destinationSession.id);
  check(assertions, "destination-shared-checkout", destinationWorkspace.sharedWorkspace === true);
  check(assertions, "destination-branch", destinationWorkspace.branch === "verification-session-move-target", destinationWorkspace.branch);
  const finalSourceWorkspace = finalDashboard.workspaces.find((workspace) => workspace.id === sourceWorkspace.id);
  const finalSourceSession = finalDashboard.sessions.find((session) => session.id === sourceSession.id);
  check(assertions, "source-workspace-retained", Boolean(finalSourceWorkspace) && finalSourceWorkspace.state !== "archived", finalSourceWorkspace?.state);
  check(assertions, "source-path-unchanged", await realpath(finalSourceWorkspace.path) === canonicalRepoPath, finalSourceWorkspace.path);
  check(assertions, "source-conversation-retained", finalSourceSession?.providerConversationId === VERIFICATION_CONVERSATION_ID);
  check(assertions, "destination-conversation-forked", destinationSession.providerConversationId === VERIFICATION_MOVED_CONVERSATION_ID);

  const sourceEvents = await readAllEvents(bridge, sourceSession.id);
  const destinationEvents = await readAllEvents(bridge, destinationSession.id);
  check(assertions, "destination-copied-source-text", destinationEvents.some((event) => event.message.includes(VERIFICATION_SCENARIOS.sessionMoveFirst.visibleText)));
  check(assertions, "destination-copied-move-request", destinationEvents.filter((event) => event.type === "session.move-requested").length === 1);
  const destinationSeams = destinationEvents.filter((event) => event.type === "session.moved" && event.payload?.direction === "destination");
  check(assertions, "one-destination-move-seam", destinationSeams.length === 1, destinationSeams.length);
  const destinationSeam = destinationSeams[0];
  const seamPath = typeof destinationSeam.payload?.destinationPath === "string"
    ? await realpath(destinationSeam.payload.destinationPath)
    : null;
  check(assertions, "destination-seam-identities", destinationSeam.payload?.sourceSessionId === sourceSession.id
    && destinationSeam.payload?.sourceWorkspaceId === sourceWorkspace.id
    && destinationSeam.payload?.sourceProjectId === sourceWorkspace.projectId
    && destinationSeam.payload?.destinationSessionId === destinationSession.id
    && destinationSeam.payload?.destinationWorkspaceId === destinationWorkspace.id
    && destinationSeam.payload?.destinationProjectId === destinationWorkspace.projectId);
  check(assertions, "destination-seam-path", seamPath === canonicalMovePath, seamPath);
  check(assertions, "destination-seam-attached", destinationSeam.payload?.checkoutMode === "attached");
  check(assertions, "destination-seam-conversation-carried", destinationSeam.payload?.conversationCarried === true);
  check(assertions, "destination-seam-source-retained", destinationSeam.payload?.sourceArchiveRequested === false);
  const sourceSeams = sourceEvents.filter((event) => event.type === "session.moved" && event.payload?.direction === "source");
  check(assertions, "one-source-move-seam", sourceSeams.length === 1, sourceSeams.length);

  const movedLabel = `Moved to ${path.basename(canonicalMovePath)}, existing checkout`;
  const branchLabel = "Copy branch name verification-session-move-target";
  const destinationUi = await waitForMovedUi(
    browser,
    movedLabel,
    branchLabel,
    VERIFICATION_SCENARIOS.sessionMoveSecond.visibleText,
    timeoutMs,
  );
  check(assertions, "native-followed-destination", destinationUi.selectedWorkspaceId === destinationWorkspace.id);
  check(assertions, "native-destination-idle", destinationUi.idle);
  const moveStatus = await browser.$('[role="status"][aria-label="Moved to sibling, existing checkout"]');
  await moveStatus.scrollIntoView({ block: "center" });
  await moveStatus.waitForDisplayed({ timeout: timeoutMs });
  const destinationScreenshot = path.join(outputDir, "session-move-destination.png");
  await browser.saveScreenshot(destinationScreenshot);

  const worktreeResult = await runChecked("git", ["-C", repoPath, "worktree", "list", "--porcelain"], { timeoutMs: 10_000 });
  const worktreePaths = [];
  for (const line of worktreeResult.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    worktreePaths.push(await realpath(line.slice("worktree ".length)));
  }
  check(assertions, "source-checkout-exists", worktreePaths.includes(canonicalRepoPath));
  check(assertions, "destination-checkout-exists", worktreePaths.includes(canonicalMovePath));
  const sourceReadme = await readFile(path.join(repoPath, "README.md"));
  const destinationReadme = await readFile(path.join(movePath, "README.md"));
  check(assertions, "source-readme-unchanged", sourceReadme.equals(BASELINE_README), sourceReadme.length);
  check(assertions, "destination-readme-unchanged", destinationReadme.equals(BASELINE_README), destinationReadme.length);

  let invocationProofs = [];
  if (invocationLog) {
    const fixtureInvocations = (await readFile(invocationLog, "utf8"))
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((entry) => entry.args.includes("-p"));
    check(assertions, "two-session-move-provider-invocations", fixtureInvocations.length === 2, fixtureInvocations.length);
    const sourceInvocations = [];
    const destinationInvocations = [];
    for (const invocation of fixtureInvocations) {
      const cwd = await realpath(invocation.cwd);
      if (cwd === canonicalRepoPath) sourceInvocations.push(invocation);
      if (cwd === canonicalMovePath) destinationInvocations.push(invocation);
    }
    check(assertions, "one-source-provider-invocation", sourceInvocations.length === 1, sourceInvocations.length);
    check(assertions, "one-destination-provider-invocation", destinationInvocations.length === 1, destinationInvocations.length);
    const [sourceInvocation] = sourceInvocations;
    const [destinationInvocation] = destinationInvocations;
    const sourceSessionIdIndex = sourceInvocation.args.indexOf("--session-id");
    check(assertions, "source-provider-session-id", sourceSessionIdIndex >= 0
      && sourceInvocation.args[sourceSessionIdIndex + 1] === sourceSession.id);
    check(assertions, "source-provider-fresh-argv", sourceInvocation
      && !sourceInvocation.args.includes("--resume") && !sourceInvocation.args.includes("--fork-session"));
    check(assertions, "destination-provider-fork-argv", destinationInvocation?.args.slice(0, 5).join("\0")
      === ["-p", "--brief", "--resume", VERIFICATION_CONVERSATION_ID, "--fork-session"].join("\0"));
    invocationProofs = [
      { scenario: "source", cwd: sourceInvocation.cwd, fresh: true },
      { scenario: "destination", cwd: destinationInvocation.cwd, argvPrefix: destinationInvocation.args.slice(0, 5) },
    ];
  }

  const proof = {
    source: { sessionId: sourceSession.id, workspaceId: sourceWorkspace.id, path: canonicalRepoPath },
    destination: { sessionId: destinationSession.id, workspaceId: destinationWorkspace.id, path: canonicalMovePath },
    cli: { args: cliResult.args, response: cliResult.response },
    seams: { source: sourceSeams[0].payload, destination: destinationSeam.payload },
    ui: { source: sourceUi, destination: destinationUi },
    screenshots: [sourceScreenshot, destinationScreenshot],
    fixtureInvocations: invocationProofs,
    assertions,
  };
  await writeJson(path.join(outputDir, "session-move.json"), proof);

  return {
    session: destinationSession,
    workspace: destinationWorkspace,
    records: destinationEvents.map((event) => ({ kind: "event", ...event })),
    assertions,
    browser: [
      { ok: true, screenshot: sourceScreenshot, uiState: sourceUi },
      { ok: true, screenshot: destinationScreenshot, uiState: destinationUi },
    ],
  };
}
