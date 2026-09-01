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

  // 2b. Convert bare Greek letter commands in prose (\tau, \alpha) -> $\tau$, $\alpha$
  result = result.replace(
    GREEK_MATH_REGEX,
    (_match, prefix: string, symbol: string, suffix: string) => {
      return `${prefix}$\\${symbol}$${suffix}`;
    }
  );

  // 3. Wrap bare LaTeX environments (\begin{align}...\end{align}) in display math fences if not already wrapped
  result = result.replace(LATEX_ENV_REGEX, (_match, envBlock: string) => {
    return `\n\n$$\n${envBlock.trim()}\n$$\n\n`;
  });

  // 4. Normalize single-line standalone $$equation$$ on its own line into block display math
  result = result.replace(/(?:^|\n)\s*\$\$(?!\$)([^\n]+?)\$\$\s*(?:\n|$)/g, (_match, equation: string) => {
    return `\n\n$$\n${equation.trim()}\n$$\n\n`;
  });

  // 5. Escape currency dollars (e.g. $50, $10.99, $1,000) so remark-math doesn't treat them as math delimiters.
  // Matches a single $ preceded by start-of-string or non-backslash/non-dollar, followed immediately by a digit.
  result = result.replace(
    /(^|[^\\$])\$(\d)/g,
    (_match, prefix: string, digit: string) => `${prefix}\\$${digit}`
  );

  return result;
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
