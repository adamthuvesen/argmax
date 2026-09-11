import { ArrowRight, ChevronLeft, ChevronRight, X } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
  type KeyboardEvent
} from "react";
import { formatAnswer, otherOptionIndex, type Question } from "../lib/questions.js";

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
 *
 * Every question ends in an "Other" row. Picked, its label becomes a line to
 * type on, in the row's own type and on the row's own fill, so an answer in
 * the reader's words is the same kind of thing as a listed one — not a form
 * field bolted under the list.
 */
function QuestionDockInner({ questions, onAnswer, onDismiss }: QuestionDockProps): JSX.Element | null {
  const [selected, setSelected] = useState<number[][]>(() => questions.map(() => []));
  const [otherText, setOtherText] = useState<string[]>(() => questions.map(() => ""));
  const [page, setPage] = useState(0);
  const [focusedOption, setFocusedOption] = useState(0);
  const [sending, setSending] = useState(false);
  const optionsRef = useRef<HTMLUListElement | null>(null);
  const otherInputRef = useRef<HTMLInputElement | null>(null);

  const lastPage = questions.length - 1;
  const question = questions[page];
  const otherIndex = question ? otherOptionIndex(question) : 0;
  const optionCount = otherIndex + 1;
  const picks = selected[page] ?? [];
  const otherPicked = picks.includes(otherIndex);

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

  // Picking "Other" is a promise to type, so the caret goes straight to the line.
  useEffect(() => {
    if (otherPicked) otherInputRef.current?.focus({ preventScroll: true });
  }, [otherPicked, page]);

  const questionAnswered = useCallback(
    (index: number): boolean => {
      const q = questions[index];
      if (!q) return false;
      const row = selected[index] ?? [];
      const typedOk = !row.includes(otherOptionIndex(q)) || (otherText[index] ?? "").trim().length > 0;
      return typedOk && (q.multiSelect ? row.length > 0 : row.length === 1);
    },
    [otherText, questions, selected]
  );

  const answered = useMemo(
    () => questions.every((_, index) => questionAnswered(index)),
    [questionAnswered, questions]
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
    void Promise.resolve(onAnswer(formatAnswer(questions, selected, otherText))).then((ok) => {
      if (ok === false) setSending(false);
    });
  }, [answered, onAnswer, otherText, questions, selected, sending]);

  const pick = useCallback(
    (optionIndex: number): void => {
      if (sending || !question) return;
      setFocusedOption(optionIndex);
      const isOther = optionIndex === otherIndex;
      setSelected((previous) => {
        const next = previous.map((row) => [...row]);
        const row = next[page] ?? [];
        if (question.multiSelect) {
          const existing = row.indexOf(optionIndex);
          // Re-picking "Other" keeps it and returns the caret to the line;
          // clicking a filled row is "let me edit", not "take it back".
          if (existing >= 0 && !isOther) row.splice(existing, 1);
          else if (existing < 0) row.push(optionIndex);
        } else {
          row.length = 0;
          row.push(optionIndex);
        }
        next[page] = row;
        return next;
      });
      if (isOther) {
        otherInputRef.current?.focus({ preventScroll: true });
        return;
      }
      // One choice settles a single-select question, so the panel moves on the
      // way the reader would have. Multi-select waits — they may not be done.
      // "Other" waits too: it is settled by what gets typed, not by the pick.
      if (!question.multiSelect && page < lastPage) goToPage(page + 1);
    },
    [goToPage, lastPage, otherIndex, page, question, sending]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLUListElement>): void => {
      if (sending || !question) return;
      // The line has its own keys; the list's must not fire under it.
      if (event.target === otherInputRef.current) return;
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
    [answered, focusedOption, goToPage, lastPage, onDismiss, optionCount, page, pick, question, sending, submit]
  );

  const handleOtherChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const value = event.target.value;
      setOtherText((previous) => {
        const next = [...previous];
        next[page] = value;
        return next;
      });
    },
    [page]
  );

  // Enter on the line does what a pick does: settles this question and moves
  // on, or sends once everything is answered. Escape hands the caret back to
  // the list rather than closing the panel over a half-typed answer.
  const handleOtherKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        optionsRef.current?.focus({ preventScroll: true });
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (!questionAnswered(page)) return;
      if (page < lastPage) goToPage(page + 1);
      else if (answered) submit();
    },
    [answered, goToPage, lastPage, page, questionAnswered, submit]
  );

  if (!question) return null;

  // The arrow is a promise, not decoration: it appears only on the row whose
  // pick moves the panel to the next question.
  const picksAdvance = !question.multiSelect && page < lastPage;
  const rows = [...question.options, null];

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
        {rows.map((option, index) => {
          const active = picks.includes(index);
          const isOther = option === null;
          return (
            <li
              key={index}
              className={`question-dock-option${active ? " is-active" : ""}${
                focusedOption === index ? " is-focused" : ""
              }${isOther ? " is-other" : ""}`}
              role="option"
              aria-selected={active}
              aria-label={isOther ? "Other" : undefined}
              onClick={() => pick(index)}
            >
              <kbd className="question-dock-key" aria-hidden="true">
                {index + 1}
              </kbd>
              {isOther ? (
                <span className="question-dock-option-text">
                  {active ? (
                    <input
                      ref={otherInputRef}
                      className="question-dock-other-input"
                      type="text"
                      value={otherText[page] ?? ""}
                      placeholder="Type your own answer"
                      aria-label="Your own answer"
                      autoComplete="off"
                      spellCheck={true}
                      disabled={sending}
                      onChange={handleOtherChange}
                      onKeyDown={handleOtherKeyDown}
                      onClick={(event) => event.stopPropagation()}
                    />
                  ) : (
                    <span className="question-dock-option-label">Other</span>
                  )}
                </span>
              ) : (
                <span className="question-dock-option-text">
                  <span className="question-dock-option-label">{option.label}</span>
                  {option.description ? (
                    <span className="question-dock-option-desc">{option.description}</span>
                  ) : null}
                </span>
              )}
              {picksAdvance && !isOther ? (
                <ArrowRight className="question-dock-go" size={15} aria-hidden="true" />
              ) : null}
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
