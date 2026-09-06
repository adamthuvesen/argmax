/**
 * Scroll `child` just enough to sit inside `container` on the block axis.
 *
 * `Element.scrollIntoView` also pans every overflow ancestor, including the
 * window. WKWebView uses that to lift a session composer off the bottom of
 * the pane when a picker row below the list fold is selected.
 */
export function scrollChildIntoNearest(container: HTMLElement, child: Element): void {
  const containerRect = container.getBoundingClientRect();
  const childRect = child.getBoundingClientRect();
  if (containerRect.height <= 0 || childRect.height <= 0) return;
  if (childRect.bottom > containerRect.bottom) {
    container.scrollTop += childRect.bottom - containerRect.bottom;
  } else if (childRect.top < containerRect.top) {
    container.scrollTop -= containerRect.top - childRect.top;
  }
}
