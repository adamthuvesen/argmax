// One real Claude turn pair: a new chat, then a follow-up in it. Returns the
// two new turn waterfall rows, oldest first. Runs as the body of an async function.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const vis = (el) => !!el && el.getClientRects().length > 0;
const lab = (l) =>
  [...document.querySelectorAll("[aria-label],[title]")].find(
    (e) => (e.getAttribute("aria-label") === l || e.getAttribute("title") === l) && vis(e),
  ) ?? null;
const type = (ed, text) => {
  ed.focus();
  document.execCommand("insertText", false, text);
};
const rows = async () => (await window.argmax.session.turnWaterfalls({ limit: 100 })) ?? [];
const until = async (what, check, ms) => {
  const start = performance.now();
  while (performance.now() - start < ms) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
};
// The composer shows "Stop chat" exactly while a turn runs.
const complete = () => !vis(lab("Stop chat"));
const seen = new Set((await rows()).map((row) => row.id));
const newRows = async () =>
  (await rows()).filter((row) => !seen.has(row.id)).sort((a, b) => a.id - b.id);
const answered = async (count) => {
  const fresh = await newRows();
  return fresh.length >= count && fresh[count - 1].stamps.some((s) => s.name === "first_content");
};

lab("New chat").click();
await until("the launcher", () => vis(lab("Task prompt")), 5000);
await sleep(400);
if (arg?.project) {
  lab("Switch project").click();
  await sleep(300);
  const option = [
    ...document.querySelectorAll("[role=option],[role=menuitem],[role=menuitemradio]"),
  ].find((el) => vis(el) && el.textContent.trim().startsWith(arg.project));
  if (!option) throw new Error(`no project option ${arg.project}`);
  option.click();
  await sleep(400);
}
const launcher = [
  ...(document.querySelector(".launcher-surface") || document).querySelectorAll(
    ".cm-content[contenteditable=true], textarea",
  ),
].find(vis);
type(launcher, "Reply with just: ok");
await sleep(150);
lab("Start agent").click();
await until("the first answer", () => answered(1), 90000);
await until("the first turn to complete", complete, 90000);
await sleep(800);

const followUp = lab("Chat prompt");
if (!followUp) throw new Error("no chat prompt after the first turn");
type(followUp, "Reply with just: ok again");
await sleep(150);
const send = lab("Send follow-up") || lab("Send message");
if (!send) throw new Error("no send button for the follow-up");
send.click();
await until("the follow-up answer", () => answered(2), 90000);
await until("the follow-up to complete", complete, 90000);
// first_painted is stamped by the renderer after the turn; give it time to land.
await until(
  "first_painted on both rows",
  async () =>
    (await newRows())
      .slice(0, 2)
      .every((row) => row.stamps.some((s) => s.name === "first_painted")),
  10000,
).catch(() => {});
const [first, second] = await newRows();
return { newChat: first, followUp: second };
