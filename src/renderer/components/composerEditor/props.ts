import type { Ref } from "react";
import type { ComposerField } from "./composerField.js";
import type { ChatChipEnvironment } from "./extensions.js";

export interface ComposerEditorProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder: string;
  disabled?: boolean;
  /** Autocomplete state, for the screen-reader contract of a combobox-like textbox. */
  expanded?: boolean;
  controls?: string;
  /** Called for every keydown that is not part of an IME composition. */
  onKeyDown?: (event: KeyboardEvent) => void;
  onPaste?: (event: ClipboardEvent) => void;
  /** The caret moved, or the text changed under it. */
  onCaretChange?: (caret: number) => void;
  isSkill?: ((lowercaseName: string) => boolean) | null;
  chats: ChatChipEnvironment;
  /** Extra data attributes on the field, for the stylesheet. */
  dataPlaceholderKind?: string;
  dataRouteCaption?: boolean;
  fieldRef: Ref<ComposerField>;
  /** Names the document shown (the draft key). A new key starts a new undo
   *  history, so undo in one chat never reaches into another's prompt. */
  documentKey?: string | null;
  /** Set by the lazy wrapper when it swaps the textarea it was showing for
   *  this editor: where the caret was and whether the field had focus. */
  handoff?: ComposerEditorHandoff;
}

export interface ComposerEditorHandoff {
  selectionStart: number;
  selectionEnd: number;
  focused: boolean;
}
