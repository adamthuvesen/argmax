import { ChevronDown, ChevronUp } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import type { Question } from "../lib/questions.js";
export type { Question, QuestionOption } from "../lib/questions.js";

export type QuestionCardProps = {
  questions: Question[];
  onAnswer: (answerMarkdown: string) => void | Promise<boolean>;
};

function pickedLabels(question: Question, picks: number[]): string[] {
  return picks
    .map((index) => question.options[index]?.label)
    .filter((label): label is string => typeof label === "string" && label.length > 0);
}

function formatAnswer(questions: Question[], selected: number[][]): string {
  return questions
    .map((question, index) => {
      const labels = pickedLabels(question, selected[index] ?? []);
      const header = question.header || question.question;
      const value = labels.length > 0 ? labels.join(", ") : "(no selection)";
      return `**${header}**: ${value}`;
    })
    .join("\n\n");
}

/// What the answered row says in the scrollback. One question shows the answer
/// itself, because that is the part worth re-reading; several show a count,
/// because the labels would run past the row.
function answerSummary(questions: Question[], selected: number[][]): string {
  if (questions.length !== 1) return `${questions.length} answers sent`;
  const only = questions[0];
  if (!only) return "Answer sent";
  const labels = pickedLabels(only, selected[0] ?? []);
  return labels.length > 0 ? labels.join(", ") : "Answer sent";
}

function QuestionCardInner({ questions, onAnswer }: QuestionCardProps): JSX.Element {
  // Per-question selection. For single-select we keep at most one index;
  // for multi-select we keep the full set.
  const [selected, setSelected] = useState<number[][]>(() => questions.map(() => []));
  const [activeIndexes, setActiveIndexes] = useState<number[]>(() => questions.map(() => 0));
  const [submitted, setSubmitted] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const optionsRefs = useRef<Array<HTMLUListElement | null>>([]);

  // Auto-focus the first question's listbox so keyboard nav works without
  // tabbing — but never steal focus from a text input the user is typing in.
  useEffect(() => {
    if (submitted) return;
    const active = document.activeElement;
    const tag = active instanceof HTMLElement ? active.tagName : "";
    const isTyping =
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      (active instanceof HTMLElement && active.isContentEditable);
    if (isTyping) return;
    optionsRefs.current[0]?.focus({ preventScroll: true });
  }, [submitted]);

  const canSubmit = useMemo(
    () => selected.every((picks, i) => (questions[i]?.multiSelect ? picks.length > 0 : picks.length === 1)),
    [selected, questions]
  );

  const toggleOption = useCallback(
    (qIdx: number, oIdx: number): void => {
      if (submitted) return;
      setActiveIndexes((prev) => {
        const next = [...prev];
        next[qIdx] = oIdx;
        return next;
      });
      setSelected((prev) => {
        const next = prev.map((row) => [...row]);
        const q = questions[qIdx];
        if (!q) return prev;
        const row = next[qIdx] ?? [];
        if (q.multiSelect) {
          const existing = row.indexOf(oIdx);
          if (existing >= 0) row.splice(existing, 1);
          else row.push(oIdx);
        } else {
          row.length = 0;
          row.push(oIdx);
        }
        next[qIdx] = row;
        return next;
      });
    },
    [questions, submitted]
  );

  const submit = useCallback((): void => {
    if (submitted || !canSubmit) return;
    setSubmitted(true);
    setCollapsed(true);
    // Optimistic: roll back if the launch fails so the user can retry.
    void Promise.resolve(onAnswer(formatAnswer(questions, selected))).then((ok) => {
      if (ok === false) {
        setSubmitted(false);
        setCollapsed(false);
      }
    });
  }, [canSubmit, onAnswer, questions, selected, submitted]);

  const handleKeyDown = useCallback(
    (qIdx: number) =>
      (event: KeyboardEvent<HTMLUListElement>): void => {
        if (submitted) return;
        const q = questions[qIdx];
        if (!q) return;
        const optionCount = q.options.length;
        const { key } = event;
        if (key === "ArrowDown" || key === "ArrowUp") {
          event.preventDefault();
          const current = q.multiSelect ? activeIndexes[qIdx] ?? 0 : selected[qIdx]?.[0] ?? -1;
          const delta = key === "ArrowDown" ? 1 : -1;
          const next = ((current === -1 ? 0 : current + delta) + optionCount) % optionCount;
          if (q.multiSelect) {
            setActiveIndexes((prev) => {
              const copy = [...prev];
              copy[qIdx] = next;
              return copy;
            });
          } else {
            toggleOption(qIdx, next);
          }
          return;
        }
        if (key >= "1" && key <= "9") {
          const num = Number.parseInt(key, 10);
          if (num >= 1 && num <= optionCount) {
            event.preventDefault();
            toggleOption(qIdx, num - 1);
          }
          return;
        }
        if (key === " " && q.multiSelect) {
          event.preventDefault();
          const focused = activeIndexes[qIdx] ?? 0;
          if (typeof focused === "number") toggleOption(qIdx, focused);
          return;
        }
        if (key === "Enter") {
          event.preventDefault();
          submit();
        }
      },
    [activeIndexes, questions, selected, submit, submitted, toggleOption]
  );

  const isActive = (qIdx: number, oIdx: number): boolean => {
    const picks = selected[qIdx] ?? [];
    return picks.includes(oIdx);
  };

  const isFocused = (qIdx: number, oIdx: number): boolean => activeIndexes[qIdx] === oIdx;

  if (collapsed) {
    return (
      <article className="question-ask is-answered" aria-label="Question from agent">
        <div className="question-ask-answered">
          <span className="question-ask-answered-text">{answerSummary(questions, selected)}</span>
          <button
            type="button"
            className="question-ask-reveal"
            aria-label="Expand question"
            onClick={() => setCollapsed(false)}
          >
            <ChevronDown size={14} />
          </button>
        </div>
      </article>
    );
  }

  return (
    <article className="question-ask" aria-label="Question from agent">
      {questions.map((q, qIdx) => (
        <section key={qIdx} className="question-ask-block">
          <p className="question-ask-prompt">{q.question}</p>
          <ul
            ref={(el) => {
              optionsRefs.current[qIdx] = el;
            }}
            className="question-ask-options"
            role="listbox"
            aria-multiselectable={q.multiSelect}
            aria-label={q.header || q.question}
            tabIndex={0}
            onKeyDown={handleKeyDown(qIdx)}
          >
            {q.options.map((option, oIdx) => {
              const active = isActive(qIdx, oIdx);
              const focused = isFocused(qIdx, oIdx);
              return (
                <li
                  key={oIdx}
                  className={`question-ask-option${active ? " is-active" : ""}${focused ? " is-focused" : ""}`}
                  role="option"
                  aria-selected={active}
                  onClick={() => toggleOption(qIdx, oIdx)}
                >
                  <kbd className="question-ask-key" aria-hidden="true">
                    {oIdx + 1}
                  </kbd>
                  <span className="question-ask-option-text">
                    <span className="question-ask-option-label">{option.label}</span>
                    {option.description ? (
                      <span className="question-ask-option-desc">{option.description}</span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <div className="question-ask-foot">
        <div className="question-ask-actions">
          <button
            type="button"
            className="question-ask-send"
            onClick={submit}
            disabled={!canSubmit || submitted}
            aria-label={submitted ? "Answer sent" : "Submit answer"}
          >
            {submitted ? (
              "Sent"
            ) : (
              <>
                Send
                <kbd className="question-ask-key" aria-hidden="true">
                  ↵
                </kbd>
              </>
            )}
          </button>
          {submitted ? (
            <button
              type="button"
              className="question-ask-reveal"
              aria-label="Collapse question"
              onClick={() => setCollapsed(true)}
            >
              <ChevronUp size={14} />
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export const QuestionCard = memo(QuestionCardInner);
