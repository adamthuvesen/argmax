import type { HighlighterCore } from "shiki/core";
import { createArgmaxHighlighter } from "./shikiCore.js";

/**
 * Shiki off the main thread. Loading a grammar and the first tokenization with
 * it was one 466 ms task in WKWebView; here it blocks only this worker.
 *
 * Each request is a whole block, so no grammar state crosses calls: the main
 * thread sliced blocks only to yield between frames, and a worker need not.
 * One request runs per task, so a cancel posted meanwhile drops queued work.
 */

export type HighlightWorkerRequest =
  | { type: "tokenize"; id: number; code: string; lang: string; theme: string }
  | { type: "cancel"; id: number };

export type HighlightWorkerReply =
  | { type: "tokens"; id: number; lines: { content: string; color?: string }[][] | null }
  | { type: "init-failed"; error: string };

type TokenizeRequest = Extract<HighlightWorkerRequest, { type: "tokenize" }>;

const queue = new Map<number, TokenizeRequest>();
let highlighter: HighlighterCore | null = null;
let scheduled = false;

function reply(message: HighlightWorkerReply): void {
  globalThis.postMessage(message);
}

function tokenize(instance: HighlighterCore, request: TokenizeRequest): HighlightWorkerReply {
  try {
    const result = instance.codeToTokens(request.code, {
      lang: request.lang,
      theme: request.theme,
    });
    return {
      type: "tokens",
      id: request.id,
      lines: result.tokens.map((line) =>
        line.map((token) => ({ content: token.content, color: token.color })),
      ),
    };
  } catch {
    return { type: "tokens", id: request.id, lines: null };
  }
}

function runNext(): void {
  scheduled = false;
  const next = queue.values().next();
  if (next.done || !highlighter) return;
  queue.delete(next.value.id);
  reply(tokenize(highlighter, next.value));
  schedule();
}

function schedule(): void {
  if (scheduled || queue.size === 0 || !highlighter) return;
  scheduled = true;
  setTimeout(runNext, 0);
}

void createArgmaxHighlighter().then(
  (instance) => {
    highlighter = instance;
    schedule();
  },
  (error: unknown) => {
    reply({ type: "init-failed", error: error instanceof Error ? error.message : String(error) });
  },
);

globalThis.addEventListener("message", (event: MessageEvent<HighlightWorkerRequest>) => {
  const message = event.data;
  if (message.type === "cancel") {
    queue.delete(message.id);
    return;
  }
  queue.set(message.id, message);
  schedule();
});
