import { createContext } from "react";

// True while the enclosing assistant message is still streaming. Shiki's
// tokenizer is synchronous and main-thread; re-running it on every few-char
// growth of a live fence is the biggest source of streaming jank. When this is
// set, CodeBlock renders plain text and defers the real highlight until the
// fence stops changing (or the stream ends and this flips to false).
export const StreamingCodeContext = createContext(false);
