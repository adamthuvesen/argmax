// Page probe for scripts/bench-latency.mjs. Runs inside the app's WKWebView as
// the body of an async function. Every timestamp is taken in the page: the
// WebDriver round trip never enters a measurement.
if (window.__perf) return "already";
const P = (window.__perf = { ipc: [], frames: [], muts: 0, lastMut: 0 });

// Count and time every request/response call on window.argmax.
for (const [area, api] of Object.entries(window.argmax ?? {})) {
  if (!api || typeof api !== "object") continue;
  for (const [name, fn] of Object.entries(api)) {
    if (typeof fn !== "function" || /^on[A-Z]/.test(name)) continue;
    api[name] = function (...args) {
      const call = { ch: `${area}.${name}`, t0: performance.now(), t1: null };
      P.ipc.push(call);
      const settle = () => (call.t1 = performance.now());
      let value;
      try {
        value = fn.apply(this, args);
      } catch (error) {
        settle();
        throw error;
      }
      if (value && typeof value.then === "function") value.then(settle, settle);
      else settle();
      return value;
    };
  }
}

new MutationObserver((records) => {
  P.muts += records.length;
  P.lastMut = performance.now();
}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });

// WKWebView emits no longtask entries, so stalls come from rAF frame gaps.
const loop = (time) => {
  P.frames.push(time);
  if (P.frames.length > 20000) P.frames.splice(0, 10000);
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

const raf = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
P.raf = raf;
P.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
P.byLabel = (label, root = document) =>
  [...root.querySelectorAll("[aria-label],[title]")].find(
    (el) => el.getAttribute("aria-label") === label || el.getAttribute("title") === label,
  );
P.key = (key, init = {}) => {
  const target = document.activeElement || document.body;
  for (const type of ["keydown", "keyup"]) {
    target.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init }));
  }
};

// shown: first frame the predicate holds. painted: two frames later, so the
// frame that drew it has been presented (floor ~33 ms at 60 Hz). settled: no
// DOM mutation for `quiet` ms and no IPC from this interaction in flight.
P.measure = async (name, action, predicate, { timeout = 15000, quiet = 150 } = {}) => {
  await raf();
  const ipcStart = P.ipc.length;
  const t0 = performance.now();
  await action();
  let shown = null;
  while (performance.now() - t0 < timeout) {
    if (predicate()) {
      shown = performance.now() - t0;
      break;
    }
    await raf();
  }
  await raf();
  await raf();
  const painted = shown == null ? null : performance.now() - t0;
  let settled = null;
  while (performance.now() - t0 < timeout) {
    const inFlight = P.ipc.slice(ipcStart).some((call) => call.t1 == null);
    if (!inFlight && performance.now() - Math.max(P.lastMut, t0) > quiet) {
      settled = Math.max(P.lastMut, t0) - t0;
      break;
    }
    await P.sleep(25);
  }
  const calls = P.ipc.slice(ipcStart);
  const channels = {};
  for (const call of calls) channels[call.ch] = (channels[call.ch] ?? 0) + 1;
  const frames = P.frames.filter((time) => time >= t0);
  let maxFrameGap = 0;
  for (let i = 1; i < frames.length; i += 1) maxFrameGap = Math.max(maxFrameGap, frames[i] - frames[i - 1]);
  const round = (value) => (value == null ? null : Math.round(value));
  return {
    name,
    shown: round(shown),
    painted: round(painted),
    settled: round(settled),
    ipc: calls.length,
    channels,
    slowestIpc: calls
      .filter((call) => call.t1 != null)
      .map((call) => [call.ch, Math.round(call.t1 - call.t0)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3),
    maxFrameGap: Math.round(maxFrameGap),
  };
};
return "installed";
