import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { delay, runChecked } from "./common.mjs";
import { writeJson } from "./evidence.mjs";

const STAGED_FILE = "staged.txt";
const EDITED_FILE = "edited.txt";
const BASELINE_CONTENT = "baseline\n";
const STAGED_CONTENT = "baseline\nstaged change\n";
const EDITED_CONTENT = "baseline\nunstaged change\n";
const EDITED_CONTENT_AFTER_REVISION = "baseline\nunstaged change after captured revision\n";
const EDITED_DIFF_TOGGLE = '[aria-label="Expand edited.txt diff"], [aria-label="Collapse edited.txt diff"]';

function recordAssertions() {
  const assertions = [];
  return {
    assertions,
    assert(name, condition, detail = null) {
      const assertion = { name, ok: Boolean(condition), ...(detail ? { detail } : {}) };
      assertions.push(assertion);
      if (!assertion.ok) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
    }
  };
}

async function isAbsent(filePath) {
  try {
    await access(filePath);
    return false;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return true;
    throw error;
  }
}

async function git(workspacePath, args, timeoutMs) {
  return await runChecked("git", args, { cwd: workspacePath, timeoutMs: Math.min(timeoutMs, 10_000) });
}

async function cachedDiff(workspacePath, timeoutMs) {
  const result = await git(workspacePath, ["diff", "--cached", "--binary"], timeoutMs);
  return Buffer.from(result.stdout, "utf8");
}

async function indexTree(workspacePath, timeoutMs) {
  return (await git(workspacePath, ["write-tree"], timeoutMs)).stdout.trim();
}

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function captureUiState(browser) {
  return await browser.execute(function workspaceRecoveryState() {
    return {
      title: document.title,
      activeElement: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName,
      bodyText: document.body.innerText.slice(0, 10_000),
      diagnostics: window.__ARGMAX_VERIFICATION__?.snapshot() ?? null
    };
  });
}

async function waitForCheckpoint({ bridge, workspaceId, checkpointIds, label, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    latest = await bridge.call("checkpoints:list", { workspaceId, limit: 50 });
    const checkpoint = latest.find((entry) => entry.label === label && !checkpointIds.has(entry.id));
    if (checkpoint) return { checkpoint, checkpoints: latest };
    await delay(100);
  }
  throw new Error(`Recovery checkpoint ${JSON.stringify(label)} was not recorded within ${timeoutMs}ms`);
}

async function waitForUncommittedOption(browser, timeoutMs) {
  let option = null;
  await browser.waitUntil(
    async () => {
      const listbox = await browser.$('[role="listbox"][aria-label="Changes shown"]');
      if (!(await listbox.isDisplayed())) return false;
      const candidates = await listbox.$$('[role="option"] button');
      for (const candidate of candidates) {
        if ((await candidate.getText()) === "Uncommitted") {
          option = candidate;
          return true;
        }
      }
      return false;
    },
    { timeout: timeoutMs, interval: 100, timeoutMsg: "Changes shown did not offer Uncommitted" }
  );
  return option;
}

async function selectUncommittedChanges(browser, timeoutMs) {
  let scope = null;
  await browser.waitUntil(
    async () => {
      const candidate = await browser.$('button[aria-label^="Changes shown: "]');
      if (!(await candidate.isDisplayed())) return false;
      scope = candidate;
      return true;
    },
    { timeout: timeoutMs, interval: 100, timeoutMsg: "Review did not expose its Changes shown control" }
  );
  const initialLabel = await scope.getAttribute("aria-label");
  if (initialLabel !== "Changes shown: Uncommitted") {
    await scope.click();
    const uncommitted = await waitForUncommittedOption(browser, timeoutMs);
    await uncommitted.click();
  }
  const selected = await browser.$('button[aria-label="Changes shown: Uncommitted"]');
  await selected.waitForDisplayed({ timeout: timeoutMs });
  return initialLabel;
}

/**
 * Verifies that an obsolete backend-bridge revision cannot revert newer file
 * bytes, then proves the native Review action reverts only that file's fresh
 * unstaged content while preserving the pre-existing index exactly.
 */
export async function verifyStagedPreservingRevert({
  bridge,
  browser,
  workspace,
  outputDir,
  timeoutMs = 30_000
}) {
  if (!bridge?.call) throw new Error("verifyStagedPreservingRevert requires a bridge with call()");
  if (!browser) throw new Error("verifyStagedPreservingRevert requires a native browser");
  if (!workspace?.id || !workspace?.path) {
    throw new Error("verifyStagedPreservingRevert requires a workspace id and path");
  }
  if (!outputDir) throw new Error("verifyStagedPreservingRevert requires outputDir");

  const workspacePath = path.resolve(workspace.path);
  const stagedPath = path.join(workspacePath, STAGED_FILE);
  const editedPath = path.join(workspacePath, EDITED_FILE);
  const beforeRevertScreenshotPath = path.join(outputDir, "workspace-recovery-before-revert.png");
  const screenshotPath = path.join(outputDir, "workspace-recovery.png");
  const statePath = path.join(outputDir, "workspace-recovery.json");
  const { assertions, assert } = recordAssertions();
  let result = null;

  await mkdir(outputDir, { recursive: true });
  try {
    const [initialStatus, stagedAbsent, editedAbsent] = await Promise.all([
      git(workspacePath, ["status", "--porcelain"], timeoutMs),
      isAbsent(stagedPath),
      isAbsent(editedPath)
    ]);
    assert("disposable recovery workspace begins clean", initialStatus.stdout.trim() === "", initialStatus.stdout.trim());
    assert(
      "recovery fixture paths are absent before creation",
      stagedAbsent && editedAbsent,
      [stagedAbsent ? null : STAGED_FILE, editedAbsent ? null : EDITED_FILE].filter(Boolean).join(", ")
    );

    await Promise.all([
      writeFile(stagedPath, BASELINE_CONTENT, { flag: "wx" }),
      writeFile(editedPath, BASELINE_CONTENT, { flag: "wx" })
    ]);
    await git(workspacePath, ["add", STAGED_FILE, EDITED_FILE], timeoutMs);
    await git(workspacePath, ["commit", "-m", "verification recovery baseline"], timeoutMs);

    await Promise.all([writeFile(stagedPath, STAGED_CONTENT), writeFile(editedPath, EDITED_CONTENT)]);
    await git(workspacePath, ["add", STAGED_FILE], timeoutMs);

    const [cachedDiffBefore, indexTreeBefore] = await Promise.all([
      cachedDiff(workspacePath, timeoutMs),
      indexTree(workspacePath, timeoutMs)
    ]);
    const stagedNames = (await git(workspacePath, ["diff", "--cached", "--name-only"], timeoutMs)).stdout
      .split("\n")
      .filter(Boolean);
    assert("fixture stages only staged.txt", stagedNames.length === 1 && stagedNames[0] === STAGED_FILE, stagedNames.join(", "));
    assert("fixture has a staged diff before recovery", cachedDiffBefore.length > 0);

    const staleDiff = await bridge.call("review:load-diff", {
      kind: "workspace",
      id: workspace.id,
      filePath: EDITED_FILE,
      comparison: "workingTree",
      contextLines: null
    });
    assert(
      "backend bridge stale-revision subcase captures edited.txt revision",
      staleDiff.filePath === EDITED_FILE && typeof staleDiff.revision === "string" && staleDiff.revision.length > 0
    );
    await writeFile(editedPath, EDITED_CONTENT_AFTER_REVISION);
    const editedBytesBeforeStaleRevert = await readFile(editedPath);
    let staleRevertError = null;
    try {
      await bridge.call("review:revert-file", {
        kind: "workspace",
        id: workspace.id,
        filePath: EDITED_FILE,
        revision: staleDiff.revision
      });
    } catch (error) {
      staleRevertError = error;
    }
    const [editedBytesAfterStaleRevert, cachedDiffAfterStaleRevert, indexTreeAfterStaleRevert, checkpointsBefore] = await Promise.all([
      readFile(editedPath),
      cachedDiff(workspacePath, timeoutMs),
      indexTree(workspacePath, timeoutMs),
      bridge.call("checkpoints:list", { workspaceId: workspace.id, limit: 50 })
    ]);
    const staleRevertMessage = staleRevertError instanceof Error ? staleRevertError.message : String(staleRevertError ?? "");
    assert(
      "backend bridge stale-revision subcase rejects with REVIEW_STALE_REVISION",
      staleRevertMessage.includes('"sub_code":"REVIEW_STALE_REVISION"'),
      staleRevertMessage
    );
    assert(
      "backend bridge stale-revision subcase preserves exact edited.txt bytes",
      editedBytesAfterStaleRevert.equals(editedBytesBeforeStaleRevert)
    );
    assert(
      "backend bridge stale-revision subcase preserves cached diff",
      cachedDiffAfterStaleRevert.equals(cachedDiffBefore)
    );
    assert(
      "backend bridge stale-revision subcase preserves index tree",
      indexTreeAfterStaleRevert === indexTreeBefore,
      `${indexTreeBefore} → ${indexTreeAfterStaleRevert}`
    );

    await bridge.call("workspaces:refresh-status", { workspaceId: workspace.id });
    const changes = await browser.$('aside[aria-label="Workspace"] button[aria-label="Changes"]');
    await changes.waitForDisplayed({ timeout: timeoutMs });
    await changes.waitForEnabled({ timeout: timeoutMs });
    await changes.click();

    const initialScope = await selectUncommittedChanges(browser, timeoutMs);
    assert("native Workspace Changes control opens Review", typeof initialScope === "string", initialScope);
    assert("native Review selects Uncommitted changes", true, initialScope);

    const editedEntry = await browser.$(EDITED_DIFF_TOGGLE);
    await editedEntry.waitForDisplayed({ timeout: timeoutMs });
    if ((await editedEntry.getAttribute("aria-label")) === `Expand ${EDITED_FILE} diff`) {
      await editedEntry.click();
    }
    const expandedEditedEntry = await browser.$(`[aria-label="Collapse ${EDITED_FILE} diff"]`);
    await expandedEditedEntry.waitForDisplayed({ timeout: timeoutMs });
    const stageHunk = await browser.$('[aria-label="Stage hunk"]');
    await stageHunk.waitForDisplayed({ timeout: timeoutMs });
    const hunkActions = await browser.execute(function workspaceRecoveryHunkActions() {
      const stage = document.querySelector('button[aria-label="Stage hunk"]');
      const header = stage?.closest(".diff-hunk-header");
      const revertHunk = header?.querySelector('button[aria-label="Revert unstaged hunk"]');
      return {
        stageText: stage?.textContent?.trim() ?? null,
        revertText: revertHunk?.textContent?.trim() ?? null,
        gap: header ? window.getComputedStyle(header).gap : null
      };
    });
    assert("native edited hunk exposes the Stage action", hunkActions.stageText === "Stage", JSON.stringify(hunkActions));
    assert(
      "native edited hunk actions use the 8px spacing token",
      hunkActions.revertText === "Revert" && hunkActions.gap === "8px",
      JSON.stringify(hunkActions)
    );
    const revert = await browser.$('[aria-label="Revert unstaged changes in edited.txt"]');
    await revert.waitForEnabled({ timeout: timeoutMs });
    await browser.saveScreenshot(beforeRevertScreenshotPath);
    await revert.click();

    const editedEntryAfterRevert = await browser.$(EDITED_DIFF_TOGGLE);
    await editedEntryAfterRevert.waitForExist({ reverse: true, timeout: timeoutMs });
    await bridge.call("workspaces:refresh-status", { workspaceId: workspace.id });

    const { checkpoint } = await waitForCheckpoint({
      bridge,
      workspaceId: workspace.id,
      checkpointIds: new Set(checkpointsBefore.map((entry) => entry.id)),
      label: "Before reverting edited.txt",
      timeoutMs
    });
    // Serialize the harness's Git operations. The renderer's own refresh can
    // still overlap the bridge read, exercising concurrent product readers.
    const cachedDiffAfter = await cachedDiff(workspacePath, timeoutMs);
    const indexTreeAfter = await indexTree(workspacePath, timeoutMs);
    const editedContent = await readFile(editedPath, "utf8");
    const headEditedContent = (await git(workspacePath, ["show", `HEAD:${EDITED_FILE}`], timeoutMs)).stdout;
    const workingTree = await bridge.call("review:load-diff", {
      kind: "workspace",
      id: workspace.id,
      filePath: null,
      comparison: "workingTree",
      contextLines: null
    });
    const workingTreeNames = (await git(workspacePath, ["diff", "--name-only"], timeoutMs)).stdout
      .split("\n")
      .filter(Boolean);

    assert("edited.txt is restored to HEAD", editedContent === headEditedContent);
    assert("cached diff is byte-identical after recovery", cachedDiffAfter.equals(cachedDiffBefore));
    assert("index tree is unchanged after recovery", indexTreeAfter === indexTreeBefore, `${indexTreeBefore} → ${indexTreeAfter}`);
    assert(
      "recovery checkpoint preserves the pre-action index tree",
      checkpoint.indexTree === indexTreeBefore,
      `${checkpoint.indexTree} === ${indexTreeBefore}`
    );
    const refreshedEditedEntry = await browser.$(EDITED_DIFF_TOGGLE);
    assert("native Review refresh removes edited.txt", !(await refreshedEditedEntry.isExisting()));
    assert(
      "working-tree review diff omits edited.txt",
      !workingTree.content.includes(EDITED_FILE),
      workingTree.content.slice(0, 500)
    );
    assert("git working-tree diff omits edited.txt", !workingTreeNames.includes(EDITED_FILE), workingTreeNames.join(", "));

    await browser.waitUntil(
      async () => await browser.execute(() => document.body.innerText.includes("staged change")),
      { timeout: timeoutMs, interval: 100, timeoutMsg: "Review did not finish rendering the preserved staged change" }
    );
    assert("native Review renders the preserved staged change after refresh", true);

    result = {
      assertions,
      staleRevisionProof: {
        driver: "backend-bridge",
        revision: staleDiff.revision,
        error: staleRevertMessage,
        editedBytesBefore: {
          bytes: editedBytesBeforeStaleRevert.length,
          sha256: digest(editedBytesBeforeStaleRevert),
          base64: editedBytesBeforeStaleRevert.toString("base64")
        },
        editedBytesAfter: {
          bytes: editedBytesAfterStaleRevert.length,
          sha256: digest(editedBytesAfterStaleRevert),
          base64: editedBytesAfterStaleRevert.toString("base64")
        },
        cachedDiffSha256Before: digest(cachedDiffBefore),
        cachedDiffSha256After: digest(cachedDiffAfterStaleRevert),
        indexTreeBefore,
        indexTreeAfter: indexTreeAfterStaleRevert
      },
      freshRevertProof: {
        driver: "native-webview",
        hunkActions,
        beforeRevertScreenshot: beforeRevertScreenshotPath
      },
      filesystemProof: {
        editedContent,
        headEditedContent,
        cachedDiffBefore: {
          bytes: cachedDiffBefore.length,
          sha256: digest(cachedDiffBefore),
          base64: cachedDiffBefore.toString("base64")
        },
        cachedDiffAfter: {
          bytes: cachedDiffAfter.length,
          sha256: digest(cachedDiffAfter),
          base64: cachedDiffAfter.toString("base64")
        },
        indexTreeBefore,
        indexTreeAfter,
        workingTreeFiles: workingTreeNames,
        reviewWorkingTreeDiff: workingTree.content
      },
      checkpoint,
      screenshot: screenshotPath,
      state: statePath
    };
    return result;
  } finally {
    const uiState = await captureUiState(browser).catch((error) => ({ captureError: String(error) }));
    await browser.saveScreenshot(screenshotPath).catch(() => {});
    await writeJson(statePath, { result, assertions, uiState });
  }
}
