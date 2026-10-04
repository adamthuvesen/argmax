import {
  historyKeymap,
  history,
  insertNewline,
  standardKeymap
} from "@codemirror/commands";
import { Facet, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type Command,
  type DecorationSet,
  type ViewUpdate
} from "@codemirror/view";
import {
  COMPOSER_CLIPBOARD_MIME,
  decodeClipboardPayload,
  encodeClipboardPayload,
  findChatReferences,
  type ChatReference
} from "../../lib/composerContext.js";
import { splitSkillTokens } from "../../lib/slashHighlight.js";

/**
 * What the editor needs to know about chats to draw a chip. A chat the app no
 * longer has resolves to null and is drawn as an unavailable chip, never
 * dropped: the link is still in the prompt, and the user can see it is.
 */
export interface ChatChipEnvironment {
  resolve(sessionId: string): { title: string } | null;
  open(sessionId: string): void;
}

const NO_CHATS: ChatChipEnvironment = { resolve: () => null, open: () => undefined };

export const chatChipEnvironment = Facet.define<ChatChipEnvironment, ChatChipEnvironment>({
  combine: (values) => values[values.length - 1] ?? NO_CHATS
});

/** Which `/name` tokens are real skills or commands, to tint. */
type SkillPredicate = (lowercaseName: string) => boolean;

export const skillTokenPredicate = Facet.define<SkillPredicate, SkillPredicate | null>({
  combine: (values) => values[values.length - 1] ?? null
});

/** A pasted wall of text is not worth re-scanning on every keystroke. */
const DECORATION_TEXT_LIMIT = 200_000;

class ChatChipWidget extends WidgetType {
  constructor(
    private readonly reference: ChatReference,
    private readonly resolvedTitle: string | null,
    private readonly open: (sessionId: string) => void
  ) {
    super();
  }

  override eq(other: ChatChipWidget): boolean {
    return (
      other.reference.sessionId === this.reference.sessionId &&
      other.reference.eventId === this.reference.eventId &&
      other.reference.title === this.reference.title &&
      other.resolvedTitle === this.resolvedTitle
    );
  }

  override toDOM(): HTMLElement {
    const resolved = this.resolvedTitle !== null;
    const title = this.resolvedTitle ?? this.reference.title;
    const chip = document.createElement("span");
    chip.className = "composer-chat-chip";
    chip.dataset.status = resolved ? "resolved" : "unresolved";
    chip.setAttribute("role", resolved ? "button" : "img");
    chip.setAttribute(
      "aria-label",
      resolved ? `Chat reference: ${title}. Open chat` : `Chat reference: ${title}. No longer available`
    );
    chip.title = resolved ? `Open chat: ${title}` : "This chat is no longer available";
    if (resolved) chip.tabIndex = 0;
    const label = document.createElement("span");
    label.className = "composer-chat-chip-label";
    label.textContent = resolved ? title : `${title} (unavailable)`;
    chip.append(label);
    if (resolved) {
      chip.addEventListener("click", (event) => {
        event.preventDefault();
        this.open(this.reference.sessionId);
      });
      chip.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        this.open(this.reference.sessionId);
      });
    }
    return chip;
  }

  // The chip handles its own click. Everything else is the editor's: a press
  // beside it still places the caret.
  override ignoreEvent(event: Event): boolean {
    return event.type === "click" || event.type === "keydown";
  }
}

interface ChipSets {
  /** Every decoration: chips and tinted skill tokens. */
  all: DecorationSet;
  /** Just the chips, which the caret and Backspace treat as one character. */
  chips: DecorationSet;
}

function buildDecorations(view: EditorView): ChipSets {
  const text = view.state.doc.toString();
  if (text.length > DECORATION_TEXT_LIMIT) return { all: Decoration.none, chips: Decoration.none };
  const environment = view.state.facet(chatChipEnvironment);
  const chips: Range<Decoration>[] = [];
  for (const match of findChatReferences(text)) {
    const resolved = environment.resolve(match.reference.sessionId);
    chips.push(
      Decoration.replace({
        widget: new ChatChipWidget(match.reference, resolved?.title ?? null, (sessionId) =>
          environment.open(sessionId)
        )
      }).range(match.from, match.to)
    );
  }
  const all = [...chips];
  const isSkill = view.state.facet(skillTokenPredicate);
  const segments = isSkill ? splitSkillTokens(text, isSkill) : null;
  if (segments) {
    let offset = 0;
    for (const segment of segments) {
      const end = offset + segment.text.length;
      const insideChip = chips.some((chip) => offset >= chip.from && offset < chip.to);
      if (segment.skill && !insideChip) {
        all.push(Decoration.mark({ class: "skill-token" }).range(offset, end));
      }
      offset = end;
    }
  }
  return { all: Decoration.set(all, true), chips: Decoration.set(chips, true) };
}

const promptDecorations = ViewPlugin.fromClass(
  class {
    sets: ChipSets;
    constructor(view: EditorView) {
      this.sets = buildDecorations(view);
    }
    update(update: ViewUpdate): void {
      const reconfigured =
        update.startState.facet(chatChipEnvironment) !== update.state.facet(chatChipEnvironment) ||
        update.startState.facet(skillTokenPredicate) !== update.state.facet(skillTokenPredicate);
      if (update.docChanged || reconfigured) this.sets = buildDecorations(update.view);
    }
  },
  {
    decorations: (plugin) => plugin.sets.all,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.sets.chips ?? Decoration.none)
  }
);

/** Open the chat reference at the selection, if it names a chat the app has. */
const openReferenceAtCaret: Command = (view) => {
  const { from, to } = view.state.selection.main;
  const touching = findChatReferences(view.state.doc.toString()).find(
    (match) => from <= match.to && to >= match.from
  );
  if (!touching) return false;
  const environment = view.state.facet(chatChipEnvironment);
  if (!environment.resolve(touching.reference.sessionId)) return false;
  environment.open(touching.reference.sessionId);
  return true;
};

function selectedText(view: EditorView): string {
  return view.state.selection.ranges
    .filter((range) => !range.empty)
    .map((range) => view.state.sliceDoc(range.from, range.to))
    .join(view.state.lineBreak);
}

/**
 * Copy and cut put two things on the clipboard: the text, with each chat chip
 * as its markdown link so a plain-text target still gets the title and the
 * id, and a typed entry the composer reads back to be sure what it is pasting.
 * Paste takes the typed entry when it is one of ours and checks out, and the
 * plain text otherwise.
 */
function clipboardHandlers(): Extension {
  const write = (event: ClipboardEvent, view: EditorView, cut: boolean): boolean => {
    const text = selectedText(view);
    // Nothing selected is nothing to copy. CodeMirror's own handler would copy
    // or cut the whole line then; a textarea does neither, and a person who
    // pressed ⌘X with only a caret did not mean to lose a line.
    if (text === "" || !event.clipboardData) {
      event.preventDefault();
      return true;
    }
    event.clipboardData.setData("text/plain", text);
    event.clipboardData.setData(COMPOSER_CLIPBOARD_MIME, encodeClipboardPayload(text));
    event.preventDefault();
    // A prompt that cannot be edited (a send is in flight) still copies.
    if (cut && !view.state.readOnly) {
      view.dispatch(view.state.replaceSelection(""), { userEvent: "delete.cut" });
    }
    return true;
  };
  return EditorView.domEventHandlers({
    copy: (event, view) => write(event, view, false),
    cut: (event, view) => write(event, view, true)
  });
}

export interface PromptCallbacks {
  onKeyDown?: (event: KeyboardEvent) => void;
  onPaste?: (event: ClipboardEvent) => void;
}

/**
 * Everything the prompt editor is, apart from the props that change: history,
 * the textarea-like keys, wrapping, the chip and skill decorations, and the
 * event hooks the composers use for Enter, Tab, the menus and attachments.
 * The callbacks are read through the object on every event, so the editor is
 * built once and the caller's closures stay current.
 */
export function promptExtensions(callbacks: { current: PromptCallbacks }): Extension {
  // A prompt is prose: Enter breaks the line and nothing else, where the code
  // editor's Enter also copies the previous line's indentation. During an IME
  // composition Enter belongs to the input method (it confirms the candidate),
  // so the command declines and the browser does what it does.
  const breakLine: Command = (view) => !view.composing && insertNewline(view);
  const keys = [
    // The keyboard way to a chip, which is not itself tabbable: open the chat
    // reference the caret is in or touching.
    { key: "Mod-Shift-o", run: openReferenceAtCaret },
    { key: "Enter", run: breakLine },
    { key: "Shift-Enter", run: breakLine },
    ...standardKeymap.filter((binding) => !(binding.key ?? "").includes("Enter")),
    ...historyKeymap
  ];
  return [
    history(),
    EditorView.lineWrapping,
    promptDecorations,
    clipboardHandlers(),
    EditorView.domEventHandlers({
      keydown: (event) => {
        // 229 is the key code browsers give the Enter that confirms an IME
        // candidate; Safari reports it with `isComposing` already false.
        if (event.keyCode === 229) return false;
        callbacks.current.onKeyDown?.(event);
        return event.defaultPrevented;
      },
      paste: (event, view) => {
        callbacks.current.onPaste?.(event);
        if (event.defaultPrevented) return true;
        // A prompt that cannot be edited takes no paste, typed or plain.
        if (view.state.readOnly) {
          event.preventDefault();
          return true;
        }
        const raw = event.clipboardData?.getData(COMPOSER_CLIPBOARD_MIME);
        const payload = raw ? decodeClipboardPayload(raw) : null;
        if (!payload) return false;
        view.dispatch(view.state.replaceSelection(payload.text), {
          userEvent: "input.paste",
          scrollIntoView: true
        });
        event.preventDefault();
        return true;
      },
      // A dropped file is the attachment hook's to take. CodeMirror would
      // read it as text and type it into the prompt.
      drop: (event) => (event.dataTransfer?.files.length ?? 0) > 0
    }),
    keymap.of(keys)
  ];
}
