const P = window.__perf;
const vis = (e) => !!e && e.getClientRects().length > 0;
const lab = (l) => [...document.querySelectorAll("[aria-label],[title]")].find((e) => (e.getAttribute("aria-label") === l || e.getAttribute("title") === l) && vis(e)) ?? null;
const textVisible = (t) => [...document.querySelectorAll(".chat-bubble, .chat-bubble-body, .turn-block, .conversation-list")].some((e) => vis(e) && e.textContent.includes(t));
const editorIn = (root) => [...root.querySelectorAll(".cm-content[contenteditable=true], textarea, [contenteditable=true]")].find(vis);
const type = (ed, text) => { ed.focus(); document.execCommand("insertText", false, text); };
const out = { newChat: [], followUp: [] };
const N = arg?.n ?? 4;
for (let i = 0; i < N; i++) {
  lab("New chat").click();
  for (let k = 0; k < 60 && !vis(P.byLabel("Task prompt")); k++) await P.sleep(50);
  await P.sleep(400);
  const prompt = `[argmax-verification:chat-resume:first] perf run ${Date.now()}`;
  const ed = editorIn(document.querySelector(".launcher-surface") || document);
  type(ed, prompt);
  await P.sleep(150);
  const ipc0 = P.ipc.length; const t0 = performance.now(); const marks = { clickEpoch: performance.timeOrigin + t0 };
  lab("Start agent").click();
  const deadline = t0 + 30000;
  while (performance.now() < deadline) {
    const now = Math.round(performance.now() - t0);
    if (marks.ack == null && (textVisible(prompt.slice(0, 40)))) marks.ack = now;
    if (marks.firstText == null && textVisible("Verification first turn complete")) marks.firstText = now;
    if (marks.firstText != null) break;
    await P.raf();
  }
  const calls = P.ipc.slice(ipc0).filter((c) => c.t0 - t0 < (marks.firstText ?? 30000));
  marks.ipc = calls.length;
  marks.launchIpc = calls.filter((c) => /launch|start|create/i.test(c.ch)).map((c) => [c.ch, Math.round(c.t0 - t0), c.t1 ? Math.round(c.t1 - t0) : null]);
  out.newChat.push(marks);
  await P.sleep(2500);
  // follow-up in the same chat (resume path)
  const pane = document.querySelector(".conversation-surface")?.closest("section,div[class*=pane]") || document;
  for (let k = 0; k < 100 && !document.querySelector(".session-link[data-status=complete][title*='in view']"); k++) await P.sleep(100);
  await P.sleep(500);
  const fed = lab("Chat prompt");
  if (fed) {
    const p2 = `[argmax-verification:chat-resume:second] follow ${Date.now()}`;
    type(fed, p2); await P.sleep(150);
    const t1 = performance.now(); const m2 = { clickEpoch: performance.timeOrigin + t1 };
    const send = lab("Send message") || lab("Send") || lab("Start agent") || [...document.querySelectorAll("button[type=submit]")].find(vis);
    if (send) send.click(); else P.key("Enter");
    while (performance.now() - t1 < 30000) {
      const now = Math.round(performance.now() - t1);
      if (m2.ack == null && textVisible(p2.slice(0, 40))) m2.ack = now;
      if (textVisible("Verification resumed turn complete")) { m2.firstText = now; break; }
      await P.raf();
    }
    m2.sendLabel = send?.getAttribute("aria-label") ?? "enter";
    out.followUp.push(m2);
  }
  await P.sleep(1500);
}
return out;
