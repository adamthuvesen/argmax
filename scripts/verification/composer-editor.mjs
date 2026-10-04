#!/usr/bin/env node
// Drive the composers' real CodeMirror editor in a real (headless) Chrome.
//
// The unit suite replaces the editor with a textarea (src/test/composerEditorMock.tsx)
// because jsdom has no layout, so it cannot show that chips, undo, IME,
// clipboard and the keyboard work in an actual browser. This script can: it
// serves the renderer against its demo snapshot, opens the New chat launcher,
// and sends *trusted* input through the DevTools protocol (Input.insertText,
// Input.dispatchKeyEvent, Input.imeSetComposition), the same events a keyboard
// and an input method produce.
//
//   node scripts/verification/composer-editor.mjs [--out scratch/composer-editor] [--port 5291]
//
// Prints one JSON report and exits 1 when any check fails. Screenshots of the
// states worth looking at are written next to it. It cannot prove native
// window behavior, a real IME's candidate window, or the Rust backend; use the
// native verify-argmax drives for those.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIME = "application/x-argmax-composer+json";
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { out: "scratch/composer-editor", port: 5291 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") options.out = argv[++i];
    else if (argv[i] === "--port") options.port = Number(argv[++i]);
    else fail(`unknown argument: ${argv[i]}`);
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(probe, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    const eventWaiters = [];
    let nextId = 1;
    socket.addEventListener("open", () =>
      resolve({
        send(method, params = {}, sessionId = undefined) {
          return new Promise((resolveSend, rejectSend) => {
            const id = nextId++;
            pending.set(id, { resolve: resolveSend, reject: rejectSend });
            socket.send(JSON.stringify({ id, method, params, sessionId }));
          });
        },
        waitForEvent(method, timeoutMs = 15000) {
          return new Promise((resolveWait, rejectWait) => {
            const timer = setTimeout(() => rejectWait(new Error(`timed out waiting for ${method}`)), timeoutMs);
            eventWaiters.push({ method, resolve: (params) => { clearTimeout(timer); resolveWait(params); } });
          });
        },
        close() {
          socket.close();
        }
      })
    );
    socket.addEventListener("error", () => reject(new Error(`could not connect to ${wsUrl}`)));
    socket.addEventListener("message", (message) => {
      const frame = JSON.parse(String(message.data));
      if (frame.id !== undefined) {
        const entry = pending.get(frame.id);
        if (!entry) return;
        pending.delete(frame.id);
        if (frame.error) entry.reject(new Error(`${frame.error.message}`));
        else entry.resolve(frame.result);
        return;
      }
      for (let i = eventWaiters.length - 1; i >= 0; i -= 1) {
        if (eventWaiters[i].method === frame.method) {
          const [waiter] = eventWaiters.splice(i, 1);
          waiter.resolve(frame.params);
        }
      }
    });
  });
}

const options = parseArgs(process.argv.slice(2));
const cleanups = [];
process.on("exit", () => {
  for (const cleanup of cleanups.reverse()) cleanup();
});

const baseUrl = `http://localhost:${options.port}/`;
const vite = spawn("npx", ["vite", "--port", String(options.port), "--strictPort"], {
  cwd: repoRoot,
  stdio: ["ignore", "ignore", "inherit"]
});
cleanups.push(() => vite.kill("SIGTERM"));
await waitFor(() => fetch(baseUrl).then((response) => response.ok).catch(() => false), 30000, "the vite dev server");

const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chrome) fail("no Chromium-based browser found");
const profileDir = mkdtempSync(path.join(tmpdir(), "argmax-composer-editor-"));
const browser = spawn(
  chrome,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--use-mock-keychain",
    "--window-size=1200,900",
    "about:blank"
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
cleanups.push(() => browser.kill("SIGTERM"));
const wsUrl = await new Promise((resolve, reject) => {
  let buffer = "";
  const timer = setTimeout(() => reject(new Error("browser never printed its DevTools URL")), 15000);
  browser.stderr.on("data", (chunk) => {
    buffer += String(chunk);
    const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) {
      clearTimeout(timer);
      resolve(match[1]);
    }
  });
}).catch((error) => fail(error.message));

const cdp = await connectCdp(wsUrl);
const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
await cdp.send("Page.enable", {}, sessionId);
await cdp.send("Page.bringToFront", {}, sessionId);
await cdp.send(
  "Page.addScriptToEvaluateOnNewDocument",
  { source: `try { localStorage.setItem("argmax.theme.mode", "dark"); } catch {}` },
  sessionId
);
const loaded = cdp.waitForEvent("Page.loadEventFired");
await cdp.send("Page.navigate", { url: baseUrl }, sessionId);
await loaded;

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    sessionId
  );
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result?.value;
};

const outDir = path.resolve(options.out);
mkdirSync(outDir, { recursive: true });
const shot = async (name) => {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, "base64"));
};

const MODIFIER = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const KEYS = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Backspace: { code: "Backspace", vk: 8 },
  z: { code: "KeyZ", vk: 90 },
  a: { code: "KeyA", vk: 65 },
  c: { code: "KeyC", vk: 67 },
  x: { code: "KeyX", vk: 88 }
};
async function press(key, modifiers = 0, commands = undefined, { char = true } = {}) {
  const spec = KEYS[key];
  const base = {
    key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
    modifiers,
    // Editing commands a native shortcut would run; headless Chrome has no menu to do it.
    ...(commands ? { commands } : {})
  };
  const withChar = char && spec.text && !modifiers;
  await cdp.send("Input.dispatchKeyEvent", { type: withChar ? "keyDown" : "rawKeyDown", ...(withChar ? { text: spec.text } : {}), ...base }, sessionId);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
  await sleep(60);
}
const typeText = async (text) => {
  await cdp.send("Input.insertText", { text }, sessionId);
  await sleep(60);
};
const MOD = process.platform === "darwin" ? MODIFIER.meta : MODIFIER.ctrl;

// Copy captures: a listener after the editor's own, reading what the editor put on the clipboard.
await evaluate(`
  window.__copied = null;
  document.addEventListener("copy", (event) => {
    window.__copied = { plain: event.clipboardData.getData("text/plain"), typed: event.clipboardData.getData(${JSON.stringify(MIME)}) };
  });
`);

/** The draft's text exactly as it would be sent, read through the editor's own copy. */
async function draftText() {
  await evaluate(`window.__copied = null; document.querySelector('[aria-label="Task prompt"]').focus()`);
  await press("a", MOD);
  await press("c", MOD, ["copy"]);
  await sleep(80);
  const copied = await evaluate("window.__copied");
  return copied;
}

const checks = [];
async function check(name, run) {
  try {
    const detail = await run();
    checks.push({ name, ok: true, ...(detail ? { detail } : {}) });
  } catch (error) {
    checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

const prompt = `document.querySelector('[aria-label="Task prompt"]')`;
const dismissToasts = () =>
  evaluate(`document.querySelectorAll('button[aria-label="Dismiss"]').forEach((button) => button.click())`);
await waitFor(() => evaluate(`!!${prompt}`), 20000, "the launcher's prompt");
// The prompt is a textarea until the editor chunk has loaded; the checks are about the editor.
await waitFor(() => evaluate(`!!${prompt}?.closest(".cm-editor")`), 20000, "the editor chunk");

await check("the prompt is a CodeMirror textbox", async () => {
  const facts = await evaluate(`(() => { const el = ${prompt}; return { role: el.getAttribute("role"), multiline: el.getAttribute("aria-multiline"), editable: el.getAttribute("contenteditable"), inEditor: !!el.closest(".cm-editor"), height: el.closest(".composer-editor").getBoundingClientRect().height }; })()`);
  expect(facts.role === "textbox" && facts.multiline === "true" && facts.editable === "true" && facts.inEditor, JSON.stringify(facts));
  expect(facts.height >= 52, `field is ${facts.height}px, below the 52px floor`);
  return facts;
});

await evaluate(`${prompt}.focus()`);
await typeText("Compare with ");
await typeText("@design");

await check("@ offers chats by title, and Enter attaches one as a chip", async () => {
  await waitFor(() => evaluate(`!!document.querySelector('#file-popover [role="option"][aria-label^="Chat: Design parallel agent board"]')`), 5000, "the chat row");
  await shot("1-chat-menu");
  await press("Enter");
  await waitFor(() => evaluate(`!!document.querySelector('.composer-chat-chip[data-status="resolved"]')`), 5000, "the chip");
  const facts = await evaluate(`(() => { const chip = document.querySelector('.composer-chat-chip'); return { label: chip.textContent, bodyHasRaw: ${prompt}.innerText.includes("argmax://") }; })()`);
  expect(facts.label === "Design parallel agent board", `chip says ${facts.label}`);
  expect(!facts.bodyHasRaw, "the raw link is showing");
  await shot("2-chip");
  return facts;
});

await check("the draft is plain text carrying the chat's stable id, and copy adds a typed entry", async () => {
  const copied = await draftText();
  expect(copied?.plain.includes("[Design parallel agent board](argmax://chat/session-ui-board?v=1)"), `plain: ${copied?.plain}`);
  const typed = JSON.parse(copied.typed);
  expect(typed.v === 1 && typed.references.length === 1 && typed.references[0].sessionId === "session-ui-board", copied.typed);
  return { plain: copied.plain };
});

await check("Backspace removes a chip as one character, and undo brings it back", async () => {
  await evaluate(`${prompt}.focus()`);
  // Select-all left a selection; collapse to the end first.
  await press("Backspace"); // deletes the selection
  await typeText("x ");
  await typeText("@design");
  await waitFor(() => evaluate(`!!document.querySelector('#file-popover [role="option"]')`), 5000, "the menu");
  await press("Enter");
  await waitFor(() => evaluate(`!!document.querySelector('.composer-chat-chip')`), 5000, "the chip");
  await press("Backspace"); // the space after the chip
  const afterSpace = await evaluate(`document.querySelectorAll('.composer-chat-chip').length`);
  expect(afterSpace === 1, `chip count after deleting the trailing space: ${afterSpace}`);
  await press("Backspace"); // the chip itself
  const afterChip = await evaluate(`document.querySelectorAll('.composer-chat-chip').length`);
  expect(afterChip === 0, "the chip survived Backspace");
  await press("z", MOD);
  const afterUndo = await evaluate(`document.querySelectorAll('.composer-chat-chip').length`);
  expect(afterUndo === 1, "undo did not bring the chip back");
  return { afterSpace, afterChip, afterUndo };
});

await check("undo after picking from the @ menu takes back the pick, then the typing", async () => {
  await evaluate(`${prompt}.focus()`);
  await press("a", MOD);
  await press("Backspace");
  await typeText("look at ");
  await typeText("@design");
  await waitFor(() => evaluate(`!!document.querySelector('#file-popover [role="option"]')`), 5000, "the menu");
  await press("Enter");
  await waitFor(() => evaluate(`!!document.querySelector('.composer-chat-chip')`), 5000, "the chip");
  await press("z", MOD);
  const afterPickUndo = (await draftText())?.plain;
  expect(afterPickUndo === "look at @design", `after undoing the pick: ${JSON.stringify(afterPickUndo)}`);
  await evaluate(`${prompt}.focus()`);
  await press("z", MOD);
  const afterTypingUndo = (await draftText())?.plain;
  // Typing that follows a delete within the grouping delay undoes together
  // with it, so this lands wherever the group began; it must at least have moved.
  expect(afterTypingUndo !== afterPickUndo, `undo did nothing: ${JSON.stringify(afterTypingUndo)}`);
  return { afterPickUndo, afterTypingUndo };
});

await check("cut with only a caret changes nothing", async () => {
  await evaluate(`${prompt}.focus()`);
  await press("a", MOD);
  await press("Backspace");
  await typeText("keep this line");
  await press("x", MOD, ["cut"]);
  const text = (await draftText())?.plain;
  expect(text === "keep this line", `after a caret-only cut: ${JSON.stringify(text)}`);
  return { text };
});

await check("Enter right after typing sends what was typed", async () => {
  await evaluate(`${prompt}.focus()`);
  await press("a", MOD);
  await press("Backspace");
  await dismissToasts();
  await sleep(150);
  // No pause between the characters and the key, as a fast typist or a dictation tool delivers them.
  await cdp.send("Input.insertText", { text: "go now" }, sessionId);
  await press("Enter");
  await waitFor(() => evaluate(`document.body.innerText.includes("Open Argmax on your Mac")`), 5000, "the send attempt");
  return {};
});

await check("completing a slash command leaves the caret after it, so typing continues", async () => {
  await evaluate(`${prompt}.focus()`);
  await press("a", MOD);
  await press("Backspace");
  await typeText("/go");
  await waitFor(() => evaluate(`!!document.querySelector('#slash-menu [role="option"]')`), 5000, "the slash menu");
  await press("Enter");
  await typeText("ship it");
  const text = (await draftText())?.plain;
  expect(text === "/goal ship it", `draft: ${JSON.stringify(text)}`);
  return { text };
});

await check("a typed clipboard entry pastes as a chip", async () => {
  await evaluate(`${prompt}.focus()`);
  await press("a", MOD);
  await press("Backspace");
  const link = "[Review studio](argmax://chat/session-review-studio?v=1)";
  await evaluate(`(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "ignored");
    data.setData(${JSON.stringify(MIME)}, JSON.stringify({ v: 1, text: ${JSON.stringify(link)}, references: [{ v: 1, sessionId: "session-review-studio", title: "Review studio" }] }));
    ${prompt}.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  })()`);
  await sleep(120);
  const facts = await evaluate(`({ chips: document.querySelectorAll('.composer-chat-chip').length, label: document.querySelector('.composer-chat-chip')?.textContent })`);
  // The chip names the chat as the app knows it now, not as the clipboard remembered it.
  expect(facts.chips === 1 && facts.label === "Build review studio shell", JSON.stringify(facts));
  return facts;
});

await check("a reference to a chat the app does not have stays visible and unopenable", async () => {
  await evaluate(`${prompt}.focus()`);
  await press("a", MOD);
  await press("Backspace");
  await typeText("[Old planning chat](argmax://chat/long-gone-chat?v=1) ");
  await sleep(120);
  const facts = await evaluate(`(() => { const chip = document.querySelector('.composer-chat-chip'); return { status: chip?.dataset.status, label: chip?.textContent, title: chip?.title }; })()`);
  expect(facts.status === "unresolved" && facts.label === "Old planning chat (unavailable)", JSON.stringify(facts));
  await shot("3-unresolved-chip");
  return facts;
});

await check("Enter during an IME composition does not send; after it commits, Enter does", async () => {
  await evaluate(`${prompt}.focus()`);
  await press("a", MOD);
  await press("Backspace");
  await dismissToasts();
  await sleep(150);
  await cdp.send("Input.imeSetComposition", { text: "にほん", selectionStart: 3, selectionEnd: 3 }, sessionId);
  await sleep(80);
  // An input method consumes the Enter that confirms a candidate, so it makes
  // no character: a key with no text, while the composition is still open.
  await press("Enter", 0, undefined, { char: false });
  await sleep(150);
  const toastWhileComposing = await evaluate(`document.body.innerText.includes("Open Argmax on your Mac")`);
  expect(!toastWhileComposing, "Enter confirmed the composition AND sent the prompt");
  await cdp.send("Input.insertText", { text: "日本" }, sessionId);
  await sleep(80);
  const committed = (await draftText())?.plain;
  expect(committed === "日本", `committed text: ${JSON.stringify(committed)}`);
  await evaluate(`${prompt}.focus()`);
  await press("Enter");
  await waitFor(() => evaluate(`document.body.innerText.includes("Open Argmax on your Mac")`), 5000, "the send attempt");
  return { committed };
});

await check("background send keeps the launcher, and a failed start restores the draft", async () => {
  await evaluate(`${prompt}.focus()`);
  await press("a", MOD);
  await press("Backspace");
  await typeText("Background draft");
  await press("Enter", MODIFIER.alt);
  await waitFor(() => evaluate(`document.body.innerText.includes("Your draft is back in the composer")`), 5000, "the restore notice");
  const copied = await draftText();
  expect(copied?.plain === "Background draft", `draft after the failed start: ${JSON.stringify(copied?.plain)}`);
  expect(await evaluate(`!!${prompt}`), "the launcher went away");
  await shot("4-background-failed-restored");
  return { restored: copied.plain };
});

await check("the usage chip shows the plan's tightest window and opens a popover", async () => {
  await waitFor(() => evaluate(`!!document.querySelector('button[aria-label*=" plan: "]')`), 8000, "the usage chip");
  const label = await evaluate(`document.querySelector('button[aria-label*=" plan: "]').getAttribute("aria-label")`);
  await evaluate(`document.querySelector('button[aria-label*=" plan: "]').click()`);
  await waitFor(() => evaluate(`!!document.querySelector('[role="dialog"][aria-label="Plan usage"]')`), 3000, "the popover");
  await waitFor(() => evaluate(`document.querySelector('[role="dialog"][aria-label="Plan usage"]').innerText.includes("left")`), 5000, "the usage windows to settle");
  const text = await evaluate(`document.querySelector('[role="dialog"][aria-label="Plan usage"]').innerText`);
  expect(text.includes("left") && !text.includes("resets in now"), text);
  await shot("5-usage-popover");
  return { label };
});

cdp.close();
const failed = checks.filter((entry) => !entry.ok);
console.log(JSON.stringify({ ok: failed.length === 0, out: outDir, checks }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
