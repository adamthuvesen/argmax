import { useImperativeHandle, useRef, type JSX } from "react";
import type { ComposerEditorProps } from "./composerEditor/props.js";

/**
 * A plain textarea that stands in for the prompt editor with the same props
 * and the same field handle. Two jobs:
 *
 * - While the CodeMirror chunk loads (a few milliseconds from disk, but not
 *   zero), the person can already type, and the wrapper hands the caret and
 *   focus to the editor when it arrives.
 * - It is what the unit suite renders, so the tests that drive the prompt like
 *   a textarea exercise a field that really works. See src/test/composerEditorMock.tsx.
 *
 * It draws no chips and tints no skills: a chat reference shows as its link
 * until the editor takes over.
 */
export function ComposerFallbackField({
  value,
  onChange,
  ariaLabel,
  placeholder,
  disabled,
  expanded,
  controls,
  onKeyDown,
  onPaste,
  onCaretChange,
  dataPlaceholderKind,
  dataRouteCaption,
  fieldRef
}: ComposerEditorProps): JSX.Element {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useImperativeHandle(fieldRef, () => ref.current as HTMLTextAreaElement);
  return (
    <div
      className="composer-editor composer-editor--fallback"
      data-disabled={disabled ? "true" : undefined}
    >
      <textarea
        ref={ref}
        data-placeholder-kind={dataPlaceholderKind}
        data-route-caption={dataRouteCaption ? "" : undefined}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={controls}
        disabled={disabled}
        placeholder={placeholder}
        rows={1}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          onCaretChange?.(event.target.selectionStart);
        }}
        onKeyDown={(event) => onKeyDown?.(event.nativeEvent)}
        onPaste={(event) => onPaste?.(event.nativeEvent)}
        onSelect={(event) => onCaretChange?.(event.currentTarget.selectionStart)}
        onClick={(event) => onCaretChange?.(event.currentTarget.selectionStart)}
      />
    </div>
  );
}
