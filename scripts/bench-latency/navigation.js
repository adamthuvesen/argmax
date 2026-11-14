const P = window.__perf;
const N = arg?.n ?? 8;
const only = arg?.only ?? null;
const vis = (el) => !!el && el.getClientRects().length > 0;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)].filter(vis);
const lab = (l) => [...document.querySelectorAll("[aria-label],[title]")].find((e) => (e.getAttribute("aria-label") === l || e.getAttribute("title") === l) && vis(e)) ?? null;
const h1 = () => $$("h1").map((e) => e.textContent.trim()).join("|");
const overlays = () => $$("[role=listbox],[role=menu],[role=dialog],[role=tooltip]").length;
const rowsAll = () => $$(".session-link").filter((e) => !/archived/.test(e.title));
const expandAll = async () => {
  for (const b of $$("[aria-label^='Show '][aria-label$=' chats']")) if (!/Archived/.test(b.getAttribute("aria-label"))) { b.click(); await P.sleep(60); }
  const hide = lab("Hide Archived chats"); if (hide) { hide.click(); await P.sleep(100); }
};
const activeTitle = () => (rowsAll().find((r) => /in view/.test(r.title))?.title ?? "").split(" — ")[0];
const openRow = (row) => { const t = row.title.split(" — ")[0]; row.click(); return t; };
const sessionReady = (t) => () => activeTitle() === t && $$(".chat-bubble, .turn-block, .user-message-group").length > 0;
const goHome = async () => { P.key("Escape"); await P.sleep(150); const r = rowsAll()[0]; if (r && activeTitle() !== r.title.split(" — ")[0]) { r.click(); } await P.sleep(500); };
const pct = (v, f) => { const s = v.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))] : null; };
const sum = (name, runs) => ({
  name, n: runs.length,
  shown_p50: pct(runs.map((r) => r.shown), 0.5), shown_p95: pct(runs.map((r) => r.shown), 0.95),
  painted_p50: pct(runs.map((r) => r.painted), 0.5), painted_p95: pct(runs.map((r) => r.painted), 0.95),
  settled_p50: pct(runs.map((r) => r.settled), 0.5), settled_p95: pct(runs.map((r) => r.settled), 0.95),
  maxGap_p95: pct(runs.map((r) => r.maxFrameGap), 0.95),
  ipc_avg: +(runs.reduce((s, r) => s + r.ipc, 0) / runs.length).toFixed(1),
  misses: runs.filter((r) => r.shown == null).length,
  channels: runs[runs.length - 1]?.channels, slowestIpc: runs[runs.length - 1]?.slowestIpc,
});
const results = [];
const scen = async (name, fn) => { if (only && !only.some((o) => name.startsWith(o))) return; try { const runs = await fn(); results.push(sum(name, runs)); } catch (e) { results.push({ name, error: String(e).slice(0, 200) }); } await goHome(); };
const rep = async (n, open, ready, close) => { const runs = []; for (let i = 0; i < n; i++) { runs.push(await P.measure("x", open, ready)); await close(); await P.sleep(120); } return runs; };
const esc = async () => { P.key("Escape"); await P.sleep(200); };

await expandAll();
await goHome();

await scen("null.noop", () => rep(N, () => {}, () => true, async () => {}));

await scen("sidebar.group.toggle", async () => {
  const g = $$("[aria-label^='Hide '][aria-label$=' chats']").find((b) => !/Archived/.test(b.getAttribute("aria-label")));
  const name = g.getAttribute("aria-label").replace(/^Hide /, "");
  return rep(N, () => lab("Hide " + name).click(), () => !!lab("Show " + name), async () => { lab("Show " + name)?.click(); await P.sleep(150); });
});

await scen("sidebar.archived.expand", () => rep(N, () => lab("Show Archived chats").click(), () => $$(".session-link").some((e) => /archived/.test(e.title)), async () => { lab("Hide Archived chats")?.click(); await P.sleep(150); }));

await scen("sidebar.hide-show", () => rep(N, () => lab("Hide sidebar").click(), () => !vis($(".sidebar")) || !!lab("Show sidebar"), async () => { (lab("Show sidebar") || lab("Hide sidebar"))?.click(); await P.sleep(250); }));

// Session switch: first visit to each chat (cold), then revisit (warm).
await scen("session.switch.first-visit", async () => {
  const runs = [];
  const rows = rowsAll();
  for (let i = 1; i < rows.length && runs.length < Math.max(N, 12); i++) {
    const row = rowsAll()[i]; const t = row.title.split(" — ")[0];
    runs.push(await P.measure("x", () => row.click(), sessionReady(t)));
    await P.sleep(300);
  }
  return runs;
});
await scen("session.switch.revisit", async () => {
  const runs = [];
  for (let i = 0; i < N * 2; i++) {
    const row = rowsAll()[i % 2]; const t = row.title.split(" — ")[0];
    if (activeTitle() === t) { rowsAll()[(i + 1) % 2].click(); await P.sleep(600); }
    runs.push(await P.measure("x", () => row.click(), sessionReady(t)));
    await P.sleep(300);
  }
  return runs;
});
if (arg?.longTitle) await scen("session.switch.longest", async () => {
  const runs = [];
  for (let i = 0; i < N; i++) {
    const row = rowsAll().find((r) => r.title.startsWith(arg.longTitle)); const other = rowsAll().find((r) => r !== row);
    other.click(); await P.sleep(700);
    runs.push(await P.measure("x", () => row.click(), sessionReady(arg.longTitle)));
  }
  return runs;
});

await scen("palette.open", () => rep(N, () => lab("Open command palette").click(), () => $$("[role=listbox][aria-label='Command results'] [role=option]").length > 0, esc));
await scen("palette.query", async () => {
  const runs = [];
  for (let i = 0; i < N; i++) {
    lab("Open command palette").click(); await P.sleep(300);
    const input = lab("Command palette query"); input.focus();
    const q = ["fix", "argmax", "ship", "fork"][i % 4];
    const before = $$("[role=option]").map((o) => o.textContent).join("|");
    runs.push(await P.measure("x", () => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; s.call(input, q); input.dispatchEvent(new Event("input", { bubbles: true })); }, () => $$("[role=option]").map((o) => o.textContent).join("|") !== before));
    await esc();
  }
  return runs;
});
await scen("palette.tab.Files", async () => {
  const runs = [];
  for (let i = 0; i < N; i++) { lab("Open command palette").click(); await P.sleep(300); const tab = $$("[role=tab]").find((t) => t.textContent.trim() === "Files"); runs.push(await P.measure("x", () => tab.click(), () => tab.getAttribute("aria-selected") === "true" && $$("[role=option]").length > 0)); await esc(); }
  return runs;
});

await scen("settings.open", () => rep(N, () => lab("Open settings").click(), () => /General/.test(h1()), esc));
await scen("settings.section", async () => {
  lab("Open settings").click(); await P.sleep(600);
  const links = $$(".settings-rail-link");
  const runs = [];
  for (let i = 0; i < links.length * 2; i++) { const l = links[(i + 1) % links.length]; const t = l.textContent.trim(); runs.push(await P.measure("x", () => l.click(), () => h1().split("|").includes(t))); await P.sleep(200); }
  await esc();
  return runs;
});
await scen("page.usage", () => rep(N, () => lab("Hacking").click(), () => /Usage/.test(h1()) && $$("[aria-label='Usage by provider'] li").length > 0, goHome));
await scen("page.activity", async () => {
  const runs = [];
  for (let i = 0; i < N; i++) { lab("Hacking").click(); await P.sleep(500); const r = $("[aria-label='Hacking view'] input[value=activity]"); if (!r) throw new Error("no activity radio"); runs.push(await P.measure("x", () => r.click(), () => /Activity/.test(h1()))); await goHome(); }
  return runs;
});
await scen("page.schedule", () => rep(N, () => lab("Schedule").click(), () => /Schedul|Routine/.test(h1()), goHome));
await scen("page.new-chat", () => rep(N, () => lab("New chat").click(), () => vis(P.byLabel("Task prompt")), goHome));

for (const picker of ["Switch model", "Switch model effort", "Switch project", "Switch branch"]) {
  await scen("launcher.picker." + picker, async () => {
    lab("New chat").click(); await P.sleep(700);
    const runs = [];
    for (let i = 0; i < N; i++) { const b = lab(picker); if (!b) throw new Error("missing " + picker); const o = overlays(); runs.push(await P.measure("x", () => b.click(), () => overlays() > o)); await esc(); }
    return runs;
  });
}

for (const tab of ["Changes", "Files", "Terminal", "Pull requests"]) {
  await scen("workspace.tab." + tab, async () => {
    const runs = [];
    const row = rowsAll()[0]; const t = row.title.split(" — ")[0]; rowsAll()[1].click(); await P.sleep(700); row.click();
    for (let k = 0; k < 100 && !sessionReady(t)(); k++) await P.sleep(50);
    await P.sleep(800);
    // An open workspace tab carries a "Close <tab>" button; that is the shown signal and the closer.
    const closer = () => lab("Close " + tab);
    if (closer()) { closer().click(); await P.sleep(300); }
    for (let i = 0; i < N; i++) {
      const b = lab(tab); if (!b) throw new Error("missing tab " + tab);
      runs.push(await P.measure("x", () => b.click(), () => !!closer()));
      closer()?.click(); await P.sleep(300);
    }
    return runs;
  });
}

await scen("composer.keystroke", async () => {
  const ed = $$(".composer-input [contenteditable=true], .composer-input textarea, .cm-content[contenteditable=true], textarea")[0];
  if (!ed) throw new Error("no composer");
  ed.focus(); await P.sleep(200);
  const text = () => (ed.value ?? ed.textContent);
  const runs = [];
  for (let i = 0; i < Math.max(N * 3, 20); i++) { const before = text().length; runs.push(await P.measure("x", () => document.execCommand("insertText", false, "a"), () => text().length > before, { quiet: 60 })); }
  document.execCommand("selectAll"); document.execCommand("delete");
  return runs;
});

if (arg?.browser) await scen("page.browser", () => rep(1, () => lab("Browser").click(), () => vis($("section[aria-label=Browser]")), async () => {}));
return results;
