import { Copy } from "lucide-react";
import { Children, useMemo, useState, type JSX, type ReactNode } from "react";

const COPY_FLASH_MS = 1500;
const LANGUAGE_CLASS_PREFIX = "language-";

function extractLanguage(className: string | undefined): string | null {
  if (!className) return null;
  const tokens = className.split(/\s+/);
  for (const token of tokens) {
    if (token.startsWith(LANGUAGE_CLASS_PREFIX)) {
      const lang = token.slice(LANGUAGE_CLASS_PREFIX.length).trim();
      return lang || null;
    }
  }
  return null;
}

function collectText(children: ReactNode): string {
  let out = "";
  Children.forEach(children, (child) => {
    if (child == null || child === false) return;
    if (typeof child === "string" || typeof child === "number") {
      out += String(child);
      return;
    }
    if (Array.isArray(child)) {
      out += collectText(child);
      return;
    }
    if (typeof child === "object" && "props" in child) {
      const innerChildren = (child as { props: { children?: ReactNode } }).props.children;
      if (innerChildren !== undefined) {
        out += collectText(innerChildren);
      }
    }
  });
  return out;
}

export function CodeBlock({
  className,
  children
}: {
  className?: string;
  children?: ReactNode;
}): JSX.Element {
  const language = useMemo(() => extractLanguage(className), [className]);
  const codeText = useMemo(() => collectText(children).replace(/\n$/, ""), [children]);
  const [copied, setCopied] = useState(false);

  const handleCopy = (): void => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(codeText).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPY_FLASH_MS);
    });
  };

  return (
    <div className="code-block">
      <div className="code-block-header">
        {language ? <span className="code-block-lang">{language}</span> : <span className="code-block-lang code-block-lang--blank" aria-hidden="true" />}
        <button
          type="button"
          className="code-block-copy"
          aria-label="Copy code"
          title={copied ? "Copied!" : "Copy code"}
          onClick={handleCopy}
        >
          <Copy size={11} aria-hidden="true" />
        </button>
      </div>
      <pre className={className ?? ""}>
        <code className={className ?? ""}>{children}</code>
      </pre>
    </div>
  );
}
