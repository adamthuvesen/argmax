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
    agentExpectedTexts = null,
    theme = null,
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
      agentExpectedTexts
        ? `(async () => {
            const session = await ${sessionProbe({ titleIncludes, expectedTexts, timeoutMs: 15_000 })};
            if (!session.ok) return session;
            const deadline = Date.now() + 15000;
            const wait = () => new Promise(resolve => setTimeout(resolve, 100));
            let launchButtons = [];
            while (Date.now() < deadline) {
              // Minimal verbosity hides completed activity behind the turn chip,
              // then condenses the restored Task rows behind an activity group.
              // Long transcripts additionally leave older turns outside the
              // render window. Open those user-facing disclosures before asking
              // for both assignments, as a reader would.
              const earlier = document.querySelector('button.conversation-show-earlier');
              if (earlier) earlier.click();
              for (const chip of document.querySelectorAll('button.turn-block-chip[aria-expanded="false"]')) chip.click();
              for (const group of document.querySelectorAll('button.tool-call-group-header[aria-expanded="false"]')) group.click();
              await wait();
              launchButtons = [...document.querySelectorAll('button[aria-label^="Started agent "]')];
              if (launchButtons.length >= 2) break;
              await wait();
            }
            if (launchButtons.length < 2) return {
              ok: false,
              error: "two parent assignment rows missing",
              count: launchButtons.length,
              chips: [...document.querySelectorAll('button.turn-block-chip')].map(button => ({ label: button.getAttribute('aria-label'), expanded: button.getAttribute('aria-expanded') })),
              groups: [...document.querySelectorAll('button.tool-call-group-header')].map(button => ({ label: button.getAttribute('aria-label'), expanded: button.getAttribute('aria-expanded') })),
            };
            for (const button of launchButtons) { button.click(); await wait(); }
            while (Date.now() < deadline) {
              const panel = document.querySelector('[role="tabpanel"][aria-labelledby^="review-agent-tab-"]');
              const text = panel?.innerText ?? '';
              const tabs = document.querySelectorAll('[aria-label="Subagents and multitasks"] [role="tab"]');
              const missing = ${JSON.stringify(agentExpectedTexts)}.filter(expected => !text.includes(expected));
              if (!missing.length && tabs.length === 1) return {ok: true, tabCount: tabs.length, runCount: panel.querySelectorAll('[aria-label^="Agent activity:"]').length, text};
              await wait();
            }
            return {ok: false, error: "persistent dock did not show both runs in one tab", text: document.body.innerText.slice(-4000)};
          })()`
        : sessionProbe({ titleIncludes, expectedTexts, timeoutMs: 15_000 }),
      ...(theme ? ["--theme", theme] : [])
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
