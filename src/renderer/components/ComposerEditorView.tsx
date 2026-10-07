import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type JSX } from "react";
import type { ComposerField } from "./composerEditor/composerField.js";
import {
  chatChipEnvironment,
  promptExtensions,
  skillTokenPredicate,
  type PromptCallbacks
} from "./composerEditor/extensions.js";
import type { ComposerEditorProps } from "./composerEditor/props.js";

/** A disabled prompt takes no edits from the keyboard, a paste, a cut or a drop. */
function editability(disabled: boolean): Extension {
  return [EditorView.editable.of(!disabled), EditorState.readOnly.of(disabled)];
}

/**
 * The CodeMirror half of the prompt field both composers share (the lazy
 * wrapper in ComposerEditor.tsx loads it):  a CodeMirror editor that behaves like
 * the textarea it replaces (plain text, wrapping, undo, IME, spellcheck, the
 * same keys) and adds what a textarea cannot: chat references drawn as chips
 * the caret treats as one character, and `/skill` tokens tinted in place with
 * no mirror layer to keep aligned.
 *
 * The text is the whole state. `value` is the prompt as a string, chips and
 * all, so drafts, queued messages and sent prompts stay plain text.
 */
export function ComposerEditorView({
  value,
  onChange,
  ariaLabel,
  placeholder,
  disabled = false,
  expanded = false,
  controls,
  onKeyDown,
  onPaste,
  onCaretChange,
  isSkill = null,
  chats,
  dataPlaceholderKind,
  dataRouteCaption = false,
  fieldRef,
  documentKey = null,
  handoff
}: ComposerEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const callbacks = useRef<PromptCallbacks>({});
  callbacks.current = { onKeyDown, onPaste };
  const latest = useRef({ onChange, onCaretChange });
  latest.current = { onChange, onCaretChange };
  // A change this component dispatches to follow `value` must not be reported
  // back as the user's edit.
  const applyingValue = useRef(false);

  const attributes = useRef(new Compartment());
  const editable = useRef(new Compartment());
  const chatSlot = useRef(new Compartment());
  const skillSlot = useRef(new Compartment());

  const contentAttributes = (): Record<string, string> => ({
    role: "textbox",
    "aria-multiline": "true",
    "aria-label": ariaLabel,
    // Also what the CSS draws while the prompt is empty (see .composer-editor
    // .cm-content::before): no placeholder widget sits beside the caret.
    "aria-placeholder": placeholder,
    "aria-autocomplete": "list",
    "aria-expanded": String(expanded),
    ...(controls ? { "aria-controls": controls } : {}),
    ...(disabled ? { "aria-disabled": "true" } : {}),
    spellcheck: "true",
    autocapitalize: "sentences"
  });

  // The editor's configuration, as it stands for the props now. Used to make
  // the view and to remake its state when the draft changes.
  const configuration = (): Extension[] => [
    promptExtensions(callbacks),
    attributes.current.of(EditorView.contentAttributes.of(contentAttributes())),
    editable.current.of(editability(disabled)),
    chatSlot.current.of(chatChipEnvironment.of(chats)),
    skillSlot.current.of(skillTokenPredicate.of(isSkill ?? (() => false))),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !applyingValue.current) {
        latest.current.onChange(update.state.doc.toString());
      }
      if (update.docChanged || update.selectionSet) {
        latest.current.onCaretChange?.(update.state.selection.main.head);
      }
    })
  ];

  /** A fresh state for `text`: no undo history, the caret at the end. */
  const freshState = (text: string): EditorState =>
    EditorState.create({
      doc: text,
      selection: { anchor: text.length },
      extensions: configuration()
    });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const view = new EditorView({ parent: host, state: freshState(value) });
    viewRef.current = view;
    // Taking over from the textarea shown while this chunk loaded: the caret
    // and the focus the person already had.
    if (handoff) {
      const length = view.state.doc.length;
      view.dispatch({
        selection: {
          anchor: Math.min(handoff.selectionStart, length),
          head: Math.min(handoff.selectionEnd, length)
        }
      });
      if (handoff.focused) view.focus();
    }
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The view is created once; every prop it reads afterwards arrives through
    // the compartments and the value effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `setState` starts a new document without an update, so nothing tells the
  // caller where the caret is. A caret left at its old offset can sit inside
  // an `@mention` of the new text and open a menu nobody asked for.
  const reportCaret = (view: EditorView): void => {
    latest.current.onCaretChange?.(view.state.selection.main.head);
  };

  const reconfigure = (): void => {
    viewRef.current?.dispatch({
      effects: [
        attributes.current.reconfigure(EditorView.contentAttributes.of(contentAttributes())),
        editable.current.reconfigure(editability(disabled)),
        chatSlot.current.reconfigure(chatChipEnvironment.of(chats)),
        skillSlot.current.reconfigure(skillTokenPredicate.of(isSkill ?? (() => false)))
      ]
    });
  };

  useEffect(() => {
    reconfigure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ariaLabel, expanded, controls, disabled, placeholder, chats, isSkill]);

  // A different draft is a different document: its undo history must not
  // reach into the last one's text. The state is rebuilt, not edited, so
  // ⌘Z in a new chat cannot rewrite it into a mix of two prompts.
  const shownKey = useRef(documentKey);
  useLayoutEffect(() => {
    if (shownKey.current === documentKey) return;
    shownKey.current = documentKey;
    const view = viewRef.current;
    if (!view) return;
    applyingValue.current = true;
    try {
      view.setState(freshState(value));
    } finally {
      applyingValue.current = false;
    }
    reconfigure();
    reportCaret(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentKey]);

  // Follow `value` after every commit, not only when it changes. The editor
  // reports an edit to React and keeps its own copy at once, so the two can
  // disagree for a moment, and a change of `value` is not the only way to
  // learn the app's last word: typing and sending inside one batch leaves
  // `value` where it was ("") while the editor holds the sent text.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    // An emptied prompt is a sent (or cleared) one. Start its history over, so
    // undo does not bring a message back that is already on its way.
    if (value === "") {
      applyingValue.current = true;
      try {
        view.setState(freshState(""));
      } finally {
        applyingValue.current = false;
      }
      reconfigure();
      reportCaret(view);
      return;
    }
    // Replace only what differs, so a caret in untouched text stays where it
    // is. These edits come from outside the field (the slash menu completing a
    // token, a file or chat picked from the @ menu, a restored draft) and they
    // are part of undo history like typing: leaving them out would make undo
    // replay earlier typing onto text it no longer matches.
    let start = 0;
    const shortest = Math.min(current.length, value.length);
    while (start < shortest && current.charCodeAt(start) === value.charCodeAt(start)) start += 1;
    let endCurrent = current.length;
    let endValue = value.length;
    while (
      endCurrent > start &&
      endValue > start &&
      current.charCodeAt(endCurrent - 1) === value.charCodeAt(endValue - 1)
    ) {
      endCurrent -= 1;
      endValue -= 1;
    }
    // A caret that sat at the end of the text stays at the end, as it does in a
    // textarea whose value is set from outside (the slash menu completing
    // `/ski` to `/skill `, a restored draft). A caret anywhere else keeps its
    // place in the text around the change.
    const caretWasAtEnd = view.state.selection.main.empty && view.state.selection.main.head === current.length;
    applyingValue.current = true;
    try {
      view.dispatch({
        changes: { from: start, to: endCurrent, insert: value.slice(start, endValue) },
        ...(caretWasAtEnd ? { selection: { anchor: value.length } } : {}),
        userEvent: "input.complete"
      });
    } finally {
      applyingValue.current = false;
    }
  });

  useImperativeHandle(
    fieldRef,
    (): ComposerField => ({
      focus: (options) => viewRef.current?.contentDOM.focus(options),
      // The document as it is now, which a submit reads: React's copy of it
      // is one render behind a keystroke that has just landed.
      get value() {
        return viewRef.current?.state.doc.toString() ?? "";
      },
      get selectionStart() {
        const selection = viewRef.current?.state.selection.main;
        return selection ? Math.min(selection.anchor, selection.head) : null;
      },
      get selectionEnd() {
        const selection = viewRef.current?.state.selection.main;
        return selection ? Math.max(selection.anchor, selection.head) : null;
      },
      setSelectionRange: (start, end) => {
        const view = viewRef.current;
        if (!view) return;
        const length = view.state.doc.length;
        view.dispatch({
          selection: { anchor: Math.min(start, length), head: Math.min(end, length) },
          scrollIntoView: true
        });
      },
      contains: (other) => viewRef.current?.dom.contains(other) ?? false,
      closest: (selector) => viewRef.current?.dom.closest(selector) ?? null
    }),
    []
  );

  return (
    <div
      className="composer-editor"
      ref={hostRef}
      data-placeholder-kind={dataPlaceholderKind}
      data-route-caption={dataRouteCaption ? "" : undefined}
      data-disabled={disabled ? "true" : undefined}
    />
  );
}
