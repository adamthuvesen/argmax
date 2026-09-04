import path from "node:path";

import { runChecked } from "./common.mjs";

function sessionProbe({ titleIncludes, expectedTexts, timeoutMs = 15_000 }) {
  return `(async () => {
    const deadline = Date.now() + ${Number(timeoutMs)};
    const wait = () => new Promise((resolve) => setTimeout(resolve, 100));
    let row = null;
    while (Date.now() < deadline) {
      row = [...document.querySelectorAll("button[title]")].find((entry) => entry.title.includes(${JSON.stringify(titleIncludes)}));
      if (row) break;
      for (const button of document.querySelectorAll('button[aria-label^="Show "][aria-label$=" chats"]')) button.click();
      await wait();
    }
    if (!row) return { ok: false, error: "session row missing", titles: [...document.querySelectorAll("button[title]")].map((entry) => entry.title).slice(0, 40) };
    row.click();
    while (Date.now() < deadline) {
      const text = document.body.innerText;
      const missing = ${JSON.stringify(expectedTexts)}.filter((expected) => !text.includes(expected));
      if (missing.length === 0) return {
        ok: true,
        missing,
        title: document.title,
        textLength: text.length,
        toolRows: document.querySelectorAll('[aria-label^="Tool call:"]').length,
        conversationRows: document.querySelectorAll('[aria-label="Conversation"] > *').length
      };
      await wait();
    }
    const text = document.body.innerText;
    return { ok: false, error: "expected text missing", missing: ${JSON.stringify(expectedTexts)}.filter((expected) => !text.includes(expected)), textTail: text.slice(-1500) };
  })()`;
}

export async function verifyBrowserSession(options) {
  const {
    repoRoot,
    port,
    token,
    outputDir,
    name = "browser-session",
    titleIncludes,
    expectedTexts,
    timeoutMs = 30_000
  } = options;
  const screenshot = path.join(outputDir, `${name}.png`);
  const url = `http://127.0.0.1:${port}/?remote#token=${token}`;
  const result = await runChecked(
    process.execPath,
    [
      "scripts/ui-screenshot.mjs",
      "--url",
      url,
      "--out",
      screenshot,
      "--settle",
      "250",
      "--eval",
      sessionProbe({ titleIncludes, expectedTexts, timeoutMs: 15_000 })
    ],
    { cwd: repoRoot, timeoutMs }
  );
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  const payload = JSON.parse(lines.at(-1));
  if (!payload.eval?.ok) throw new Error(`browser UI assertion failed: ${JSON.stringify(payload.eval)}`);
  return {
    ok: true,
    screenshot,
    uiState: payload.eval
  };
}
