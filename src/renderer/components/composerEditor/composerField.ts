/**
 * What the composers, the slash menu, the file menu and the popovers ask of
 * the prompt field, in the vocabulary of a textarea: focus it, read or move
 * the caret, ask whether focus is inside it. The editor behind it is a
 * CodeMirror view, and a textarea satisfies the same shape, so everything
 * above the field is indifferent to which one it is holding.
 */
export interface ComposerField {
  focus(options?: FocusOptions): void;
  /** The text now. A submit reads this rather than React state, which can be a
   *  render behind a keystroke that just landed in the editor. */
  readonly value: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  setSelectionRange(start: number, end: number): void;
  /** True for the field itself and anything inside it, as `Node.contains` is. */
  contains(other: Node | null): boolean;
  closest(selector: string): Element | null;
}

/** Keyboard events reach the composers as the browser's own, not React's. */
export type ComposerKeyEvent = KeyboardEvent;
