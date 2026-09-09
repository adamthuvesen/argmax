#!/usr/bin/env node
// Mount the production conversation scroll hook in a Vite fixture, then drive
// real browser layout through Chromium. `--serve` keeps the fixture available
// so another browser engine can open the printed URL and evaluate the exported
// `getBrowserCheckSource()` expression.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteEntry = path.join(repoRoot, "node_modules/vite/bin/vite.js");

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("could not allocate a Vite port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForUrl(url, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited with code ${child.exitCode}`);
    if (await fetch(url).then((response) => response.ok).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for the chat-scroll fixture");
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

export const browserFixtureSource = String.raw`
import React, { useLayoutEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useConversationScroll } from "/src/renderer/hooks/useConversationScroll.ts";

const h = React.createElement;
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const afterPaint = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
let mountedRoot = null;
let active = null;
const browserErrors = [];

window.addEventListener("error", (event) => {
  browserErrors.push(event.message || String(event.error || "unknown window error"));
});

function block(id, height, extra = {}) {
  return h("section", {
    className: "fixture-block",
    "data-block": id,
    style: { height: height + "px" },
    ...extra
  }, id);
}

function ScrollFixture({ surface, initialLiveHeight, sameTurnScenario = false, initialAboveHeight = 300, initialViewportHeight = 480 }) {
  const [liveHeight, setLiveHeight] = useState(initialLiveHeight ?? (surface === "main" ? 260 : 380));
  const [insertedHeight, setInsertedHeight] = useState(0);
  const [itemVersion, setItemVersion] = useState(0);
  const [nestedHeight, setNestedHeight] = useState(180);
  const [aboveHeight, setAboveHeight] = useState(initialAboveHeight);
  const [viewportHeight, setViewportHeight] = useState(initialViewportHeight);
  const items = useMemo(
    () => [surface, liveHeight, insertedHeight, itemVersion, nestedHeight, aboveHeight],
    [surface, liveHeight, insertedHeight, itemVersion, nestedHeight, aboveHeight]
  );
  const api = useConversationScroll({ sessionId: "scroll-check-" + surface, items });
  const measure = () => {
    const scroller = api.scrollRef.current;
    const content = api.contentRef.current;
    const rect = scroller.getBoundingClientRect();
    const probeY = rect.top + 48;
    const children = [...content.children].filter((child) => child.matches("[data-block]"));
    const probe = children.find((child) => {
      const childRect = child.getBoundingClientRect();
      return childRect.top <= probeY && childRect.bottom >= probeY;
    }) ?? children.find((child) => child.getBoundingClientRect().bottom >= probeY) ?? null;
    const tracked = probe ?? scroller.querySelector('[data-block="reader"]');
    return {
      surface,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      distanceFromBottom: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
      contentMinHeight: content.style.minHeight,
      contentHeight: content.getBoundingClientRect().height,
      anchorId: tracked?.getAttribute("data-block") ?? null,
      anchorTop: tracked?.getBoundingClientRect().top ?? null,
      showFab: api.showScrollToBottom,
      newBelowCount: api.newBelowCount
    };
  };

  const measureAnchor = (anchorId) => {
    const scroller = api.scrollRef.current;
    const anchor = api.contentRef.current.querySelector('[data-block="' + anchorId + '"]');
    return { ...measure(), anchorId, anchorTop: anchor?.getBoundingClientRect().top ?? null };
  };

  const measureMarker = (markerId) => {
    const marker = api.contentRef.current.querySelector('[data-marker="' + markerId + '"]');
    return { ...measure(), anchorId: markerId, anchorTop: marker?.getBoundingClientRect().top ?? null };
  };

  useLayoutEffect(() => {
    active = {
      measure,
      measureAnchor,
      measureMarker,
      scrollToBottom: async () => {
        api.scrollToBottom();
        await nextFrame();
        return measure();
      },
      scrollUp: async (pixels) => {
        const scroller = api.scrollRef.current;
        scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -pixels }));
        scroller.scrollBy({ top: -pixels, behavior: "instant" });
        await nextFrame();
        return measure();
      },
      touchScrollUp: async (pixels) => {
        const scroller = api.scrollRef.current;
        const touchEvent = (type, clientY) => {
          const event = new Event(type, { bubbles: true });
          Object.defineProperty(event, "touches", {
            value: type === "touchend" ? [] : [{ clientY }]
          });
          scroller.dispatchEvent(event);
        };
        touchEvent("touchstart", 100);
        touchEvent("touchmove", 100 + pixels);
        scroller.scrollBy({ top: -pixels, behavior: "instant" });
        touchEvent("touchend", 100 + pixels);
        await nextFrame();
        return measure();
      },
      // Upward input at the physical bottom that the scroller cannot act on:
      // the macOS overscroll bounce's negative wheel deltas, a thumb's drift
      // on a tap. Nothing scrolls, so no scroll event follows either.
      inertUpwardInput: async (kind) => {
        const scroller = api.scrollRef.current;
        if (kind === "wheel") {
          scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -40 }));
        } else {
          const touchEvent = (type, clientY) => {
            const event = new Event(type, { bubbles: true });
            Object.defineProperty(event, "touches", {
              value: type === "touchend" ? [] : [{ clientY }]
            });
            scroller.dispatchEvent(event);
          };
          touchEvent("touchstart", 100);
          touchEvent("touchmove", 106);
          touchEvent("touchend", 106);
        }
        await nextFrame();
        await nextFrame();
        return measure();
      },
      scrollUpThenGrow: async (pixels, growth) => {
        const scroller = api.scrollRef.current;
        scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -pixels }));
        scroller.scrollBy({ top: -pixels, behavior: "instant" });
        setLiveHeight((height) => height + growth);
        setItemVersion((version) => version + 1);
        await nextFrame();
        return measure();
      },
      scrollUpThenGrowWithoutWheel: async (pixels, growth) => {
        const scroller = api.scrollRef.current;
        scroller.scrollBy({ top: -pixels, behavior: "instant" });
        setLiveHeight((height) => height + growth);
        setItemVersion((version) => version + 1);
        await nextFrame();
        return measure();
      },
      growBelow: async (pixels) => {
        setLiveHeight((height) => height + pixels);
        setItemVersion((version) => version + 1);
        await nextFrame();
        return measure();
      },
      collapseBelow: async (pixels) => {
        setLiveHeight((height) => Math.max(20, height - pixels));
        setItemVersion((version) => version + 1);
        await nextFrame();
        return measure();
      },
      insertAbove: async (pixels) => {
        setInsertedHeight((height) => height + pixels);
        setItemVersion((version) => version + 1);
        await nextFrame();
        return measure();
      },
      changeSameTurnAbove: async (pixels) => {
        setAboveHeight((height) => Math.max(20, height + pixels));
        setItemVersion((version) => version + 1);
        await nextFrame();
        return measure();
      },
      resizeViewport: async (pixels) => {
        setViewportHeight((height) => Math.max(240, height + pixels));
        await nextFrame();
        return measure();
      },
      scrollToPhysicalBottom: async () => {
        const scroller = api.scrollRef.current;
        scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
        await nextFrame();
        return measure();
      },
      scrollToBottomBeforeCommit: async (growth) => {
        const scroller = api.scrollRef.current;
        scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
        flushSync(() => {
          setLiveHeight((height) => height + growth);
          setItemVersion((version) => version + 1);
        });
        await nextFrame();
        return measure();
      },
      resizeBelowWithoutRender: async (pixels) => {
        const target = api.contentRef.current.querySelector('[data-block="live-output"]');
        target.style.height = Math.max(20, target.getBoundingClientRect().height + pixels) + "px";
        await nextFrame();
        return measure();
      },
      resizeBelowWithoutRenderAndSettle: async (pixels) => {
        const target = api.contentRef.current.querySelector('[data-block="live-output"]');
        const before = measure();
        const errorStart = browserErrors.length;
        target.style.height = Math.max(20, target.getBoundingClientRect().height + pixels) + "px";
        await new Promise((resolve) => setTimeout(resolve, 100));
        const firstSettled = measure();
        await nextFrame();
        const after = measure();
        return {
          before,
          after,
          errors: browserErrors.slice(errorStart),
          settled:
            Math.abs(after.scrollTop - firstSettled.scrollTop) <= 1 &&
            Math.abs(after.scrollHeight - firstSettled.scrollHeight) <= 1 &&
            Math.abs(after.contentHeight - firstSettled.contentHeight) <= 1
        };
      },
      resizeAroundPromptAcrossPaints: async (targetId, pixels) => {
        const target = api.contentRef.current.querySelector('[data-block="' + targetId + '"]');
        await new Promise((resolve) => setTimeout(resolve, 100));
        const before = measureAnchor("latest-user");
        const errorStart = browserErrors.length;
        target.style.height = Math.max(20, target.getBoundingClientRect().height + pixels) + "px";
        const frames = [];
        for (let frame = 1; frame <= 4; frame += 1) {
          await afterPaint();
          frames.push({ frame, ...measureAnchor("latest-user") });
        }
        return { before, frames, errors: browserErrors.slice(errorStart) };
      },
      collapseThenRegrowBeforeReconcile: async (collapsePixels, regrowthPixels) => {
        const scroller = api.scrollRef.current;
        const target = api.contentRef.current.querySelector('[data-block="live-output"]');
        const before = measure();
        target.style.height = Math.max(20, target.getBoundingClientRect().height - collapsePixels) + "px";
        // Reading scrollTop forces Chromium to apply the transient range clamp
        // before React replaces the collapsed child in the same task.
        const forcedScrollTop = scroller.scrollTop;
        const collapsed = { ...measure(), forcedScrollTop };
        flushSync(() => {
          setLiveHeight((height) => height + regrowthPixels);
          setItemVersion((version) => version + 1);
        });
        await nextFrame();
        return { before, collapsed, regrown: measure() };
      },
      nestedScrollThenGrow: async (nestedPixels, growth) => {
        const nested = api.contentRef.current.querySelector(".nested-scroll");
        nested.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: nestedPixels }));
        nested.scrollBy({ top: nestedPixels, behavior: "instant" });
        setNestedHeight((height) => height + growth);
        await nextFrame();
        return measure();
      }
    };
  });

  const ordinaryContent = [
    insertedHeight > 0 ? block("inserted", insertedHeight) : null,
    block("history-a", 360),
    block("history-b", 300),
    block("reader", 180),
    h("section", { className: "fixture-block nested-card", "data-block": "nested", key: "nested" },
      h("div", { className: "nested-scroll" },
        h("div", { style: { height: nestedHeight + "px" } }, "nested tool output"))),
    surface === "main"
      ? block("latest-user", 64, { "data-turn-anchor": "", key: "latest-user" })
      : null,
    block("live-output", liveHeight, { key: "live-output" }),
    surface === "main"
      ? h("div", { className: "conversation-tail", key: "tail" }, "working")
      : null,
  ];
  const sameTurnContent = [
    block("same-history", 800),
    h("section", { className: "fixture-block same-turn", "data-block": "same-turn", key: "same-turn" },
      h("div", { className: "same-turn-above", style: { height: aboveHeight + "px" } }, "activity above reader"),
      h("div", { className: "same-turn-reader", "data-marker": "same-turn-reader" }, "reader marker"),
      h("div", { className: "same-turn-below" }, "activity below reader"))
  ];
  const content = sameTurnScenario ? sameTurnContent : ordinaryContent;

  return h("main", { className: "fixture-shell " + surface },
    h("h1", null, surface === "main" ? "Agent conversation" : "Subagent activity"),
    h("div", { className: "scroll-frame" },
      h("div", { className: surface === "main" ? "conversation-list" : "agent-activity-scroll", ref: api.scrollRef, style: { height: viewportHeight + "px" } },
        h("div", { className: surface === "main" ? "conversation-content" : "agent-activity-content", ref: api.contentRef }, content)),
      api.showScrollToBottom
        ? h("button", { className: "scroll-to-bottom-fab", onClick: api.scrollToBottom }, "Scroll to latest")
        : null));
}

async function mount(surface, options = {}) {
  if (mountedRoot) mountedRoot.unmount();
  document.querySelector("#root").replaceChildren();
  mountedRoot = createRoot(document.querySelector("#root"));
  mountedRoot.render(h(ScrollFixture, { surface, ...options }));
  for (let attempt = 0; attempt < 10 && !active; attempt += 1) await nextFrame();
  await nextFrame();
  if (!active) throw new Error("scroll fixture did not mount");
  await active.scrollToBottom();
  return active.measure();
}

function movement(before, after) {
  return Math.round((after.anchorTop - before.anchorTop) * 100) / 100;
}

async function tinyScrollThen(surface, action, pixels, amount) {
  await mount(surface);
  const detached = await active.scrollUp(pixels);
  const before = active.measureAnchor(detached.anchorId);
  await active[action](amount);
  const after = active.measureAnchor(before.anchorId);
  return { surface, before, after, movement: movement(before, after) };
}

async function runChecks() {
  const results = [];
  for (const surface of ["main", "agent"]) {
    results.push({ name: surface + ": tiny upward scroll then streamed growth", ...(await tinyScrollThen(surface, "growBelow", 12, 320)), tolerance: 2 });
    results.push({ name: surface + ": tiny upward scroll then collapse below", ...(await tinyScrollThen(surface, "collapseBelow", 12, 360)), tolerance: 2 });

    await mount(surface);
    const touchDetached = await active.touchScrollUp(12);
    const touchBefore = active.measureAnchor(touchDetached.anchorId);
    await active.growBelow(320);
    const touchAfter = active.measureAnchor(touchBefore.anchorId);
    results.push({
      name: surface + ": touch movement detaches before streamed growth",
      surface,
      before: touchBefore,
      after: touchAfter,
      movement: movement(touchBefore, touchAfter),
      tolerance: 2
    });

    for (const kind of ["wheel", "touch"]) {
      await mount(surface);
      await active.inertUpwardInput(kind);
      const inertInput = active.measure();
      await active.growBelow(120);
      const inertAfterGrowth = active.measure();
      results.push({
        name: surface + ": inert upward " + kind + " input at the bottom keeps following",
        surface,
        before: inertInput,
        after: inertAfterGrowth,
        movement: Math.round(Math.max(inertInput.distanceFromBottom, inertAfterGrowth.distanceFromBottom) * 100) / 100,
        extraOk: !inertInput.showFab && !inertAfterGrowth.showFab,
        tolerance: 1
      });
    }

    await mount(surface);
    const raceProbe = active.measure();
    const raceStart = active.measureAnchor(raceProbe.anchorId);
    await active.scrollUpThenGrow(12, 320);
    const raceEnd = active.measureAnchor(raceStart.anchorId);
    const raceMovement = movement(raceStart, raceEnd);
    results.push({
      name: surface + ": user movement pending before layout reconciliation",
      surface,
      before: raceStart,
      after: raceEnd,
      movement: Math.round((raceMovement - 12) * 100) / 100,
      observedMovement: raceMovement,
      expectedMovement: 12,
      tolerance: 2
    });

    await mount(surface);
    const scrollbarProbe = active.measure();
    const scrollbarStart = active.measureAnchor(scrollbarProbe.anchorId);
    await active.scrollUpThenGrowWithoutWheel(12, 320);
    const scrollbarEnd = active.measureAnchor(scrollbarStart.anchorId);
    const scrollbarMovement = movement(scrollbarStart, scrollbarEnd);
    results.push({
      name: surface + ": scrollbar movement pending before layout reconciliation",
      surface,
      before: scrollbarStart,
      after: scrollbarEnd,
      movement: Math.round((scrollbarMovement - 12) * 100) / 100,
      observedMovement: scrollbarMovement,
      expectedMovement: 12,
      tolerance: 2
    });

    await mount(surface);
    await active.scrollUp(160);
    const insertBeforeProbe = active.measure();
    const insertBefore = active.measureAnchor(insertBeforeProbe.anchorId);
    await active.insertAbove(240);
    const insertAfter = active.measureAnchor(insertBefore.anchorId);
    results.push({ name: surface + ": earlier insertion preserves the reader", surface, before: insertBefore, after: insertAfter, movement: movement(insertBefore, insertAfter), tolerance: 2 });

    await mount(surface);
    await active.scrollUp(160);
    const nestedBeforeProbe = active.measure();
    const nestedBefore = active.measureAnchor(nestedBeforeProbe.anchorId);
    await active.nestedScrollThenGrow(80, 140);
    const nestedAfter = active.measureAnchor(nestedBefore.anchorId);
    results.push({ name: surface + ": nested scrolling does not move the outer reader", surface, before: nestedBefore, after: nestedAfter, movement: movement(nestedBefore, nestedAfter), tolerance: 2 });

    await mount(surface);
    await active.resizeViewport(-120);
    const followingResize = active.measure();
    results.push({
      name: surface + ": viewport resize follows the bottom",
      surface,
      before: null,
      after: followingResize,
      movement: Math.round(followingResize.distanceFromBottom * 100) / 100,
      tolerance: 1
    });

    await mount(surface);
    const grownViewport = await active.resizeViewport(120);
    await active.growBelow(200);
    const grownViewportFollow = active.measure();
    results.push({
      name: surface + ": viewport increase stays following through later growth",
      surface,
      before: grownViewport,
      after: grownViewportFollow,
      movement: Math.round(Math.max(grownViewport.distanceFromBottom, grownViewportFollow.distanceFromBottom) * 100) / 100,
      extraOk: !grownViewport.showFab && !grownViewportFollow.showFab,
      tolerance: 1
    });

    await mount(surface, { initialLiveHeight: 720 });
    const followingCollapseBefore = active.measure();
    await active.collapseBelow(400);
    const followingCollapseAfter = active.measure();
    results.push({
      name: surface + ": permanent child collapse keeps following without a stale floor",
      surface,
      before: followingCollapseBefore,
      after: followingCollapseAfter,
      movement: Math.round(followingCollapseAfter.distanceFromBottom * 100) / 100,
      extraOk:
        followingCollapseAfter.distanceFromBottom <= 1 &&
        !followingCollapseAfter.showFab &&
        followingCollapseAfter.contentHeight <= followingCollapseBefore.contentHeight - 399 &&
        followingCollapseAfter.contentMinHeight !== followingCollapseBefore.contentHeight + "px",
      tolerance: 1
    });

    await mount(surface, { initialLiveHeight: 720 });
    const observerCollapse = await active.resizeBelowWithoutRenderAndSettle(-400);
    results.push({
      name: surface + ": observed child collapse keeps following and settles cleanly",
      surface,
      before: observerCollapse.before,
      after: observerCollapse.after,
      errors: observerCollapse.errors,
      settled: observerCollapse.settled,
      movement: Math.round(observerCollapse.after.distanceFromBottom * 100) / 100,
      extraOk:
        observerCollapse.after.distanceFromBottom <= 1 &&
        !observerCollapse.after.showFab &&
        observerCollapse.after.contentHeight <= observerCollapse.before.contentHeight - 399 &&
        observerCollapse.after.contentMinHeight !== observerCollapse.before.contentHeight + "px" &&
        observerCollapse.settled &&
        observerCollapse.errors.length === 0,
      tolerance: 1
    });

    await mount(surface, { initialLiveHeight: 720 });
    const transientClamp = await active.collapseThenRegrowBeforeReconcile(400, 40);
    await active.growBelow(240);
    const transientClampFollow = active.measure();
    results.push({
      name: surface + ": transient child collapse and same-commit regrowth keeps following",
      surface,
      before: transientClamp.before,
      collapsed: transientClamp.collapsed,
      regrown: transientClamp.regrown,
      after: transientClampFollow,
      movement: Math.round(Math.max(
        transientClamp.regrown.distanceFromBottom,
        transientClampFollow.distanceFromBottom
      ) * 100) / 100,
      extraOk:
        transientClamp.regrown.distanceFromBottom <= 1 &&
        transientClampFollow.distanceFromBottom <= 1 &&
        !transientClamp.regrown.showFab &&
        !transientClampFollow.showFab,
      tolerance: 1
    });

    await mount(surface);
    await active.scrollUp(160);
    const detachedResizeProbe = active.measure();
    const detachedResizeBefore = active.measureAnchor(detachedResizeProbe.anchorId);
    await active.resizeViewport(-120);
    const detachedResizeAfter = active.measureAnchor(detachedResizeBefore.anchorId);
    results.push({
      name: surface + ": viewport resize preserves a detached reader",
      surface,
      before: detachedResizeBefore,
      after: detachedResizeAfter,
      movement: movement(detachedResizeBefore, detachedResizeAfter),
      tolerance: 2
    });

    await mount(surface, { initialViewportHeight: 240 });
    const detachedGrowthProbe = await active.scrollUp(12);
    const detachedGrowthBefore = active.measureAnchor(detachedGrowthProbe.anchorId);
    await active.resizeViewport(100);
    const detachedGrowthAfter = active.measureAnchor(detachedGrowthBefore.anchorId);
    results.push({
      name: surface + ": viewport increase preserves a near-bottom detached reader",
      surface,
      before: detachedGrowthBefore,
      after: detachedGrowthAfter,
      movement: movement(detachedGrowthBefore, detachedGrowthAfter),
      tolerance: 2
    });

    await mount(surface);
    const localResizeDetached = await active.scrollUp(12);
    const localResizeBefore = active.measureAnchor(localResizeDetached.anchorId);
    await active.resizeBelowWithoutRender(-360);
    const localResizeAfter = active.measureAnchor(localResizeBefore.anchorId);
    results.push({
      name: surface + ": local child collapse below preserves the detached floor",
      surface,
      before: localResizeBefore,
      after: localResizeAfter,
      movement: movement(localResizeBefore, localResizeAfter),
      floorBefore: localResizeBefore.contentMinHeight,
      floorAfter: localResizeAfter.contentMinHeight,
      extraOk: localResizeBefore.contentMinHeight === localResizeAfter.contentMinHeight,
      tolerance: 2
    });

    await mount(surface, { sameTurnScenario: true, initialAboveHeight: 300 });
    await active.scrollUp(12);
    const sameTurnInsertBefore = active.measureMarker("same-turn-reader");
    await active.changeSameTurnAbove(200);
    const sameTurnInsertAfter = active.measureMarker("same-turn-reader");
    results.push({
      name: surface + ": same-turn insertion above preserves the reader",
      surface,
      before: sameTurnInsertBefore,
      after: sameTurnInsertAfter,
      movement: movement(sameTurnInsertBefore, sameTurnInsertAfter),
      tolerance: 2
    });

    await mount(surface, { sameTurnScenario: true, initialAboveHeight: 500 });
    await active.scrollUp(12);
    const sameTurnCollapseBefore = active.measureMarker("same-turn-reader");
    await active.changeSameTurnAbove(-200);
    const sameTurnCollapseAfter = active.measureMarker("same-turn-reader");
    results.push({
      name: surface + ": same-turn collapse above preserves the reader",
      surface,
      before: sameTurnCollapseBefore,
      after: sameTurnCollapseAfter,
      movement: movement(sameTurnCollapseBefore, sameTurnCollapseAfter),
      tolerance: 2
    });

    await mount(surface);
    await active.scrollUp(180);
    await active.scrollToBottom();
    await active.growBelow(260);
    const followed = active.measure();
    results.push({
      name: surface + ": returning to latest resumes follow",
      surface,
      before: null,
      after: followed,
      movement: Math.round(followed.distanceFromBottom * 100) / 100,
      tolerance: 1
    });

    await mount(surface);
    await active.scrollUp(180);
    await active.scrollToPhysicalBottom();
    await active.growBelow(260);
    const scrollbarFollowed = active.measure();
    results.push({
      name: surface + ": scrollbar return to bottom resumes follow",
      surface,
      before: null,
      after: scrollbarFollowed,
      movement: Math.round(scrollbarFollowed.distanceFromBottom * 100) / 100,
      extraOk: !scrollbarFollowed.showFab,
      tolerance: 1
    });

    for (const growth of [0, 260]) {
      await mount(surface);
      await active.scrollUp(180);
      await active.scrollToBottomBeforeCommit(growth);
      const returnedBeforeCommit = active.measure();
      await active.growBelow(260);
      const pendingReturnFollowed = active.measure();
      results.push({
        name: surface + ": return to bottom before a commit with " + growth + "px growth resumes follow",
        surface,
        before: returnedBeforeCommit,
        after: pendingReturnFollowed,
        movement: Math.round(pendingReturnFollowed.distanceFromBottom * 100) / 100,
        extraOk: !returnedBeforeCommit.showFab && !pendingReturnFollowed.showFab,
        tolerance: 1
      });
    }
  }

  for (const scenario of [
    { targetId: "nested", pixels: -40, name: "above-prompt shrink" },
    { targetId: "nested", pixels: 40, name: "above-prompt growth" },
    { targetId: "live-output", pixels: -40, name: "below-prompt shrink control" },
    { targetId: "live-output", pixels: 40, name: "below-prompt growth control" }
  ]) {
    await mount("main", { initialLiveHeight: 80 });
    const paintedResize = await active.resizeAroundPromptAcrossPaints(
      scenario.targetId,
      scenario.pixels
    );
    const promptDrift = Math.max(...paintedResize.frames.map((frame) =>
      Math.abs(frame.anchorTop - paintedResize.before.anchorTop)
    ));
    results.push({
      name: "main: short anchored turn remains stable through painted " + scenario.name,
      surface: "main",
      before: paintedResize.before,
      after: paintedResize.frames.at(-1),
      frames: paintedResize.frames,
      errors: paintedResize.errors,
      movement: Math.round(promptDrift * 100) / 100,
      extraOk:
        paintedResize.errors.length === 0 &&
        paintedResize.frames.every((frame) =>
          frame.distanceFromBottom <= 1 && !frame.showFab
        ),
      tolerance: 1
    });
  }

  await mount("main", { initialLiveHeight: 720 });
  const longTurnDetached = await active.scrollUp(12);
  const longTurnBefore = active.measureAnchor(longTurnDetached.anchorId);
  await active.collapseBelow(400);
  const longTurnAfter = active.measureAnchor(longTurnBefore.anchorId);
  results.push({
    name: "main: long latest turn collapse preserves the near-bottom reader",
    surface: "main",
    before: longTurnBefore,
    after: longTurnAfter,
    movement: movement(longTurnBefore, longTurnAfter),
    tolerance: 2
  });
  results.push({
    name: "browser: no window error events",
    surface: "browser",
    before: null,
    after: null,
    errors: [...browserErrors],
    movement: 0,
    extraOk: browserErrors.length === 0,
    tolerance: 0
  });
  return results.map((result) => ({
    ...result,
    ok: Math.abs(result.movement) <= result.tolerance && result.extraOk !== false
  }));
}

window.chatScrollCheck = { mount, runChecks };
window.chatScrollCheckReady = true;
`;

export const browserFixtureHtml = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Argmax chat scroll check</title>
    <style>
      * { box-sizing: border-box; }
      html, body, #root { height: 100%; margin: 0; }
      body { background: #111416; color: #dfe5e8; font: 14px/1.4 system-ui, sans-serif; }
      .fixture-shell { width: 780px; margin: 24px auto; }
      h1 { margin: 0 0 12px; font-size: 16px; }
      .scroll-frame { position: relative; height: 480px; }
      .conversation-list, .agent-activity-scroll {
        position: relative;
        height: 480px;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
        overflow-anchor: none;
        border: 1px solid #394247;
        border-radius: 12px;
        background: #181d20;
      }
      .conversation-content, .agent-activity-content {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 16px;
        padding: 32px 44px;
      }
      .agent-activity-content { gap: 24px; padding-top: 24px; }
      .fixture-block { flex: 0 0 auto; min-height: 0; padding: 12px; border-radius: 8px; background: #252c30; }
      [data-block="reader"], [data-block="latest-user"] { background: #234154; }
      [data-block="live-output"] { background: #302b3b; }
      .nested-card { height: 116px; padding: 8px; }
      .nested-scroll { height: 100px; overflow-y: auto; overscroll-behavior: contain; background: #15191b; }
      .same-turn { height: auto; padding: 0; overflow: hidden; }
      .same-turn-above { background: #302b3b; }
      .same-turn-reader { height: 120px; padding: 12px; background: #234154; }
      .same-turn-below { height: 400px; padding: 12px; background: #302b3b; }
      .conversation-tail { flex: 0 0 auto; height: 24px; min-height: 24px; }
      .scroll-to-bottom-fab { position: absolute; right: 20px; bottom: 20px; z-index: 2; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./fixture.jsx"></script>
  </body>
</html>`;

export function getBrowserCheckSource() {
  return `(async () => {
    const deadline = Date.now() + 15000;
    while (!window.chatScrollCheckReady && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!window.chatScrollCheckReady) throw new Error("chat scroll fixture never became ready");
    return window.chatScrollCheck.runChecks();
  })()`;
}

async function main() {
  const fixtureDir = mkdtempSync(path.join(repoRoot, ".chat-scroll-check-"));
  const screenshotDir = mkdtempSync(path.join(tmpdir(), "argmax-chat-scroll-"));
  const screenshotPath = path.join(screenshotDir, "fixture.png");
  writeFileSync(path.join(fixtureDir, "fixture.jsx"), browserFixtureSource);
  writeFileSync(path.join(fixtureDir, "index.html"), browserFixtureHtml);

  let vite;
  try {
    const port = await freePort();
    const fixtureUrl = `http://127.0.0.1:${port}/${path.basename(fixtureDir)}/index.html`;
    vite = spawn(process.execPath, [viteEntry, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let viteErrors = "";
    vite.stderr.on("data", (chunk) => { viteErrors += String(chunk); });
    await waitForUrl(fixtureUrl, vite);

    if (process.argv.includes("--serve")) {
      console.log(JSON.stringify({ ready: true, url: fixtureUrl }));
      await new Promise((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      return;
    }

    const expression = getBrowserCheckSource();
  const shot = await run(process.execPath, [
    "scripts/ui-screenshot.mjs",
    "--url", fixtureUrl,
    "--out", screenshotPath,
    "--width", "900",
    "--height", "650",
    "--settle", "0",
    "--eval", expression
  ]);
  if (shot.code !== 0) {
    fail(`browser check could not run:\n${shot.stderr || shot.stdout || viteErrors}`);
  } else {
    const payloadLine = shot.stdout.trim().split("\n").filter(Boolean).at(-1);
    const payload = JSON.parse(payloadLine);
    const results = payload.eval ?? [];
    const failures = results.filter((result) => !result.ok);
    console.log(JSON.stringify({
      ok: failures.length === 0,
      checks: results.length,
      failures: failures.map((failure) => ({
        name: failure.name,
        movement: failure.movement,
        scrollTopBefore: failure.before?.scrollTop ?? null,
        scrollTopAfter: failure.after?.scrollTop ?? null,
        scrollHeightBefore: failure.before?.scrollHeight ?? null,
        scrollHeightAfter: failure.after?.scrollHeight ?? null
      })),
      results
    }, null, 2));
    if (failures.length > 0) process.exitCode = 1;
  }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    if (vite && vite.exitCode === null) vite.kill("SIGTERM");
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(screenshotDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
