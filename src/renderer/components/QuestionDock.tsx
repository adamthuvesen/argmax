import { ArrowRight, ChevronLeft, ChevronRight, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { formatAnswer, type Question } from "../lib/questions.js";

export type QuestionDockProps = {
  questions: Question[];
  onAnswer: (answerMarkdown: string) => void | Promise<boolean>;
  /** Put the composer back so the reader can answer in their own words instead. */
  onDismiss: () => void;
};

/**
 * The live question, in the composer's place.
 *
 * While the agent waits on an answer there is nothing to type, so the panel
 * takes the composer's slot rather than sitting in the scrollback, where a turn
 * that keeps working scrolls the question out of view. It wears the composer's
 * own surface for the same reason: this is the thing you act in right now.
 *
 * Several questions page rather than stack, so the panel is the same height
 * whether the agent asked one thing or four.
 */
function QuestionDockInner({ questions, onAnswer, onDismiss }: QuestionDockProps): JSX.Element | null {
  const [selected, setSelected] = useState<number[][]>(() => questions.map(() => []));
  const [page, setPage] = useState(0);
  const [focusedOption, setFocusedOption] = useState(0);
  const [sending, setSending] = useState(false);
  const optionsRef = useRef<HTMLUListElement | null>(null);

  const lastPage = questions.length - 1;
  const question = questions[page];

  // Focus the options as the panel takes the composer's place, so the numbers
  // work without a click — but never steal a caret the reader is already using.
  useEffect(() => {
    const active = document.activeElement;
    const tag = active instanceof HTMLElement ? active.tagName : "";
    if (tag === "INPUT" || tag === "TEXTAREA" || (active instanceof HTMLElement && active.isContentEditable)) {
      return;
    }
    optionsRef.current?.focus({ preventScroll: true });
  }, [page]);

  const answered = useMemo(
    () => selected.every((picks, index) => (questions[index]?.multiSelect ? picks.length > 0 : picks.length === 1)),
    [selected, questions]
  );

  const goToPage = useCallback((next: number): void => {
    setPage(next);
    setFocusedOption(0);
  }, []);

  const submit = useCallback((): void => {
    if (sending || !answered) return;
    setSending(true);
    // Optimistic: the panel disappears with the turn it answers, so a failed
    // send has to hand the question back rather than leave a dead slab.
    void Promise.resolve(onAnswer(formatAnswer(questions, selected))).then((ok) => {
      if (ok === false) setSending(false);
    });
  }, [answered, onAnswer, questions, selected, sending]);

  const pick = useCallback(
    (optionIndex: number): void => {
      if (sending || !question) return;
      setFocusedOption(optionIndex);
      setSelected((previous) => {
        const next = previous.map((row) => [...row]);
        const row = next[page] ?? [];
        if (question.multiSelect) {
          const existing = row.indexOf(optionIndex);
          if (existing >= 0) row.splice(existing, 1);
          else row.push(optionIndex);
        } else {
          row.length = 0;
          row.push(optionIndex);
        }
        next[page] = row;
        return next;
      });
      // One choice settles a single-select question, so the panel moves on the
      // way the reader would have. Multi-select waits — they may not be done.
      if (!question.multiSelect && page < lastPage) goToPage(page + 1);
    },
    [goToPage, lastPage, page, question, sending]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLUListElement>): void => {
      if (sending || !question) return;
      const optionCount = question.options.length;
      const { key } = event;
      if (key === "Escape") {
        event.preventDefault();
        onDismiss();
        return;
      }
      if (key === "ArrowDown" || key === "ArrowUp") {
        event.preventDefault();
        const delta = key === "ArrowDown" ? 1 : -1;
        setFocusedOption((current) => (current + delta + optionCount) % optionCount);
        return;
      }
      if (key === "ArrowLeft" && page > 0) {
        event.preventDefault();
        goToPage(page - 1);
        return;
      }
      if (key === "ArrowRight" && page < lastPage) {
        event.preventDefault();
        goToPage(page + 1);
        return;
      }
      if (key >= "1" && key <= "9") {
        const number = Number.parseInt(key, 10);
        if (number <= optionCount) {
          event.preventDefault();
          pick(number - 1);
        }
        return;
      }
      if (key === " ") {
        event.preventDefault();
        pick(focusedOption);
        return;
      }
      if (key === "Enter") {
        event.preventDefault();
        if (answered) submit();
        else pick(focusedOption);
      }
    },
    [answered, focusedOption, goToPage, lastPage, onDismiss, page, pick, question, sending, submit]
  );

  if (!question) return null;

  const picks = selected[page] ?? [];
  // The arrow is a promise, not decoration: it appears only on the row whose
  // pick moves the panel to the next question.
  const picksAdvance = !question.multiSelect && page < lastPage;

  return (
    <div className="session-input question-dock" data-type-scale="composer" aria-label="Question from agent">
      <div className="question-dock-head">
        <p className="question-dock-prompt">{question.question}</p>
        <div className="question-dock-nav">
          {questions.length > 1 ? (
            <>
              <button
                type="button"
                className="question-dock-page"
                aria-label="Previous question"
                disabled={page === 0}
                onClick={() => goToPage(page - 1)}
              >
                <ChevronLeft size={15} aria-hidden="true" />
              </button>
              <span className="question-dock-count">
                {page + 1} of {questions.length}
              </span>
              <button
                type="button"
                className="question-dock-page"
                aria-label="Next question"
                disabled={page === lastPage}
                onClick={() => goToPage(page + 1)}
              >
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="question-dock-close"
            aria-label="Answer in your own words"
            title="Answer in your own words"
            onClick={onDismiss}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      <ul
        ref={optionsRef}
        className="question-dock-options"
        role="listbox"
        aria-multiselectable={question.multiSelect}
        aria-label={question.header || question.question}
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {question.options.map((option, index) => {
          const active = picks.includes(index);
          return (
            <li
              key={index}
              className={`question-dock-option${active ? " is-active" : ""}${
                focusedOption === index ? " is-focused" : ""
              }`}
              role="option"
              aria-selected={active}
              onClick={() => pick(index)}
            >
              <kbd className="question-dock-key" aria-hidden="true">
                {index + 1}
              </kbd>
              <span className="question-dock-option-text">
                <span className="question-dock-option-label">{option.label}</span>
                {option.description ? (
                  <span className="question-dock-option-desc">{option.description}</span>
                ) : null}
              </span>
              {picksAdvance ? <ArrowRight className="question-dock-go" size={15} aria-hidden="true" /> : null}
            </li>
          );
        })}
      </ul>

      <div className="question-dock-foot">
        {question.multiSelect ? <span className="question-dock-hint">Pick as many as apply</span> : null}
        <button
          type="button"
          className="question-dock-send"
          onClick={submit}
          disabled={!answered || sending}
          aria-label={sending ? "Answer sent" : "Submit answer"}
        >
          {sending ? "Sent" : "Send"}
        </button>
      </div>
    </div>
  );
}

export const QuestionDock = memo(QuestionDockInner);
