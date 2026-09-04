import { Check, ChevronDown, ChevronUp, Copy, Download } from "lucide-react";
import { Suspense, lazy, memo, useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Plan, PlanItem, PlanSubSection } from "../lib/parsePlan.js";
import { needsMath } from "../lib/needsMath.js";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard.js";

const PlanInlineMath = lazy(async () => ({
  default: (await import("./MathMarkdown.js")).PlanInlineMath
}));

export type PlanCardProps = {
  plan: Plan;
  createdAt: string;
  rawMarkdown: string;
  modelLabel?: string | null;
  onAccept: () => void | Promise<boolean>;
  onReject: () => void;
};

// PlanInlineMarkdown renders inline-only, but remark still parses its input as
// a block document. A label like "1. **README.md**" or "- **Foo**" would be
// read as a list — swallowing the marker and breaking the inline layout — so
// escape a leading list marker to keep it literal while emphasis/code parse.
function escapeLeadingListMarker(text: string): string {
  return text
    .replace(/^(\s*\d{1,9})([.)])(\s)/, "$1\\$2$3")
    .replace(/^(\s*)([-*+])(\s)/, "$1\\$2$3");
}

function PlanInlineMarkdown({ children }: { children: string }): JSX.Element {
  if (needsMath(children)) {
    return (
      <Suspense fallback={<PlanInlinePlain>{children}</PlanInlinePlain>}>
        <PlanInlineMath text={children} />
      </Suspense>
    );
  }
  return <PlanInlinePlain>{children}</PlanInlinePlain>;
}

function PlanInlinePlain({ children }: { children: string }): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Render the wrapping paragraph as a span so this stays inline-safe
        // when nested inside list items, headings, etc.
        p: ({ children: kids }) => <>{kids}</>,
        strong: ({ children: kids }) => <strong className="plan-card-strong">{kids}</strong>,
        code: ({ className, children: kids, ...rest }) => {
          const isFenced = typeof className === "string" && className.includes("language-");
          if (isFenced) {
            return (
              <code className={className} {...rest}>
                {kids}
              </code>
            );
          }
          return <span className="plan-card-chip">{kids}</span>;
        }
      }}
    >
      {escapeLeadingListMarker(children)}
    </ReactMarkdown>
  );
}

function PlanChangeItem({ item, marker }: { item: PlanItem; marker: string }): JSX.Element {
  return (
    <li className="plan-card-change">
      <div className="plan-card-change-head">
        <span className="plan-card-change-marker" aria-hidden="true">
          {marker}.
        </span>
        <span className="plan-card-change-title">
          <PlanInlineMarkdown>{item.title}</PlanInlineMarkdown>
        </span>
      </div>
      {item.children && item.children.length > 0 ? (
        <ul className="plan-card-sublist">
          {item.children.map((sub, idx) => (
            <li key={idx} className="plan-card-subitem">
              <PlanInlineMarkdown>{sub.title}</PlanInlineMarkdown>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function PlanSubSectionView({ subsection }: { subsection: PlanSubSection }): JSX.Element {
  return (
    <div className="plan-card-sub-block">
      <div className="plan-card-sub-label">
        <PlanInlineMarkdown>{subsection.label}</PlanInlineMarkdown>
      </div>

      {subsection.note ? (
        <p className="plan-card-sub-text">
          <PlanInlineMarkdown>{subsection.note}</PlanInlineMarkdown>
        </p>
      ) : null}

      {subsection.items.length > 0 ? (
        <ul className="plan-card-change-list">
          {subsection.items.map((item, iIdx) => (
            <PlanChangeItem
              key={iIdx}
              item={item}
              marker={String(iIdx + 1)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PlanCardInner({
  plan,
  rawMarkdown,
  onAccept,
  onReject
}: PlanCardProps): JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [copyFlash, copy] = useCopyToClipboard();
  const optionsRef = useRef<HTMLUListElement | null>(null);

  const options = plan.action.options;
  const optionCount = options.length;

  const submit = useCallback(
    (index: number): void => {
      if (submitted) return;
      const option = options[index];
      if (!option) return;
      setSubmitted(true);
      // Collapse on submit — Escape no longer collapses (cards are not
      // dismissable), so the answer is what hides the card.
      setCollapsed(true);
      // First option is conventionally "Yes / implement"; everything else is reject.
      if (index === 0) {
        // Optimistic: stay submitted on the happy path; if the launch fails,
        // roll back so the user can retry (the error shows in the composer).
        void Promise.resolve(onAccept()).then((ok) => {
          if (ok === false) {
            setSubmitted(false);
            setCollapsed(false);
          }
        });
      } else {
        onReject();
      }
    },
    [options, onAccept, onReject, submitted]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLUListElement>): void => {
      const { key } = event;
      if (submitted) return;
      if (key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((idx) => (idx + 1) % optionCount);
        return;
      }
      if (key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((idx) => (idx - 1 + optionCount) % optionCount);
        return;
      }
      if (key >= "1" && key <= "9") {
        const num = Number.parseInt(key, 10);
        if (num >= 1 && num <= optionCount) {
          event.preventDefault();
          setSelectedIndex(num - 1);
        }
        return;
      }
      if (key === "Enter") {
        event.preventDefault();
        submit(selectedIndex);
      }
      // Cards are not dismissable — the answer is the dismiss. Escape stays
      // a no-op so it doesn't accidentally collapse an in-progress decision,
      // matching QuestionCard.
    },
    [optionCount, selectedIndex, submit, submitted]
  );

  // Auto-focus the listbox on mount so `Enter` / `1` / `2` / arrow keys
  // work without the user having to tab in — but never steal focus from an
  // active text input (the composer or anything else the user is typing in).
  useEffect(() => {
    if (collapsed) return;
    const active = document.activeElement;
    const tag = active instanceof HTMLElement ? active.tagName : "";
    const isTyping =
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      (active instanceof HTMLElement && active.isContentEditable);
    if (isTyping) return;
    optionsRef.current?.focus({ preventScroll: true });
  }, [collapsed]);

  const handleCopy = useCallback((): void => {
    void copy(rawMarkdown);
  }, [copy, rawMarkdown]);

  const handleDownload = useCallback((): void => {
    const blob = new Blob([rawMarkdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "plan.md";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, [rawMarkdown]);

  if (collapsed) {
    return (
      <article className="plan-card plan-card-collapsed" aria-label={`Plan: ${plan.title}`}>
        <div className="plan-card-collapsed-row">
          <span className="plan-card-eyebrow">
            <span className="plan-card-eyebrow-dot" aria-hidden="true" />
            Plan
          </span>
          <span className="plan-card-collapsed-title">
            <PlanInlineMarkdown>{plan.title}</PlanInlineMarkdown>
          </span>
          <button
            type="button"
            className="plan-card-icon-btn"
            aria-label="Expand plan"
            onClick={() => setCollapsed(false)}
          >
            <ChevronDown size={14} />
          </button>
        </div>
      </article>
    );
  }

  return (
    <article className="plan-card plan-card--inline-meta" aria-label={`Plan: ${plan.title}`}>
      <div className="plan-card-content">
        <header className="plan-card-header">
          <div className="plan-card-header-main">
            <span className="plan-card-eyebrow">
              <span className="plan-card-eyebrow-dot" aria-hidden="true" />
              Plan
            </span>
          </div>
          <div className="plan-card-actions">
            <button
              type="button"
              className="plan-card-icon-btn"
              aria-label="Download plan"
              title="Download as markdown"
              onClick={handleDownload}
            >
              <Download size={14} />
            </button>
            <button
              type="button"
              className="plan-card-icon-btn"
              aria-label="Copy plan"
              title={
                copyFlash === "copied"
                  ? "Copied!"
                  : copyFlash === "failed"
                    ? "Couldn't copy"
                    : "Copy markdown"
              }
              onClick={handleCopy}
            >
              <Copy size={14} />
            </button>
            <button
              type="button"
              className="plan-card-icon-btn"
              aria-label="Collapse plan"
              onClick={() => setCollapsed(true)}
            >
              <ChevronUp size={14} />
            </button>
          </div>
        </header>

        <div className="plan-card-title-block">
          <h1 className="plan-card-title">
            <PlanInlineMarkdown>{plan.title}</PlanInlineMarkdown>
          </h1>
        </div>

        {plan.summary.length > 0 ? (
          <section className="plan-card-summary-section">
            <div className="plan-card-summary-label">
              <span className="plan-card-section-name">Summary</span>
            </div>
            <div className="plan-card-summary-body">
              {plan.summary.map((paragraph, idx) => (
                <p key={idx} className={`plan-card-summary${idx > 0 ? " plan-card-summary-secondary" : ""}`}>
                  <PlanInlineMarkdown>{paragraph}</PlanInlineMarkdown>
                </p>
              ))}
            </div>
          </section>
        ) : null}

        <div className="plan-card-sections-container">
          {plan.sections.map((section, sIdx) => {
            const isPhaseCard = Boolean(section.badge) || (section.subsections && section.subsections.length > 0);

            if (isPhaseCard) {
              return (
                <section key={sIdx} className="plan-card-phase-card">
                  <div className="plan-card-phase-head">
                    <h2 className="plan-card-phase-title">
                      {section.badge ? (
                        <>
                          <span className="plan-card-phase-tag">{section.badge}</span>
                          <span className="plan-card-phase-sep" aria-hidden="true"> · </span>
                        </>
                      ) : null}
                      <PlanInlineMarkdown>{section.title ?? section.label}</PlanInlineMarkdown>
                    </h2>
                  </div>

                  {section.note ? (
                    <p className="plan-card-section-note">
                      <PlanInlineMarkdown>{section.note}</PlanInlineMarkdown>
                    </p>
                  ) : null}

                  {section.items.length > 0 ? (
                    <ul className="plan-card-change-list">
                      {section.items.map((item, iIdx) => (
                        <PlanChangeItem
                          key={iIdx}
                          item={item}
                          marker={String(iIdx + 1)}
                        />
                      ))}
                    </ul>
                  ) : null}

                  {section.subsections && section.subsections.length > 0 ? (
                    <div className="plan-card-subsections">
                      {section.subsections.map((sub, subIdx) => (
                        <PlanSubSectionView key={subIdx} subsection={sub} />
                      ))}
                    </div>
                  ) : null}
                </section>
              );
            }

            return (
              <section key={sIdx} className="plan-card-section">
                <div className="plan-card-section-label">
                  <span className="plan-card-section-name">
                    <PlanInlineMarkdown>{section.label}</PlanInlineMarkdown>
                  </span>
                </div>
                {section.note ? (
                  <p className="plan-card-section-note">
                    <PlanInlineMarkdown>{section.note}</PlanInlineMarkdown>
                  </p>
                ) : null}
                {section.items.length > 0 ? (
                  <ul className="plan-card-change-list">
                    {section.items.map((item, iIdx) => (
                      <PlanChangeItem
                        key={iIdx}
                        item={item}
                        marker={String(iIdx + 1)}
                      />
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })}
        </div>

        <div className="plan-card-action-block">
          <p className="plan-card-action-q">
            <PlanInlineMarkdown>{plan.action.question}</PlanInlineMarkdown>
          </p>
          <ul
            ref={optionsRef}
            className="plan-card-options"
            role="listbox"
            aria-label="Plan response"
            aria-disabled={submitted}
            tabIndex={0}
            onKeyDown={handleKeyDown}
          >
            {options.map((option, idx) => {
              const isActive = idx === selectedIndex;
              return (
                <li
                  key={idx}
                  className={`plan-card-option${isActive ? " is-active" : ""}`}
                  role="option"
                  aria-selected={isActive}
                  aria-disabled={submitted}
                  onClick={() => {
                    if (submitted) return;
                    setSelectedIndex(idx);
                    submit(idx);
                  }}
                >
                  <span className="plan-card-option-num">{idx + 1}</span>
                  <span className="plan-card-option-label">
                    <PlanInlineMarkdown>{option.label}</PlanInlineMarkdown>
                  </span>
                  <span className="plan-card-option-arrow" aria-hidden="true">
                    {idx === 0 ? "↵" : "→"}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="plan-card-action-foot">
            {submitted ? (
              <span className="plan-card-key-hint">
                <Check size={12} className="plan-card-submitted-icon" aria-hidden="true" /> Submitted
              </span>
            ) : (
              <div className="plan-card-key-hints">
                <span className="plan-card-key-hint">
                  <kbd className="plan-card-key-cap">↵</kbd> Proceed
                </span>
                <span className="plan-card-key-hint">
                  <kbd className="plan-card-key-cap">1</kbd>–<kbd className="plan-card-key-cap">{optionCount}</kbd> Select
                </span>
                <span className="plan-card-key-hint">
                  <kbd className="plan-card-key-cap">↑</kbd><kbd className="plan-card-key-cap">↓</kbd> Navigate
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

export const PlanCard = memo(PlanCardInner);
