/**
 * Normalizes LaTeX math delimiters (\(...\), \[...\], \begin{env}...\end{env}) into
 * standard Markdown math syntax ($...$, $$...$$) that `remark-math` understands,
 * while safely disambiguating currency ($50) and preserving code fences/spans.
 */

const LATEX_ENV_REGEX =
  /(?:^|\n)\s*(\\begin\{(?:equation|equation\*|align|align\*|alignat|alignat\*|gather|gather\*|multline|multline\*|cases|matrix|pmatrix|bmatrix)\}[\s\S]*?\\end\{(?:equation|equation\*|align|align\*|alignat|alignat\*|gather|gather\*|multline|multline\*|cases|matrix|pmatrix|bmatrix)\})/g;

const GREEK_MATH_SYMBOLS =
  "alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega";

const GREEK_MATH_REGEX = new RegExp(
  `(^|[\\s(])\\\\(${GREEK_MATH_SYMBOLS})([\\s.,;:!?)"]|$)`,
  "g"
);

/**
 * A private-use sentinel: markdown never contains it, and unlike NUL it is not a
 * control character a regex lint would reject.
 */
const MATH_SENTINEL = "";

/** Characters that make a multi-word `$...$` body read as an equation rather than prose. */
const MATH_SIGNALS = /[\d=+\-*/^_\\{}<>|]/;
/** A digit-leading body closing against one of these is a bracketed aside, not an equation. */
const ASIDE_OPENERS = "\\([{";

/**
 * Whether `text.slice(open, close + 1)` is an equation rather than a pair of
 * unrelated dollar signs.
 *
 * Mirrors `isInlineMath` in `TranscriptMarkdownPreparation.swift` on iOS; keep the
 * two in step. A prose `$` is nearly always currency (`$1.25/1M in and $4.25`) or
 * a shell variable (`$PATH and $HOME`), and pairing those swallows the text
 * between them.
 */
function isInlineMath(text: string, open: number, close: number): boolean {
  const body = text.slice(open + 1, close);
  if (!body.trim()) return false;
  const after = text[close + 1] ?? "";
  // "$5,$10": a closer running straight into another amount closes nothing.
  if (/\d/.test(after)) return false;
  const first = body[0];
  const last = body[body.length - 1];
  if (/\d/.test(first)) {
    // "$1.25/1M in and $4.25" and "$50 ($x$ ...)": an amount, not an equation.
    if (/\s/.test(last) || ASIDE_OPENERS.includes(last)) return false;
    if (/[\p{L}\\]/u.test(after)) return false;
    return true;
  }
  // "$PATH and $HOME": several words with nothing equation-shaped in them.
  if (/\s/.test(body) && !MATH_SIGNALS.test(body)) return false;
  return true;
}

/** Index of the next `$` that could close inline math, or -1. */
function inlineCloser(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === "\n") return -1;
    if (text[i] === "$" && text[i - 1] !== "\\") return i;
  }
  return -1;
}

/**
 * Replaces each math region with a sentinel, pushing its source onto `spans`.
 * A rejected `$` is emitted verbatim and scanning resumes at the next character,
 * so the dollar sign that failed to close one span can still open the next.
 */
function maskMathSpans(text: string, spans: string[]): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char !== "$" || text[index - 1] === "\\") {
      output += char;
      index += 1;
      continue;
    }
    if (text[index + 1] === "$") {
      const close = text.indexOf("$$", index + 2);
      if (close !== -1 && text.slice(index + 2, close).trim()) {
        spans.push(text.slice(index, close + 2));
        output += `${MATH_SENTINEL}${spans.length - 1}${MATH_SENTINEL}`;
        index = close + 2;
        continue;
      }
    }
    const close = inlineCloser(text, index + 1);
    if (close !== -1 && isInlineMath(text, index, close)) {
      spans.push(text.slice(index, close + 1));
      output += `${MATH_SENTINEL}${spans.length - 1}${MATH_SENTINEL}`;
      index = close + 1;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

/**
 * Transforms non-code text by normalizing math delimiters and escaping currency.
 */
function transformProseMath(text: string): string {
  let result = text;

  // 1. Convert LaTeX block display math: \[ equation \] -> $$ equation $$
  result = result.replace(/\\\[([\s\S]*?)\\\]/g, (_match, equation: string) => {
    return `\n\n$$\n${equation.trim()}\n$$\n\n`;
  });

  // 1b. Convert bracketed LaTeX equations missing backslash on brackets: [ \command ... ] -> $$ ... $$
  result = result.replace(
    /(?:^|\n)\s*\[\s*(\\[a-zA-Z]+[\s\S]*?)\]\s*(?:\n|$)/g,
    (_match, equation: string) => {
      return `\n\n$$\n${equation.trim()}\n$$\n\n`;
    }
  );

  // 2. Convert LaTeX inline math: \( equation \) -> $equation$
  result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_match, equation: string) => {
    return `$${equation.trim()}$`;
  });

  // 3. Wrap bare LaTeX environments (\begin{align}...\end{align}) in display math fences if not already wrapped
  result = result.replace(LATEX_ENV_REGEX, (_match, envBlock: string) => {
    return `\n\n$$\n${envBlock.trim()}\n$$\n\n`;
  });

  // 4. Normalize single-line standalone $$equation$$ on its own line into block display math
  result = result.replace(/(?:^|\n)\s*\$\$(?!\$)([^\n]+?)\$\$\s*(?:\n|$)/g, (_match, equation: string) => {
    return `\n\n$$\n${equation.trim()}\n$$\n\n`;
  });

  // 5. Mask every math region — the ones above just created and any the author
  // already wrote — so the currency and bare-symbol passes below only ever see
  // prose. Without this, a Greek letter inside `$$ ... $$` gets its own `$...$`
  // wrapper and KaTeX is handed `$` characters in the middle of a math body.
  const mathSpans: string[] = [];
  result = maskMathSpans(result, mathSpans);

  // 6. Everything still holding a `$` is prose, so escape it. A lone `$` renders
  // as a dollar sign instead of silently opening math against the next one.
  result = result.replace(/(?<!\\)\$/g, () => "\\$");

  // 7. Convert bare Greek letter commands in prose (\tau, \alpha) -> $\tau$, $\alpha$
  result = result.replace(
    GREEK_MATH_REGEX,
    (_match, prefix: string, symbol: string, suffix: string) => {
      return `${prefix}$\\${symbol}$${suffix}`;
    }
  );

  return result.replace(
    /\uE000(\d+)\uE000/g,
    (_match, index: string) => mathSpans[Number(index)]
  );
}

/**
 * Normalizes math delimiters in markdown while preserving code fences and inline code.
 */
export function normalizeMathDelimiters(markdown: string): string {
  if (!markdown) return "";
  if (!markdown.includes("$") && !markdown.includes("\\")) {
    return markdown;
  }

  // Matches fenced code blocks (```...``` or ~~~...~~~) and inline code (`...`)
  const tokenRegex = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;

  let lastIndex = 0;
  let output = "";
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(markdown)) !== null) {
    if (match.index > lastIndex) {
      const text = markdown.slice(lastIndex, match.index);
      output += transformProseMath(text);
    }
    // Append code verbatim
    output += match[0];
    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < markdown.length) {
    const text = markdown.slice(lastIndex);
    output += transformProseMath(text);
  }

  return output;
}
