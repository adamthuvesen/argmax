/**
 * jsdom has no layout, and CodeMirror measures text with `Range` rects. Zeros
 * are enough for tests that never look at geometry: they get a real EditorView
 * that edits, decorates and handles events.
 */
export function installZeroLayoutForCodeMirror(): void {
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0, toJSON: () => ({}) };
  Range.prototype.getBoundingClientRect = () => rect;
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator]
  });
}
