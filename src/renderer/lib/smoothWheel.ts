/**
 * Smooth scrolling for a notched mouse wheel.
 *
 * WebKit on macOS applies a wheel event without a gesture phase (a notched
 * mouse) as an instant jump, and no preference changes that. A fast spin moves
 * 150–600px per event. So wheel input classified as a mouse is taken over and
 * eased out over a few frames. Trackpads and the Magic Mouse keep native
 * scrolling and momentum.
 *
 * JS cannot see the device. Logged on macOS Safari 26: every trackpad gesture
 * opens with |deltaY| of 1–2 and streams every ~6ms, while every mouse event is
 * at least 12px. The first event after a pause decides the whole gesture, so a
 * trackpad swipe that speeds up past 12px stays native.
 */

const GESTURE_GAP_MS = 60;
const MOUSE_MIN_DELTA_PX = 8;
/** Time constant of the exponential ease: ~95% of a notch lands in 3τ. */
const EASE_TAU_MS = 45;
const SETTLED_PX = 1;

type Device = "mouse" | "trackpad";

function nearestVerticalScroller(root: HTMLElement, target: EventTarget | null): HTMLElement {
  let node = target instanceof Element ? target : null;
  while (node && node !== root) {
    if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 1) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") return node;
    }
    node = node.parentElement;
  }
  return root;
}

function canScroll(element: HTMLElement, direction: number): boolean {
  const maxTop = element.scrollHeight - element.clientHeight;
  return direction < 0 ? element.scrollTop > 0 : element.scrollTop < maxTop - 1;
}

/** Attach to a scroll viewport. Returns the detach function. */
export function attachSmoothWheel(root: HTMLElement): () => void {
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let device: Device = "trackpad";
  let lastEventAt = -Infinity;
  let animated: HTMLElement | null = null;
  let pending = 0;
  let carry = 0;
  let frame: number | null = null;
  let lastFrameAt = 0;

  const stop = (): void => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    animated = null;
    pending = 0;
    carry = 0;
  };

  const step = (now: number): void => {
    const element = animated;
    if (!element) return stop();
    const elapsed = Math.min(64, Math.max(1, now - lastFrameAt));
    lastFrameAt = now;
    let move = pending * (1 - Math.exp(-elapsed / EASE_TAU_MS));
    if (Math.abs(pending - move) < SETTLED_PX) move = pending;
    // Read the position every frame rather than tracking our own, so the
    // follow controller's anchor corrections and a scrollbar drag survive.
    const current = element.scrollTop;
    const target = current + move + carry;
    element.scrollTop = target;
    const landed = element.scrollTop;
    pending -= move;
    carry = target - landed;
    const blocked = Math.abs(landed - current) < 0.01 && Math.abs(move) >= 1;
    if (blocked || Math.abs(pending) < SETTLED_PX || !canScroll(element, pending)) return stop();
    frame = requestAnimationFrame(step);
  };

  const onWheel = (event: WheelEvent): void => {
    const gap = event.timeStamp - lastEventAt;
    lastEventAt = event.timeStamp;
    if (gap > GESTURE_GAP_MS) {
      device = Math.abs(event.deltaY) >= MOUSE_MIN_DELTA_PX ? "mouse" : "trackpad";
    }
    if (
      device !== "mouse" ||
      !event.cancelable ||
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL ||
      Math.abs(event.deltaY) <= Math.abs(event.deltaX) ||
      reducedMotion?.matches
    ) {
      return;
    }
    const element = nearestVerticalScroller(root, event.target);
    // At an edge, leave the event to the browser so overscroll containment
    // and chaining behave exactly as they do natively.
    if (!canScroll(element, event.deltaY)) return;
    event.preventDefault();
    if (element !== animated || Math.sign(pending) !== Math.sign(event.deltaY)) {
      stop();
      animated = element;
    }
    pending += event.deltaY;
    if (frame === null) {
      lastFrameAt = performance.now();
      frame = requestAnimationFrame(step);
    }
  };

  // Non-passive, which moves wheel scrolling over this region to the main
  // thread for trackpads too; the transcript's scroll path is kept cheap.
  root.addEventListener("wheel", onWheel, { passive: false });
  root.addEventListener("pointerdown", stop, { passive: true });
  return () => {
    root.removeEventListener("wheel", onWheel);
    root.removeEventListener("pointerdown", stop);
    stop();
  };
}
