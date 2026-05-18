import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";

export type QuestionOption = {
  label: string;
  description?: string;
};

export type Question = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
};

export type QuestionCardProps = {
  questions: Question[];
  createdAt: string;
  modelLabel?: string | null;
  onAnswer: (answerMarkdown: string) => void;
};

function formatAnswer(questions: Question[], selected: number[][]): string {
  return questions
    .map((q, qi) => {
      const picks = selected[qi] ?? [];
      const labels = picks
        .map((idx) => q.options[idx]?.label)
        .filter((label): label is string => typeof label === "string" && label.length > 0);
      const header = q.header || q.question;
      const value = labels.length > 0 ? labels.join(", ") : "(no selection)";
      return `**${header}**: ${value}`;
    })
    .join("\n\n");
}

function QuestionCardInner({ questions, createdAt, modelLabel, onAnswer }: QuestionCardProps): JSX.Element {
  // Per-question selection. For single-select we keep at most one index;
  // for multi-select we keep the full set.
  const [selected, setSelected] = useState<number[][]>(() => questions.map(() => []));
  const [activeIndexes, setActiveIndexes] = useState<number[]>(() => questions.map(() => 0));
  const [submitted, setSubmitted] = useState(false);
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
    onAnswer(formatAnswer(questions, selected));
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

  return (
    <article className="plan-card question-card" aria-label="Question from agent">
      <aside className="plan-card-rail">
        <div className="plan-card-eyebrow-block">
          <span className="plan-card-eyebrow">
            <span className="plan-card-eyebrow-dot" aria-hidden="true" />
            Question
          </span>
          <span className="plan-card-eyebrow-rule" aria-hidden="true" />
        </div>
        {modelLabel ? (
          <div className="plan-card-meta-group">
            <span className="plan-card-meta-label">Model</span>
            <span className="plan-card-meta-value">{modelLabel}</span>
          </div>
        ) : null}
        <div className="plan-card-meta-group">
          <span className="plan-card-meta-label">Questions</span>
          <span className="plan-card-meta-value">{questions.length}</span>
        </div>
        <div className="plan-card-rail-foot">
          <time className="plan-card-folio">{new Date(createdAt).toLocaleString()}</time>
        </div>
      </aside>

      <div className="plan-card-content">
        {questions.map((q, qIdx) => (
          <section key={qIdx} className="plan-card-action-block">
            <p className="plan-card-action-q">{q.question}</p>
            <ul
              ref={(el) => {
                optionsRefs.current[qIdx] = el;
              }}
              className="plan-card-options"
              role={q.multiSelect ? "listbox" : "listbox"}
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
                    className={`plan-card-option${active ? " is-active" : ""}${focused ? " is-focused" : ""}`}
                    role="option"
                    aria-selected={active}
                    onClick={() => toggleOption(qIdx, oIdx)}
                  >
                    <span className="plan-card-option-num">{oIdx + 1}</span>
                    <span className="plan-card-option-label">
                      {option.label}
                      {option.description ? (
                        <span className="question-card-option-desc"> — {option.description}</span>
                      ) : null}
                    </span>
                    <span className="plan-card-option-arrow" aria-hidden="true">→</span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

        <div className="plan-card-action-foot">
          <span className="plan-card-key-hint" aria-hidden="true">
            <span className="plan-card-key-cap">↑↓</span> move
          </span>
          <span className="plan-card-key-hint" aria-hidden="true">
            <span className="plan-card-key-cap">1–9</span> pick
          </span>
          <span className="plan-card-key-hint" aria-hidden="true">
            <span className="plan-card-key-cap">␣</span> toggle (multi)
          </span>
          <button
            type="button"
            className="question-card-submit"
            onClick={submit}
            disabled={!canSubmit || submitted}
            aria-label={submitted ? "Answer sent" : "Submit answer"}
          >
            {submitted ? "Sent" : "Submit"}
            <span className="question-card-submit-key" aria-hidden="true">↵</span>
          </button>
        </div>
      </div>
    </article>
  );
}

export const QuestionCard = memo(QuestionCardInner);
